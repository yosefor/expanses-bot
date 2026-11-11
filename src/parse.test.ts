import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessage } from "./parse.ts";

const expense = (amountCents: number, reason: string) => ({ kind: "expense", amountCents, reason });

test("summary command", () => {
  assert.deepEqual(parseMessage("סיכום"), { kind: "summary" });
  assert.deepEqual(parseMessage("  סיכום! "), { kind: "summary" });
  assert.deepEqual(parseMessage("‏סיכום"), { kind: "summary" });
});

test("number then reason", () => {
  assert.deepEqual(parseMessage("50 סופר"), expense(5000, "סופר"));
  assert.deepEqual(parseMessage("12.5 קפה ומאפה"), expense(1250, "קפה ומאפה"));
  assert.deepEqual(parseMessage("50 - דלק"), expense(5000, "דלק"));
});

test("reason then number", () => {
  assert.deepEqual(parseMessage("סופר 50"), expense(5000, "סופר"));
  assert.deepEqual(parseMessage("סופר: 50₪"), expense(5000, "סופר"));
});

test("currency and separators", () => {
  assert.deepEqual(parseMessage("₪120 מסעדה"), expense(12000, "מסעדה"));
  assert.deepEqual(parseMessage("120 ש\"ח מסעדה"), expense(12000, "מסעדה"));
  assert.deepEqual(parseMessage("1,250 שכירות חניה"), expense(125000, "שכירות חניה"));
  assert.deepEqual(parseMessage("1,250,000 דירה"), expense(125000000, "דירה"));
  assert.deepEqual(parseMessage("7,5 במבה"), expense(750, "במבה"));
});

test("prefers number at start/end over numbers in the reason", () => {
  assert.deepEqual(parseMessage("80 על 2 פיצות"), expense(8000, "על 2 פיצות"));
  assert.deepEqual(parseMessage("2 פיצות ב 80"), expense(200, "פיצות ב 80"));
  assert.deepEqual(parseMessage("פיצות 2 ב 80"), expense(8000, "פיצות 2 ב"));
});

test("number only", () => {
  assert.deepEqual(parseMessage("40"), expense(4000, ""));
});

test("unknown", () => {
  assert.deepEqual(parseMessage("שלום"), { kind: "unknown" });
  assert.deepEqual(parseMessage("0 כלום"), { kind: "unknown" });
  assert.deepEqual(parseMessage(""), { kind: "unknown" });
});

test("account commands", () => {
  assert.deepEqual(parseMessage("הוסף משתמש"), { kind: "invite" });
  assert.deepEqual(parseMessage("הוספת  משתמש!"), { kind: "invite" });
  assert.deepEqual(parseMessage("Add User"), { kind: "invite" });
  assert.deepEqual(parseMessage("הצטרפות 012345"), { kind: "join", code: "012345" });
  assert.deepEqual(parseMessage("הצטרפות: 482913"), { kind: "join", code: "482913" });
  assert.deepEqual(parseMessage("JOIN 482913"), { kind: "join", code: "482913" });
  assert.deepEqual(parseMessage("ניתוק"), { kind: "leave" });
  // Not a 6-digit code: still an expense.
  assert.deepEqual(parseMessage("קוד 50"), expense(5000, "קוד"));
});

test("help command", () => {
  for (const text of ["עזרה", "עזרה?", "Help", "?", "תפריט"]) {
    assert.deepEqual(parseMessage(text), { kind: "help" }, text);
  }
});
