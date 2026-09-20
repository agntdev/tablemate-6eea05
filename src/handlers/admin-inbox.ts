import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner, writeData } from "../toolkit/index.js";
import { allBookings, bookingSummary, notifyOwner, rules, tables, updateBooking } from "../booking.js";

registerMainMenuItem({ label: "Admin inbox", data: "admin:inbox", order: 90 });
const composer = new Composer<Ctx>();

async function inbox(ctx: Ctx) {
  if (!(await requireOwner(ctx as never))) return;
  const bookings = (await allBookings(ctx)).filter((b) => b.status === "confirmed" || b.status === "rescheduled").sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  if (!bookings.length) { await ctx.reply("No upcoming bookings yet.", { reply_markup: inlineKeyboard([[inlineButton("Restaurant settings", "admin:settings")]]) }); return; }
  const lines = [`You have ${bookings.length} upcoming ${bookings.length === 1 ? "booking" : "bookings"}.`];
  const rows = [];
  for (const b of bookings.slice(0, 20)) { lines.push(`\n${b.date} at ${b.startTime} · ${b.partySize} guests · ${b.reference}`); rows.push([inlineButton(`Open ${b.reference}`, `admin:booking:${b.id}`)]); }
  rows.push([inlineButton("Restaurant settings", "admin:settings")]); await ctx.reply(lines.join(""), { reply_markup: inlineKeyboard(rows) });
}
composer.callbackQuery("admin:inbox", async (ctx) => { await ctx.answerCallbackQuery(); await inbox(ctx); });
composer.callbackQuery("admin:settings", async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const r = await rules(ctx); const ts = await tables(ctx);
  await ctx.reply(`Restaurant settings\nTables: ${ts.length}\nSitting time: ${r.duration} minutes\nBooking window: ${r.windowDays} days\nReminders: ${r.reminderMinutes ? "on" : "off"}`, { reply_markup: inlineKeyboard([[inlineButton("90-minute sittings", "admin:duration:90"), inlineButton("120-minute sittings", "admin:duration:120")], [inlineButton("Reminders on", "admin:reminders:on"), inlineButton("Reminders off", "admin:reminders:off")], [inlineButton("30-day window", "admin:window:30"), inlineButton("60-day window", "admin:window:60")]]) });
});
composer.callbackQuery(/^admin:duration:/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; const r = await rules(ctx); r.duration = Number(ctx.callbackQuery.data.slice("admin:duration:".length)); await writeData(ctx, "rules", r); await ctx.editMessageText(`Sitting time is now ${r.duration} minutes.`); });
composer.callbackQuery(/^admin:reminders:/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; const r = await rules(ctx); r.reminderMinutes = ctx.callbackQuery.data.endsWith(":on") ? 120 : 0; await writeData(ctx, "rules", r); await ctx.editMessageText(`Guest reminders are ${r.reminderMinutes ? "on" : "off"}.`); });
composer.callbackQuery(/^admin:window:/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; const r = await rules(ctx); r.windowDays = Number(ctx.callbackQuery.data.slice("admin:window:".length)); await writeData(ctx, "rules", r); await ctx.editMessageText(`The booking window is now ${r.windowDays} days.`); });
composer.callbackQuery(/^admin:booking:/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const b = (await allBookings(ctx)).find((x) => x.id === ctx.callbackQuery.data.slice("admin:booking:".length));
  if (!b) { await ctx.reply("That booking is no longer available."); return; }
  await ctx.reply(bookingSummary(b), { reply_markup: inlineKeyboard([[inlineButton("Mark no-show", `admin:noshow:${b.id}`), inlineButton("Cancel", `admin:cancel:${b.id}`)], [inlineButton("Contact guest", `admin:contact:${b.id}`), inlineButton("Back to inbox", "admin:inbox")]]) });
});
composer.callbackQuery(/^admin:noshow:/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const id = ctx.callbackQuery.data.slice("admin:noshow:".length); const b = (await allBookings(ctx)).find((x) => x.id === id);
  if (!b) { await ctx.reply("That booking is no longer available."); return; }
  await ctx.editMessageText("Mark this guest as a no-show?", { reply_markup: inlineKeyboard([[inlineButton("Yes, mark no-show", `admin:noshow-yes:${id}`), inlineButton("Keep booking", `admin:booking:${id}`)]]) });
});
composer.callbackQuery(/^admin:noshow-yes:/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const b = (await allBookings(ctx)).find((x) => x.id === ctx.callbackQuery.data.slice("admin:noshow-yes:".length));
  if (!b) { await ctx.editMessageText("That booking is no longer available."); return; }
  b.status = "no-show"; await updateBooking(ctx, b); await ctx.editMessageText(`Marked ${b.reference} as a no-show.`);
});
composer.callbackQuery(/^admin:cancel:/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const b = (await allBookings(ctx)).find((x) => x.id === ctx.callbackQuery.data.slice("admin:cancel:".length));
  if (!b) { await ctx.reply("That booking is no longer available."); return; }
  b.status = "cancelled"; b.reminderStatus = "cancelled"; await updateBooking(ctx, b); try { await ctx.api.sendMessage(b.chatId, `Your booking ${b.reference} was cancelled by the restaurant.`); } catch { /* The owner still gets a confirmation when a guest is unreachable. */ } await ctx.editMessageText(`Booking ${b.reference} is cancelled.`); await notifyOwner(ctx, `Booking ${b.reference} was cancelled by the owner.`);
});
composer.callbackQuery(/^admin:contact:/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return;
  const b = (await allBookings(ctx)).find((x) => x.id === ctx.callbackQuery.data.slice("admin:contact:".length));
  if (!b) { await ctx.reply("That booking is no longer available."); return; }
  try { await ctx.api.sendMessage(b.chatId, "The restaurant has a message about your reservation. Please reply here when you can."); await ctx.reply("Message sent to the guest."); } catch { await ctx.reply("I couldn’t reach that guest. They may have blocked the bot."); }
});
export default composer;
