export type ParsedMessage =
  | { kind: "summary" }
  | { kind: "help" }
  | { kind: "invite" }
  | { kind: "join"; code: string }
  | { kind: "leave" }
  | { kind: "expense"; amountCents: number; reason: string }
  | { kind: "unknown" };

/** Invite codes are this many digits. */
export const INVITE_CODE_LENGTH = 6;

const SUMMARY_COMMANDS = new Set(["סיכום"]);
const HELP_COMMANDS = new Set(["עזרה", "הוראות", "תפריט", "פקודות", "help", "?", "？"]);
const INVITE_COMMANDS = new Set([
  "הוסף משתמש",
  "הוספת משתמש",
  "הוסיפי משתמש",
  "הוסף",
  "הזמן",
  "הזמנה",
  "שיתוף",
  "add user",
  "invite",
]);
const LEAVE_COMMANDS = new Set(["ניתוק", "התנתק", "התנתקות", "leave"]);
const JOIN_COMMAND = new RegExp(
  String.raw`^(?:הצטרפות|הצטרף|הצטרפי|קוד|join|code)\s*:?\s*(\d{${INVITE_CODE_LENGTH}})$`,
  "i",
);

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const LEADING_NUMBER = new RegExp(`^${NUMBER}`);
const TRAILING_NUMBER = new RegExp(`${NUMBER}$`);
const ANY_NUMBER = new RegExp(NUMBER);

const CURRENCY = /₪|ש["״']?ח|שקלים|שקל|\bnis\b|\bils\b/gi;
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;
// A comma between digits that is followed by exactly 3 digits is a thousands separator: 1,250 / 1,250,000
const THOUSANDS_SEPARATOR = /(?<=\d),(?=\d{3}(?!\d))/g;

/**
 * Parses an incoming message.
 * - "סיכום" -> summary
 * - "עזרה" -> help
 * - "הוסף משתמש" -> invite (create a code another number can use to join this account)
 * - "הצטרפות 123456" -> join the account that created the code
 * - "ניתוק" -> leave a shared account
 * - "50 סופר", "סופר 50", "קפה 12.5 ₪", "1,250 שכירות" -> expense
 * The amount is the number at the start of the message, else at the end, else the first number.
 */
export function parseMessage(text: string): ParsedMessage {
  const cleaned = text.replace(DIRECTION_MARKS, "").trim();

  if (HELP_COMMANDS.has(cleaned)) return { kind: "help" };
  const command = cleaned.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (SUMMARY_COMMANDS.has(command)) return { kind: "summary" };
  if (HELP_COMMANDS.has(command)) return { kind: "help" };
  if (INVITE_COMMANDS.has(command)) return { kind: "invite" };
  if (LEAVE_COMMANDS.has(command)) return { kind: "leave" };
  const join = JOIN_COMMAND.exec(command);
  if (join?.[1]) return { kind: "join", code: join[1] };

  // Currency signs are noise both around the number and inside the reason.
  const normalized = cleaned.replace(THOUSANDS_SEPARATOR, "").replace(CURRENCY, " ").replace(/\s+/g, " ").trim();

  const match =
    LEADING_NUMBER.exec(normalized) ?? TRAILING_NUMBER.exec(normalized) ?? ANY_NUMBER.exec(normalized);
  if (!match) return { kind: "unknown" };

  const amountCents = Math.round(Number.parseFloat(match[0].replace(",", ".")) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { kind: "unknown" };

  const reason = (normalized.slice(0, match.index) + " " + normalized.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,]+$/g, "")
    .trim();

  return { kind: "expense", amountCents, reason };
}
