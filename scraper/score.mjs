/**
 * Transparent weighted scoring. Every component is stored with the total
 * (score_detail) so the pipeline page can show why a creator ranked where they
 * did. Weights, tiers and thresholds live in config/scoring.json; keywords in
 * config/niches.json.
 */
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Whole-word-ish matching, so the credential "nd" does not match "and".
const hits = (text, words) => words.filter((w) => {
  const k = w.toLowerCase().trim();
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(text);
}).length;

export function scoreCreator(c, { scoring, niches }) {
  const hay = `${c.nickname || ''} ${c.bio || ''}`.toLowerCase();

  // Reach: log-scaled, so 40k engaged followers are not buried by 2M passive.
  const reach = c.followers > 0
    ? clamp01((Math.log10(c.followers) - scoring.reach_scale.log_min) / (scoring.reach_scale.log_max - scoring.reach_scale.log_min))
    : 0;

  // Engagement: linear from floor to target. Implausibly high values from the
  // lifetime-likes proxy are scored as 0.5 and flagged rather than maxed out.
  const er = c.engagement_rate;
  const distrust = scoring.engagement_scale.distrust_above ?? 0.35;
  let engagement = er == null ? 0
    : clamp01((er - scoring.engagement_scale.floor) / (scoring.engagement_scale.target - scoring.engagement_scale.floor));
  let engagement_unreliable = false;
  if (er != null && c.engagement_source !== 'observed_views' && er > distrust) { engagement = 0.5; engagement_unreliable = true; }

  const topical = clamp01(hits(hay, niches.topical_keywords) / 3);

  // Creators who already sell something convert on a partner offer far better.
  const monetHits = hits(hay, niches.monetization_keywords);
  const monetizability = clamp01((monetHits / 2) * 0.6 + (c.external_link ? 0.3 : 0) + (c.email ? 0.1 : 0));

  // A published email is the difference between a letter and a DM.
  const contactability = c.email ? 1 : c.external_link ? 0.4 : 0.1;

  const credHits = hits(hay, niches.credential_keywords);
  const credibility = clamp01(credHits / 2) * 0.8 + (c.verified ? 0.2 : 0);

  const parts = { reach_log_scaled: reach, engagement_rate: engagement, topical_fit: topical, monetizability, contactability, credibility };
  const total = Object.entries(scoring.weights).reduce((sum, [k, w]) => sum + w * (parts[k] ?? 0), 0);

  const t = scoring.tiers;
  const tier = c.followers >= t.A.min_followers ? 'A' : c.followers >= t.B.min_followers ? 'B' : c.followers >= t.C.min_followers ? 'C' : 'D';

  const flags = niches.exclusions.bio_keywords.filter((w) => hits(hay, [w]));
  if (engagement_unreliable) flags.push('engagement proxy unreliable, verify by hand');

  return {
    score: Math.round(total * 1000) / 10,
    tier,
    topical_fit: Math.round(topical * 100) / 100,
    credentialed: credHits > 0 ? 1 : 0,
    monetizing: monetHits > 0 || c.external_link ? 1 : 0,
    score_detail: JSON.stringify({
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      weights: scoring.weights,
      flags,
    }),
    flags,
  };
}

/** A drop reason, or null if the creator survives. */
export function hardDrop(c, { scoring }) {
  const hd = scoring.hard_drops;
  if (hd.drop_private && c.private_account) return 'private account';
  if (c.followers != null && c.followers < hd.min_followers) return `under ${hd.min_followers.toLocaleString()} followers`;
  if (c.engagement_rate != null && c.engagement_rate < hd.min_engagement_rate) {
    return `engagement ${(c.engagement_rate * 100).toFixed(2)}% below floor`;
  }
  return null;
}

/** The status and score fields for an enriched creator. */
export function judge(c, cfg) {
  const drop = hardDrop(c, cfg);
  if (drop) return { status: 'dropped', drop_reason: drop };
  const s = scoreCreator(c, cfg);
  return {
    score: s.score,
    tier: s.tier,
    topical_fit: s.topical_fit,
    credentialed: s.credentialed,
    monetizing: s.monetizing,
    score_detail: s.score_detail,
    status: s.flags.length ? 'flagged' : 'shortlisted',
    drop_reason: s.flags.length ? `bio flags: ${s.flags.join(', ')}` : null,
  };
}
