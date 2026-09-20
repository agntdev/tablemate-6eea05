/** Small durable JSON store for domain records.
 * Node uses Redis when REDIS_URL is present; Workers use the optional D1 DB
 * binding. Callers use explicit keys/indexes and never enumerate a keyspace.
 */
export type DataContext = unknown;
interface D1Like { prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } }

interface RedisStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> }
let redisPromise: Promise<RedisStore> | null = null;
async function redis(): Promise<RedisStore> {
  if (!redisPromise) {
    redisPromise = (async () => {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const mod: any = require("ioredis");
      const Redis = mod.default ?? mod.Redis ?? mod;
      return new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) as { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> };
    })();
  }
  return await redisPromise;
}

function contextEnv(ctx: DataContext): Record<string, unknown> | null | undefined {
  return (ctx as { env?: Record<string, unknown> | null } | null | undefined)?.env;
}

function nodeEnv(key: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[key];
}

export async function readData<T>(ctx: DataContext, key: string): Promise<T | undefined> {
  const db = contextEnv(ctx)?.DB as D1Like | undefined;
  if (db) {
    const row = await db.prepare("SELECT value FROM bot_data WHERE key = ?1").bind(key).first<{ value: string }>();
    return row ? JSON.parse(row.value) as T : undefined;
  }
  if (nodeEnv("REDIS_URL")) {
    const raw = await (await redis()).get(`table-reserve:${key}`);
    return raw == null ? undefined : JSON.parse(raw) as T;
  }
  return undefined;
}

export async function writeData(ctx: DataContext, key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  const db = contextEnv(ctx)?.DB as D1Like | undefined;
  if (db) {
    await db.prepare("CREATE TABLE IF NOT EXISTS bot_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)").bind().run();
    await db.prepare("INSERT INTO bot_data(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, encoded).run();
    return;
  }
  if (nodeEnv("REDIS_URL")) await (await redis()).set(`table-reserve:${key}`, encoded);
}
