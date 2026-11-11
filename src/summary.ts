import type { Expense } from "./store.ts";

/** WhatsApp text messages are capped at 4096 characters; leave some headroom. */
const MAX_MESSAGE_LENGTH = 3800;

export function formatAmount(cents: number): string {
  return new Intl.NumberFormat("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
}

/** Builds the summary text, split into as many WhatsApp messages as needed. */
export function formatSummary(expenses: Expense[], timeZone: string): string[] {
  if (expenses.length === 0) return ["אין הוצאות עדיין 🤷"];

  const monthFormat = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone });
  const dayFormat = new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", timeZone });

  const months = new Map<string, Expense[]>();
  for (const expense of expenses) {
    const month = monthFormat.format(expense.createdAt);
    const bucket = months.get(month) ?? [];
    bucket.push(expense);
    months.set(month, bucket);
  }

  // In a shared account, say who spent what.
  const names = senderNames(expenses);
  const shared = names.size > 1;

  const lines: string[] = [shared ? "📊 *סיכום הוצאות — חשבון משותף*" : "📊 *סיכום הוצאות*"];
  for (const [month, items] of months) {
    const subtotal = items.reduce((sum, e) => sum + e.amountCents, 0);
    lines.push("", `*${month}* — ${formatAmount(subtotal)} ₪`);
    for (const e of items) {
      const who = shared ? ` · ${names.get(e.sender)}` : "";
      lines.push(`${dayFormat.format(e.createdAt)} · ${formatAmount(e.amountCents)} ₪ · ${e.reason || "ללא פירוט"}${who}`);
    }
  }

  const total = expenses.reduce((sum, e) => sum + e.amountCents, 0);
  lines.push("", "━━━━━━━━━━");
  if (shared) {
    for (const [sender, name] of names) {
      const own = expenses.filter((e) => e.sender === sender);
      const sum = own.reduce((acc, e) => acc + e.amountCents, 0);
      lines.push(`${name}: ${formatAmount(sum)} ₪ (${own.length})`);
    }
  }
  lines.push(`*סה״כ: ${formatAmount(total)} ₪* (${expenses.length} הוצאות)`);

  return chunkLines(lines, MAX_MESSAGE_LENGTH);
}

/** A display name per sender, in order of first expense: the latest WhatsApp name, else the end of the number. */
function senderNames(expenses: Expense[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of expenses) {
    if (e.senderName) names.set(e.sender, e.senderName);
    else if (!names.has(e.sender)) names.set(e.sender, `…${e.sender.slice(-4)}`);
  }
  return names;
}

function chunkLines(lines: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
