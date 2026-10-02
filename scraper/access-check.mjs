#!/usr/bin/env node
/**
 * Diagnostic: what can the scraper still read from TikTok?
 *
 * When TikTok changes its web app the scraper tends to return nothing rather
 * than fail loudly. Run this when a run looks suspiciously empty.
 *
 *   npm run access-check
 */
import { withChrome } from './chrome.mjs';
import { settings } from './env.mjs';
import { warmUp, searchUsers, fetchProfile, sleep } from './tiktok.mjs';

const SAMPLE_TERM = 'functional medicine';
const results = [];

await withChrome(async ({ page }) => {
  await warmUp(page);
  const search = await searchUsers(page, SAMPLE_TERM, { scrolls: 1 });
  results.push(['user search (discovery)', search.handles.length > 1,
    search.captcha ? 'CAPTCHA shown' : `${search.handles.length} handles for "${SAMPLE_TERM}"`]);
  await sleep(4000);

  const handle = search.handles[0] || 'tiktok';
  const prof = await fetchProfile(page, handle);
  results.push(['profile stats (enrichment)', prof.ok,
    prof.ok ? `@${handle}: ${prof.profile.followers?.toLocaleString()} followers read` : prof.reason]);
  await sleep(4000);

  await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  await page.evaluate(() => window.scrollBy(0, 1200));
  await sleep(3000);
  const views = await page.evaluate(() => document.querySelectorAll('[data-e2e="video-views"]').length);
  results.push(['per-video views (optional)', views > 0, views ? `${views} view counts visible` : 'not visible, using the likes-based estimate (normal without login)']);
});

console.log(`\nChrome profile: ${settings.profileDir || 'fresh anonymous profile'}\n`);
for (const [what, ok, detail] of results) console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what.padEnd(32)} ${detail}`);
console.log('');
// Only the first two are required for the scraper to work.
process.exit(results.slice(0, 2).every(([, ok]) => ok) ? 0 : 1);
