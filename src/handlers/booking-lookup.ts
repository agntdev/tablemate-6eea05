import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { allBookings, bookingSummary, manageKeyboard, notifyOwner, now, sessionBooking, updateBooking } from "../booking.js";

registerMainMenuItem({ label: "My booking", data: "booking:lookup", order: 20 });
const composer = new Composer<Ctx>();

composer.callbackQuery("booking:lookup", async (ctx) => {
  await ctx.answerCallbackQuery(); ctx.session.step = "lookup";
  await ctx.reply("Send your reference code or phone number and I’ll find it.", { reply_markup: { force_reply: true, selective: true } });
});

async function find(ctx: Ctx, query: string) {
  const normalized = query.replace(/\s+/g, "").toUpperCase(); const bookings = await allBookings(ctx);
  return bookings.find((b) => (b.reference.toUpperCase() === normalized || (b.phone && b.phone.replace(/\s+/g, "") === query.replace(/\s+/g, ""))) && b.chatId === ctx.chat?.id && b.status !== "cancelled");
}
async function show(ctx: Ctx, b: Awaited<ReturnType<typeof find>>) {
  if (!b) { await ctx.reply("I couldn’t find an active booking for that detail. Check it and try again."); return; }
  sessionBooking(ctx).bookingId = b.id; sessionBooking(ctx).reference = b.reference; ctx.session.step = undefined;
  await ctx.reply(bookingSummary(b), { reply_markup: manageKeyboard(b.id) });
}
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "lookup") { await next(); return; }
  ctx.session.step = undefined; await show(ctx, await find(ctx, ctx.message.text.trim()));
});

composer.callbackQuery(/^booking:reschedule:/, async (ctx) => {
  await ctx.answerCallbackQuery(); const id = ctx.callbackQuery.data.slice("booking:reschedule:".length); const b = (await allBookings(ctx)).find((item) => item.id === id && item.chatId === ctx.chat?.id);
  if (!b) { await ctx.reply("I couldn’t find that booking. Tap My booking to look it up again."); return; }
  ctx.session.booking = { bookingId: b.id, reference: b.reference, partySize: b.partySize, rescheduling: true }; ctx.session.step = "booking_date";
  const rows = []; for (let i = 0; i < 7; i++) { const d = new Date(now().getTime() + i * 86_400_000).toISOString().slice(0, 10); rows.push([inlineButton(i === 0 ? `Today · ${d}` : d, `booking:date:${d}`)]); }
  await ctx.editMessageText("Choose a new date:", { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^booking:cancel:/, async (ctx) => {
  await ctx.answerCallbackQuery(); const id = ctx.callbackQuery.data.slice("booking:cancel:".length); const b = (await allBookings(ctx)).find((item) => item.id === id && item.chatId === ctx.chat?.id);
  if (!b) { await ctx.reply("I couldn’t find that booking. Tap My booking to look it up again."); return; }
  ctx.session.booking = { bookingId: b.id, reference: b.reference }; await ctx.editMessageText("Cancel this reservation?", { reply_markup: inlineKeyboard([[inlineButton("Yes, cancel", `booking:cancel-yes:${id}`), inlineButton("Keep it", `booking:cancel-no:${id}`)]]) });
});

composer.callbackQuery(/^booking:cancel-no:/, async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("Your reservation is still on the books.", { reply_markup: inlineKeyboard([[inlineButton("Back", "booking:lookup")]]) }); });
composer.callbackQuery(/^booking:cancel-yes:/, async (ctx) => {
  await ctx.answerCallbackQuery(); const id = ctx.callbackQuery.data.slice("booking:cancel-yes:".length); const b = (await allBookings(ctx)).find((item) => item.id === id && item.chatId === ctx.chat?.id);
  if (!b) { await ctx.editMessageText("I couldn’t find that booking. It may already be closed."); return; }
  b.status = "cancelled"; b.reminderStatus = "cancelled"; await updateBooking(ctx, b); await ctx.editMessageText(`Your booking ${b.reference} is cancelled.`); await notifyOwner(ctx, `Booking ${b.reference} was cancelled.`);
});

export default composer;
