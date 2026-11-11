// Plain Node server (local dev, Docker, Cloud Run). On Vercel, api/webhook.ts is used instead.
import { createServer, type IncomingMessage } from "node:http";
import { createBotFromEnv } from "./app.ts";
import { handleWebhook } from "./server.ts";

const options = createBotFromEnv();
const port = Number(process.env.PORT ?? 8080);

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (pathname !== "/webhook" && pathname !== "/api/webhook") {
      res.writeHead(404).end();
      return;
    }
    // A long-running server needs no waitUntil: background promises keep running.
    const response = await handleWebhook(await toRequest(req), options, () => {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Request failed", error);
    res.writeHead(500).end();
  }
});

server.listen(port, () => console.log(`Expenses bot listening on http://localhost:${port}/webhook`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
