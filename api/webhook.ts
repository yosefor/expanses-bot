// Vercel function: https://<deployment>/api/webhook
import { waitUntil } from "@vercel/functions";
import { createBotFromEnv } from "../src/app.ts";
import { handleWebhook, type WebhookOptions } from "../src/server.ts";

let options: WebhookOptions | undefined;

function handle(request: Request): Promise<Response> {
  options ??= createBotFromEnv();
  return handleWebhook(request, options, waitUntil);
}

export const GET = handle;
export const POST = handle;
