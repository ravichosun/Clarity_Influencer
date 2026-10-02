# ClarityTX Creator Pipeline

This tool finds TikTok creators who would make good ClarityTX partners and
drafts a personal letter to each one. Each letter invites the creator to sign
up at **https://meetclaritytx.com/partners**. The team then works through
them on one password-protected page: review, approve, send, follow up once,
and see who clicked and who signed up.

```
 ┌──────────── your computer ─────────────┐        ┌───────── Cloudflare (free tier) ─────────┐
 │                                        │        │                                          │
 │  npm run pipeline                      │ admin  │  Pipeline page  (password protected)     │
 │   1. search TikTok for niche terms     │  API   │   Review → Approve → Send → Follow up    │
 │   2. read each creator's profile       ├───────►│                                          │
 │   3. score + tier them                 │        │  D1 database (creators, letters, clicks) │
 │  (real Chrome, read-only on TikTok)    │        │                                          │
 └────────────────────────────────────────┘        │  /go/<token>  tracked link in a letter ──┼──► meetclaritytx.com/partners?ref=<handle>
                                                   │                                          │
   (optional) your partners form ─────────────────►│  /hooks/signup or CSV upload             │
                                                   │   → matched creators move to "Signed"    │
                                                   └──────────────────────────────────────────┘
```

**Nothing is ever sent automatically.** A person approves each letter and
sends it from their own mailbox (Gmail, Outlook or a mail app; the page opens
a filled-in compose window) or pastes it into a TikTok DM.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Put the pipeline page online](#2-put-the-pipeline-page-online-about-15-minutes)
3. [Fill in the outreach details](#3-fill-in-the-outreach-details)
4. [Set up and run the scraper](#4-set-up-and-run-the-scraper)
5. [Daily workflow](#5-daily-workflow)
6. [Connecting sign-ups (optional)](#6-connecting-sign-ups-optional)
7. [Running the scraper on a schedule (optional)](#7-running-the-scraper-on-a-schedule-optional)
8. [Customising](#8-customising)
9. [Every setting in one place](#9-every-setting-in-one-place)
10. [Good practice and caveats](#10-good-practice-and-caveats)
11. [Troubleshooting](#11-troubleshooting)
12. [How it's built](#12-how-its-built)

---

## 1. What you need

- **A Cloudflare account.** The free plan is enough. It hosts the pipeline page
  and its database.
- **Node.js 22 or newer** on the computer that runs the scraper. Check with
  `node -v`.
- **Google Chrome** on that same computer. The scraper drives the real,
  installed Chrome.
- About 15 minutes for the first setup.

Install everything:

```bash
git clone <this repo>
cd <repo>
npm install            # the scraper (puppeteer-core only; it uses your installed Chrome)
npm run app:install    # the pipeline page (Cloudflare's wrangler CLI)
```

---

## 2. Put the pipeline page online (about 15 minutes)

All of these commands run inside the `app/` folder.

```bash
cd app

# 1. Log in to Cloudflare (opens a browser).
npx wrangler login

# 2. Create the database.
npx wrangler d1 create clarity_creator_pipeline
```

Step 2 prints a `database_id`. Paste it into `app/wrangler.jsonc` in place of
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

```bash
# 3. Create the tables.
npm run db:init:remote

# 4. Set the secrets. Each command asks you to paste the value.
npx wrangler secret put GATE_PASSWORD   # the password your team types to open the page
npx wrangler secret put ADMIN_TOKEN     # a long random string, e.g. from: openssl rand -hex 32
                                        # (you'll paste the same value into .env in step 4)

# 5. Deploy.
npm run deploy
```

`npm run deploy` prints the page's address, something like
`https://clarity-creator-pipeline.<your-subdomain>.workers.dev`. Open it and
enter the `GATE_PASSWORD`. Everyone with the password shares the same view,
so make it a strong one and change it when people leave.

**Optional: use your own domain.** If you want the pipeline (and the tracked
links in letters) at something like `go.meetclaritytx.com` instead of
workers.dev:

1. Uncomment `routes` in `app/wrangler.jsonc` and put your hostname in it.
   The domain must be on Cloudflare in the same account.
2. Set `PUBLIC_BASE_URL` to `https://go.meetclaritytx.com`.
3. Run `npm run deploy` again.

Tracked links look more trustworthy on your own domain.

---

## 3. Fill in the outreach details

Open `config/outreach.json` and replace every `TODO`:

| Key | What to put |
|---|---|
| `sender_name` | The real person signing the letters |
| `sender_title` | e.g. `Partnerships, ClarityTX` |
| `sender_email` | The mailbox the letters will be sent from |
| `offer` | What partners earn, written to complete the sentence "Partners …". For example: `earn 30% of every subscription that comes through their link, every month the clinician stays subscribed` |
| `mailing_address` | ClarityTX's postal address. US law (CAN-SPAM) requires one in commercial email. |

Then redeploy: `npm run app:deploy` from the repo root.

**Approving is switched off until every `TODO` is gone.** The page shows a
yellow notice until then, so a placeholder can never reach a creator.

The letters themselves are in `outreach/templates/`. Read them before you
send anything, and edit freely; see [Customising](#8-customising).

---

## 4. Set up and run the scraper

```bash
cp .env.example .env
```

Edit `.env`:

```bash
APP_URL=https://clarity-creator-pipeline.<your-subdomain>.workers.dev   # no trailing slash
ADMIN_TOKEN=<the same value you gave wrangler secret put ADMIN_TOKEN>
```

First, check that TikTok can still be read:

```bash
npm run access-check
```

You want `OK` on **user search** and **profile stats**. The third line is
informational only.

Next, a dry run. It scrapes and prints the results, and writes nothing:

```bash
npm run pipeline:dry
```

Then a real run:

```bash
npm run pipeline
```

A run takes the next 6 search terms from `config/niches.json` and finds
roughly 10 creators per term. It then visits up to 45 new profiles, scores
each one, and pushes the results to the pipeline page. It paces itself like a
person browsing, so expect 10 to 20 minutes. Run it once a day; consecutive
runs rotate through all the search terms.

Two more commands:

```bash
npm run emails    # finds business emails on creators' bio-link pages (Linktree, Beacons, their own site)
npm run rescore   # re-ranks everyone after you change config/scoring.json or config/niches.json
```

`npm run emails` is worth running after each pipeline run. Every creator it
finds an email for gets a letter instead of a DM.

Useful flags:

```bash
npm run pipeline -- --terms 3                       # fewer search terms this run
npm run pipeline -- --max-enrich 20                 # fewer profile visits this run
npm run pipeline -- --term "functional dietitian"   # one specific search
npm run emails -- --dry                             # show what it would save
```

To pause scheduled runs without touching the schedule, create a file named
`PAUSED` in the repo root. Its contents are printed as the reason. Delete the
file to resume, or run once anyway with `npm run pipeline -- --force`.

---

## 5. Daily workflow

Open the pipeline page.

| Tab | What's in it | What you do |
|---|---|---|
| **Review** | New creators, best first. Each card has the score breakdown, the bio and a drafted letter. | Read the bio. Edit the letter if you like, or pick another template. Then **Approve**, **Skip** (not now) or **Block** (never). Keys: `j`/`k` to move, `a` approve, `s` skip, `c` copy. |
| **Ready to send** | Approved letters. Each now contains the creator's own tracked link. | **Open in Gmail/Outlook** (choose which at the top) and send, or for creators without an email **Copy and open their TikTok** and paste into a DM. Then click **✓ Mark as sent**. |
| **Sent** | Everyone contacted, with follow-ups due first. | Each card shows whether they clicked their link. After 5 days a **Follow-up due** panel opens with the one follow-up already drafted: send it, then **✓ Mark follow-up sent**. Record replies with **They replied**, **They signed up** or **Declined**. |
| **Replied / Signed** | Where conversations and partners end up. | |
| **Sign-ups** | Sign-ups reported from the partners page, if connected (see section 6). | Upload a CSV, or link an unmatched sign-up to a creator by hand. |
| **Flagged** | Creators whose bio tripped an exclusion keyword (MLM, "miracle cure"…), or whose engagement number looks implausible. | A human decides: approve, skip or block. |
| **Dropped** | Under 3,000 followers, very low engagement, private, or the profile wouldn't load. | Usually nothing. |

**Export CSV** (top right) downloads everything, including statuses, send
dates, clicks and sign-ups.

**Tracked links.** Approving a creator gives them a personal link,
`https://<pipeline>/go/<token>`. Clicking it records the click and sends the
person straight to `meetclaritytx.com/partners?ref=<their handle>`. Link
previews from Slack, iMessage and corporate mail scanners are recognised and
not counted as clicks.

---

## 6. Connecting sign-ups (optional)

The partners page lets anyone sign up without identifying themselves first.
The pipeline therefore matches sign-ups to the creators you wrote to by the
TikTok handle or email they enter on the form. If the form also captures the
`ref` value from the link, the match is exact.

You can leave this alone. Without it, mark people signed with **They signed
up** on their card.

To connect it, pick any of:

- **A. CSV upload.** Export sign-ups from wherever the form saves them and
  upload the file on the Sign-ups tab. No developer needed.
- **B. Webhook.** Your backend, or Zapier or Make, POSTs each new sign-up to
  `/hooks/signup`. Turn it on with
  `npx wrangler secret put SIGNUP_WEBHOOK_SECRET`.
- **C. Capture `ref` on the form.** Add a hidden field that saves `?ref=`
  from the URL. It's a few lines of code and makes matching exact; use it
  with A or B.

Step-by-step instructions, payload format, a Next.js snippet, a Zapier recipe
and the hidden-field code are in **[docs/SIGNUPS.md](docs/SIGNUPS.md)**.

Asking for a **TikTok handle** on the partners form is the single biggest
improvement to matching.

---

## 7. Running the scraper on a schedule (optional)

The scraper has to run on a machine that has Chrome: a team member's Mac or
an always-on box.

**macOS / Linux (cron)**, every morning at 7:30:

```bash
crontab -e
# add (adjust the paths; `which node` shows yours):
30 7 * * * cd /path/to/repo && /usr/local/bin/node scraper/pipeline.mjs >> logs/pipeline.log 2>&1 && /usr/local/bin/node scraper/emails.mjs >> logs/pipeline.log 2>&1
```

Create the `logs/` folder first. On macOS, cron only runs while the Mac is
awake.

**Windows:** in Task Scheduler, create a daily task with program `node`,
arguments `scraper\pipeline.mjs`, and "start in" set to the repo folder.

Pausing: create the `PAUSED` file (see section 4).

---

## 8. Customising

All of these live in plain files. Edit them, then:

- **for anything under `config/` or `outreach/`**, redeploy the page with
  `npm run app:deploy`, because the page bundles the templates and
  `outreach.json`;
- **after changing scoring or niches**, also run `npm run rescore`.

**Who to look for: `config/niches.json`**

| Key | What it does |
|---|---|
| `search_terms` | Phrases typed into TikTok's user search, rotating 6 per run. Add or remove freely. |
| `topical_keywords` | Raise *topical fit* when found in a name or bio. |
| `credential_keywords` | Raise *credibility*: ND, MD, DO, RD, NP, IFMCP, NBC-HWC and so on. Clinicians talk to the people who buy ClarityTX. |
| `monetization_keywords` | Raise *monetizability*: creators who already sell courses or use affiliate codes convert better. |
| `exclusions.bio_keywords` | Send a creator to **Flagged** for a human look. Nothing is deleted automatically. |

**How they're ranked: `config/scoring.json`**

- `weights`: six components, adding up to 1.
- `tiers`: A is 250k or more followers, B is 25k or more, C is 3k or more.
- `hard_drops`: under 3,000 followers, under 0.2% engagement, or private.

**What the letters say: `outreach/templates/*.md`**

| Template | When it's used |
|---|---|
| `tier-b-direct-email` | Creators with an email |
| `tier-a-manager-email` | Tier A creators with an email (written to a manager) |
| `tier-c-dm` | No email, so a TikTok DM |
| `followup` | The one follow-up |

The placeholders, and the style rules the letters follow, are documented in
[outreach/voice.md](outreach/voice.md). To add a template, create the file
and add it to the list in `app/src/templates.js`.

**Brand colour:** change `--accent` at the top of `app/src/ui.html`.

---

## 9. Every setting in one place

**Cloudflare Worker secrets.** Set each with `cd app && npx wrangler secret put <NAME>`.

| Name | Required | Purpose |
|---|---|---|
| `GATE_PASSWORD` | yes | Team password for the pipeline page. Without it the page stays locked. |
| `ADMIN_TOKEN` | yes | Lets the scraper write to the page. Must equal `ADMIN_TOKEN` in `.env`. |
| `SIGNUP_WEBHOOK_SECRET` | no | Turns on `/hooks/signup` (section 6). |

**Worker settings in `app/wrangler.jsonc`**

| Name | Purpose |
|---|---|
| `database_id` | From `wrangler d1 create` |
| `PUBLIC_BASE_URL` | Optional custom domain for tracked links |
| `routes` | Optional custom domain |

**Scraper settings in `.env`**

| Name | Required | Purpose |
|---|---|---|
| `APP_URL` | yes | The pipeline page address |
| `ADMIN_TOKEN` | yes | Same value as the Worker secret |
| `CHROME_PATH` | no | Where Chrome is, if it isn't in the usual place |
| `TIKTOK_PROFILE_DIR` | no | A persistent Chrome profile. Use it with `npm run tiktok-login` to scrape while logged in. |
| `HEADLESS` | no | `0` shows the Chrome window while scraping |

**Content:** `config/outreach.json`, `config/niches.json`,
`config/scoring.json` and `outreach/templates/`.

**Local development.** Copy `app/.dev.vars.example` to `app/.dev.vars`, then
from the repo root:

```bash
npm run app:db:init   # local database
npm run app:dev       # http://localhost:8787
```

To scrape into the local copy, set `APP_URL=http://localhost:8787` in `.env`.

---

## 10. Good practice and caveats

- **TikTok.** The scraper only reads public pages and paces itself like a
  person. It stops at the first captcha or after 5 failures in a row.
  Automated collection may still conflict with TikTok's Terms of Service, and
  TikTok changes its site without notice. Keep runs to about one a day, and
  run `npm run access-check` whenever a run comes back empty.
  - If you log in to scrape (`TIKTOK_PROFILE_DIR` + `npm run tiktok-login`),
    use a dedicated account, never a personal or company one.
- **Email law.** Commercial email in the US must:
  - identify the sender honestly,
  - include a postal address (`mailing_address`),
  - honour opt-outs.

  Every template ends with an opt-out line. When someone opts out, click
  **Block** so they are never suggested again. Check the rules for any other
  countries you write to.
- **Deliverability.** Send by hand from a real mailbox, tens per day rather
  than hundreds, and never paste the same text to hundreds of people in one
  sitting. Make sure the sending domain has SPF, DKIM and DMARC set up.
- **Data.** The database holds public profile information plus any emails
  found on public bio-link pages. Keep the page password private. Delete
  creators you won't contact (or export and clear periodically) in line with
  your privacy policy.
- **Claims.** ClarityTX supports clinician judgment. Keep letters free of
  medical claims (see `outreach/voice.md`).

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| A scraper run finds 0 handles | Run `npm run access-check`. If search fails, try `HEADLESS=0 npm run pipeline -- --terms 1` to watch what TikTok shows, wait a few hours, or log in with `npm run tiktok-login`. |
| `ADMIN_TOKEN in .env does not match` | The `.env` value and the Worker secret differ. Re-run `wrangler secret put ADMIN_TOKEN`, or fix `.env`. |
| `Google Chrome not found` | Install Chrome, or set `CHROME_PATH` in `.env`. |
| The page says it is locked | `GATE_PASSWORD` isn't set: run `npx wrangler secret put GATE_PASSWORD`. |
| Approve button is disabled | `config/outreach.json` still has a `TODO`. Fill it in and run `npm run app:deploy`. |
| Template or config edits don't show | Redeploy: `npm run app:deploy`. |
| `no such table` errors | Run `npm run app:db:init:remote` (it is safe to re-run). |
| Webhook returns 503 | Set `SIGNUP_WEBHOOK_SECRET`. A 401 means the secret sent doesn't match. |

Live logs from the deployed page: `cd app && npm run tail`.

---

## 12. How it's built

```
config/                 what to look for, how to rank, what letters say
  niches.json  scoring.json  outreach.json
outreach/
  templates/*.md        the letters
  voice.md              style rules and placeholders
scraper/                runs on a computer with Chrome (Node 22+, puppeteer-core)
  pipeline.mjs          discover → enrich → score → push
  tiktok.mjs            reading TikTok search and profile pages
  score.mjs             the scoring model
  emails.mjs            email finder for bio-link pages
  rescore.mjs           re-rank after config changes
  access-check.mjs      is TikTok still readable?
  tiktok-login.mjs      optional logged-in profile
  chrome.mjs, api.mjs, env.mjs
app/                    Cloudflare Worker + D1 (no build step, no framework)
  src/index.js          routes: page, API, tracked links, webhook, admin API
  src/ui.html           the pipeline page
  src/draft.js          fills templates
  src/match.js          sign-up matching and CSV parsing
  schema.sql            the database
docs/SIGNUPS.md         connecting sign-ups
```

**Who can reach which routes:**

| Route | Access |
|---|---|
| `/go/<token>` | Public. This is the tracked link in letters. |
| `/hooks/signup` | Needs `SIGNUP_WEBHOOK_SECRET` |
| `/admin/*` | Needs `ADMIN_TOKEN`; used by the scraper |
| Everything else | Behind `GATE_PASSWORD` |

The database is the only store. The scraper keeps nothing on disk apart from
an optional Chrome profile.
