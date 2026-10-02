#!/usr/bin/env node
/**
 * The scraper: DISCOVER -> ENRICH -> SCORE -> PUSH to the pipeline page.
 *
 * Read-only against TikTok. Nothing is sent to any creator from here; results
 * land on the pipeline page for a person to review.
 *
 *   npm run pipeline                      normal run
 *   npm run pipeline -- --dry             scrape and print, write nothing
 *   npm run pipeline -- --terms 3         fewer search terms this run
 *   npm run pipeline -- --max-enrich 20   fewer profile visits this run
 *   npm run pipeline -- --term "gut health doctor"   one specific search
 *   npm run pipeline -- --force           run even if a PAUSED file exists
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, nowIso, log, arg, flag } from './env.mjs';
import { apiConfigured, requireApi, knownHandles, runCount, recordRun, getCreators, pushCreators } from './api.mjs';
import { withChrome } from './chrome.mjs';
import { warmUp, searchUsers, fetchProfile, engagementFromTotals, pace } from './tiktok.mjs';
import { judge } from './score.mjs';

const DRY = flag('dry');
const cfg = loadConfig();
const TERMS_PER_RUN = Number(arg('terms', cfg.niches.terms_per_run || 6));
const MAX_ENRICH = Number(arg('max-enrich', 45));

// Kill switch for scheduled runs: create a file named PAUSED in the repo root
// (its contents are printed as the reason) and every run exits immediately.
const PAUSE_FILE = path.join(ROOT, 'PAUSED');
if (fs.existsSync(PAUSE_FILE) && !flag('force')) {
  console.log('Scraper is PAUSED (a file named PAUSED exists in the repo root). Exiting.');
  const why = fs.readFileSync(PAUSE_FILE, 'utf8').trim();
  if (why) console.log(`\n${why}\n`);
  console.log('Resume: delete PAUSED.   Run once anyway: npm run pipeline -- --force');
  process.exit(0);
}

if (!DRY) requireApi();

/** Rotate through the term list so consecutive runs cover different ground. */
async function pickTerms() {
  const one = arg('term', null);
  if (one) return [one];
  const all = cfg.niches.search_terms;
  const prior = apiConfigured() ? await runCount('pipeline').catch(() => 0) : 0;
  const start = (prior * TERMS_PER_RUN) % all.length;
  return Array.from({ length: Math.min(TERMS_PER_RUN, all.length) }, (_, i) => all[(start + i) % all.length]);
}

const started = nowIso();
const errors = [];
let found = 0, fresh = 0, enriched = 0, dropped = 0;
const results = [];
let terms = [];

try {
  terms = await pickTerms();
  log(`terms: ${terms.join(' | ')}`);
  const known = apiConfigured() ? await knownHandles() : new Set();
  log(`${known.size} creators already in the pipeline`);

  await withChrome(async ({ page }) => {
    // ---- DISCOVER ----------------------------------------------------------
    const discovered = [];
    await warmUp(page);
    for (const term of terms) {
      try {
        const res = await searchUsers(page, term);
        if (res.captcha) {
          errors.push(`captcha on search "${term}"`);
          log(`CAPTCHA on "${term}", stopping discovery for this run`);
          break;
        }
        found += res.handles.length;
        const newOnes = res.handles.filter((h) => !known.has(h) && !discovered.some((d) => d.handle === h));
        newOnes.forEach((h) => discovered.push({ handle: h, source: 'search', source_term: term }));
        log(`search "${term}": ${res.handles.length} handles, ${newOnes.length} new`);
      } catch (e) {
        errors.push(`search "${term}": ${e.message}`);
        log(`search "${term}" failed: ${e.message}`);
      }
      await pace();
    }
    fresh = discovered.length;
    if (!DRY && discovered.length) await pushCreators(discovered);

    // ---- ENRICH + SCORE ----------------------------------------------------
    // Everything still 'new', oldest first, including leftovers from runs that
    // stopped early.
    const queue = DRY ? discovered.slice(0, MAX_ENRICH) : await getCreators({ status: 'new', limit: MAX_ENRICH });
    log(`enriching ${queue.length} profiles`);
    let consecutiveFailures = 0;
    for (const c of queue) {
      try {
        const res = await fetchProfile(page, c.handle);
        if (!res.ok) {
          consecutiveFailures++;
          if (res.reason === 'captcha' || consecutiveFailures >= 5) {
            errors.push(`enrichment stopped after ${consecutiveFailures} failures (${res.reason})`);
            log(`stopping enrichment: ${res.reason}`);
            break; // leave them 'new' so a later run retries
          }
          const row = { handle: c.handle, enriched_at: nowIso(), status: 'dropped', drop_reason: res.reason };
          results.push(row);
          if (!DRY) await pushCreators([row]);
          dropped++;
          await pace();
          continue;
        }
        consecutiveFailures = 0;
        const p = res.profile;
        const eng = engagementFromTotals({ totalLikes: p.totalLikes, videoCount: p.videoCount, followers: p.followers });
        const fields = {
          handle: c.handle,
          enriched_at: nowIso(),
          nickname: p.nickname,
          bio: p.bio,
          external_link: p.bioLink,
          avatar_url: p.avatar,
          email: p.email,
          ig_handle: p.ig_handle,
          verified: p.verified ? 1 : 0,
          private_account: p.privateAccount ? 1 : 0,
          followers: p.followers,
          following: p.following,
          total_likes: p.totalLikes,
          video_count: p.videoCount,
          ...eng,
        };
        const row = { ...fields, ...judge({ ...c, ...fields }, cfg) };
        if (row.status === 'dropped') dropped++;
        results.push(row);
        if (!DRY) await pushCreators([row]);
        enriched++;
        log(`  @${c.handle}: ${p.followers?.toLocaleString() ?? '?'} followers -> ${row.status}${row.score != null ? ` (score ${row.score}, tier ${row.tier})` : ''}${row.drop_reason ? `: ${row.drop_reason}` : ''}`);
      } catch (e) {
        errors.push(`enrich @${c.handle}: ${e.message}`);
        log(`  @${c.handle} failed: ${e.message}`);
      }
      await pace();
    }
  });
} catch (e) {
  errors.push(`fatal: ${e.message}`);
  console.error('FATAL:', e.message);
}

const shortlisted = results.filter((r) => r.status === 'shortlisted').length;
if (!DRY) {
  await recordRun({
    kind: 'pipeline', started_at: started, ended_at: nowIso(), terms_run: terms,
    found, new_candidates: fresh, enriched, dropped, errors: errors.join(' | ') || null, ok: errors.length === 0,
  }).catch((e) => console.error(`could not record the run: ${e.message}`));
} else {
  console.log('\nDry run, nothing written. Top results:');
  for (const r of results.filter((x) => x.score != null).sort((a, b) => b.score - a.score).slice(0, 15)) {
    console.log(`  ${String(r.score).padStart(5)}  ${r.tier}  @${r.handle.padEnd(26)} ${String(r.followers ?? '?').padStart(9)} followers  ${r.status}${r.email ? '  ' + r.email : ''}`);
  }
}
log(`done. found=${found} new=${fresh} enriched=${enriched} shortlisted=${shortlisted} dropped=${dropped} errors=${errors.length}`);
if (errors.length) log(`errors: ${errors.join(' | ')}`);
process.exit(errors.some((e) => e.startsWith('fatal')) ? 1 : 0);
