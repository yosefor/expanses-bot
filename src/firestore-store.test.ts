import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreExpenseStore } from "./firestore-store.ts";

// Runs only against the Firestore emulator: `npm run test:firestore`.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;

test("Firestore store", { skip: !emulator && "FIRESTORE_EMULATOR_HOST not set" }, async () => {
  const app = initializeApp({ projectId: "demo-expenses" }, `test-${Date.now()}`);
  after(() => deleteApp(app));
  const store = new FirestoreExpenseStore(getFirestore(app));
  const sender = `9725${Date.now()}`;

  // Real WhatsApp ids are base64 and can contain "/".
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
  const code = String(Date.now()).slice(-6);
  const invite = { code, accountId: sender, createdBy: sender, createdByName: "יוסי", expiresAt: 5_000 };
  assert.equal(await store.createInvite(invite), true);
  assert.equal(await store.createInvite(invite), false);
  assert.deepEqual(await store.getInvite(code), invite);

  await store.add(member, { sender: member, messageId: "m1", amountCents: 700, reason: "קפה", createdAt: 3_000 });
  assert.equal(await store.linkedAccount(member), null);
  assert.equal(await store.hasMembers(sender), false);
  assert.equal(await store.redeemInvite(code, member), true);
  assert.equal(await store.redeemInvite(code, member), false);
  assert.equal(await store.getInvite(code), null);
  assert.equal(await store.linkedAccount(member), sender);
  assert.equal(await store.hasMembers(sender), true);

  assert.equal(await store.moveExpenses(member, sender), 1);
  assert.deepEqual(await store.list(member), []);
  assert.equal((await store.list(sender)).at(-1)?.sender, member);

  assert.equal(await store.unlink(member), true);
  assert.equal(await store.unlink(member), false);
  assert.equal(await store.linkedAccount(member), null);
});
