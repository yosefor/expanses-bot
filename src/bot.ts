import { randomInt } from "node:crypto";
import { INVITE_CODE_LENGTH, parseMessage } from "./parse.ts";
import type { ExpenseStore } from "./store.ts";
import { formatSummary } from "./summary.ts";
import type { WhatsAppSender } from "./whatsapp.ts";

export interface IncomingMessage {
  id: string;
  from: string;
  /** Unix epoch seconds, as sent by WhatsApp */
  timestamp: string;
  type: string;
  text?: { body: string };
  /** The sender's WhatsApp profile name (taken from the webhook's contacts, not part of the message). */
  senderName?: string;
}

export interface BotOptions {
  store: ExpenseStore;
  whatsapp: WhatsAppSender;
  allowedNumbers: Set<string>;
  timeZone: string;
  reactionEmoji: string;
  /** The bot's own number (digits only). Used to put a wa.me link in invites. */
  botPhoneNumber?: string;
  /** How long an invite code stays valid. Defaults to 24 hours. */
  inviteTtlMs?: number;
  /** Defaults to Date.now; tests override it. */
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const BARE_CODE = new RegExp(`^\\d{${INVITE_CODE_LENGTH}}$`);

export async function handleMessage(message: IncomingMessage, options: BotOptions): Promise<void> {
  const { store, whatsapp, allowedNumbers, timeZone, reactionEmoji } = options;
  const log = options.log ?? console.log;
  const from = message.from;

  const body = message.type === "text" ? (message.text?.body ?? "") : "";
  const parsed = parseMessage(body);
  // Someone who got an invite may send just the code. Treat 6 bare digits as a code when such an invite exists.
  const bareCode = body.trim();
  const joinCode =
    parsed.kind === "join"
      ? parsed.code
      : BARE_CODE.test(bareCode) && (await store.getInvite(bareCode))
        ? bareCode
        : null;

  // Numbers linked to a shared account can use the bot even if they are not in ALLOWED_NUMBERS,
  // and anyone may try to redeem an invite code.
  const linked = await store.linkedAccount(from);
  const allowed = allowedNumbers.size === 0 || allowedNumbers.has(from) || linked !== null;
  if (!allowed && joinCode === null) {
    log(`Ignoring message from unauthorized number ${from}`);
    return;
  }
  if (!(await store.markProcessed(message.id))) return; // duplicate webhook delivery

  if (joinCode !== null) {
    await join(joinCode, message, linked, options);
    return;
  }

  if (message.type !== "text" || !message.text) {
    await whatsapp.react(from, message.id, "❓");
    return;
  }

  const accountId = linked ?? from;
  switch (parsed.kind) {
    case "expense": {
      const seconds = Number(message.timestamp);
      await store.add(accountId, {
        sender: from,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        messageId: message.id,
        amountCents: parsed.amountCents,
        reason: parsed.reason,
        createdAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
      });
      await whatsapp.react(from, message.id, reactionEmoji);
      return;
    }
    case "summary": {
      for (const chunk of formatSummary(await store.list(accountId), timeZone)) {
        await whatsapp.sendText(from, chunk);
      }
      return;
    }
    case "help": {
      await whatsapp.sendText(from, helpText(linked !== null));
      return;
    }
    case "invite": {
      await invite(accountId, message, options);
      return;
    }
    case "leave": {
      if (!(await store.unlink(from))) {
        await whatsapp.sendText(from, "ℹ️ המספר הזה לא מחובר לחשבון משותף.");
        return;
      }
      const stillAllowed = allowedNumbers.size === 0 || allowedNumbers.has(from);
      await whatsapp.sendText(
        from,
        stillAllowed
          ? "👋 התנתקת מהחשבון המשותף. מעכשיו ההוצאות שלך נרשמות בחשבון אישי.\nההוצאות שכבר נרשמו נשארות בחשבון המשותף."
          : "👋 התנתקת מהחשבון המשותף. ההוצאות שכבר נרשמו נשארות בו.\nכדי לחזור להשתמש בבוט צריך קוד הצטרפות חדש.",
      );
      return;
    }
    case "join":
    case "unknown": {
      await whatsapp.react(from, message.id, "❓");
      return;
    }
  }
}

export function helpText(inSharedAccount: boolean): string {
  return [
    "👋 *בוט ההוצאות*",
    "",
    "*רישום הוצאה*: שלחו סכום ותיאור, למשל:",
    "50 סופר",
    "דלק 250",
    "הבוט מסמן ✅ כשההוצאה נשמרה, ו-❓ כשלא הבין.",
    "",
    "*סיכום*: כל ההוצאות לפי חודשים, עם סה״כ.",
    "",
    "*הוסף משתמש*: קוד הצטרפות לבן/בת משפחה, כדי לרשום הוצאות לאותו חשבון ולראות סיכום משותף.",
    "*הצטרפות 123456*: הצטרפות לחשבון עם קוד שקיבלתם.",
    ...(inSharedAccount ? ["*ניתוק*: יציאה מהחשבון המשותף."] : []),
    "",
    "*עזרה*: ההודעה הזאת.",
  ].join("\n");
}

/** Creates an invite code for the account and sends it, with a message ready to forward. */
async function invite(accountId: string, message: IncomingMessage, options: BotOptions): Promise<void> {
  const { store, whatsapp } = options;
  const now = (options.now ?? Date.now)();

  let code: string | undefined;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = String(randomInt(0, 10 ** INVITE_CODE_LENGTH)).padStart(INVITE_CODE_LENGTH, "0");
    const created = await store.createInvite({
      code: candidate,
      accountId,
      createdBy: message.from,
      ...(message.senderName ? { createdByName: message.senderName } : {}),
      expiresAt: now + (options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS),
    });
    if (created) code = candidate;
  }
  if (!code) throw new Error("Could not allocate an invite code");

  const joinText = `הצטרפות ${code}`;
  await whatsapp.sendText(
    message.from,
    `🔗 קוד הצטרפות: *${code}*\nהקוד בתוקף ל-24 שעות ולשימוש אחד.\n\nהעבירו את ההודעה הבאה למי שמצטרף/ת לחשבון 👇`,
  );

  const lines = [`הזמנה לחשבון ההוצאות ${message.senderName ? `של ${message.senderName}` : "המשותף"} 💸`];
  if (options.botPhoneNumber) {
    lines.push(
      "",
      "לחצו על הקישור ושלחו את ההודעה שתיפתח:",
      `https://wa.me/${options.botPhoneNumber}?text=${encodeURIComponent(joinText)}`,
      "",
      `או שלחו למספר ${formatPhone(options.botPhoneNumber)} את ההודעה:`,
    );
  } else {
    lines.push("", "שלחו לבוט את ההודעה:");
  }
  lines.push(joinText);
  await whatsapp.sendText(message.from, lines.join("\n"));
}

/** Links the sender's number to the account that created the code. */
async function join(code: string, message: IncomingMessage, linked: string | null, options: BotOptions): Promise<void> {
  const { store, whatsapp } = options;
  const log = options.log ?? console.log;
  const from = message.from;
  const now = (options.now ?? Date.now)();

  const invite = await store.getInvite(code);
  if (!invite || invite.expiresAt < now) {
    await whatsapp.sendText(from, "❌ הקוד לא תקין או שפג תוקפו.\nבקשו קוד חדש: שלחו לבוט ״הוסף משתמש״ מהמספר שכבר בחשבון.");
    return;
  }
  if (invite.accountId === (linked ?? from)) {
    await whatsapp.sendText(from, "ℹ️ המספר הזה כבר בחשבון הזה.");
    return;
  }
  if (await store.hasMembers(from)) {
    await whatsapp.sendText(
      from,
      "❌ יש מספרים שמחוברים לחשבון שלך, אז אי אפשר לצרף אותו לחשבון אחר.\nאפשר במקום זה לשלוח ״הוסף משתמש״ ולצרף את המספר השני לחשבון שלך.",
    );
    return;
  }
  if (!(await store.redeemInvite(code, from))) {
    await whatsapp.sendText(from, "❌ הקוד כבר נוצל. בקשו קוד חדש.");
    return;
  }

  // Bring the expenses this number recorded on its own into the shared account.
  const moved = await store.moveExpenses(from, invite.accountId);

  const owner = invite.createdByName ?? formatPhone(invite.createdBy);
  const lines = [
    `✅ הצטרפת לחשבון ההוצאות של ${owner}!`,
    "מעכשיו ההוצאות שלך נרשמות בחשבון המשותף, ו״סיכום״ מציג את ההוצאות של כולם.",
  ];
  if (moved > 0) lines.push(`${moved} הוצאות שרשמת קודם הועברו לחשבון המשותף.`);
  lines.push("", "כדי להתנתק: ״ניתוק״.");
  await whatsapp.sendText(from, lines.join("\n"));

  // Let the inviter know. This can fail if they haven't messaged the bot in the last 24 hours.
  const who = message.senderName ? `${message.senderName} (${formatPhone(from)})` : formatPhone(from);
  await whatsapp
    .sendText(invite.createdBy, `👋 ${who} הצטרף/ה לחשבון ההוצאות שלך.`)
    .catch((error: unknown) => log(`Could not notify ${invite.createdBy} about ${from} joining`, error));
}

/** 972501234567 -> +972 50-123-4567 (Israeli mobiles); other numbers -> +<digits>. */
export function formatPhone(phone: string): string {
  const israeli = /^972(5\d)(\d{3})(\d{4})$/.exec(phone);
  return israeli ? `+972 ${israeli[1]}-${israeli[2]}-${israeli[3]}` : `+${phone}`;
}
