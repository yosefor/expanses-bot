import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSetup, type SetupOptions } from "./setup.ts";

const ORIGIN = "https://bot.example";
const HOOK = `${ORIGIN}/webhook`;
const env = {
  WHATSAPP_TOKEN: "token",
  WHATSAPP_PHONE_NUMBER_ID: "111",
  WHATSAPP_APP_SECRET: "secret",
  WHATSAPP_VERIFY_TOKEN: "verify",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "222",
  ADMIN_PASSWORD: "pw",
};
const auth = (password: string) => ({ authorization: `Basic ${btoa(`admin:${password}`)}` });
const get = () => new Request(`${ORIGIN}/`, { headers: auth("pw") });
const post = (fields: Record<string, string>, origin = ORIGIN) =>
  new Request(`${ORIGIN}/`, { method: "POST", headers: { ...auth("pw"), origin }, body: new URLSearchParams(fields) });

/** A fake Graph API with one app (999), one business account (222) and one phone number (111). */
class FakeMeta {
  calls: { method: string; path: string; token: string; body?: Record<string, unknown> }[] = [];
  appWebhook?: string;
  wabaApps: string[] = [];
  phoneOverride?: string;
  registered = false;

  constructor(init: Partial<Pick<FakeMeta, "appWebhook" | "wabaApps" | "phoneOverride" | "registered">> = {}) {
    Object.assign(this, init);
  }

  writes() {
    return this.calls.filter((c) => c.method === "POST").map((c) => `${c.path} ${c.token}`);
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v23.0/", "");
    const method = init?.method ?? "GET";
    const appToken = url.searchParams.get("access_token");
    const token = appToken ?? (init?.headers as Record<string, string>).Authorization?.replace("Bearer ", "") ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.calls.push({ method, path, token: appToken ? "app" : "user", ...(body ? { body } : {}) });

    const fail = (message: string) => Response.json({ error: { message } }, { status: 400 });
    if (appToken && appToken !== "999|secret") return fail("Invalid OAuth access token signature.");
    if (!appToken && token !== "token") return fail("Invalid OAuth access token.");

    if (path === "app") return Response.json({ id: "999", name: "My bot" });
    if (path === "999/subscriptions") {
      if (method === "POST") {
        this.appWebhook = String(body?.callback_url);
        return Response.json({ success: true });
      }
      return Response.json({ data: this.appWebhook ? [{ object: "whatsapp_business_account", callback_url: this.appWebhook }] : [] });
    }
    if (path === "222/subscribed_apps") {
      if (method === "POST") this.wabaApps.push("999");
      return Response.json(method === "POST" ? { success: true } : { data: this.wabaApps.map((id) => ({ whatsapp_business_api_data: { id } })) });
    }
    if (path === "222") return Response.json({ name: "My business" });
    if (path === "111/register") {
      this.registered = true;
      return Response.json({ success: true });
    }
    if (path === "111" && method === "POST") {
      this.phoneOverride = String((body?.webhook_configuration as { override_callback_uri: string }).override_callback_uri);
      return Response.json({ success: true });
    }
    if (path === "111" && url.searchParams.get("fields") === "webhook_configuration") {
      return Response.json({
        webhook_configuration: {
          ...(this.phoneOverride ? { phone_number: this.phoneOverride } : {}),
          ...(this.appWebhook ? { application: this.appWebhook } : {}),
        },
      });
    }
    if (path === "111") {
      return Response.json({
        display_phone_number: "+972 50-000-0099",
        verified_name: "Bot",
        platform_type: this.registered ? "CLOUD_API" : "NOT_APPLICABLE",
        status: this.registered ? "CONNECTED" : "PENDING",
        code_verification_status: "VERIFIED",
      });
    }
    return fail(`unexpected ${method} ${path}`);
  }) as typeof fetch;
}

const run = (request: Request, meta: FakeMeta, extra: Partial<SetupOptions> = {}) =>
  handleSetup(request, { env, fetch: meta.fetch, ...extra });

test("setup page is closed without ADMIN_PASSWORD and needs the password otherwise", async () => {
  const closed = await handleSetup(new Request(`${ORIGIN}/`), { env: { ...env, ADMIN_PASSWORD: "" } });
  assert.equal(closed.status, 200);
  assert.match(await closed.text(), /ADMIN_PASSWORD/);

  assert.equal((await handleSetup(new Request(`${ORIGIN}/`), { env })).status, 401);
  assert.equal((await handleSetup(new Request(`${ORIGIN}/`, { headers: auth("wrong") }), { env })).status, 401);
  assert.equal((await run(post({ action: "connect" }, "https://evil.example"), new FakeMeta())).status, 403);
});

test("a fresh install shows the form and calls nobody", async () => {
  const meta = new FakeMeta();
  const html = await (await run(get(), meta, { env: { ADMIN_PASSWORD: "pw" }, save: async () => {} })).text();
  assert.match(html, /name="WHATSAPP_TOKEN"/);
  assert.match(html, /כרגע ריק/, "warns that anyone could use the bot");
  assert.match(html, /✗<\/span> טוקן: <span class="muted">חסר/);
  assert.equal(meta.calls.length, 0);
});

test("saving normalizes numbers, keeps unchanged secrets, makes a verify token and finds the bot's number", async () => {
  const meta = new FakeMeta();
  let saved: Record<string, string> = {};
  const response = await run(
    post({
      action: "save",
      WHATSAPP_PHONE_NUMBER_ID: " 111 ",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "222",
      ALLOWED_NUMBERS: "050-1234567, +972 52-765-4321",
      WHATSAPP_APP_SECRET: "",
      WHATSAPP_TOKEN: "token",
    }),
    meta,
    { env: { ADMIN_PASSWORD: "pw", WHATSAPP_APP_SECRET: "old" }, save: async (values) => void (saved = values) },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/?saved=1`);
  assert.match(saved.WHATSAPP_VERIFY_TOKEN ?? "", /^[0-9a-f]{32}$/);
  const { WHATSAPP_VERIFY_TOKEN: _, ...rest } = saved;
  assert.deepEqual(rest, {
    WHATSAPP_PHONE_NUMBER_ID: "111",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "222",
    ALLOWED_NUMBERS: "972501234567,972527654321",
    WHATSAPP_TOKEN: "token",
    BOT_PHONE_NUMBER: "972500000099",
  });
});

test("wrong details are shown as rejected by Meta", async () => {
  const html = await (await run(get(), new FakeMeta(), { env: { ...env, WHATSAPP_APP_SECRET: "nope" } })).text();
  assert.match(html, /✗<\/span> App secret/);
  assert.match(html, /✓<\/span> טוקן: אפליקציה: My bot/);

  // With a token Meta rejects, the other values are filled in but can't be checked yet.
  const badToken = await (await run(get(), new FakeMeta(), { env: { ...env, WHATSAPP_TOKEN: "bad" } })).text();
  assert.match(badToken, /✗<\/span> טוקן: Meta לא מקבלת/);
  assert.match(badToken, /–<\/span> App secret: <span class="muted">ייבדק כשהטוקן יתקבל/);
});

test("registering the number checks the PIN", async () => {
  const meta = new FakeMeta();
  assert.match(await (await run(post({ action: "register", pin: "12" }), meta)).text(), /6 ספרות/);
  assert.equal(meta.registered, false);
  assert.match(await (await run(post({ action: "register", pin: "123456" }), meta)).text(), /המספר הופעל/);
  assert.deepEqual(meta.calls.find((c) => c.path === "111/register")?.body, { messaging_product: "whatsapp", pin: "123456" });
});

test("connecting a new app points the app's webhook at the bot", async () => {
  const meta = new FakeMeta({ registered: true });
  assert.match(await (await run(post({ action: "connect" }), meta)).text(), /הבוט מחובר/);
  assert.deepEqual(meta.writes(), ["999/subscriptions app", "222/subscribed_apps user"]);
  assert.deepEqual(meta.calls.find((c) => c.method === "POST")?.body, {
    object: "whatsapp_business_account",
    callback_url: HOOK,
    verify_token: "verify",
    fields: "messages",
  });
  assert.equal(meta.phoneOverride, undefined, "no override needed");
  assert.match(await (await run(get(), meta)).text(), /הודעות למספר מגיעות לבוט/);
});

test("connecting an app shared with other services only redirects this number", async () => {
  const meta = new FakeMeta({ appWebhook: "https://other.example/hook", wabaApps: ["999"], registered: true });
  assert.match(await (await run(post({ action: "connect" }), meta)).text(), /הבוט מחובר/);
  assert.deepEqual(meta.writes(), ["111 user"], "the app and account webhooks are left alone");
  assert.equal(meta.appWebhook, "https://other.example/hook");
  assert.equal(meta.phoneOverride, HOOK);
});

test("the last step turns green once a message arrived", async () => {
  const meta = new FakeMeta({ appWebhook: HOOK, wabaApps: ["999"], registered: true });
  const before = await (await run(get(), meta, { env: { ...env, BOT_PHONE_NUMBER: "972500000099" } })).text();
  assert.match(before, /https:\/\/wa\.me\/972500000099/);
  assert.match(before, /שלחו לבוט ״עזרה״/);
  const after = await (await run(get(), meta, { env: { ...env, LAST_WEBHOOK_AT: "1762800000000" } })).text();
  assert.match(after, /מוכן לשימוש/);
});
