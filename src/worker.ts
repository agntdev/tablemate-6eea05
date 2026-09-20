/**
 * Cloudflare Workers entry point (docs/cloudflare/new-projects-on-cf.md §1, §3).
 *
 * Telegram delivers each update as a webhook POST to /tg; the Worker builds the
 * grammY bot (once per isolate) with the build-time handler manifest and a
 * Durable-Object session store, then hands the request to grammY's Workers
 * adapter. Reminders run on Durable Object alarms (see toolkit/session/durable).
 *
 * The Node/long-poll entry (src/index.ts) is untouched — a bot deployed to Fly
 * still runs there. Only a bot whose agnt engine is `cloudflare` is served here.
 */

import { webhookCallback, Composer, type Bot } from "grammy";
import { buildBot, type Ctx } from "./bot.js";
import { handlers } from "./handlers.generated.js";
import { createDurableSessionStorage, type WorkerEnv } from "./toolkit/session/durable.js";

export { ChatDO } from "./toolkit/session/durable.js";

// A grammY context under Workers additionally carries the runtime `env`, so a
// handler can reach bindings + helpers (e.g. remindAt(ctx.env, …), ctx.env.DB).
export type WorkerCtx = Ctx & { env: WorkerEnv };

// Build the bot ONCE per isolate. The token is stable for the isolate's
// lifetime; grammY requires init() before handling updates. A FAILED build is
// NOT cached: isolates live for many requests, so caching a rejected promise
// (e.g. one transient getMe timeout during a cold start) would brick every
// subsequent update until Cloudflare happens to recycle the isolate.
let botPromise: Promise<Bot<Ctx>> | null = null;
function getBot(env: WorkerEnv): Promise<Bot<Ctx>> {
  if (!botPromise) {
    botPromise = (async () => {
      // Expose the runtime env to handlers (Workers-only; the harness never sets
      // it) BEFORE they run — a handler reaches bindings + helpers through it
      // (remindAt(ctx.env, …), ctx.env.DB). buildBot installs `handlers` in array
      // order, so this must be the FIRST entry, not a trailing bot.use() (which
      // would run AFTER the feature handlers and leave ctx.env undefined).
      const attachEnv = new Composer<Ctx>();
      attachEnv.use((ctx, next) => {
        (ctx as WorkerCtx).env = env;
        return next();
      });
      const bot = await buildBot(env.BOT_TOKEN, {
        handlers: [attachEnv, ...handlers],
        storage: createDurableSessionStorage(env),
        // Worker isolates are request-scoped: they do not expose secrets through
        // process.env and cannot reliably keep a five-minute interval alive.
        telemetryEnv: env,
        telemetryReporterOptions: { flushOnRecord: true, startTimer: false },
      });
      await bot.init();
      return bot;
    })();
    botPromise.catch(() => {
      botPromise = null;
    });
  }
  return botPromise;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, runtime: "cloudflare-workers" });
    }

    if (request.method === "POST" && url.pathname === "/tg") {
      // Telegram echoes the secret we registered with setWebhook; reject anything
      // that doesn't match so only Telegram can drive the bot.
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
      ) {
        return new Response("forbidden", { status: 403 });
      }
      const bot = await getBot(env);
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    if (!env.ADMIN_CHAT_ID || !env.DB) return;
    const db = env.DB as { prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } };
    await db.prepare("CREATE TABLE IF NOT EXISTS bot_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)").bind().run();
    const index = await db.prepare("SELECT value FROM bot_data WHERE key = ?1").bind("bookings:index").first<{ value: string }>();
    const ids: string[] = index ? JSON.parse(index.value) : [];
    const today = new Date().toISOString().slice(0, 10);
    let count = 0; let guests = 0;
    for (const id of ids) {
      const row = await db.prepare("SELECT value FROM bot_data WHERE key = ?1").bind(`booking:${id}`).first<{ value: string }>();
      if (!row) continue;
      const b = JSON.parse(row.value) as { date: string; partySize: number; status: string };
      if (b.date === today && (b.status === "confirmed" || b.status === "rescheduled")) { count++; guests += b.partySize; }
    }
    const failures = await db.prepare("SELECT value FROM bot_data WHERE key = ?1").bind("reminder-failures:index").first<{ value: string }>();
    const failed = failures ? (JSON.parse(failures.value) as string[]).length : 0;
    const text = `Today’s capacity overview\n${count} ${count === 1 ? "booking" : "bookings"} · ${guests} guests${failed ? `\n${failed} reminder ${failed === 1 ? "delivery needs" : "deliveries need"} attention.` : ""}`;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text }) });
  },
};
