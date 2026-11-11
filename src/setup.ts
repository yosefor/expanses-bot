import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Env, parseNumbers, readEnv } from "./config.ts";
import { escape, html, page } from "./html.ts";
import { LAST_WEBHOOK_AT } from "./settings.ts";

/**
 * Setup wizard at "/" (Hebrew): the owner pastes the Meta details into a form (saved in D1),
 * each one is checked with Meta, and one click each registers the number and connects the webhook.
 * Protected with HTTP Basic auth (any user name, password = ADMIN_PASSWORD).
 * Secret values are never shown, only whether they are set and whether Meta accepts them.
 */

const TEXT_FIELDS = ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "ALLOWED_NUMBERS"] as const;
const SECRET_FIELDS = ["WHATSAPP_APP_SECRET", "WHATSAPP_TOKEN"] as const;
const REQUIRED = ["WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID"] as const;

export interface SetupOptions {
  /** The Worker environment with saved settings on top. */
  env: Env;
  /** Saves settings (D1). Without it the form is read-only. */
  save?: (values: Record<string, string>) => Promise<void>;
  /** Tests replace these. */
  fetch?: typeof fetch;
  now?: () => number;
}

export async function handleSetup(request: Request, options: SetupOptions): Promise<Response> {
  const { env } = options;
  const password = readEnv(env, "ADMIN_PASSWORD");
  if (!password) {
    return html(page("בוט ההוצאות", `<p>הבוט רץ. כדי לפתוח את דף ההגדרות, הגדירו את הסוד <code>ADMIN_PASSWORD</code> ב-Cloudflare.</p>`));
  }
  if (!isAuthorized(request.headers.get("authorization"), password)) {
    return new Response("Sign in with any user name and your bot's password (ADMIN_PASSWORD).", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Expenses bot setup", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);
  const origin = url.origin;
  // Wrapped: Workers throws "Illegal invocation" when the global fetch is called as a method of another object.
  const graph = new Graph(env, options.fetch ?? ((input, init) => fetch(input, init)));
  let notice = "";

  if (request.method === "POST") {
    // Basic auth credentials are sent on cross-site form posts too, so only accept posts from this page.
    if (request.headers.get("origin") !== origin) return new Response("Bad origin", { status: 403 });
    const form = await request.formData();
    const action = form.get("action");
    if (action === "save") {
      if (!options.save) return new Response("Saving is not available here", { status: 405 });
      await saveSettings(form, env, graph, options.save);
      return Response.redirect(`${origin}/?saved=1`, 303);
    }
    if (action === "register") notice = await registerNumber(graph, env, String(form.get("pin") ?? ""));
    if (action === "connect") notice = await connectWebhook(graph, env, `${origin}/webhook`);
  } else if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  if (url.searchParams.get("saved")) notice ||= message(true, "נשמר.");

  return html(page("הגדרת בוט ההוצאות", notice + (await wizard(graph, env, origin, options))));
}

// ---------------------------------------------------------------------------------------------
// Actions

async function saveSettings(form: FormData, env: Env, graph: Graph, save: (values: Record<string, string>) => Promise<void>) {
  const values: Record<string, string> = {};
  for (const name of TEXT_FIELDS) values[name] = String(form.get(name) ?? "").trim();
  values.ALLOWED_NUMBERS = [...parseNumbers(values.ALLOWED_NUMBERS?.replace(/(^|,)\s*0/g, "$1972"))].join(",");
  // Empty secret fields keep the saved value.
  for (const name of SECRET_FIELDS) {
    const value = String(form.get(name) ?? "").trim();
    if (value) values[name] = value;
  }
  if (!readEnv(env, "WHATSAPP_VERIFY_TOKEN")) values.WHATSAPP_VERIFY_TOKEN = randomBytes(16).toString("hex");

  // The bot's own number (for wa.me links in invites) comes from Meta.
  const next = new Graph({ ...env, ...values }, graph.fetchImpl);
  const phoneId = values.WHATSAPP_PHONE_NUMBER_ID;
  if (phoneId) {
    const phone = await next.get<{ display_phone_number?: string }>(`${phoneId}?fields=display_phone_number`);
    if (phone.ok && phone.data.display_phone_number) values.BOT_PHONE_NUMBER = phone.data.display_phone_number.replace(/\D/g, "");
  }
  await save(values);
}

async function registerNumber(graph: Graph, env: Env, pin: string): Promise<string> {
  const phoneId = readEnv(env, "WHATSAPP_PHONE_NUMBER_ID");
  if (!phoneId) return message(false, "קודם ממלאים את הפרטים בשלב 1.");
  if (!/^\d{6}$/.test(pin.trim())) return message(false, "הקוד צריך להיות 6 ספרות.");
  const result = await graph.post(`${phoneId}/register`, { messaging_product: "whatsapp", pin: pin.trim() });
  return result.ok ? message(true, "המספר הופעל.") : message(false, `Meta לא הפעילה את המספר: ${result.error}`);
}

async function connectWebhook(graph: Graph, env: Env, webhookUrl: string): Promise<string> {
  const phoneId = readEnv(env, "WHATSAPP_PHONE_NUMBER_ID");
  const verifyToken = readEnv(env, "WHATSAPP_VERIFY_TOKEN");
  const secret = readEnv(env, "WHATSAPP_APP_SECRET");
  if (!phoneId || !verifyToken || !secret || !readEnv(env, "WHATSAPP_TOKEN")) return message(false, "קודם ממלאים את הפרטים בשלב 1.");

  const app = await graph.get<{ id?: string }>("app");
  if (!app.ok || !app.data.id) return message(false, `Meta לא מכירה את הטוקן: ${app.ok ? "no app" : app.error}`);
  const appToken = `${app.data.id}|${secret}`;

  // 1. A new app has no WhatsApp webhook yet: point the app's webhook at the bot.
  //    An app that already has one (shared with other services) keeps it, and only this number is redirected (step 3).
  const subs = await graph.get<{ data?: { object?: string; callback_url?: string }[] }>(`${app.data.id}/subscriptions`, appToken);
  if (!subs.ok) return message(false, `ה-App secret לא נכון: ${subs.error}`);
  const existing = (subs.data.data ?? []).find((s) => s.object === "whatsapp_business_account");
  if (!existing) {
    const created = await graph.post(
      `${app.data.id}/subscriptions`,
      { object: "whatsapp_business_account", callback_url: webhookUrl, verify_token: verifyToken, fields: "messages" },
      appToken,
    );
    if (!created.ok) return message(false, `Meta סירבה לחבר את הבוט: ${created.error}`);
  }

  // 2. Subscribe the app to the business account, only when it isn't subscribed yet: re-posting to
  //    subscribed_apps on an account that other services share could reset its account-level webhook.
  const waba = readEnv(env, "WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (waba) {
    const apps = await graph.get<{ data?: { whatsapp_business_api_data?: { id?: string } }[] }>(`${waba}/subscribed_apps`);
    const already = apps.ok && (apps.data.data ?? []).some((a) => a.whatsapp_business_api_data?.id === app.data.id);
    if (apps.ok && !already) {
      const subscribed = await graph.post(`${waba}/subscribed_apps`, {});
      if (!subscribed.ok) return message(false, `לא הצלחתי לחבר את האפליקציה לחשבון ה-WhatsApp: ${subscribed.error}`);
    }
  }

  // 3. If messages to this number still go somewhere else, redirect only this number.
  const config = await graph.get<{ webhook_configuration?: Record<string, string> }>(`${phoneId}?fields=webhook_configuration`);
  if (!config.ok || activeWebhook(config.data.webhook_configuration) !== webhookUrl) {
    // Meta calls the webhook (GET with the verify token) before it accepts the override.
    const result = await graph.post(phoneId, { webhook_configuration: { override_callback_uri: webhookUrl, verify_token: verifyToken } });
    if (!result.ok) return message(false, `Meta סירבה לחבר את הבוט: ${result.error}`);
  }
  return message(true, "הבוט מחובר ל-WhatsApp.");
}

/** Meta uses the most specific webhook: phone number, then business account, then the app. */
function activeWebhook(levels: Record<string, string> | undefined): string | undefined {
  return levels?.phone_number ?? levels?.whatsapp_business_account ?? levels?.application;
}

// ---------------------------------------------------------------------------------------------
// The wizard

interface Phone {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  platform_type?: string;
  status?: string;
  code_verification_status?: string;
}

async function wizard(graph: Graph, env: Env, origin: string, options: SetupOptions): Promise<string> {
  const webhookUrl = `${origin}/webhook`;
  const phoneId = readEnv(env, "WHATSAPP_PHONE_NUMBER_ID");
  const waba = readEnv(env, "WHATSAPP_BUSINESS_ACCOUNT_ID");
  const secret = readEnv(env, "WHATSAPP_APP_SECRET");
  const filled = REQUIRED.every((name) => readEnv(env, name));

  // Ask Meta about everything that is filled in.
  const app = readEnv(env, "WHATSAPP_TOKEN") ? await graph.get<{ id?: string; name?: string }>("app") : undefined;
  const appId = app?.ok ? app.data.id : undefined;
  const [subs, phone, account, config] = await Promise.all([
    appId && secret ? graph.get(`${appId}/subscriptions`, `${appId}|${secret}`) : undefined,
    phoneId && app?.ok
      ? graph.get<Phone>(`${phoneId}?fields=display_phone_number,verified_name,quality_rating,platform_type,status,code_verification_status`)
      : undefined,
    waba && app?.ok ? graph.get<{ name?: string }>(`${waba}?fields=name`) : undefined,
    phoneId && app?.ok ? graph.get<{ webhook_configuration?: Record<string, string> }>(`${phoneId}?fields=webhook_configuration`) : undefined,
  ]);

  // Step 1: details
  const checks = [
    check("טוקן", !!readEnv(env, "WHATSAPP_TOKEN"), app, app?.ok ? `אפליקציה: ${app.data.name ?? app.data.id}` : undefined),
    check("App secret", !!secret, subs, "תקין"),
    check("מספר הטלפון", !!phoneId, phone, phone?.ok ? `${phone.data.verified_name ?? ""} ${phone.data.display_phone_number ?? ""}` : undefined),
    check("חשבון WhatsApp Business", !!waba, account, account?.ok ? (account.data.name ?? "") : undefined, true),
  ].join("");
  const step1Done = filled && !!app?.ok && !!subs?.ok && !!phone?.ok;
  const allowed = readEnv(env, "ALLOWED_NUMBERS");
  const form = options.save
    ? `<form method="post"><input type="hidden" name="action" value="save">
      ${input("WHATSAPP_PHONE_NUMBER_ID", "Phone number ID", env)}
      ${input("WHATSAPP_BUSINESS_ACCOUNT_ID", "WhatsApp Business Account ID", env)}
      ${secretInput("WHATSAPP_APP_SECRET", "App secret", env)}
      ${secretInput("WHATSAPP_TOKEN", "טוקן קבוע (Access token)", env)}
      <label for="ALLOWED_NUMBERS">מי יכול להשתמש בבוט</label>
      <input id="ALLOWED_NUMBERS" name="ALLOWED_NUMBERS" class="ltr" placeholder="050-1234567, 052-7654321" value="${escape(allowed ?? "")}">
      <small>המספרים שלכם ושל בני המשפחה, מופרדים בפסיק. מי שמצטרף עם קוד הזמנה מורשה גם הוא.
      ${allowed ? "" : '<span class="bad">כרגע ריק: כל מי שישלח הודעה לבוט יוכל להשתמש בו.</span>'}</small><br>
      <button>שמירה ובדיקה</button></form>`
    : `<p class="muted">את הפרטים האלה משנים ב-Cloudflare: Workers ← הבוט ← Settings ← Variables and Secrets.</p>`;
  let out = section(1, "פרטי החיבור מ-Meta", step1Done, `<ul>${checks}</ul>${form}${META_GUIDE}`);

  // Step 2: register the number
  const p = phone?.ok ? phone.data : undefined;
  const registered = p?.platform_type === "CLOUD_API" && p.status === "CONNECTED";
  out += section(
    2,
    "הפעלת המספר",
    registered,
    registered
      ? `<p>המספר פעיל (דירוג איכות: ${escape(p?.quality_rating ?? "לא ידוע")}).</p>`
      : !step1Done
        ? `<p class="muted">אחרי שלב 1.</p>`
        : `<p>בחרו קוד סודי בן 6 ספרות. זה קוד האימות הדו-שלבי של המספר. שמרו אותו, Meta תבקש אותו אם תעבירו את המספר.</p>
          ${p?.code_verification_status && p.code_verification_status !== "VERIFIED" && p.code_verification_status !== "EXPIRED" ? '<p class="bad">קודם צריך לאמת את המספר ב-Meta (בקוד SMS או בשיחה), ב-WhatsApp ← API Setup.</p>' : ""}
          <form method="post"><input type="hidden" name="action" value="register">
          <label for="pin">קוד בן 6 ספרות</label><input id="pin" name="pin" class="ltr" inputmode="numeric" pattern="\\d{6}" maxlength="6" required>
          <button>הפעלת המספר</button></form>`,
  );

  // Step 3: webhook
  const active = config?.ok ? activeWebhook(config.data.webhook_configuration) : undefined;
  const connected = active === webhookUrl;
  out += section(
    3,
    "חיבור הבוט ל-WhatsApp",
    connected,
    !step1Done
      ? `<p class="muted">אחרי שלב 1.</p>`
      : `<p>${connected ? "הודעות למספר מגיעות לבוט." : "הודעות למספר עוד לא מגיעות לבוט."}</p>
        <form method="post"><input type="hidden" name="action" value="connect"><button>${connected ? "חיבור מחדש" : "חיבור"}</button></form>
        <details><summary>פרטים טכניים</summary><p>כתובת הבוט: <code>${escape(webhookUrl)}</code></p>
        ${active ? `<p>ההודעות מגיעות עכשיו אל: <code>${escape(active)}</code></p>` : ""}</details>`,
  );

  // Step 4: live mode. Messages from real numbers only arrive once the app is Live.
  const lastWebhook = Number(readEnv(env, LAST_WEBHOOK_AT) ?? 0);
  const appSettings = appId ? `https://developers.facebook.com/apps/${encodeURIComponent(appId)}/settings/basic/` : "https://developers.facebook.com/apps";
  out += section(
    4,
    "העברת האפליקציה למצב Live",
    lastWebhook > 0,
    `<p>Meta מעבירה לבוט הודעות אמיתיות רק כשהאפליקציה במצב Live.</p>
    <ol><li>פתחו את <a href="${appSettings}" target="_blank" rel="noopener">הגדרות האפליקציה (App settings ← Basic)</a>.</li>
    <li>בשדה <b>Privacy Policy URL</b> הדביקו: <code>${escape(origin)}/privacy</code>, ולמטה <b>Save changes</b>.</li>
    <li>בראש הדף, העבירו את <b>App Mode</b> ל-<b>Live</b>.</li></ol>`,
  );

  // Step 5: test
  const bot = readEnv(env, "BOT_PHONE_NUMBER")?.replace(/\D/g, "");
  const when = lastWebhook > 0 ? formatTime(lastWebhook, readEnv(env, "TIMEZONE") ?? "Asia/Jerusalem") : "";
  out += section(
    5,
    "בדיקה",
    lastWebhook > 0,
    `${bot ? `<p><a class="button big" href="https://wa.me/${bot}?text=${encodeURIComponent("עזרה")}" target="_blank" rel="noopener">שליחת ״עזרה״ לבוט</a></p>` : ""}
    <p>${lastWebhook > 0 ? `✓ הבוט קיבל הודעה ב-${escape(when)}. מוכן לשימוש!` : "שלחו לבוט ״עזרה״ מהוואטסאפ שלכם, ורעננו את הדף."}</p>
    <p class="muted">אם הבוט לא עונה: בדקו ששלבים 1–4 מסומנים, ושהמספר שלכם ברשימת ״מי יכול להשתמש בבוט״.</p>`,
  );
  return out;
}

const META_GUIDE = `<details><summary>איך משיגים את הפרטים? (מדריך)</summary><ol>
<li>היכנסו ל-<a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com</a> עם חשבון הפייסבוק שלכם. אם מבקשים, הירשמו כמפתחים (Get started).</li>
<li><b>Create app</b> ← בחרו <b>Connect with customers through WhatsApp</b> ← תנו שם (למשל ״בוט הוצאות״) ← בחרו או צרו Business portfolio ← <b>Create app</b>.</li>
<li>בתפריט: <b>WhatsApp ← API Setup</b>. למטה: <b>Add phone number</b>. מלאו שם תצוגה ואת מספר הטלפון של הבוט, ואמתו אותו בקוד שיגיע ב-SMS או בשיחה. המספר לא יכול להיות מחובר לוואטסאפ רגיל.</li>
<li>באותו דף, בחרו את המספר החדש ב-<b>From</b>, והעתיקו לטופס את <b>Phone number ID</b> ואת <b>WhatsApp Business Account ID</b>.</li>
<li><b>App settings ← Basic</b>: ליד <b>App secret</b> לחצו <b>Show</b> והעתיקו.</li>
<li>טוקן קבוע: <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener">business.facebook.com ← Settings ← System users</a> ← <b>Add</b> (שם כלשהו, תפקיד Admin) ← <b>Assign assets</b>: את האפליקציה ואת חשבון ה-WhatsApp, עם Full control ← <b>Generate token</b>: בחרו את האפליקציה, תוקף <b>Never</b>, והרשאות <code>whatsapp_business_messaging</code> ו-<code>whatsapp_business_management</code>. העתיקו את הטוקן.</li>
</ol><p class="muted">הבוט רק עונה להודעות שנשלחות אליו, ותשובות כאלה לא עולות כסף ב-WhatsApp.</p></details>`;

function section(n: number, title: string, done: boolean, body: string): string {
  return `<section${done ? ' class="done"' : ""}><h2>${done ? '<span class="ok">✓</span>' : `<span class="muted">${n}.</span>`} ${escape(title)}</h2>${body}</section>`;
}

/** `set`: the value is filled in. Without a result it could not be checked yet (the token is missing or wrong). */
function check<T>(label: string, set: boolean, result: GraphResult<T> | undefined, okText?: string, optional = false): string {
  if (!result && set) return `<li><span class="opt">–</span> ${escape(label)}: <span class="muted">ייבדק כשהטוקן יתקבל</span></li>`;
  if (!result) return `<li>${optional ? '<span class="opt">–</span>' : '<span class="bad">✗</span>'} ${escape(label)}: <span class="muted">חסר</span></li>`;
  return result.ok
    ? `<li><span class="ok">✓</span> ${escape(label)}: ${escape(okText ?? "")}</li>`
    : `<li><span class="bad">✗</span> ${escape(label)}: Meta לא מקבלת: <small>${escape(result.error)}</small></li>`;
}

function input(name: string, label: string, env: Env): string {
  return `<label for="${name}">${escape(label)}</label><input id="${name}" name="${name}" class="ltr" inputmode="numeric" value="${escape(readEnv(env, name) ?? "")}">`;
}

function secretInput(name: string, label: string, env: Env): string {
  const set = readEnv(env, name) !== undefined;
  return `<label for="${name}">${escape(label)}</label><input id="${name}" name="${name}" type="password" class="ltr" autocomplete="off" placeholder="${set ? "שמור ✓ (השאירו ריק כדי לא לשנות)" : ""}">`;
}

function message(ok: boolean, text: string): string {
  return `<p class="notice ${ok ? "ok" : "bad"}">${escape(text)}</p>`;
}

function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone, dateStyle: "short", timeStyle: "short" }).format(ms);
}

// ---------------------------------------------------------------------------------------------

type GraphResult<T> = { ok: true; data: T } | { ok: false; error: string };

class Graph {
  #base: string;
  #token: string;
  fetchImpl: typeof fetch;

  constructor(env: Env, fetchImpl: typeof fetch) {
    this.#base = `https://graph.facebook.com/${readEnv(env, "GRAPH_API_VERSION") ?? "v23.0"}/`;
    this.#token = readEnv(env, "WHATSAPP_TOKEN") ?? "";
    this.fetchImpl = fetchImpl;
  }

  /** `appToken` ("<app id>|<app secret>") replaces the user token for app-level calls. */
  get<T>(path: string, appToken?: string): Promise<GraphResult<T>> {
    return this.#call<T>(path, { method: "GET" }, appToken);
  }

  post<T>(path: string, body: unknown, appToken?: string): Promise<GraphResult<T>> {
    return this.#call<T>(path, { method: "POST", body: JSON.stringify(body) }, appToken);
  }

  async #call<T>(path: string, init: RequestInit, appToken?: string): Promise<GraphResult<T>> {
    try {
      const url = new URL(this.#base + path);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (appToken) url.searchParams.set("access_token", appToken);
      else headers.Authorization = `Bearer ${this.#token}`;
      const response = await this.fetchImpl(url, { ...init, headers });
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
