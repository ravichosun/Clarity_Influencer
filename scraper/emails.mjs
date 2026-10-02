#!/usr/bin/env node
/**
 * Find business emails on the page each creator links from their bio
 * (Linktree, Beacons, Stan, their own site). Creators who want brand deals put
 * a booking address there on purpose; it turns a TikTok DM into an email.
 *
 * Conservative: at most one address per page, and only one that is tied to
 * the creator (their name, their handle, or their own domain). A wrong
 * address is worse than none: it is a letter to a stranger.
 *
 *   npm run emails                    find and save
 *   npm run emails -- --dry           find and print only
 *   npm run emails -- --limit 20
 */
import { arg, flag, settings, loadConfig } from './env.mjs';
import { requireApi, getCreators, pushCreators } from './api.mjs';
import { judge } from './score.mjs';

requireApi();
const DRY = flag('dry');
const LIMIT = Number(arg('limit', '500')) || 500;
const CONCURRENCY = 4;
const cfg = loadConfig();
const TIMEOUT_MS = 12000;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STRICT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Domains that belong to a platform the creator uses, not to the creator.
const PLATFORM_DOMAINS = [
  'meetclaritytx.com',
  'linktr.ee', 'linktree.com', 'komi.io', 'beacons.ai', 'stan.store', 'solo.to', 'shopmy.us',
  'patreon.com', 'gofundme.com', 'cash.app', 'venmo.com', 'paypal.com', 'fullscript.com',
  'substack.com', 'mailchimp.com', 'convertkit.com', 'kajabi.com', 'teachable.com', 'calendly.com',
  'shopify.com', 'squarespace.com', 'wix.com', 'wordpress.com', 'godaddy.com',
  'instagram.com', 'facebook.com', 'tiktok.com', 'youtube.com', 'twitter.com', 'x.com',
  'amazon.com', 'google.com', 'apple.com', 'microsoft.com', 'cloudflare.com',
  'sentry.io', 'hotjar.com', 'intercom.io', 'zendesk.com',
];
const REJECT = [
  /^(no-?reply|do-?not-?reply|postmaster|abuse|webmaster|privacy|legal|dmca|support|help)@/i,
  /@(sentry\.|wixpress|example\.|test\.|email\.com$|domain\.com$|yourdomain|company\.com$)/i,
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /^[0-9a-f]{16,}@/i,
  /^u00[0-9a-f]{2}/i, // escaped JSON artefacts
];
const PREFER = [
  /^(booking|bookings|business|biz|brand|brands|partnerships|collab|collabs|management|mgmt|media|press|inquiries|enquiries)@/i,
  /^(hello|hi|contact|info|team)@/i,
];

function usable(e) {
  const email = String(e).trim().toLowerCase();
  if (!STRICT_EMAIL.test(email) || email.length > 120) return false;
  if (REJECT.some((re) => re.test(email))) return false;
  const domain = email.split('@')[1] || '';
  return !PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

/** How likely an address is to be this creator's, and whether anything ties it to them at all. */
function scoreEmail(email, { handle, nickname, link }) {
  const [local, domain] = email.toLowerCase().split('@');
  let score = 0, identified = false;
  PREFER.forEach((re, i) => { if (re.test(email)) { score += 30 - i * 10; identified = true; } });
  try {
    const host = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.replace(/^www\./, '');
    if (domain === host) { score += 40; identified = true; }
  } catch {}
  const flat = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const l = flat(local), d = flat(domain.split('.')[0]), h = flat(handle), n = flat(nickname);
  const ties = (a, b) => a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
  if (h && (ties(l, h) || ties(d, h))) { score += 25; identified = true; }
  if (n.length > 4 && (ties(l, n) || ties(d, n))) { score += 20; identified = true; }
  const first = flat(String(nickname || '').trim().split(/\s+/)[0]);
  if (first.length > 4 && (l.includes(first) || d.includes(first))) { score += 15; identified = true; }
  if (/^(gmail|yahoo|hotmail|outlook|icloud|proton(mail)?|aol)\./.test(domain)) score -= 5;
  return { score, identified };
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.startsWith('http') ? url : `https://${url}`, {
      redirect: 'follow',
      signal: ctrl.signal,
      // Identifies itself honestly. No email in here: pages echo the user agent.
      headers: { 'user-agent': `CreatorPipelineBot/1.0 (+${settings.appUrl || 'https://meetclaritytx.com'})`, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    if (!/html|json|text/i.test(res.headers.get('content-type') || '')) return { ok: false, reason: 'not html' };
    return { ok: true, body: (await res.text()).slice(0, 800_000) };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

function harvest(body, ctx) {
  const found = new Map();
  for (const m of body.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    let e;
    try { e = decodeURIComponent(m[1]).trim().replace(/^(mailto:)+/i, ''); } catch { continue; }
    if (!usable(e)) continue;
    const r = scoreEmail(e, ctx);
    if (r.identified) found.set(e.toLowerCase(), r.score + 15);
  }
  for (const m of body.matchAll(EMAIL_RE)) {
    const e = m[0].replace(/[.,;:)]+$/, '');
    if (!usable(e) || found.has(e.toLowerCase())) continue;
    const r = scoreEmail(e, ctx);
    if (r.identified) found.set(e.toLowerCase(), r.score);
  }
  return found.size ? [...found.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
}

const targets = (await getCreators({ status: 'shortlisted,flagged', limit: LIMIT, missingEmail: true, hasLink: true }));
console.log(`${targets.length} creators with a bio link and no email${DRY ? ' (dry run)' : ''}\n`);
const tally = { found: 0, none: 0, failed: 0 };
const updates = [];

async function work(c) {
  const ctx = { handle: c.handle, nickname: c.nickname, link: c.external_link };
  let email = (c.external_link.match(EMAIL_RE) || []).find(usable) || null;
  if (!email) {
    const page = await fetchPage(c.external_link);
    if (!page.ok) { tally.failed++; console.log(`  ..  @${c.handle.padEnd(26)} ${page.reason}`); return; }
    email = harvest(page.body, ctx);
  }
  if (!email) { tally.none++; console.log(`  --  @${c.handle.padEnd(26)} nothing on ${c.external_link.slice(0, 48)}`); return; }
  tally.found++;
  // Re-score too: an email raises contactability and monetizability.
  updates.push({ handle: c.handle, email, ...judge({ ...c, email }, cfg) });
  console.log(`  OK  @${c.handle.padEnd(26)} ${email}`);
}

const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) await work(queue.shift()); }));
if (!DRY && updates.length) await pushCreators(updates);
console.log(`\n${tally.found} found${DRY ? '' : ' and saved'}, ${tally.none} pages with nothing, ${tally.failed} unreachable`);
