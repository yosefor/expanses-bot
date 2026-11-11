import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, readEnv, requireEnv } from "./config.ts";
import { FirestoreExpenseStore } from "./firestore-store.ts";
import type { WebhookOptions } from "./server.ts";
import { WhatsAppClient } from "./whatsapp.ts";

/** Wires the bot on Node (Vercel, Docker, Cloud Run) with Firestore storage. Cloudflare uses src/worker.ts. */
export function createBotFromEnv(): WebhookOptions {
  const config = loadConfig(process.env);
  const serviceAccount = parseServiceAccount(readEnv(process.env, "FIREBASE_SERVICE_ACCOUNT"));

  // FIREBASE_SERVICE_ACCOUNT (Vercel) or Application Default Credentials
  // (GOOGLE_APPLICATION_CREDENTIALS locally, automatic on Cloud Run).
  const firebase =
    getApps()[0] ??
    initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      projectId: requireEnv(process.env, "FIREBASE_PROJECT_ID"),
    });

  if (config.allowedNumbers.size === 0) {
    console.warn("⚠️  ALLOWED_NUMBERS is empty: anyone who messages the bot can record expenses.");
  }

  return {
    store: new FirestoreExpenseStore(getFirestore(firebase)),
    whatsapp: new WhatsAppClient({
      token: config.token,
      phoneNumberId: config.phoneNumberId,
      apiVersion: config.apiVersion,
    }),
    allowedNumbers: config.allowedNumbers,
    timeZone: config.timeZone,
    reactionEmoji: config.reactionEmoji,
    ...(config.botPhoneNumber ? { botPhoneNumber: config.botPhoneNumber } : {}),
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
    log: (message, error) => (error === undefined ? console.log(message) : console.error(message, error)),
  };
}

/** Service account key as JSON or base64 JSON. */
function parseServiceAccount(raw: string | undefined): ServiceAccount | undefined {
  if (!raw) return undefined;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json) as ServiceAccount;
}
