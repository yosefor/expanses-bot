-- Expenses bot schema (Cloudflare D1). Times are Unix epoch milliseconds.

-- An account's id is the number of its owner. A number that joined a shared account
-- records into the owner's account (see links).
CREATE TABLE expenses (
  account_id   TEXT    NOT NULL,
  message_id   TEXT    NOT NULL,
  sender       TEXT    NOT NULL,
  sender_name  TEXT,
  amount_cents INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX expenses_by_account_time ON expenses (account_id, created_at);

-- Number -> the shared account it joined.
CREATE TABLE links (
  phone      TEXT    PRIMARY KEY,
  account_id TEXT    NOT NULL,
  linked_at  INTEGER NOT NULL
);
CREATE INDEX links_by_account ON links (account_id);

CREATE TABLE invites (
  code            TEXT    PRIMARY KEY,
  account_id      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  created_by_name TEXT,
  expires_at      INTEGER NOT NULL
);

-- Dedupes webhook retries. Old rows are deleted by the daily cron.
CREATE TABLE processed_messages (
  message_id   TEXT    PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
