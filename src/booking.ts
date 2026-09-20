import type { Ctx, Session } from "./bot.js";
import { adminChatId, inlineButton, inlineKeyboard, readData, remindAt, writeData } from "./toolkit/index.js";

export type BookingStatus = "confirmed" | "cancelled" | "rescheduled" | "no-show";
export interface Booking {
  id: string; reference: string; guestLabel: string; phone?: string; chatId: number;
  partySize: number; date: string; startTime: string; durationMinutes: number;
  assignedTables: string[]; status: BookingStatus; createdAt: string; updatedAt: string;
  reminderSentAt?: string; reminderStatus?: "scheduled" | "sent" | "failed" | "cancelled";
}
export interface Rules { duration: number; leadMinutes: number; windowDays: number; granularity: number; reminderMinutes: number; timezone: string }
export interface Table { id: string; seats: number }

let clock = () => new Date();
export const now = (): Date => clock();
export function setClock(next: () => Date): void { clock = next; }
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const minute = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
const timeText = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export async function rules(ctx: Ctx): Promise<Rules> {
  return (await readData<Rules>(ctx, "rules")) ?? { duration: 90, leadMinutes: 60, windowDays: 30, granularity: 15, reminderMinutes: 120, timezone: "UTC" };
}
export async function tables(ctx: Ctx): Promise<Table[]> {
  const saved = await readData<Table[]>(ctx, "tables");
  if (saved?.length) return saved;
  return [...Array(5)].map((_, i) => ({ id: `T${i + 1}`, seats: 2 })).concat([...Array(8)].map((_, i) => ({ id: `T${i + 6}`, seats: 4 })));
}
async function bookingIds(ctx: Ctx): Promise<string[]> { return (await readData<string[]>(ctx, "bookings:index")) ?? []; }
export async function allBookings(ctx: Ctx): Promise<Booking[]> {
  const ids = await bookingIds(ctx); const out: Booking[] = [];
  for (const id of ids) { const b = await readData<Booking>(ctx, `booking:${id}`); if (b) out.push(b); }
  return out;
}
async function saveBooking(ctx: Ctx, b: Booking): Promise<void> {
  const ids = await bookingIds(ctx); if (!ids.includes(b.id)) ids.push(b.id);
  await writeData(ctx, `booking:${b.id}`, b); await writeData(ctx, "bookings:index", ids);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) { return aStart < bEnd && bStart < aEnd; }
function availableTables(bookings: Booking[], pool: Table[], date: string, time: string, duration: number, ignoreId?: string): Table[] {
  const used = new Set<string>(); const start = minute(time), end = start + duration;
  for (const b of bookings) {
    if (b.id === ignoreId || b.date !== date || b.status === "cancelled" || b.status === "no-show") continue;
    if (overlaps(start, end, minute(b.startTime), minute(b.startTime) + b.durationMinutes)) for (const id of b.assignedTables) used.add(id);
  }
  return pool.filter((t) => !used.has(t.id));
}
function chooseTables(pool: Table[], party: number): string[] | undefined {
  const sorted = [...pool].sort((a, b) => a.seats - b.seats);
  const search = (at: number, seats: number, picked: string[]): string[] | undefined => {
    if (seats >= party) return picked;
    for (let i = at; i < sorted.length; i++) { const found = search(i + 1, seats + sorted[i].seats, [...picked, sorted[i].id]); if (found) return found; }
    return undefined;
  };
  return search(0, 0, []);
}
export async function assignment(ctx: Ctx, date: string, time: string, party: number, ignoreId?: string): Promise<string[] | undefined> {
  const [bs, ts, r] = await Promise.all([allBookings(ctx), tables(ctx), rules(ctx)]);
  const free = new Set(availableTables(bs, ts, date, time, r.duration, ignoreId).map((t) => t.id));
  return chooseTables(ts.filter(t => free.has(t.id)), party);
}

export async function availableSlots(ctx: Ctx, date: string, party = 1, ignoreId?: string): Promise<string[]> {
  const r = await rules(ctx); const d = new Date(`${date}T00:00:00Z`); const day = d.getUTCDay();
  const [bs, ts] = await Promise.all([allBookings(ctx), tables(ctx)]);
  const out: string[] = []; const today = isoDate(now()); const current = now(); const earliest = date === today ? current.getUTCHours() * 60 + current.getUTCMinutes() + r.leadMinutes : -1;
  const daysAhead = Math.floor((d.getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
  if (daysAhead < 0 || daysAhead >= r.windowDays) return out;
  if (day < 0 || ts.length === 0) return out;
  for (let m = 11 * 60; m + r.duration <= 22 * 60; m += r.granularity) {
    if (m < earliest) continue;
    const time = timeText(m); const free = new Set(availableTables(bs, ts, date, time, r.duration, ignoreId).map((t) => t.id));
    if (chooseTables(ts.filter(t => free.has(t.id)), party)) out.push(time);
  }
  return out;
}

export const menu = () => inlineKeyboard([[inlineButton("Reserve table", "booking:start"), inlineButton("My booking", "booking:lookup")], [inlineButton("❓ Help", "menu:help")]]);
export const manageKeyboard = (id: string) => inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${id}`), inlineButton("Cancel", `booking:cancel:${id}`)]]);
export function sessionBooking(ctx: Ctx): NonNullable<Session["booking"]> { return (ctx.session.booking ??= {}); }
export function reference(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(); }
export function bookingSummary(b: Booking): string { return `Booking ${b.reference}\n${b.date} at ${b.startTime}\n${b.partySize} ${b.partySize === 1 ? "guest" : "guests"}\nName: ${b.guestLabel}`; }

export async function persistBooking(ctx: Ctx, input: Omit<Booking, "id" | "createdAt" | "updatedAt">): Promise<Booking> {
  const stamp = now().toISOString(); const b = { ...input, id: crypto.randomUUID(), createdAt: stamp, updatedAt: stamp };
  await saveBooking(ctx, b);
  const r = await rules(ctx); const when = new Date(`${b.date}T${b.startTime}:00Z`).getTime() - r.reminderMinutes * 60_000;
  const runtime = (ctx as Ctx & { env?: Record<string, unknown> }).env;
  if (when > now().getTime() && runtime) await remindAt(runtime as never, b.chatId, when, `A quick reminder: your table is booked for ${b.date} at ${b.startTime}.`, inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${b.id}`), inlineButton("Cancel", `booking:cancel:${b.id}`)]]));
  return b;
}
export async function updateBooking(ctx: Ctx, b: Booking): Promise<void> { b.updatedAt = now().toISOString(); await saveBooking(ctx, b); }
export async function notifyOwner(ctx: Ctx, text: string): Promise<boolean> {
  const owner = adminChatId(ctx as never); if (!owner) return false;
  try { await ctx.api.sendMessage(owner, text); return true; } catch { return false; }
}
