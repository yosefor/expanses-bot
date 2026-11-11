import type { Env } from "./config.ts";
import type { D1Database } from "./d1-store.ts";

/** Set by the Worker when a signed webhook arrives, so the setup page can show that messages get through. */
export const LAST_WEBHOOK_AT = "LAST_WEBHOOK_AT";

const CACHE_MS = 30_000;
let cache: { at: number; values: Record<string, string> } | undefined;

/** Settings saved from the setup page (table `settings`). Cached per isolate for 30 seconds. */
export class SettingsStore {
  #db: D1Database;
  #now: () => number;

  constructor(db: D1Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** `fresh` skips the cache (for Meta's webhook verification right after a save). */
  async all(fresh = false): Promise<Record<string, string>> {
    const now = this.#now();
    if (!fresh && cache && now - cache.at < CACHE_MS) return cache.values;
    const { results } = await this.#db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const values = Object.fromEntries(results.map((row) => [row.key, row.value]));
    cache = { at: now, values };
    return values;
  }

  /** Saves the given settings. An empty string deletes the setting (the environment variable applies again). */
  async save(values: Record<string, string>): Promise<void> {
    const now = this.#now();
    const statements = Object.entries(values).map(([key, value]) =>
      value === ""
        ? this.#db.prepare("DELETE FROM settings WHERE key = ?").bind(key)
        : this.#db
            .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
            .bind(key, value, now),
    );
    if (statements.length > 0) await this.#db.batch(statements);
    cache = undefined;
  }

  /** The Worker environment with saved settings on top. */
  async effectiveEnv(env: Env, fresh = false): Promise<Env> {
    return { ...env, ...(await this.all(fresh)) };
  }
}

/** Tests only: forget the cached settings. */
export function clearSettingsCache(): void {
  cache = undefined;
}
