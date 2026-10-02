/**
 * The scraper's only link to the pipeline page: the Worker's /admin API,
 * authenticated with ADMIN_TOKEN. The database lives in Cloudflare D1, so
 * nothing scraped is ever kept on this machine.
 */
import { settings } from './env.mjs';

export const apiConfigured = () => Boolean(settings.appUrl && settings.adminToken);

export function requireApi() {
  if (apiConfigured()) return;
  console.error('APP_URL and ADMIN_TOKEN must be set in .env (see .env.example and the README).');
  console.error('To try the scraper without the pipeline page, use --dry.');
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(`${settings.appUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${settings.adminToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (ADMIN_TOKEN in .env does not match the Worker secret)' : '';
    throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}${hint}`);
  }
  return data;
}

export const knownHandles = async () => new Set((await call('GET', '/admin/known-handles')).handles);
export const runCount = async (kind = 'pipeline') => (await call('GET', `/admin/runs?kind=${kind}`)).count;
export const recordRun = (run) => call('POST', '/admin/runs', run);

export async function getCreators({ status = 'new', limit = 100, missingEmail = false, hasLink = false } = {}) {
  const q = new URLSearchParams({ status, limit: String(limit) });
  if (missingEmail) q.set('missing_email', '1');
  if (hasLink) q.set('has_link', '1');
  return (await call('GET', `/admin/creators?${q}`)).creators;
}

/** Upsert creators in chunks. Each item needs at least { handle }. */
export async function pushCreators(creators) {
  let created = 0;
  for (let i = 0; i < creators.length; i += 200) {
    const r = await call('POST', '/admin/creators', { creators: creators.slice(i, i + 200) });
    created += r.created || 0;
  }
  return { created };
}
