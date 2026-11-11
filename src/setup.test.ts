import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSetup } from "./setup.ts";

const ORIGIN = "https://bot.example";
const env = {
  WHATSAPP_TOKEN: "token",
  WHATSAPP_PHONE_NUMBER_ID: "111",
  WHATSAPP_APP_SECRET: "secret",
  WHATSAPP_VERIFY_TOKEN: "verify",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "222",
  ADMIN_PASSWORD: "pw",
};
const auth = (password: string) => ({ authorization: `Basic ${btoa(`admin:${password}`)}` });

/** A fake Graph API that records calls and knows one phone number. */
function fakeGraph(webhook?: string, subscribedApps: string[] = []) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("fields=webhook_configuration")) {
      return Response.json({ webhook_configuration: { application: "https://other.example/hook", ...(webhook ? { phone_number: webhook } : {}) } });
    }
    if (url.endsWith("/app")) return Response.json({ id: "999" });
    if (url.endsWith("/222/subscribed_apps") && init?.method !== "POST") {
      return Response.json({ data: subscribedApps.map((id) => ({ whatsapp_business_api_data: { id } })) });
    }
    if (url.includes("fields=display_phone_number")) return Response.json({ display_phone_number: "+972 50-000-0000", verified_name: "Bot" });
    return Response.json({ success: true });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("setup page is closed without ADMIN_PASSWORD and needs the password otherwise", async () => {
  const closed = await handleSetup(new Request(`${ORIGIN}/`), { env: { ...env, ADMIN_PASSWORD: "" } });
  assert.equal(closed.status, 200);
  assert.match(await closed.text(), /Set the <code>ADMIN_PASSWORD<\/code>/);

  assert.equal((await handleSetup(new Request(`${ORIGIN}/`), { env })).status, 401);
  assert.equal((await handleSetup(new Request(`${ORIGIN}/`, { headers: auth("wrong") }), { env })).status, 401);
});

test("setup page shows what is missing without calling Meta", async () => {
  const { calls, fetchImpl } = fakeGraph();
  const response = await handleSetup(new Request(`${ORIGIN}/`, { headers: auth("pw") }), {
    env: { ADMIN_PASSWORD: "pw", WHATSAPP_TOKEN: "t" },
    fetch: fetchImpl,
  });
  const html = await response.text();
  assert.match(html, /✗<\/span> <code>WHATSAPP_PHONE_NUMBER_ID/);
  assert.match(html, /✓<\/span> <code>WHATSAPP_TOKEN/);
  assert.doesNotMatch(html, />t</, "never shows values");
  assert.equal(calls.length, 0);
});

test("setup page reports the webhook and connects it", async () => {
  const before = fakeGraph();
  const page = await (await handleSetup(new Request(`${ORIGIN}/`, { headers: auth("pw") }), { env, fetch: before.fetchImpl })).text();
  assert.match(page, /don't reach the bot yet/);
  assert.match(page, /https:\/\/bot\.example\/webhook/);

  const connect = (origin: string) =>
    new Request(`${ORIGIN}/`, { method: "POST", headers: { ...auth("pw"), origin }, body: new URLSearchParams({ action: "connect" }) });

  assert.equal((await handleSetup(connect("https://evil.example"), { env, fetch: before.fetchImpl })).status, 403);

  const { calls, fetchImpl } = fakeGraph();
  const done = await (await handleSetup(connect(ORIGIN), { env, fetch: fetchImpl })).text();
  assert.match(done, /Webhook connected/);
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(
    posts.map((c) => [new URL(c.url).pathname, c.body]),
    [
      ["/v23.0/222/subscribed_apps", {}],
      ["/v23.0/111", { webhook_configuration: { override_callback_uri: `${ORIGIN}/webhook`, verify_token: "verify" } }],
    ],
  );

  // An app that is already subscribed is not subscribed again (that could reset a shared account's webhook).
  const subscribed = fakeGraph(undefined, ["999"]);
  await handleSetup(connect(ORIGIN), { env, fetch: subscribed.fetchImpl });
  assert.deepEqual(
    subscribed.calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname),
    ["/v23.0/111"],
  );

  const after = fakeGraph(`${ORIGIN}/webhook`);
  const connected = await (await handleSetup(new Request(`${ORIGIN}/`, { headers: auth("pw") }), { env, fetch: after.fetchImpl })).text();
  assert.match(connected, /Messages to this number reach the bot/);
});
