#!/usr/bin/env node
/**
 * Optional. Opens a visible Chrome window on the persistent profile in
 * TIKTOK_PROFILE_DIR so you can log in to TikTok once. Later scraper runs
 * reuse that session. Use a separate TikTok account made for this, not a
 * personal or company one: scraping always carries some risk of the account
 * being rate-limited.
 */
import readline from 'node:readline/promises';
import { settings } from './env.mjs';
import { withChrome } from './chrome.mjs';

if (!settings.profileDir) {
  console.error('Set TIKTOK_PROFILE_DIR in .env first (for example TIKTOK_PROFILE_DIR=.chrome-profile).');
  process.exit(2);
}
await withChrome(async ({ page }) => {
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Log in to TikTok in the Chrome window, then press Enter here to save and close. ');
  rl.close();
}, { headless: false });
console.log(`Saved. Scraper runs will now use the logged-in profile at ${settings.profileDir}`);
