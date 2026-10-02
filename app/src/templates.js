/**
 * The outreach templates, bundled into the Worker as text.
 *
 * They live in /outreach/templates so they can be edited without touching code.
 * To add one: create the .md file there, import it below, add it to TEMPLATES,
 * and redeploy.
 */
import tierA from '../../outreach/templates/tier-a-manager-email.md';
import tierB from '../../outreach/templates/tier-b-direct-email.md';
import tierC from '../../outreach/templates/tier-c-dm.md';
import followup from '../../outreach/templates/followup.md';

const RAW = {
  'tier-b-direct-email': tierB,
  'tier-a-manager-email': tierA,
  'tier-c-dm': tierC,
  followup,
};

function parse(name, raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: { name }, body: text.trim() };
  const meta = Object.fromEntries(
    m[1].split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
  );
  return { meta, body: m[2].trim() };
}

export const TEMPLATES = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, parse(k, v)]));
export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
