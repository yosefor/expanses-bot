import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { getPlatformProxy } from "wrangler";
import { type D1Database, D1ExpenseStore } from "./d1-store.ts";

// A real (local, in-memory) D1 from wrangler, with the production migrations applied.
let db: D1Database;
let dispose: () => Promise<void>;

before(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(schema.map((sql) => db.prepare(sql)));
});
after(() => dispose());

test("D1 store", async () => {
  let now = 10_000;
  const store = new D1ExpenseStore(db, () => now);
  const sender = "972500000001";

  const id = "wamid.HBgM/abc+def==";
  assert.equal(await store.markProcessed(id), true);
  assert.equal(await store.markProcessed(id), false);

  await store.add(sender, { sender, messageId: "b", amountCents: 2000, reason: "דלק", createdAt: 2_000 });
  await store.add(sender, { sender, senderName: "יוסי", messageId: id, amountCents: 5000, reason: "סופר", createdAt: 1_000 });
  await store.add(sender, { sender, senderName: "יוסי", messageId: id, amountCents: 5000, reason: "סופר", createdAt: 1_000 }); // idempotent
  await store.add("someone-else", { sender: "someone-else", messageId: "c", amountCents: 1, reason: "x", createdAt: 1 });

  assert.deepEqual(await store.list(sender), [
    { sender, senderName: "יוסי", messageId: id, amountCents: 5000, reason: "סופר", createdAt: 1_000 },
    { sender, messageId: "b", amountCents: 2000, reason: "דלק", createdAt: 2_000 },
  ]);

  // Shared accounts: invite, redeem once, move expenses, unlink.
  const member = `${sender}9`;
  const invite = { code: "123456", accountId: sender, createdBy: sender, createdByName: "יוסי", expiresAt: 50_000 };
  assert.equal(await store.createInvite(invite), true);
  assert.equal(await store.createInvite(invite), false);
  assert.deepEqual(await store.getInvite("123456"), invite);
  assert.equal(await store.getInvite("000000"), null);

  await store.add(member, { sender: member, messageId: "m1", amountCents: 700, reason: "קפה", createdAt: 3_000 });
  assert.equal(await store.linkedAccount(member), null);
  assert.equal(await store.hasMembers(sender), false);
  assert.equal(await store.redeemInvite("123456", member), true);
  assert.equal(await store.redeemInvite("123456", member), false);
  assert.equal(await store.redeemInvite("000000", "972500000002"), false);
  assert.equal(await store.linkedAccount("972500000002"), null);
  assert.equal(await store.getInvite("123456"), null);
  assert.equal(await store.linkedAccount(member), sender);
  assert.equal(await store.hasMembers(sender), true);

  assert.equal(await store.moveExpenses(member, sender), 1);
  assert.equal(await store.moveExpenses(member, sender), 0);
  assert.deepEqual(await store.list(member), []);
  assert.equal((await store.list(sender)).at(-1)?.sender, member);
  assert.equal((await store.list("someone-else")).length, 1);

  assert.equal(await store.unlink(member), true);
  assert.equal(await store.unlink(member), false);
  assert.equal(await store.linkedAccount(member), null);

  // Cleanup drops old dedupe records and expired invites only.
  await store.createInvite({ ...invite, code: "222222", expiresAt: 5_000 });
  await store.createInvite({ ...invite, code: "333333", expiresAt: 90_000 });
  now = 60_000;
  await store.markProcessed("recent");
  await store.cleanup(40_000);
  assert.equal(await store.markProcessed(id), true, "old record was deleted");
  assert.equal(await store.markProcessed("recent"), false, "recent record was kept");
  assert.equal(await store.getInvite("222222"), null);
  assert.notEqual(await store.getInvite("333333"), null);
});
