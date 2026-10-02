-- ClarityTX creator pipeline: everything the pipeline page knows.
-- Apply with:  npm run db:init          (local, for `wrangler dev`)
--              npm run db:init:remote   (the deployed database)
-- Safe to re-run: every statement is IF NOT EXISTS.

-- One row per TikTok creator the scraper has found.
CREATE TABLE IF NOT EXISTS creators (
  handle            TEXT PRIMARY KEY,          -- lowercase TikTok handle, no @
  platform          TEXT NOT NULL DEFAULT 'tiktok',
  discovered_at     TEXT NOT NULL,
  source            TEXT,                       -- 'search', 'manual', ...
  source_term       TEXT,                       -- the search phrase that found them
  enriched_at       TEXT,
  nickname          TEXT,
  bio               TEXT,
  external_link     TEXT,
  avatar_url        TEXT,
  email             TEXT,
  ig_handle         TEXT,
  verified          INTEGER DEFAULT 0,
  private_account   INTEGER DEFAULT 0,
  followers         INTEGER,
  following         INTEGER,
  total_likes       INTEGER,
  video_count       INTEGER,
  avg_likes         REAL,
  engagement_rate   REAL,
  engagement_source TEXT,
  monetizing        INTEGER,
  credentialed      INTEGER,
  topical_fit       REAL,
  score             REAL,
  score_detail      TEXT,                       -- JSON: per-component breakdown
  tier              TEXT,                       -- A / B / C / D
  -- new -> shortlisted | flagged | dropped -> approved -> contacted -> replied -> signed
  -- plus skipped / blocked (a human said no)
  status            TEXT NOT NULL DEFAULT 'new',
  drop_reason       TEXT,
  notes             TEXT,
  signed_at         TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_creators_status ON creators(status, score);
CREATE INDEX IF NOT EXISTS idx_creators_email ON creators(email COLLATE NOCASE);

-- Every message drafted, approved and sent. A follow-up is its own row
-- pointing at the first message (followup_of) and reusing its link.
CREATE TABLE IF NOT EXISTS outreach (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  handle          TEXT NOT NULL,
  channel         TEXT NOT NULL,              -- 'email' | 'tiktok_dm'
  template        TEXT,
  subject         TEXT,
  message_text    TEXT,
  link_token      TEXT,                       -- /go/<token>
  link_url        TEXT,
  drafted_at      TEXT,
  approved_at     TEXT,
  sent_at         TEXT,
  status          TEXT NOT NULL DEFAULT 'approved',  -- 'approved' | 'sent'
  outcome         TEXT,                       -- 'replied' | 'signed' | 'declined'
  reply_at        TEXT,
  followup_of     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outreach_handle ON outreach(handle);
CREATE INDEX IF NOT EXISTS idx_outreach_token ON outreach(link_token);

-- Tracked links. One per creator, minted on Approve.
CREATE TABLE IF NOT EXISTS links (
  token           TEXT PRIMARY KEY,
  handle          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  first_click_at  TEXT,
  last_click_at   TEXT,
  click_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_links_handle ON links(handle);

-- Sign-ups reported back from ClarityTX's partners page (optional).
-- Arrive by webhook (POST /api/signups), CSV upload, or are added by hand.
CREATE TABLE IF NOT EXISTS signups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     TEXT NOT NULL,
  source          TEXT NOT NULL,              -- 'webhook' | 'csv'
  dedupe_key      TEXT NOT NULL UNIQUE,       -- stops the same person arriving twice
  signed_up_at    TEXT,                       -- when they signed up, if the source says
  email           TEXT,
  tiktok_handle   TEXT,
  name            TEXT,
  ref             TEXT,
  raw             TEXT,                       -- the original payload / CSV row as JSON
  matched_handle  TEXT,
  match_method    TEXT,                       -- 'ref' | 'handle' | 'email' | 'manual'
  matched_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_signups_matched ON signups(matched_handle);

-- One row per scraper run, for the status line and term rotation.
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  terms_run       TEXT,
  found           INTEGER,
  new_candidates  INTEGER,
  enriched        INTEGER,
  dropped         INTEGER,
  errors          TEXT,
  ok              INTEGER
);

-- Append-only audit log: clicks, approvals, sends, sign-ups, failed logins.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  type            TEXT NOT NULL,
  handle          TEXT,
  detail          TEXT,
  ip              TEXT,
  user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, at);
