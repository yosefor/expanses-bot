// Cloudflare Workers entry point (wrangler.jsonc). Storage is D1; see migrations/.
import { type Config, type Env, loadConfig } from "./config.ts";
import { type D1Database, D1ExpenseStore } from "./d1-store.ts";
import { handleWebhook, type WebhookOptions } from "./server.ts";
import { handleSetup } from "./setup.ts";
import { WhatsAppClient } from "./whatsapp.ts";

interface WorkerEnv extends Env {
  DB: D1Database;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Webhook retries arrive within minutes, so a month of dedupe records is plenty. */
const PROCESSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function botOptions(env: WorkerEnv, config: Config): WebhookOptions {
  return {
    store: new D1ExpenseStore(env.DB),
    whatsapp: new WhatsAppClient({ token: config.token, phoneNumberId: config.phoneNumberId, apiVersion: config.apiVersion }),
    allowedNumbers: config.allowedNumbers,
    timeZone: config.timeZone,
    reactionEmoji: config.reactionEmoji,
    ...(config.botPhoneNumber ? { botPhoneNumber: config.botPhoneNumber } : {}),
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
    log: (message, error) => (error === undefined ? console.log(message) : console.error(message, error)),
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/webhook" || pathname === "/api/webhook") {
      let config: Config;
      try {
        config = loadConfig(env);
      } catch (error) {
        console.error(error);
        return new Response("The bot is not configured yet. Open / to finish the setup.", { status: 503 });
      }
      return handleWebhook(request, botOptions(env, config), (promise) => ctx.waitUntil(promise));
    }
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/" || pathname === "/setup") return handleSetup(request, { env });
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(new D1ExpenseStore(env.DB).cleanup(PROCESSED_TTL_MS));
  },
};
