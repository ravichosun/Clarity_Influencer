/**
 * Connecting ClarityTX partner sign-ups back to the creators we wrote to.
 *
 * The partners page is open to anyone, so the only things linking a sign-up
 * to a creator are what the person typed into the form and, if ClarityTX adds
 * the optional hidden field, the `ref` their tracked link carried. Matching
 * tries the strongest evidence first:
 *
 *   1. ref     the ?ref=<handle> our /go/ link appended (exact, if captured)
 *   2. handle  the TikTok handle they typed, normalised
 *   3. email   the email they typed, against the email we wrote to
 *
 * Anything that does not match is kept as "unmatched" and can be linked to a
 * creator by hand on the Sign-ups tab. Nothing is ever thrown away.
 */

const nowIso = () => new Date().toISOString();

/**
 * "@Dr.Jane", "https://www.tiktok.com/@dr.jane?lang=en", "tiktok.com/@dr.jane"
 * and "dr.jane" all mean the same account.
 */
export function normalizeHandle(value) {
  let v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  const fromUrl = v.match(/tiktok\.com\/@([\w.\-]+)/);
  if (fromUrl) v = fromUrl[1];
  v = v.replace(/^@+/, '').replace(/[/?#].*$/, '').trim();
  return /^[\w.\-]{2,30}$/.test(v) ? v : '';
}

export function normalizeEmail(value) {
  const v = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
}

// Which incoming field means what. Matched against lowercased field names /
// CSV headers with spaces and punctuation removed.
const FIELD_PATTERNS = {
  email: [/^email$/, /^emailaddress$/, /^e?mail/, /email/],
  tiktok_handle: [/^tiktok(handle|username|user|account|url|profile)?$/, /tiktok/, /^handle$/, /^username$/, /social(handle|media)?/, /^(instagram|ig)?handle$/],
  name: [/^(full)?name$/, /^firstname$/, /name/],
  ref: [/^ref$/, /^referral(code)?$/, /^refcode$/, /^utmcontent$/, /ref/],
  signed_up_at: [/^(created|submitted|signedup|signup|date|timestamp)(at|on|date|time)?$/, /date|time/],
};

const squash = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map arbitrary field names onto ours. Each of our fields takes the first
 * source field that fits its most specific pattern.
 */
export function detectColumns(keys) {
  const flat = keys.map((k) => ({ k, s: squash(k) }));
  const used = new Set();
  const map = {};
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    for (const re of patterns) {
      const hit = flat.find(({ k, s }) => !used.has(k) && re.test(s));
      if (hit) { map[field] = hit.k; used.add(hit.k); break; }
    }
  }
  return map;
}

/** Turn one incoming record (webhook body or CSV row) into a sign-up. */
export function toSignup(record, map = detectColumns(Object.keys(record))) {
  const get = (f) => (map[f] ? String(record[map[f]] ?? '').trim() : '');
  return {
    email: normalizeEmail(get('email')),
    tiktok_handle: normalizeHandle(get('tiktok_handle')),
    name: get('name').slice(0, 200),
    ref: normalizeHandle(get('ref')) || get('ref').slice(0, 100),
    signed_up_at: get('signed_up_at') || null,
  };
}

/** Small RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, records };
}

/** Find the creator a sign-up belongs to, strongest evidence first. */
export async function findCreator(db, s) {
  const byHandle = (h) => db.prepare('SELECT handle, status FROM creators WHERE handle = ?').bind(h).first();
  if (s.ref) {
    const ref = normalizeHandle(s.ref);
    const c = ref && (await byHandle(ref));
    if (c) return { creator: c, method: 'ref' };
  }
  if (s.tiktok_handle) {
    const c = await byHandle(s.tiktok_handle);
    if (c) return { creator: c, method: 'handle' };
  }
  if (s.email) {
    const c = await db.prepare('SELECT handle, status FROM creators WHERE lower(email) = ? LIMIT 1').bind(s.email).first();
    if (c) return { creator: c, method: 'email' };
  }
  return null;
}

/** Mark a creator signed, and the outreach that got them there. */
export async function markSigned(db, handle, at = nowIso()) {
  await db.batch([
    db.prepare("UPDATE creators SET status = 'signed', signed_at = COALESCE(signed_at, ?), updated_at = ? WHERE handle = ?")
      .bind(at, nowIso(), handle),
    db.prepare("UPDATE outreach SET outcome = 'signed', reply_at = COALESCE(reply_at, ?) WHERE handle = ? AND outcome IS NULL")
      .bind(at, handle),
  ]);
}

/**
 * Store one sign-up and try to match it. Returns what happened, so the
 * webhook and the CSV upload can report it.
 *
 * The same person arriving twice (a re-uploaded CSV, a retried webhook) is
 * recognised by email, then handle, and ignored the second time.
 */
export async function recordSignup(db, s, { source, raw }) {
  const dedupe_key = s.email ? `e:${s.email}` : s.tiktok_handle ? `h:${s.tiktok_handle}` : s.ref ? `r:${s.ref}` : null;
  if (!dedupe_key) return { status: 'skipped', reason: 'no email, handle or ref' };

  const existing = await db.prepare('SELECT id, matched_handle FROM signups WHERE dedupe_key = ?').bind(dedupe_key).first();
  if (existing) return { status: 'duplicate', id: existing.id, matched_handle: existing.matched_handle };

  const match = await findCreator(db, s);
  const at = nowIso();
  const res = await db.prepare(
    `INSERT INTO signups (received_at, source, dedupe_key, signed_up_at, email, tiktok_handle, name, ref, raw, matched_handle, match_method, matched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(at, source, dedupe_key, s.signed_up_at || null, s.email || null, s.tiktok_handle || null, s.name || null,
         s.ref || null, JSON.stringify(raw ?? {}).slice(0, 4000),
         match?.creator.handle || null, match?.method || null, match ? at : null).run();

  if (match) await markSigned(db, match.creator.handle, s.signed_up_at && !isNaN(Date.parse(s.signed_up_at)) ? new Date(s.signed_up_at).toISOString() : at);
  return { status: match ? 'matched' : 'unmatched', id: res.meta?.last_row_id, matched_handle: match?.creator.handle || null, method: match?.method || null };
}

/** Try every unmatched sign-up again, e.g. after new creators or emails arrive. */
export async function rematchAll(db) {
  const { results = [] } = await db.prepare('SELECT * FROM signups WHERE matched_handle IS NULL').all();
  const matched = [];
  for (const s of results) {
    const m = await findCreator(db, s);
    if (!m) continue;
    await db.prepare('UPDATE signups SET matched_handle = ?, match_method = ?, matched_at = ? WHERE id = ?')
      .bind(m.creator.handle, m.method, nowIso(), s.id).run();
    await markSigned(db, m.creator.handle);
    matched.push(m.creator.handle);
  }
  return matched;
}
