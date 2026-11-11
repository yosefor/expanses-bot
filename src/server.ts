import { createHmac, timingSafeEqual } from "node:crypto";
import { type BotOptions, handleMessage, type IncomingMessage } from "./bot.ts";

export interface WebhookOptions extends BotOptions {
  verifyToken: string;
  appSecret: string;
}

/** Keeps the runtime alive for work that continues after the response is sent. */
export type WaitUntil = (promise: Promise<unknown>) => void;

interface WebhookPayload {
  entry?: {
    changes?: {
      field?: string;
      value?: { messages?: IncomingMessage[]; contacts?: { wa_id?: string; profile?: { name?: string } }[] };
    }[];
  }[];
}

const MAX_BODY_BYTES = 1024 * 1024;

export function isValidSignature(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const received = Buffer.from(header.slice("sha256=".length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Meta's webhook verification: GET with hub.verify_token, answered with hub.challenge. */
export function verifyHandshake(request: Request, verifyToken: string | undefined): Response {
  const params = new URL(request.url).searchParams;
  const ok = !!verifyToken && params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === verifyToken;
  return ok ? new Response(params.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
}

/**
 * WhatsApp Cloud API webhook as a standard fetch handler (works on Vercel, Node, anything).
 * GET = Meta's verification handshake, POST = incoming messages.
 */
export async function handleWebhook(request: Request, options: WebhookOptions, waitUntil: WaitUntil): Promise<Response> {
  const log = options.log ?? console.log;

  if (request.method === "GET") return verifyHandshake(request, options.verifyToken);

  if (request.method !== "POST") return new Response(null, { status: 405 });

  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  if (!isValidSignature(body, request.headers.get("x-hub-signature-256"), options.appSecret)) {
    log("Rejected webhook with invalid signature");
    return new Response(null, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body.toString("utf8")) as WebhookPayload;
  } catch {
    return new Response(null, { status: 400 });
  }

  const messages = (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .filter((change) => change.field === "messages")
    .flatMap((change) => {
      const names = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name?.trim()]));
      return (change.value?.messages ?? []).map((m): IncomingMessage => {
        const senderName = names.get(m.from);
        return senderName ? { ...m, senderName } : m;
      });
    });

  // Acknowledge immediately (Meta retries slow webhooks) and finish the work in the background.
  for (const message of messages) {
    waitUntil(handleMessage(message, options).catch((error: unknown) => log(`Failed to handle message ${message.id}`, error)));
  }
  return new Response(null, { status: 200 });
}
