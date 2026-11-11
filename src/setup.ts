import { createHash, timingSafeEqual } from "node:crypto";
import { type Env, readEnv } from "./config.ts";

/**
 * Setup page at "/": checks the settings, the WhatsApp token and the webhook, and connects the
 * webhook with one click. Protected with HTTP Basic auth (any user name, password = ADMIN_PASSWORD).
 * Values are never shown, only whether they are set and whether Meta accepts them.
 */

const REQUIRED = [
  ["WHATSAPP_TOKEN", "Permanent access token (System user with whatsapp_business_messaging)"],
  ["WHATSAPP_PHONE_NUMBER_ID", "Phone number ID (WhatsApp → API Setup)"],
  ["WHATSAPP_APP_SECRET", "App secret (App settings → Basic)"],
  ["WHATSAPP_VERIFY_TOKEN", "Any random string, used when Meta verifies the webhook"],
] as const;
const OPTIONAL = [
  ["WHATSAPP_BUSINESS_ACCOUNT_ID", "WhatsApp Business Account ID, lets this page subscribe the app to it"],
  ["ALLOWED_NUMBERS", "Numbers allowed to use the bot. Empty = anyone"],
  ["BOT_PHONE_NUMBER", "The bot's own number, for wa.me links in invites"],
] as const;

export interface SetupOptions {
  env: Env;
  /** Tests replace it. */
  fetch?: typeof fetch;
}

export async function handleSetup(request: Request, options: SetupOptions): Promise<Response> {
  const { env } = options;
  const password = readEnv(env, "ADMIN_PASSWORD");
  if (!password) {
    return html(page("Expenses bot", `<p>The bot is running. Set the <code>ADMIN_PASSWORD</code> secret to open this setup page.</p>`));
  }
  if (!isAuthorized(request.headers.get("authorization"), password)) {
    return new Response("Sign in with any user name and the ADMIN_PASSWORD secret.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Expenses bot setup", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/webhook`;
  // Wrapped: Workers throws "Illegal invocation" when the global fetch is called as a method of another object.
  const graph = new Graph(env, options.fetch ?? ((input, init) => fetch(input, init)));
  let notice = "";

  if (request.method === "POST") {
    // Basic auth credentials are sent on cross-site form posts too, so only accept posts from this page.
    if (request.headers.get("origin") !== url.origin) return new Response("Bad origin", { status: 403 });
    const form = await request.formData();
    if (form.get("action") === "connect") notice = await connectWebhook(graph, env, webhookUrl);
  } else if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }

  return html(page("Expenses bot setup", notice + (await statusSections(graph, env, webhookUrl))));
}

async function statusSections(graph: Graph, env: Env, webhookUrl: string): Promise<string> {
  const missing = REQUIRED.filter(([name]) => !readEnv(env, name));
  const settings = [...REQUIRED, ...OPTIONAL]
    .map(([name, help]) => {
      const set = readEnv(env, name) !== undefined;
      const required = REQUIRED.some(([n]) => n === name);
      return `<li>${mark(set, !required)} <code>${name}</code><br><small>${escape(help)}</small></li>`;
    })
    .join("");

  let sections = `<section><h2>1. Settings</h2><ul>${settings}</ul>
    <p><small>Change these in your Cloudflare dashboard: Workers → this Worker → Settings → Variables and Secrets
    (or in Appflare's app settings).</small></p></section>`;

  if (missing.length > 0) {
    return `${sections}<section><h2>2. WhatsApp</h2><p>Fill in the required settings first.</p></section>`;
  }

  const phoneId = readEnv(env, "WHATSAPP_PHONE_NUMBER_ID")!;
  const phone = await graph.get<{ display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
    `${phoneId}?fields=display_phone_number,verified_name,quality_rating`,
  );
  sections += `<section><h2>2. WhatsApp number</h2>${
    phone.ok
      ? `<p>${mark(true)} ${escape(phone.data.verified_name ?? "")} <code>${escape(phone.data.display_phone_number ?? "")}</code>
         (quality: ${escape(phone.data.quality_rating ?? "unknown")})</p>`
      : `<p>${mark(false)} Meta rejected the token or the phone number ID: ${escape(phone.error)}</p>`
  }</section>`;
  if (!phone.ok) return sections;

  const config = await graph.get<{ webhook_configuration?: Record<string, string> }>(`${phoneId}?fields=webhook_configuration`);
  const levels = config.ok ? (config.data.webhook_configuration ?? {}) : {};
  const targets = Object.entries(levels);
  // Meta uses the most specific override: phone number, then business account, then the app.
  const active = levels.phone_number ?? levels.whatsapp_business_account ?? levels.application;
  const connected = active === webhookUrl;
  const list = targets
    .map(([level, target]) => `<li><code>${escape(level)}</code>: <code>${escape(target)}</code>${target === webhookUrl ? " (this bot)" : ""}</li>`)
    .join("");
  sections += `<section><h2>3. Webhook</h2>
    <p>${mark(connected)} ${connected ? "Messages to this number reach the bot." : "Messages to this number don't reach the bot yet."}</p>
    ${config.ok ? (list ? `<ul>${list}</ul>` : "") : `<p><small>Could not read the webhook settings: ${escape(config.error)}</small></p>`}
    <p>Bot webhook: <code>${escape(webhookUrl)}</code></p>
    <form method="post"><input type="hidden" name="action" value="connect">
    <button>${connected ? "Reconnect" : "Connect"} webhook</button></form>
    <p><small>Points this phone number (only this one) at the bot.${
      readEnv(env, "WHATSAPP_BUSINESS_ACCOUNT_ID") ? " Also subscribes your Meta app to the business account." : ""
    }</small></p></section>`;

  const bot = readEnv(env, "BOT_PHONE_NUMBER")?.replace(/\D/g, "");
  if (connected && bot) {
    sections += `<section><h2>4. Try it</h2><p><a href="https://wa.me/${bot}?text=${encodeURIComponent("עזרה")}">Message the bot</a>
      and send <code>עזרה</code>.</p></section>`;
  }
  return sections;
}

async function connectWebhook(graph: Graph, env: Env, webhookUrl: string): Promise<string> {
  const phoneId = readEnv(env, "WHATSAPP_PHONE_NUMBER_ID");
  const verifyToken = readEnv(env, "WHATSAPP_VERIFY_TOKEN");
  if (!phoneId || !verifyToken || !readEnv(env, "WHATSAPP_TOKEN")) return notice(false, "Fill in the required settings first.");

  const waba = readEnv(env, "WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (waba) {
    // Subscribe only when the app isn't subscribed yet: re-posting to subscribed_apps on an account
    // that other services share could reset its account-level webhook.
    const [app, apps] = await Promise.all([
      graph.get<{ id?: string }>("app"),
      graph.get<{ data?: { whatsapp_business_api_data?: { id?: string } }[] }>(`${waba}/subscribed_apps`),
    ]);
    const appId = app.ok ? app.data.id : undefined;
    const already = apps.ok && appId !== undefined && (apps.data.data ?? []).some((a) => a.whatsapp_business_api_data?.id === appId);
    if (appId && apps.ok && !already) {
      const subscribed = await graph.post(`${waba}/subscribed_apps`, {});
      if (!subscribed.ok) return notice(false, `Could not subscribe the app to the business account: ${subscribed.error}`);
    }
  }
  // Meta calls the webhook (GET with the verify token) before it accepts the override.
  const result = await graph.post(phoneId, {
    webhook_configuration: { override_callback_uri: webhookUrl, verify_token: verifyToken },
  });
  return result.ok ? notice(true, "Webhook connected.") : notice(false, `Meta refused the webhook: ${result.error}`);
}

type GraphResult<T> = { ok: true; data: T } | { ok: false; error: string };

class Graph {
  #base: string;
  #token: string;
  #fetch: typeof fetch;

  constructor(env: Env, fetchImpl: typeof fetch) {
    this.#base = `https://graph.facebook.com/${readEnv(env, "GRAPH_API_VERSION") ?? "v23.0"}/`;
    this.#token = readEnv(env, "WHATSAPP_TOKEN") ?? "";
    this.#fetch = fetchImpl;
  }

  get<T>(path: string): Promise<GraphResult<T>> {
    return this.#call<T>(path, { method: "GET" });
  }

  post<T>(path: string, body: unknown): Promise<GraphResult<T>> {
    return this.#call<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  }

  async #call<T>(path: string, init: RequestInit): Promise<GraphResult<T>> {
    try {
      const response = await this.#fetch(this.#base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.#token}` },
      });
      const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
      if (!response.ok) return { ok: false, error: data.error?.message ?? `HTTP ${response.status}` };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function isAuthorized(header: string | null, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  // Compare hashes so the lengths always match.
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(given), hash(password));
}

function mark(ok: boolean, optional = false): string {
  return ok ? '<span class="ok">✓</span>' : optional ? '<span class="opt">–</span>' : '<span class="bad">✗</span>';
}

function notice(ok: boolean, text: string): string {
  return `<p class="notice ${ok ? "ok" : "bad"}">${escape(text)}</p>`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      "X-Frame-Options": "DENY",
    },
  });
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--ok:#4ade80;--bad:#f87171;--accent:#2dd4bf}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px 12px;margin:16px 0}
h1{font-size:1.4rem}h2{font-size:1.05rem}ul{padding-left:0;list-style:none}li{margin:8px 0}
small{color:var(--muted)}code{font-size:.9em;word-break:break-all}
.ok{color:var(--ok)}.bad{color:var(--bad)}.opt{color:var(--muted)}
.notice{font-weight:600}a{color:var(--accent)}
button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:var(--accent);color:var(--bg);cursor:pointer}
</style></head><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`;
}
