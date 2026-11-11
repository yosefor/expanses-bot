import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, test } from "node:test";
import { handleWebhook, type WebhookOptions } from "./server.ts";
import { MemoryExpenseStore } from "./store.ts";
import { formatSummary } from "./summary.ts";
import type { WhatsAppSender } from "./whatsapp.ts";

const APP_SECRET = "secret";
const ME = "972500000001";
const URL_BASE = "https://bot.example/api/webhook";

type Call = { kind: "react"; to: string; messageId: string; emoji: string } | { kind: "text"; to: string; body: string };
const calls: Call[] = [];
const whatsapp: WhatsAppSender = {
  react: async (to, messageId, emoji) => void calls.push({ kind: "react", to, messageId, emoji }),
  sendText: async (to, body) => void calls.push({ kind: "text", to, body }),
};

const store = new MemoryExpenseStore();
const options: WebhookOptions = {
  store,
  whatsapp,
  allowedNumbers: new Set([ME]),
  timeZone: "Asia/Jerusalem",
  reactionEmoji: "✅",
  verifyToken: "verify-me",
  appSecret: APP_SECRET,
  log: () => {},
};
let seq = 0;

beforeEach(() => {
  calls.length = 0;
});

function payloadFor(from: string, text: string, id = `wamid.${++seq}`, name?: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              ...(name ? { contacts: [{ wa_id: from, profile: { name } }] } : {}),
              messages: [{ id, from, timestamp: "1762800000", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

/** Posts a signed webhook and waits for the background work, like Vercel's waitUntil does. */
async function post(payload: unknown, secret = APP_SECRET, opts: WebhookOptions = options): Promise<number> {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const pending: Promise<unknown>[] = [];
  const response = await handleWebhook(
    new Request(URL_BASE, { method: "POST", headers: { "x-hub-signature-256": signature }, body }),
    opts,
    (p) => pending.push(p),
  );
  await Promise.all(pending);
  return response.status;
}

test("webhook verification handshake", async () => {
  const ok = await handleWebhook(
    new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`),
    options,
    () => {},
  );
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "42");
  const bad = await handleWebhook(
    new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`),
    options,
    () => {},
  );
  assert.equal(bad.status, 403);
});

test("rejects bad signatures", async () => {
  assert.equal(await post(payloadFor(ME, "50 סופר"), "wrong-secret"), 401);
  assert.equal(calls.length, 0);
});

test("expense gets a ✅ reaction and is saved; summary sends totals", async () => {
  const expenseMessage = payloadFor(ME, "50 סופר", "wamid.expense1");
  assert.equal(await post(expenseMessage), 200);
  assert.equal(await post(payloadFor(ME, "דלק 250.5")), 200);
  assert.deepEqual(calls, [
    { kind: "react", to: ME, messageId: "wamid.expense1", emoji: "✅" },
    { kind: "react", to: ME, messageId: `wamid.${seq}`, emoji: "✅" },
  ]);

  // Duplicate delivery of the same message is ignored.
  calls.length = 0;
  await post(expenseMessage);
  assert.equal(calls.length, 0);

  await post(payloadFor(ME, "סיכום"));
  assert.equal(calls.length, 1);
  const summary = calls[0];
  assert.ok(summary?.kind === "text" && summary.body.includes("סופר"));
  assert.ok(summary?.kind === "text" && summary.body.includes("300.5"));
});

test("help lists the commands", async () => {
  await post(payloadFor(ME, "עזרה"));
  assert.equal(calls.length, 1);
  const help = calls[0];
  assert.ok(help?.kind === "text" && help.to === ME, JSON.stringify(help));
  for (const command of ["סיכום", "הוסף משתמש", "הצטרפות"]) assert.ok(help.body.includes(command), command);
  assert.ok(!help.body.includes("ניתוק"), "leave is only shown to linked numbers");
});

test("unparseable text gets ❓", async () => {
  await post(payloadFor(ME, "מה נשמע"));
  assert.equal(calls[0]?.kind === "react" && calls[0].emoji, "❓");
});

test("ignores numbers that are not allowed", async () => {
  await post(payloadFor("972599999999", "50 סופר"));
  assert.equal(calls.length, 0);
  assert.equal((await store.list("972599999999")).length, 0);
});

test("summary splits long lists into several messages", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    messageId: `m${i}`,
    sender: ME,
    amountCents: 1000,
    reason: "הוצאה ארוכה מאוד לבדיקה",
    createdAt: Date.UTC(2026, 10, 1),
  }));
  const chunks = formatSummary(many, "Asia/Jerusalem");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.ok(chunks.at(-1)?.includes("3,000"));
  assert.deepEqual(formatSummary([], "Asia/Jerusalem"), ["אין הוצאות עדיין 🤷"]);
});

test("two numbers share one account through an invite code", async () => {
  const OWNER = "972500000010";
  const SPOUSE = "972500000020";
  const STRANGER = "972500000030";
  let now = 1_000_000;
  const shared: WebhookOptions = { ...options, store: new MemoryExpenseStore(), allowedNumbers: new Set([OWNER]), botPhoneNumber: "972500000099", now: () => now };
  const send = (from: string, text: string, name?: string) => post(payloadFor(from, text, undefined, name), APP_SECRET, shared);
  const texts = (to: string) => calls.flatMap((c) => (c.kind === "text" && c.to === to ? [c.body] : []));

  // Not allowed yet.
  await send(SPOUSE, "50 סופר");
  assert.equal(calls.length, 0);

  await send(OWNER, "100 דלק", "יוסי");
  await send(OWNER, "הוסף משתמש", "יוסי");
  const [codeMessage, forward] = texts(OWNER);
  const code = /\*(\d{6})\*/.exec(codeMessage ?? "")?.[1];
  assert.ok(code, codeMessage);
  assert.ok(forward?.includes(`הצטרפות ${code}`));
  assert.ok(forward?.includes(`https://wa.me/972500000099?text=${encodeURIComponent(`הצטרפות ${code}`)}`));
  assert.ok(forward?.includes("של יוסי"));

  calls.length = 0;
  await send(SPOUSE, `הצטרפות ${code}`, "רחל");
  assert.ok(texts(SPOUSE)[0]?.includes("הצטרפת לחשבון ההוצאות של יוסי"));
  assert.ok(texts(OWNER)[0]?.includes("רחל"));

  // The code is single use.
  calls.length = 0;
  await send(STRANGER, `הצטרפות ${code}`);
  assert.ok(texts(STRANGER)[0]?.includes("לא תקין"));

  // Both numbers record into, and summarize, the same account.
  calls.length = 0;
  await send(SPOUSE, "30 קפה", "רחל");
  assert.equal(calls[0]?.kind === "react" && calls[0].emoji, "✅");
  calls.length = 0;
  await send(SPOUSE, "סיכום", "רחל");
  const summary = texts(SPOUSE).join("\n");
  assert.ok(summary.includes("חשבון משותף"), summary);
  assert.ok(summary.includes("דלק") && summary.includes("קפה"), summary);
  assert.ok(summary.includes("יוסי: 100 ₪") && summary.includes("רחל: 30 ₪"), summary);
  assert.ok(summary.includes("130"), summary);

  // Leaving: the spouse is no longer allowed, the shared expenses stay.
  calls.length = 0;
  await send(SPOUSE, "ניתוק", "רחל");
  assert.ok(texts(SPOUSE)[0]?.includes("התנתקת"));
  calls.length = 0;
  await send(SPOUSE, "20 לחם");
  assert.equal(calls.length, 0);
  assert.equal((await shared.store.list(OWNER)).length, 2);

  // Joining with just the code works too, and own expenses move into the shared account.
  await send(OWNER, "הזמנה");
  const code2 = /\*(\d{6})\*/.exec(texts(OWNER).at(-2) ?? "")?.[1];
  assert.ok(code2);
  await shared.store.add(STRANGER, { sender: STRANGER, messageId: "old", amountCents: 900, reason: "ישן", createdAt: 1 });
  calls.length = 0;
  await send(STRANGER, code2);
  assert.ok(texts(STRANGER)[0]?.includes("1 הוצאות שרשמת קודם הועברו"));
  assert.equal((await shared.store.list(OWNER)).length, 3);

  // Expired codes are refused.
  await send(OWNER, "הוסף משתמש");
  const code3 = /\*(\d{6})\*/.exec(texts(OWNER).at(-2) ?? "")?.[1];
  now += 25 * 60 * 60 * 1000;
  calls.length = 0;
  await send(SPOUSE, `הצטרפות ${code3}`);
  assert.ok(texts(SPOUSE)[0]?.includes("פג תוקפו"));
});

test("a number that has members cannot join another account", async () => {
  const A = "972500000110";
  const B = "972500000120";
  const C = "972500000130";
  const opts: WebhookOptions = { ...options, store: new MemoryExpenseStore(), allowedNumbers: new Set([A, B]) };
  const send = (from: string, text: string) => post(payloadFor(from, text), APP_SECRET, opts);
  const lastCode = (to: string) =>
    calls.flatMap((c) => (c.kind === "text" && c.to === to ? [/\*(\d{6})\*/.exec(c.body)?.[1]] : [])).filter(Boolean).at(-1);

  await send(B, "הוסף משתמש");
  await send(C, `הצטרפות ${lastCode(B)}`);
  await send(A, "הוסף משתמש");
  const codeA = lastCode(A);
  calls.length = 0;
  await send(B, `הצטרפות ${codeA}`);
  assert.ok(calls.some((c) => c.kind === "text" && c.to === B && c.body.includes("אי אפשר")));

  // Joining your own account is a no-op.
  await send(A, "הוסף משתמש");
  const ownCode = lastCode(A);
  calls.length = 0;
  await send(A, `הצטרפות ${ownCode}`);
  assert.ok(calls.some((c) => c.kind === "text" && c.to === A && c.body.includes("כבר בחשבון")));
});
