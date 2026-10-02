/**
 * ClarityTX creator pipeline: the hosted page and its API.
 *
 * Routes, by who may call them:
 *
 *   public   GET  /go/<token>        tracked link in a letter -> partners page
 *   secret   POST /hooks/signup      optional sign-up webhook (SIGNUP_WEBHOOK_SECRET)
 *   bearer   /admin/*                the scraper (ADMIN_TOKEN)
 *   gated    /, /api/*               the team, behind GATE_PASSWORD
 *
 * Nothing here sends a message. Letters are approved on the page and sent by
 * a person from their own mailbox or TikTok account.
 */
import UI from './ui.html';
import { OUTREACH, LINK_PLACEHOLDER, TEMPLATE_NAMES, pickTemplate, renderDraft, unfinishedConfig } from './draft.js';
import { detectColumns, markSigned, normalizeHandle, parseCsv, recordSignup, rematchAll, toSignup } from './match.js';

const nowIso = () => new Date().toISOString();
const DAY_MS = 86_400_000;
const FOLLOWUP_AFTER_DAYS = Number(OUTREACH.followup_after_days) || 5;
const QUIET_AFTER_DAYS = Number(OUTREACH.quiet_after_days) || 7;

const SECURITY_HEADERS = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra } });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS } });

function clientMeta(request) {
  return {
    ip: request.headers.get('cf-connecting-ip') || null,
    ua: (request.headers.get('user-agent') || '').slice(0, 400),
  };
}

async function logEvent(env, { type, handle = null, detail = null, ip = null, user_agent = null }) {
  try {
    await env.DB.prepare('INSERT INTO events (at, type, handle, detail, ip, user_agent) VALUES (?,?,?,?,?,?)')
      .bind(nowIso(), type, handle, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), ip, user_agent)
      .run();
  } catch (e) {
    console.error('event log failed', e);
  }
}

// Length-checked, non-short-circuiting comparison for secrets.
function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

const randomToken = (len = 10) => {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
};

// --- password gate ------------------------------------------------------
//
// One shared password for the team. The cookie holds a hash of the password,
// not the password. Fails closed: with no GATE_PASSWORD set, nobody gets in.

const GATE_COOKIE = 'cp_gate';

async function gateToken(env) {
  const bytes = new TextEncoder().encode(`${env.GATE_PASSWORD}|clarity-creator-pipeline`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function gatePassed(request, env) {
  if (!env.GATE_PASSWORD) return false;
  return sameSecret(readCookie(request, GATE_COOKIE), await gateToken(env));
}

function gatePage({ error = '', configured = true } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Creator Pipeline</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#dfe3ea;--text:#16202c;--dim:#5d6b7c;--accent:#0f7b74;--bad:#c2373d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e8eaf0;--dim:#9aa3b2;--accent:#3cc6b8;--bad:#f2555a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:360px}
h1{font-size:18px;margin:0 0 4px}p{color:var(--dim);margin:0 0 18px;font-size:14px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
button{margin-top:12px;width:100%;padding:10px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/gate">
<h1>${esc(OUTREACH.company_name)} creator pipeline</h1>
<p>${configured ? 'Enter the team password.' : 'This page is locked: no GATE_PASSWORD has been set. See the README.'}</p>
<input type="password" name="password" autocomplete="current-password" autofocus ${configured ? '' : 'disabled'}>
<button ${configured ? '' : 'disabled'}>Open</button>
${error ? `<div class="err">${esc(error)}</div>` : ''}
</form></body></html>`;
}

async function handleGateSubmit(request, env) {
  if (!env.GATE_PASSWORD) return html(gatePage({ configured: false }), 503);
  const form = await request.formData();
  const supplied = String(form.get('password') || '');
  if (!sameSecret(supplied, env.GATE_PASSWORD)) {
    const meta = clientMeta(request);
    await logEvent(env, { type: 'gate_failed', ip: meta.ip, user_agent: meta.ua });
    return html(gatePage({ error: 'That password is not right.' }), 401);
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': `${GATE_COOKIE}=${await gateToken(env)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}

// --- tracked links ------------------------------------------------------

function linkBase(request, env) {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
}

/**
 * Where a tracked link lands: the partners page, carrying who it was for.
 * `ref` is harmless if the partners page ignores it, and exact matching if it
 * captures it (docs/SIGNUPS.md, option C).
 */
function partnersUrl(handle) {
  const u = new URL(OUTREACH.partners_url);
  if (handle) u.searchParams.set('ref', handle);
  u.searchParams.set('utm_source', 'tiktok');
  u.searchParams.set('utm_medium', 'creator_outreach');
  return u.toString();
}

async function handleGo(request, env, token) {
  const link = await env.DB.prepare('SELECT * FROM links WHERE token = ?').bind(token).first();
  // An unknown or mistyped token still lands on the partners page: a creator
  // who wants to sign up should never hit an error because of our bookkeeping.
  if (!link) return Response.redirect(partnersUrl(null), 302);

  // Link-preview bots (Slack, iMessage, mail scanners) fetch links too. Count
  // them separately so "clicked" means a person, as far as we can tell.
  const meta = clientMeta(request);
  const bot = /bot|crawl|spider|preview|slurp|facebookexternalhit|whatsapp|telegram|skype|outlook|safelinks|proofpoint|mimecast|barracuda/i.test(meta.ua);
  const at = nowIso();
  if (!bot) {
    await env.DB.prepare(
      'UPDATE links SET click_count = click_count + 1, first_click_at = COALESCE(first_click_at, ?), last_click_at = ? WHERE token = ?'
    ).bind(at, at, token).run();
  }
  await logEvent(env, { type: bot ? 'link_prefetch' : 'link_click', handle: link.handle, detail: token, ip: meta.ip, user_agent: meta.ua });
  return Response.redirect(partnersUrl(link.handle), 302);
}

async function mintLink(env, request, handle) {
  const existing = await env.DB.prepare('SELECT token FROM links WHERE handle = ? ORDER BY created_at LIMIT 1').bind(handle).first();
  const token = existing?.token || randomToken();
  if (!existing) {
    await env.DB.prepare('INSERT INTO links (token, handle, created_at) VALUES (?,?,?)').bind(token, handle, nowIso()).run();
  }
  return { token, url: `${linkBase(request, env)}/go/${token}` };
}

// --- pipeline queries ---------------------------------------------------

const STATUS_TABS = {
  review: "status = 'shortlisted'",
  flagged: "status = 'flagged'",
  approved: "status = 'approved'",
  sent: "status = 'contacted'",
  replied: "status = 'replied'",
  signed: "status = 'signed'",
  skipped: "status IN ('skipped','blocked')",
  dropped: "status = 'dropped'",
  new: "status = 'new'",
  all: '1=1',
};

/**
 * Where one creator is in send -> wait -> follow up once -> stop, from the
 * messages actually sent to them and their tracked link's clicks.
 */
function contactHistory(sent, link) {
  if (!sent?.length) return null;
  sent = [...sent].sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
  const first = sent.find((r) => !r.followup_of) || sent[0];
  const last = sent[sent.length - 1];
  const followups = sent.filter((r) => r.followup_of);
  const days = Math.floor((Date.now() - Date.parse(last.sent_at)) / DAY_MS);
  const stage = !followups.length
    ? days >= FOLLOWUP_AFTER_DAYS ? 'followup_due' : 'waiting'
    : days >= QUIET_AFTER_DAYS ? 'quiet' : 'followed_up';
  return {
    stage,
    first_id: first.id,
    first_channel: first.channel,
    first_sent_at: first.sent_at,
    last_sent_at: last.sent_at,
    last_channel: last.channel,
    days_since: days,
    due_in: Math.max(0, FOLLOWUP_AFTER_DAYS - days),
    followups: followups.length,
    clicked_at: link?.first_click_at || null,
    click_count: link?.click_count || 0,
  };
}

const STAGE_ORDER = { followup_due: 0, waiting: 1, followed_up: 2, quiet: 3 };

async function relatedRows(env, handles) {
  if (!handles.length) return { outreach: {}, links: {} };
  const arr = JSON.stringify(handles);
  const [o, l] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM outreach WHERE handle IN (SELECT value FROM json_each(?)) ORDER BY id').bind(arr),
    env.DB.prepare('SELECT * FROM links WHERE handle IN (SELECT value FROM json_each(?))').bind(arr),
  ]);
  const outreach = {}, links = {};
  for (const r of o.results || []) (outreach[r.handle] ||= []).push(r);
  for (const r of l.results || []) links[r.handle] ||= r;
  return { outreach, links };
}

async function candidates(env, tab, { limit = 300, tier = '', q = '' } = {}) {
  const where = [STATUS_TABS[tab] || STATUS_TABS.review];
  const binds = [];
  if (['A', 'B', 'C', 'D'].includes(tier)) { where.push('tier = ?'); binds.push(tier); }
  if (q) {
    where.push("(handle LIKE ? OR nickname LIKE ? OR IFNULL(email,'') LIKE ?)");
    const like = `%${q.replace(/[%_]/g, '')}%`;
    binds.push(like, like, like);
  }
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT * FROM creators WHERE ${where.join(' AND ')} ORDER BY (score IS NULL), score DESC, discovered_at DESC LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 300, 1000)).all();

  const { outreach, links } = await relatedRows(env, rows.map((r) => r.handle));
  const out = rows.map((c) => {
    const all = outreach[c.handle] || [];
    const o = all[all.length - 1] || null;
    const draft = o || renderDraft(c);
    return {
      ...c,
      score_detail: c.score_detail ? safeJson(c.score_detail) : null,
      outreach: o,
      draft: {
        id: o?.id || null,
        template: draft.template || pickTemplate(c),
        channel: draft.channel || (c.email ? 'email' : 'tiktok_dm'),
        subject: draft.subject || '',
        message_text: draft.message_text,
        link_url: o?.link_url || '',
      },
      link: links[c.handle] || null,
      contact: contactHistory(all.filter((r) => r.sent_at), links[c.handle]),
    };
  });
  if (tab === 'sent') {
    out.sort((a, b) =>
      (STAGE_ORDER[a.contact?.stage] ?? 9) - (STAGE_ORDER[b.contact?.stage] ?? 9) ||
      String(a.contact?.last_sent_at).localeCompare(String(b.contact?.last_sent_at)));
  }
  return out;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function stats(env) {
  const [byStatus, sentRows, lastRun, clicks, signups] = await env.DB.batch([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM creators GROUP BY status'),
    env.DB.prepare("SELECT o.handle, o.sent_at, o.followup_of, o.id, o.channel FROM outreach o JOIN creators c ON c.handle = o.handle WHERE c.status = 'contacted' AND o.sent_at IS NOT NULL"),
    env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE click_count > 0'),
    env.DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN matched_handle IS NULL THEN 1 ELSE 0 END) AS unmatched, MAX(received_at) AS last_at FROM signups'),
  ]);
  const s = Object.fromEntries((byStatus.results || []).map((r) => [r.status, r.n]));
  const perHandle = {};
  for (const r of sentRows.results || []) (perHandle[r.handle] ||= []).push(r);
  const followupDue = Object.values(perHandle).filter((rows) => contactHistory(rows)?.stage === 'followup_due').length;
  const sig = signups.results?.[0] || {};
  return {
    review: s.shortlisted || 0,
    flagged: s.flagged || 0,
    approved: s.approved || 0,
    sent: s.contacted || 0,
    followup_due: followupDue,
    replied: s.replied || 0,
    signed: s.signed || 0,
    skipped: (s.skipped || 0) + (s.blocked || 0),
    dropped: s.dropped || 0,
    new: s.new || 0,
    total: Object.values(s).reduce((a, b) => a + b, 0),
    clicked: clicks.results?.[0]?.n || 0,
    signups_total: sig.total || 0,
    signups_unmatched: sig.unmatched || 0,
    signups_last_at: sig.last_at || null,
    webhook_configured: Boolean(env.SIGNUP_WEBHOOK_SECRET),
    last_run: lastRun.results?.[0] || null,
    templates: TEMPLATE_NAMES,
    unfinished_config: unfinishedConfig(),
    company: OUTREACH.company_name,
    sender_email: OUTREACH.sender_email,
    partners_url: OUTREACH.partners_url,
  };
}

async function getCreator(env, handle) {
  return env.DB.prepare('SELECT * FROM creators WHERE handle = ?').bind(normalizeHandle(handle)).first();
}

async function setStatus(env, handle, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE creators SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE handle = ?`)
    .bind(...keys.map((k) => fields[k]), nowIso(), handle).run();
}

async function firstSent(env, handle) {
  const { results = [] } = await env.DB.prepare('SELECT * FROM outreach WHERE handle = ? AND sent_at IS NOT NULL ORDER BY sent_at').bind(handle).all();
  return results.find((r) => !r.followup_of) || results[0] || null;
}

/**
 * The one follow-up. By email it threads under the first subject. As a DM to
 * someone first reached by email it is the full DM, since it is the first
 * thing they will have seen from us on TikTok.
 */
function followupDraft(c, first, channel) {
  const dm = channel === 'tiktok_dm';
  const template = dm && first.channel === 'email' ? 'tier-c-dm' : 'followup';
  const d = renderDraft(c, { template, link: first.link_url || LINK_PLACEHOLDER });
  const subject = dm ? '' : first.subject ? `Re: ${first.subject.replace(/^Re:\s*/i, '')}` : d.subject;
  return { template, channel: dm ? 'tiktok_dm' : 'email', subject, message_text: d.message_text };
}

// --- gated API (the pipeline page) ---------------------------------------

const api = {
  'GET /api/stats': async (req, env) => json(await stats(env)),

  'GET /api/candidates': async (req, env, url) => {
    const tab = url.searchParams.get('tab') || 'review';
    const creators = await candidates(env, tab, {
      limit: url.searchParams.get('limit'),
      tier: url.searchParams.get('tier') || '',
      q: (url.searchParams.get('q') || '').trim().slice(0, 60),
    });
    return json({ tab, creators });
  },

  'POST /api/preview': async (req, env, url, body) => {
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    return json(renderDraft(c, { template: body.template }));
  },

  /** Approve: create the tracked link, put it in the letter, queue it to send. */
  'POST /api/approve': async (req, env, url, body) => {
    const todo = unfinishedConfig();
    if (todo.length) {
      return json({ error: `Fill in config/outreach.json first (still TODO: ${todo.join(', ')}), then redeploy.` }, 400);
    }
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    const existing = await env.DB.prepare("SELECT id FROM outreach WHERE handle = ? AND status IN ('approved','sent')").bind(c.handle).first();
    if (existing) return json({ error: 'already approved', outreach_id: existing.id }, 409);

    const link = await mintLink(env, req, c.handle);
    const channel = body.channel === 'tiktok_dm' || body.channel === 'email' ? body.channel : (c.email ? 'email' : 'tiktok_dm');
    let text = typeof body.message_text === 'string' && body.message_text.trim()
      ? body.message_text
      : renderDraft(c, { template: body.template }).message_text;
    text = text.split(LINK_PLACEHOLDER).join(link.url).replace(/\{\{link\}\}/g, link.url);
    // If the link line was edited away, put it back: a letter without the
    // tracked link cannot be followed up or matched.
    if (!text.includes(link.url)) text = `${text.trimEnd()}\n\n${link.url}`;

    const now = nowIso();
    const r = await env.DB.prepare(
      `INSERT INTO outreach (handle, channel, template, subject, message_text, link_token, link_url, drafted_at, approved_at, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'approved')`
    ).bind(c.handle, channel, TEMPLATE_NAMES.includes(body.template) ? body.template : pickTemplate(c),
           channel === 'email' ? (body.subject || null) : null, text, link.token, link.url, now, now).run();
    await setStatus(env, c.handle, { status: 'approved' });
    await logEvent(env, { type: 'approved', handle: c.handle });
    return json({ ok: true, outreach_id: r.meta?.last_row_id, link_url: link.url, message_text: text });
  },

  'POST /api/status': async (req, env, url, body) => {
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    const allowed = ['shortlisted', 'skipped', 'blocked', 'approved', 'contacted', 'replied', 'signed', 'dropped'];
    if (!allowed.includes(body.status)) return json({ error: 'bad status' }, 400);
    // Un-approving: drop the unsent letter so the creator can be redrafted.
    if (body.status === 'shortlisted' && c.status === 'approved') {
      await env.DB.prepare("DELETE FROM outreach WHERE handle = ? AND status = 'approved' AND sent_at IS NULL").bind(c.handle).run();
    }
    await setStatus(env, c.handle, body.notes != null ? { status: body.status, notes: String(body.notes).slice(0, 2000) } : { status: body.status });
    await logEvent(env, { type: `status_${body.status}`, handle: c.handle });
    return json({ ok: true });
  },

  'POST /api/sent': async (req, env, url, body) => {
    const row = body.outreach_id
      ? await env.DB.prepare('SELECT * FROM outreach WHERE id = ?').bind(body.outreach_id).first()
      : await env.DB.prepare("SELECT * FROM outreach WHERE handle = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").bind(normalizeHandle(body.handle)).first();
    if (!row) return json({ error: 'no approved message for that creator' }, 404);
    await env.DB.prepare("UPDATE outreach SET sent_at = ?, status = 'sent' WHERE id = ?").bind(nowIso(), row.id).run();
    await setStatus(env, row.handle, { status: 'contacted' });
    await logEvent(env, { type: 'sent', handle: row.handle, detail: row.channel });
    return json({ ok: true });
  },

  'POST /api/followup-draft': async (req, env, url, body) => {
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    const first = await firstSent(env, c.handle);
    if (!first) return json({ error: 'nothing has been sent to this creator yet' }, 400);
    return json(followupDraft(c, first, body.channel));
  },

  'POST /api/followup': async (req, env, url, body) => {
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    const first = await firstSent(env, c.handle);
    if (!first) return json({ error: 'nothing has been sent to this creator yet' }, 400);
    const ch = body.channel === 'tiktok_dm' ? 'tiktok_dm' : 'email';
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO outreach (handle, channel, template, subject, message_text, link_token, link_url, drafted_at, approved_at, sent_at, status, followup_of)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'sent', ?)`
    ).bind(c.handle, ch, ch === 'tiktok_dm' && first.channel === 'email' ? 'tier-c-dm' : 'followup',
           ch === 'email' ? (body.subject || null) : null, String(body.message_text || ''), first.link_token, first.link_url,
           now, now, now, first.id).run();
    await setStatus(env, c.handle, { status: 'contacted' });
    await logEvent(env, { type: 'followup_sent', handle: c.handle, detail: ch });
    return json({ ok: true });
  },

  'POST /api/outcome': async (req, env, url, body) => {
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: 'unknown creator' }, 404);
    const outcome = ['replied', 'signed', 'declined'].includes(body.outcome) ? body.outcome : null;
    if (!outcome) return json({ error: 'bad outcome' }, 400);
    if (outcome === 'signed') {
      await markSigned(env.DB, c.handle);
    } else {
      await env.DB.prepare('UPDATE outreach SET outcome = ?, reply_at = ? WHERE handle = ? AND sent_at IS NOT NULL AND outcome IS NULL')
        .bind(outcome, nowIso(), c.handle).run();
      await setStatus(env, c.handle, { status: outcome === 'replied' ? 'replied' : 'skipped' });
    }
    await logEvent(env, { type: `outcome_${outcome}`, handle: c.handle });
    return json({ ok: true });
  },

  'GET /api/signups': async (req, env) => {
    const { results = [] } = await env.DB.prepare(
      `SELECT s.*, c.nickname AS creator_nickname, c.status AS creator_status
         FROM signups s LEFT JOIN creators c ON c.handle = s.matched_handle
        ORDER BY (s.matched_handle IS NOT NULL), s.received_at DESC LIMIT 1000`
    ).all();
    return json({ signups: results.map(({ raw, ...s }) => s), webhook_configured: Boolean(env.SIGNUP_WEBHOOK_SECRET) });
  },

  /** CSV export from wherever the partners form stores sign-ups. */
  'POST /api/signups/csv': async (req, env, url, body) => {
    const { headers, records } = parseCsv(body.csv);
    if (!records.length) return json({ error: 'No rows found. Is the first line a header row?' }, 400);
    if (records.length > 5000) return json({ error: 'Upload at most 5,000 rows at a time.' }, 400);
    const map = detectColumns(headers);
    if (!map.email && !map.tiktok_handle && !map.ref) {
      return json({ error: `Could not find an email, TikTok handle or ref column in: ${headers.join(', ')}` }, 400);
    }
    const tally = { matched: 0, unmatched: 0, duplicate: 0, skipped: 0 };
    const newlyMatched = [];
    for (const rec of records) {
      const r = await recordSignup(env.DB, toSignup(rec, map), { source: 'csv', raw: rec });
      tally[r.status]++;
      if (r.status === 'matched') newlyMatched.push(r.matched_handle);
    }
    await logEvent(env, { type: 'signups_csv', detail: { rows: records.length, ...tally } });
    return json({ ok: true, columns: map, rows: records.length, ...tally, newly_matched: newlyMatched });
  },

  'POST /api/signups/link': async (req, env, url, body) => {
    const s = await env.DB.prepare('SELECT * FROM signups WHERE id = ?').bind(Number(body.id)).first();
    if (!s) return json({ error: 'unknown sign-up' }, 404);
    const c = await getCreator(env, body.handle);
    if (!c) return json({ error: `no creator @${normalizeHandle(body.handle)} in the pipeline` }, 404);
    await env.DB.prepare("UPDATE signups SET matched_handle = ?, match_method = 'manual', matched_at = ? WHERE id = ?")
      .bind(c.handle, nowIso(), s.id).run();
    await markSigned(env.DB, c.handle);
    await logEvent(env, { type: 'signup_linked', handle: c.handle, detail: String(s.id) });
    return json({ ok: true });
  },

  'POST /api/signups/rematch': async (req, env) => json({ ok: true, matched: await rematchAll(env.DB) }),

  'GET /api/creators/search': async (req, env, url) => {
    const q = (url.searchParams.get('q') || '').trim().replace(/^@/, '').replace(/[%_]/g, '').slice(0, 40);
    if (q.length < 2) return json({ creators: [] });
    const like = `%${q}%`;
    const { results = [] } = await env.DB.prepare(
      "SELECT handle, nickname, status, email FROM creators WHERE handle LIKE ? OR nickname LIKE ? OR IFNULL(email,'') LIKE ? ORDER BY (status IN ('contacted','replied','approved')) DESC, score DESC LIMIT 10"
    ).bind(like, like, like).all();
    return json({ creators: results });
  },

  /** Everything, as a spreadsheet. */
  'GET /api/export.csv': async (req, env) => {
    const { results = [] } = await env.DB.prepare(
      `SELECT c.handle, c.nickname, c.status, c.tier, c.score, c.followers, c.engagement_rate, c.email, c.external_link,
              c.source_term, c.discovered_at, c.signed_at,
              (SELECT MIN(sent_at) FROM outreach o WHERE o.handle = c.handle) AS first_sent_at,
              (SELECT COUNT(*) FROM outreach o WHERE o.handle = c.handle AND o.followup_of IS NOT NULL) AS followups,
              l.click_count, l.first_click_at, c.notes
         FROM creators c LEFT JOIN links l ON l.handle = c.handle
        ORDER BY c.score DESC`
    ).all();
    const cols = ['handle', 'nickname', 'status', 'tier', 'score', 'followers', 'engagement_rate', 'email', 'external_link',
      'source_term', 'discovered_at', 'first_sent_at', 'followups', 'click_count', 'first_click_at', 'signed_at', 'notes'];
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...results.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="creator-pipeline-${nowIso().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  },
};

// --- admin API (the scraper) ---------------------------------------------

// Fields the scraper may write. Anything else in a payload is ignored.
const CREATOR_FIELDS = [
  'platform', 'source', 'source_term', 'enriched_at', 'nickname', 'bio', 'external_link', 'avatar_url',
  'email', 'ig_handle', 'verified', 'private_account', 'followers', 'following', 'total_likes', 'video_count',
  'avg_likes', 'engagement_rate', 'engagement_source', 'monetizing', 'credentialed', 'topical_fit', 'score',
  'score_detail', 'tier', 'status', 'drop_reason',
];
// Statuses the scraper owns. Once a person has acted on a creator (approved,
// skipped, contacted, ...), the scraper can update their numbers but never
// moves them.
const SCRAPER_STATUSES = ['new', 'shortlisted', 'flagged', 'dropped'];
const KEEP_FIRST = new Set(['source', 'source_term']);

function upsertStatement(db, raw) {
  const handle = normalizeHandle(raw.handle);
  if (!handle) return null;
  const fields = {};
  for (const k of CREATOR_FIELDS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v === null && k !== 'drop_reason') continue; // never blank out what we know
    if (k === 'status' && !SCRAPER_STATUSES.includes(v)) continue;
    fields[k] = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  }
  if (fields.email) fields.email = String(fields.email).trim().toLowerCase();
  const cols = Object.keys(fields);
  const now = nowIso();
  const owned = SCRAPER_STATUSES.map((s) => `'${s}'`).join(',');
  const sets = cols.map((k) => {
    if (KEEP_FIRST.has(k)) return `${k} = COALESCE(creators.${k}, excluded.${k})`;
    if (k === 'status') return `status = CASE WHEN creators.status IN (${owned}) THEN excluded.status ELSE creators.status END`;
    if (k === 'drop_reason') return `drop_reason = CASE WHEN creators.status IN (${owned}) THEN excluded.drop_reason ELSE creators.drop_reason END`;
    return `${k} = excluded.${k}`;
  });
  sets.push('updated_at = excluded.updated_at');
  return db.prepare(
    `INSERT INTO creators (handle, discovered_at, updated_at${cols.map((c) => `, ${c}`).join('')})
     VALUES (?, ?, ?${cols.map(() => ', ?').join('')})
     ON CONFLICT(handle) DO UPDATE SET ${sets.join(', ')}`
  ).bind(handle, now, now, ...cols.map((k) => fields[k]));
}

const admin = {
  /** Upsert up to 500 creators: { creators: [{ handle, ...fields }] } */
  'POST /admin/creators': async (req, env, url, body) => {
    const list = Array.isArray(body.creators) ? body.creators.slice(0, 500) : [];
    const handles = list.map((c) => normalizeHandle(c.handle)).filter(Boolean);
    const before = new Set();
    if (handles.length) {
      const { results = [] } = await env.DB.prepare('SELECT handle FROM creators WHERE handle IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(handles)).all();
      results.forEach((r) => before.add(r.handle));
    }
    const stmts = list.map((c) => upsertStatement(env.DB, c)).filter(Boolean);
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    // New creators or new emails can complete a sign-up that arrived first.
    const matched = (await env.DB.prepare('SELECT COUNT(*) AS n FROM signups WHERE matched_handle IS NULL').first())?.n
      ? await rematchAll(env.DB) : [];
    return json({ ok: true, upserted: stmts.length, created: handles.filter((h) => !before.has(h)).length, signups_matched: matched });
  },

  /** Creators to work on: ?status=new,shortlisted&limit=50&missing_email=1&has_link=1 */
  'GET /admin/creators': async (req, env, url) => {
    const statuses = (url.searchParams.get('status') || 'new').split(',').map((s) => s.trim()).filter(Boolean);
    const where = ['status IN (SELECT value FROM json_each(?))'];
    if (url.searchParams.get('missing_email') === '1') where.push("(email IS NULL OR email = '')");
    if (url.searchParams.get('has_link') === '1') where.push("external_link IS NOT NULL AND external_link <> ''");
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 5000);
    const { results = [] } = await env.DB.prepare(
      `SELECT * FROM creators WHERE ${where.join(' AND ')} ORDER BY (score IS NULL), score DESC, discovered_at LIMIT ?`
    ).bind(JSON.stringify(statuses), limit).all();
    return json({ creators: results });
  },

  /** Every handle already in the pipeline, so discovery can skip them. */
  'GET /admin/known-handles': async (req, env) => {
    const { results = [] } = await env.DB.prepare('SELECT handle FROM creators').all();
    return json({ handles: results.map((r) => r.handle) });
  },

  'GET /admin/runs': async (req, env, url) => {
    const kind = url.searchParams.get('kind') || 'pipeline';
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE kind = ?').bind(kind).first();
    return json({ kind, count: n?.n || 0 });
  },

  'POST /admin/runs': async (req, env, url, b) => {
    await env.DB.prepare(
      `INSERT INTO runs (kind, started_at, ended_at, terms_run, found, new_candidates, enriched, dropped, errors, ok)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(String(b.kind || 'pipeline'), b.started_at || nowIso(), b.ended_at || nowIso(),
           Array.isArray(b.terms_run) ? b.terms_run.join(', ') : b.terms_run ?? null,
           b.found ?? null, b.new_candidates ?? null, b.enriched ?? null, b.dropped ?? null,
           b.errors ? String(b.errors).slice(0, 4000) : null, b.ok ? 1 : 0).run();
    return json({ ok: true });
  },
};

// --- sign-up webhook -------------------------------------------------------

/**
 * POST /hooks/signup
 *
 * For ClarityTX's partners form (or Zapier/Make sitting behind it) to report
 * each new partner. Accepts JSON (one object or an array) or a form post.
 * Authenticated by SIGNUP_WEBHOOK_SECRET, sent as `Authorization: Bearer ...`
 * or, for tools that cannot set headers, as `?key=...`.
 */
async function handleSignupHook(request, env, url) {
  if (!env.SIGNUP_WEBHOOK_SECRET) return json({ error: 'sign-up webhook is not enabled (set SIGNUP_WEBHOOK_SECRET)' }, 503);
  const supplied = bearer(request) || url.searchParams.get('key') || '';
  if (!sameSecret(supplied, env.SIGNUP_WEBHOOK_SECRET)) return json({ error: 'unauthorized' }, 401);

  let records;
  const type = request.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) {
      const body = await request.json();
      records = Array.isArray(body) ? body : [body];
    } else {
      records = [Object.fromEntries((await request.formData()).entries())];
    }
  } catch {
    return json({ error: 'body must be JSON or a form post' }, 400);
  }
  records = records.filter((r) => r && typeof r === 'object').slice(0, 100);
  const results = [];
  for (const rec of records) {
    const r = await recordSignup(env.DB, toSignup(rec), { source: 'webhook', raw: rec });
    results.push(r);
    await logEvent(env, { type: `signup_${r.status}`, handle: r.matched_handle, detail: r.method || r.reason || null });
  }
  return json({ ok: true, results });
}

// --- router ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const key = `${request.method} ${path}`;

    try {
      const go = path.match(/^\/go\/([A-Za-z0-9]{4,40})$/);
      if (go && request.method === 'GET') return handleGo(request, env, go[1]);

      if (path === '/hooks/signup') {
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
        return handleSignupHook(request, env, url);
      }

      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });

      if (path.startsWith('/admin/')) {
        if (!env.ADMIN_TOKEN || !sameSecret(bearer(request), env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
        const fn = admin[key];
        if (!fn) return json({ error: 'not found' }, 404);
        const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
        return await fn(request, env, url, body);
      }

      if (key === 'POST /gate') return handleGateSubmit(request, env);
      if (key === 'GET /logout') {
        return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` } });
      }

      // Everything below is the team's page.
      if (!(await gatePassed(request, env))) {
        if (path.startsWith('/api/')) return json({ error: 'locked' }, 401);
        return html(gatePage({ configured: Boolean(env.GATE_PASSWORD) }), env.GATE_PASSWORD ? 200 : 503);
      }

      if (key === 'GET /') return html(UI);

      const fn = api[key];
      if (!fn) return json({ error: 'not found' }, 404);
      let body = {};
      if (request.method === 'POST') {
        // JSON only: a cross-site form cannot send this content type without a
        // CORS preflight, which this Worker never grants.
        if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'expected JSON' }, 415);
        body = await request.json().catch(() => ({}));
      }
      return await fn(request, env, url, body);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || 'server error' }, 500);
    }
  },
};
