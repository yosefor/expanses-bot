import type { Expense, ExpenseStore, Invite } from "./store.ts";

/** The subset of Cloudflare's D1 API this store uses (avoids pulling Workers types into the Node build). */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}
export interface D1Result {
  meta: { changes: number };
}

interface ExpenseRow {
  message_id: string;
  sender: string;
  sender_name: string | null;
  amount_cents: number;
  reason: string;
  created_at: number;
}

interface InviteRow {
  code: string;
  account_id: string;
  created_by: string;
  created_by_name: string | null;
  expires_at: number;
}

/** Schema: migrations/0001_init.sql */
export class D1ExpenseStore implements ExpenseStore {
  #db: D1Database;
  #now: () => number;

  constructor(db: D1Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  async markProcessed(messageId: string): Promise<boolean> {
    const result = await this.#db
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)")
      .bind(messageId, this.#now())
      .run();
    return result.meta.changes === 1;
  }

  async add(accountId: string, expense: Expense): Promise<void> {
    await this.#db
      .prepare(
        `INSERT OR REPLACE INTO expenses (account_id, message_id, sender, sender_name, amount_cents, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        accountId,
        expense.messageId,
        expense.sender,
        expense.senderName ?? null,
        expense.amountCents,
        expense.reason,
        expense.createdAt,
      )
      .run();
  }

  async list(accountId: string): Promise<Expense[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT message_id, sender, sender_name, amount_cents, reason, created_at
         FROM expenses WHERE account_id = ? ORDER BY created_at, rowid`,
      )
      .bind(accountId)
      .all<ExpenseRow>();
    return results.map((row) => {
      const expense: Expense = {
        sender: row.sender,
        messageId: row.message_id,
        amountCents: row.amount_cents,
        reason: row.reason,
        createdAt: row.created_at,
      };
      if (row.sender_name) expense.senderName = row.sender_name;
      return expense;
    });
  }

  async linkedAccount(phone: string): Promise<string | null> {
    const row = await this.#db.prepare("SELECT account_id FROM links WHERE phone = ?").bind(phone).first<{ account_id: string }>();
    return row?.account_id ?? null;
  }

  async hasMembers(accountId: string): Promise<boolean> {
    const row = await this.#db.prepare("SELECT 1 AS found FROM links WHERE account_id = ? LIMIT 1").bind(accountId).first();
    return row !== null;
  }

  async createInvite(invite: Invite): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO invites (code, account_id, created_by, created_by_name, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(invite.code, invite.accountId, invite.createdBy, invite.createdByName ?? null, invite.expiresAt)
      .run();
    return result.meta.changes === 1;
  }

  async getInvite(code: string): Promise<Invite | null> {
    const row = await this.#db.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<InviteRow>();
    if (!row) return null;
    const invite: Invite = {
      code: row.code,
      accountId: row.account_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
    };
    if (row.created_by_name) invite.createdByName = row.created_by_name;
    return invite;
  }

  async redeemInvite(code: string, phone: string): Promise<boolean> {
    // A batch is one transaction: the link is only written if the invite still exists,
    // and the invite is consumed in the same step.
    const [, deleted] = await this.#db.batch([
      this.#db
        .prepare("INSERT OR REPLACE INTO links (phone, account_id, linked_at) SELECT ?, account_id, ? FROM invites WHERE code = ?")
        .bind(phone, this.#now(), code),
      this.#db.prepare("DELETE FROM invites WHERE code = ?").bind(code),
    ]);
    return deleted?.meta.changes === 1;
  }

  async unlink(phone: string): Promise<boolean> {
    const result = await this.#db.prepare("DELETE FROM links WHERE phone = ?").bind(phone).run();
    return result.meta.changes > 0;
  }

  async moveExpenses(fromAccountId: string, toAccountId: string): Promise<number> {
    const [, deleted] = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO expenses (account_id, message_id, sender, sender_name, amount_cents, reason, created_at)
           SELECT ?, message_id, sender, sender_name, amount_cents, reason, created_at FROM expenses WHERE account_id = ?`,
        )
        .bind(toAccountId, fromAccountId),
      this.#db.prepare("DELETE FROM expenses WHERE account_id = ?").bind(fromAccountId),
    ]);
    return deleted?.meta.changes ?? 0;
  }

  /** Deletes dedupe records older than `maxAgeMs` and expired invites. Run from the daily cron. */
  async cleanup(maxAgeMs: number): Promise<void> {
    const now = this.#now();
    await this.#db.batch([
      this.#db.prepare("DELETE FROM processed_messages WHERE processed_at < ?").bind(now - maxAgeMs),
      this.#db.prepare("DELETE FROM invites WHERE expires_at < ?").bind(now),
    ]);
  }
}
