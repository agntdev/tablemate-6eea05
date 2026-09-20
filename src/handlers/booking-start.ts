import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { assignment, availableSlots, bookingSummary, menu, now, notifyOwner, persistBooking, reference, rules, sessionBooking, type Booking } from "../booking.js";

registerMainMenuItem({ label: "Reserve table", data: "booking:start", order: 10 });
const composer = new Composer<Ctx>();
const back = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

function calendar(): { text: string; reply_markup: ReturnType<typeof inlineKeyboard> } {
  const rows = []; const start = now();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86_400_000); const date = d.toISOString().slice(0, 10);
    rows.push([inlineButton(i === 0 ? `Today · ${date}` : date, `booking:date:${date}`)]);
  }
  return { text: "When would you like to visit?", reply_markup: inlineKeyboard(rows.concat([[inlineButton("⬅️ Back to menu", "menu:main")]])) };
}

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "booking_date"; ctx.session.booking = {};
  const view = calendar(); await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
});

composer.callbackQuery(/^booking:date:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.callbackQuery.data.slice("booking:date:".length); const b = sessionBooking(ctx); b.date = date; ctx.session.step = "booking_time";
  const slots = await availableSlots(ctx, date, b.partySize ?? 1, b.rescheduling ? b.bookingId : undefined);
  if (!slots.length) { await ctx.editMessageText("There aren't open tables on that date. Pick another day.", { reply_markup: back }); return; }
  const rows = []; for (let i = 0; i < slots.length; i += 3) rows.push(slots.slice(i, i + 3).map((t) => inlineButton(t, `booking:time:${t}`)));
  await ctx.editMessageText(`Here are the open times for ${date}:`, { reply_markup: inlineKeyboard(rows.concat([[inlineButton("⬅️ Change date", "booking:start")]])) });
});

composer.callbackQuery(/^booking:time:/, async (ctx) => {
  await ctx.answerCallbackQuery(); const b = sessionBooking(ctx); b.time = ctx.callbackQuery.data.slice("booking:time:".length); ctx.session.step = "booking_party";
  await ctx.editMessageText("How many guests should I book for?", { reply_markup: inlineKeyboard([[inlineButton("1–2", "booking:party:2"), inlineButton("3–4", "booking:party:4")], [inlineButton("5–6", "booking:party:6"), inlineButton("Custom", "booking:party:custom")]]) });
});

composer.callbackQuery(/^booking:party:/, async (ctx) => {
  await ctx.answerCallbackQuery(); const value = ctx.callbackQuery.data.slice("booking:party:".length);
  if (value === "custom") { ctx.session.step = "booking_party_custom"; await ctx.reply("How many guests?", { reply_markup: { force_reply: true, selective: true } }); return; }
  sessionBooking(ctx).partySize = Number(value); ctx.session.step = "booking_contact";
  await ctx.reply("Send a phone number, or type skip if you’d rather not share one.", { reply_markup: { force_reply: true, selective: true } });
});

async function showConfirmation(ctx: Ctx): Promise<void> {
  const b = sessionBooking(ctx); if (!b.date || !b.time || !b.partySize) { await ctx.reply("That reservation is missing a detail. Tap Reserve table to start again."); return; }
  const assigned = await assignment(ctx, b.date, b.time, b.partySize); if (!assigned) { await ctx.reply("That time just filled up. Pick another open time.", { reply_markup: back }); return; }
  b.reference ??= reference();
  const guest = b.name?.trim() || `Guest-${b.reference}`;
  await ctx.reply(`Here’s your reservation:\n${b.date} at ${b.time}\n${b.partySize} ${b.partySize === 1 ? "guest" : "guests"}\nName: ${guest}\nReference: ${b.reference}`, { reply_markup: inlineKeyboard([[inlineButton("Confirm booking", "booking:confirm"), inlineButton("Change", "booking:start")], [inlineButton("Cancel", "booking:discard")]]) });
}

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step; const text = ctx.message.text.trim();
  if (step === "booking_party_custom") {
    const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 20) { await ctx.reply("Enter a number from 1 to 20.", { reply_markup: { force_reply: true } }); return; }
    sessionBooking(ctx).partySize = n; ctx.session.step = "booking_contact"; await ctx.reply("Send a phone number, or type skip if you’d rather not share one.", { reply_markup: { force_reply: true } }); return;
  }
  if (step === "booking_contact") {
    const b = sessionBooking(ctx); if (text.toLowerCase() !== "skip") b.phone = text.slice(0, 40); ctx.session.step = "booking_name";
    await ctx.reply("What name should I put on the reservation? Type skip if you’d rather not say.", { reply_markup: { force_reply: true } }); return;
  }
  if (step === "booking_name") {
    const b = sessionBooking(ctx); if (text.toLowerCase() !== "skip") b.name = text.slice(0, 80); ctx.session.step = "booking_confirm"; await showConfirmation(ctx); return;
  }
  await next();
});

composer.callbackQuery("booking:discard", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = undefined; ctx.session.booking = undefined; await ctx.editMessageText("No problem — your reservation wasn’t saved.", { reply_markup: menu() }); });

composer.callbackQuery("booking:confirm", async (ctx) => {
  await ctx.answerCallbackQuery(); const b = sessionBooking(ctx); const runtime = ctx as Ctx & { env?: Record<string, unknown> };
  if (!adminChatId(runtime)) { await ctx.editMessageText("This restaurant is still finishing setup, so I can’t accept reservations yet. Please try again later.", { reply_markup: back }); return; }
  if (!b.date || !b.time || !b.partySize || !b.reference) { await ctx.editMessageText("That reservation has expired. Tap Reserve table to start again.", { reply_markup: back }); return; }
  const assigned = await assignment(ctx, b.date, b.time, b.partySize, b.rescheduling ? b.bookingId : undefined); if (!assigned) { await ctx.editMessageText("That time just filled up. Pick another open time.", { reply_markup: back }); return; }
  if (b.rescheduling && b.bookingId) {
    const existing = (await import("../booking.js")).allBookings(ctx).then((items) => items.find((item) => item.id === b.bookingId));
    const current = await existing;
    if (!current) { await ctx.editMessageText("That booking has changed. Tap My booking to look it up again.", { reply_markup: back }); return; }
    current.date = b.date; current.startTime = b.time; current.partySize = b.partySize; current.assignedTables = assigned; current.status = "rescheduled";
    await (await import("../booking.js")).updateBooking(ctx, current); await ctx.editMessageText(`Your booking ${current.reference} is moved to ${current.date} at ${current.startTime}.`, { reply_markup: inlineKeyboard([[inlineButton("Cancel", `booking:cancel:${current.id}`)]]) }); await notifyOwner(ctx, `Booking ${current.reference} was rescheduled.`); ctx.session.step = undefined; return;
  }
  const created = await persistBooking(ctx, { reference: b.reference, guestLabel: b.name?.trim() || `Guest-${b.reference}`, phone: b.phone, chatId: ctx.chat?.id ?? 0, partySize: b.partySize, date: b.date, startTime: b.time, durationMinutes: (await rules(ctx)).duration, assignedTables: assigned, status: "confirmed", reminderStatus: "scheduled" });
  await ctx.editMessageText(`You’re all set!\n${bookingSummary(created)}\nI’ll remind you before your visit.`, { reply_markup: inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${created.id}`), inlineButton("Cancel", `booking:cancel:${created.id}`)]]) });
  await notifyOwner(ctx, `New booking ${created.reference}\n${created.date} at ${created.startTime}\n${created.partySize} guests`);
  ctx.session.step = undefined; ctx.session.booking = { reference: created.reference, bookingId: created.id };
});

export default composer;
