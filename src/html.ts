/** Shared page layout for the setup, install and privacy pages (Hebrew, right to left). */

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src https://deploy.workers.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function page(title: string, content: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--accent:#0f766e;--soft:#f0fdfa}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--ok:#4ade80;--bad:#f87171;--accent:#2dd4bf;--soft:#134e4a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:680px;margin:0 auto;padding:24px 16px 48px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px 14px;margin:16px 0}
section.done{opacity:.8}
h1{font-size:1.5rem;margin-bottom:4px}h2{font-size:1.1rem;display:flex;gap:8px;align-items:center}
ol,ul{padding-inline-start:22px}li{margin:6px 0}
small,.muted{color:var(--muted)}code{font-size:.9em;word-break:break-all;direction:ltr;unicode-bidi:embed}
.ok{color:var(--ok)}.bad{color:var(--bad)}.opt{color:var(--muted)}
.notice{font-weight:600;padding:10px 14px;border-radius:10px;background:var(--soft)}
a{color:var(--accent)}
label{display:block;margin:12px 0 4px;font-weight:600}
input{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input.ltr{direction:ltr;text-align:left}
button,.button{display:inline-block;font:inherit;font-weight:600;padding:10px 18px;margin-top:12px;border-radius:8px;border:0;background:var(--accent);color:var(--bg);cursor:pointer;text-decoration:none}
details{margin:8px 0}summary{cursor:pointer;color:var(--accent)}
.big{font-size:1.15rem;padding:14px 22px}
</style></head><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`;
}
