# Uni Expenses (WhatsApp bot)

Send the bot a message with an amount and a reason. It reacts with ✅ and saves the expense.
Send `סיכום` and it replies with all your expenses, grouped by month, with totals.

| You send | Bot does |
|---|---|
| `50 סופר` / `סופר 50` / `120 ש"ח מסעדה` / `1,250 שכירות` | ✅ reaction, saved |
| `עזרה` (or `help`, `?`) | Replies with the list of commands |
| `סיכום` | Replies with the summary (in a shared account: everyone's expenses, who spent what, and a total per person) |
| `הוסף משתמש` (or `הזמנה`, `add user`) | Replies with a 6-digit code (valid 24h, single use) and a message to forward, with a `wa.me` link that opens the bot with the join text already typed |
| `הצטרפות 123456` (or just `123456`) | Links this number to the account that created the code. Its own expenses so far move into the shared account |
| `ניתוק` | Unlinks this number from the shared account. Expenses already recorded stay there |
| Anything without a number | ❓ reaction, nothing saved |

The amount is the number at the **start** of the message. If there is none, it's the number at the **end**, and failing that, the first number in the message.
So `80 על 2 פיצות` is saved as 80. Each number has its own account until it joins another one with an invite code.

### Shared accounts (family)

1. Someone already using the bot sends `הוסף משתמש`.
2. They forward the bot's second message to the family member.
3. The family member taps the link, or sends `הצטרפות <code>` to the bot.

From then on, both numbers record into the same account and `סיכום` shows everything. A number
that joined with a code may use the bot even if it is not in `ALLOWED_NUMBERS`. A number that
others have joined can't join a different account. It can invite them instead.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yosefor/expanses-bot)

Built on the official WhatsApp Cloud API. It runs on **Cloudflare Workers + D1** (free plan), or on
Node (Vercel, Docker, Cloud Run) with Firestore.

## Setup

1. **Meta app**: at https://developers.facebook.com, create an app and add the **WhatsApp** product.
   - Copy the **Phone number ID** and the **WhatsApp Business Account ID** from *WhatsApp → API Setup*.
   - Create a **permanent token**: *Business Settings → System users*, then generate a token with
     `whatsapp_business_messaging` and `whatsapp_business_management`.
   - Copy the **App secret** from *App settings → Basic*.
2. Deploy (below) and fill in the settings.
3. Open the Worker's URL (`/`), sign in with any user name and `ADMIN_PASSWORD`, and click
   **Connect webhook**. The setup page checks every setting and the token, then points this phone
   number (only this one, with a phone-number-level override) at `/webhook`.
4. Send the bot `עזרה`.

| Setting | |
|---|---|
| `WHATSAPP_TOKEN` | Permanent access token (secret) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID |
| `WHATSAPP_APP_SECRET` | App secret, verifies webhook signatures (secret) |
| `WHATSAPP_VERIFY_TOKEN` | Any random string. Meta sends it back when verifying the webhook |
| `ADMIN_PASSWORD` | Password for the setup page. Without it the page stays closed |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Optional. Lets the setup page subscribe the app to the account |
| `ALLOWED_NUMBERS` | Comma-separated numbers allowed to use the bot (e.g. `972501234567`). Empty = anyone |
| `BOT_PHONE_NUMBER` | Optional. The bot's number, digits only, for `wa.me` links in invites |
| `TIMEZONE` | Default `Asia/Jerusalem` |

## Deploy (Cloudflare Workers)

Click **Deploy to Cloudflare** above, or from a clone:

```sh
npm install
cp .dev.vars.example .dev.vars    # fill it in; delete the lines you leave empty
# First deploy: creates the Worker with its secrets and the D1 database, then the tables
npx wrangler deploy --secrets-file .dev.vars && npx wrangler d1 migrations apply DB --remote
# Later deploys
npm run deploy
```

- `src/worker.ts` is the entry point: `/webhook` for Meta, `/` for the setup page, and a daily cron
  that deletes old dedupe records and expired invite codes.
- Data lives in D1. The schema is in `migrations/`: `expenses`, `links` (number → shared account),
  `invites` and `processed_messages` (dedupes webhook retries).
- Settings changed in the Cloudflare dashboard survive redeploys (`keep_vars`).
- Local: `cp .dev.vars.example .dev.vars`, then `npm run dev:worker`.
- `appflare/appflare.jsonc` is a draft entry for the [Appflare](https://appflare.dev) catalog.

## Deploy (Node: Vercel, Docker, Cloud Run)

The Node build stores data in Firestore:

```
users/{accountId}/expenses/{sha256(messageId)}  { amountCents, reason, messageId, createdAt, sender, senderName }
links/{phone}                                   { accountId, linkedAt }      // number -> shared account
inviteCodes/{code}                              { accountId, createdBy, createdByName, expiresAt }
processedMessages/{sha256(messageId)}           { messageId, processedAt }   // dedupes webhook retries
```

An account's id is the number of its owner, so a number that never joined anyone uses `users/{its number}`.
Expenses saved before shared accounts existed have no `sender`. The account owner is assumed.
The Admin SDK bypasses security rules, so `firestore.rules` blocks all client access
(`firebase deploy --only firestore:rules`).

1. `cp .env.example .env` and fill in the values, plus `FIREBASE_PROJECT_ID` (Firestore enabled).
   Locally, credentials come from `GOOGLE_APPLICATION_CREDENTIALS` (a service account key file).
2. `npm install && npm start`. To reach it from Meta locally, use a tunnel, e.g.
   `cloudflared tunnel --url http://localhost:8080`.
3. Point the number's webhook at the server (the Node build has no setup page):
   ```sh
   curl -X POST "https://graph.facebook.com/v23.0/$WHATSAPP_PHONE_NUMBER_ID" \
     -H "Authorization: Bearer $WHATSAPP_TOKEN" -H "Content-Type: application/json" \
     -d '{"webhook_configuration":{"override_callback_uri":"https://<your-host>/webhook","verify_token":"<WHATSAPP_VERIFY_TOKEN>"}}'
   ```

**Vercel**: `api/webhook.ts` is the function (`vercel deploy --prod`). Firestore credentials come from
`FIREBASE_SERVICE_ACCOUNT` (base64 of the key JSON) instead of a key file.

**Cloud Run**:

```sh
gcloud run deploy expenses-bot --source . --allow-unauthenticated \
  --env-vars-file <(grep -v '^#' .env | grep . | grep -v GOOGLE_APPLICATION_CREDENTIALS | sed -E 's/^([^=]+)=(.*)$/\1: "\2"/')
```

The service's own identity reaches Firestore (it needs the **Cloud Datastore User** role), so the key
file is not shipped (it is in `.dockerignore`).

## Development

```sh
npm run dev        # restarts on change
npm test           # parser, webhook flow, setup page, D1 store (Firestore test skipped)
npm run dev:worker # the Worker locally, with a local D1
npm run test:firestore   # everything, including Firestore, against the local emulator
npm run typecheck
```
