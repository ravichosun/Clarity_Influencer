#!/usr/bin/env node
/**
 * Re-score everyone still waiting for review after you change
 * config/scoring.json or config/niches.json. Creators a person has already
 * acted on (approved, skipped, contacted, ...) are left alone.
 *
 *   npm run rescore            npm run rescore -- --dry
 */
import { loadConfig, flag } from './env.mjs';
import { requireApi, getCreators, pushCreators } from './api.mjs';
import { judge } from './score.mjs';

requireApi();
const DRY = flag('dry');
const cfg = loadConfig();
const creators = (await getCreators({ status: 'shortlisted,flagged,dropped', limit: 5000 })).filter((c) => c.enriched_at && c.followers != null);
const updates = [];
const moved = {};
for (const c of creators) {
  const j = judge(c, cfg);
  // Profile-level failures (blocked, not found) have no numbers to re-judge.
  if (c.status === 'dropped' && c.followers == null) continue;
  if (j.status !== c.status) moved[`${c.status} -> ${j.status}`] = (moved[`${c.status} -> ${j.status}`] || 0) + 1;
  updates.push({ handle: c.handle, ...j });
}
if (!DRY) await pushCreators(updates);
console.log(`${DRY ? 'Would re-score' : 'Re-scored'} ${updates.length} creators.`);
for (const [k, n] of Object.entries(moved)) console.log(`  ${k}: ${n}`);
