// Cloudflare Workers entry point (wrangler.jsonc). Storage is D1; see migrations/.
import { type Config, type Env, loadConfig, readEnv } from "./config.ts";
import { type D1Database, D1ExpenseStore } from "./d1-store.ts";
import { installPage, privacyPage } from "./pages.ts";
import { handleWebhook, verifyHandshake, type WebhookOptions } from "./server.ts";
import { LAST_WEBHOOK_AT, SettingsStore } from "./settings.ts";
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
/** How often the "last message received" time is written (it is only shown on the setup page). */
const LAST_WEBHOOK_EVERY_MS = 60 * 60 * 1000;

function botOptions(store: D1ExpenseStore, config: Config): WebhookOptions {
  return {
    store,
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
    const settings = new SettingsStore(env.DB);

    if (pathname === "/webhook" || pathname === "/api/webhook") {
      // Verification comes right after the verify token is saved, so read the settings fresh.
      if (request.method === "GET") {
        return verifyHandshake(request, readEnv(await settings.effectiveEnv(env, true), "WHATSAPP_VERIFY_TOKEN"));
      }
      const effective = await settings.effectiveEnv(env);
      let config: Config;
      try {
        config = loadConfig(effective);
      } catch (error) {
        console.error(error);
        return new Response("The bot is not configured yet. Open / to finish the setup.", { status: 503 });
      }
      const response = await handleWebhook(request, botOptions(new D1ExpenseStore(env.DB), config), (p) => ctx.waitUntil(p));
      // A signed webhook got through: the setup page shows this as the final check.
      const last = Number(readEnv(effective, LAST_WEBHOOK_AT) ?? 0);
      if (response.status === 200 && Date.now() - last > LAST_WEBHOOK_EVERY_MS) {
        ctx.waitUntil(settings.save({ [LAST_WEBHOOK_AT]: String(Date.now()) }));
      }
      return response;
    }
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/install") return installPage();
    if (pathname === "/privacy") return privacyPage(new URL(request.url).origin);
    if (pathname === "/" || pathname === "/setup") {
      return handleSetup(request, { env: await settings.effectiveEnv(env), save: (values) => settings.save(values) });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(new D1ExpenseStore(env.DB).cleanup(PROCESSED_TTL_MS));
  },
};
