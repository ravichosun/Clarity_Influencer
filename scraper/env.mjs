/**
 * Settings for the scraper, read from .env in the repo root (copy
 * .env.example to start) or from the real environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) { console.warn(`could not read .env: ${e.message}`); }
}

export const settings = {
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  chromePath: process.env.CHROME_PATH || '',
  // A persistent Chrome profile directory. Leave empty for a fresh anonymous
  // profile every run. Set it and run `npm run tiktok-login` once to scrape
  // while logged in, which tends to mean fewer captchas and fuller search
  // results.
  profileDir: process.env.TIKTOK_PROFILE_DIR ? path.resolve(ROOT, process.env.TIKTOK_PROFILE_DIR) : '',
  headless: process.env.HEADLESS !== '0',
};

export function loadConfig() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
  return { scoring: read('scoring.json'), niches: read('niches.json') };
}

export const nowIso = () => new Date().toISOString();
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

export const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
export const flag = (name) => process.argv.includes(`--${name}`);
