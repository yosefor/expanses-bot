/** Environment variables as plain strings: `process.env` on Node, the Worker `env` on Cloudflare. */
export type Env = Record<string, unknown>;

export interface Config {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  allowedNumbers: Set<string>;
  timeZone: string;
  apiVersion: string;
  reactionEmoji: string;
  /** The bot's own number, digits only (for wa.me links in invites). */
  botPhoneNumber?: string;
}

export function readEnv(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireEnv(env: Env, name: string): string {
  const value = readEnv(env, name);
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    token: requireEnv(env, "WHATSAPP_TOKEN"),
    phoneNumberId: requireEnv(env, "WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: requireEnv(env, "WHATSAPP_VERIFY_TOKEN"),
    appSecret: requireEnv(env, "WHATSAPP_APP_SECRET"),
    allowedNumbers: parseNumbers(readEnv(env, "ALLOWED_NUMBERS")),
    timeZone: readEnv(env, "TIMEZONE") ?? "Asia/Jerusalem",
    apiVersion: readEnv(env, "GRAPH_API_VERSION") ?? "v23.0",
    reactionEmoji: readEnv(env, "REACTION_EMOJI") ?? "✅",
    botPhoneNumber: readEnv(env, "BOT_PHONE_NUMBER")?.replace(/\D/g, "") || undefined,
  };
}

/** "972501234567, +972 50-765-4321" -> {"972501234567", "972507654321"} */
export function parseNumbers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((n) => n.replace(/\D/g, ""))
      .filter(Boolean),
  );
}
