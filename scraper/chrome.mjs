/**
 * Launches the real Chrome installed on this machine through puppeteer-core.
 *
 * Real, user-installed Chrome passes far more of TikTok's checks than a
 * bundled test browser, so this deliberately does very little: no
 * `--enable-automation` flag, no `navigator.webdriver` override (overriding it
 * is itself a tell), and `--disable-blink-features=AutomationControlled`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { settings } from './env.mjs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ],
};

export function findChrome() {
  if (settings.chromePath) {
    if (!fs.existsSync(settings.chromePath)) throw new Error(`CHROME_PATH does not exist: ${settings.chromePath}`);
    return settings.chromePath;
  }
  const hit = (CANDIDATES[process.platform] || []).find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('Google Chrome not found. Install it, or set CHROME_PATH in .env to the Chrome executable.');
  return hit;
}

/**
 * Open Chrome, run fn({ page, browser }), always close Chrome afterwards.
 * Without TIKTOK_PROFILE_DIR each run starts from a fresh, empty profile.
 */
export async function withChrome(fn, { headless = settings.headless } = {}) {
  const temp = settings.profileDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'creator-scraper-'));
  const userDataDir = settings.profileDir || temp;
  fs.mkdirSync(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    userDataDir,
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    // Headless differs from headed in a few observable ways; align them. The
    // user agent matters most: headless Chrome announces itself as
    // "HeadlessChrome", and TikTok answers searches from it with an error page.
    try { await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome')); } catch {}
    try { await page.emulateTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch {}
    try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }); } catch {}
    return await fn({ page, browser });
  } finally {
    await browser.close().catch(() => {});
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
