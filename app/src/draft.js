/**
 * Turns a creator record into a letter.
 *
 * Fills only what is known for certain from the creator record and from
 * config/outreach.json. Nothing about a creator's content is invented: see
 * outreach/voice.md for why.
 */
import outreach from '../../config/outreach.json';
import { TEMPLATES, TEMPLATE_NAMES } from './templates.js';

export const OUTREACH = outreach;

/**
 * Shown in a draft until Approve creates the creator's tracked link.
 * Deliberately conspicuous, so a letter copied out before approval is
 * obviously unfinished rather than silently linkless.
 */
export const LINK_PLACEHOLDER = '[your tracked link is added when you click Approve]';

/** Config values still marked TODO. Approving is refused while any remain. */
export function unfinishedConfig() {
  return Object.entries(outreach)
    .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && /\bTODO\b/.test(v))
    .map(([k]) => k);
}

export function readableCount(n) {
  if (n == null) return 'your';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu;

/** Display name without emoji or decoration; falls back to @handle. */
export function cleanName(creator) {
  const stripped = String(creator.nickname || '')
    .replace(EMOJI_RE, ' ')
    // "Dr. Maria Lopez | Functional Medicine": keep the name, drop the tagline.
    .split(/\s+[|•·]\s+/)[0]
    .replace(/\s+/g, ' ')
    .replace(/^[\s|,.\-·•]+|[\s|,.\-·•]+$/g, '')
    .trim();
  return stripped.length >= 2 ? stripped : `@${creator.handle}`;
}

/**
 * Best guess at a first name, used only where one reads naturally.
 *
 * TikTok display names are often brands ("Gut Health Doc", "HormoneHealing").
 * "Hi Gut," reads as a mail merge, so anything that does not look like a
 * given name falls back to "there". A missed real name costs nothing; a wrong
 * one costs the email.
 */
const NOT_A_NAME = new Set([
  'wellness', 'health', 'healthy', 'healthcare', 'medical', 'medicine', 'functional',
  'integrative', 'holistic', 'naturopathic', 'naturopath', 'natural', 'root', 'cause',
  'nutrition', 'nutritionist', 'diet', 'dietitian', 'gut', 'hormone', 'hormones',
  'thyroid', 'metabolic', 'longevity', 'fertility', 'menopause', 'perimenopause',
  'autoimmune', 'healing', 'heal', 'herbal', 'herbalist', 'herbs', 'lab', 'labs',
  'supplement', 'supplements', 'doctor', 'dr', 'doc', 'nurse', 'practitioner',
  'physician', 'pharmacist', 'chiropractor', 'chiro', 'acupuncture', 'coach',
  'coaching', 'clinic', 'clinical', 'mental', 'chronic', 'women', 'womens', 'men',
  'mens', 'mom', 'mama', 'the', 'my', 'your', 'our', 'a', 'an', 'is', 'im', 'new',
  'best', 'real', 'daily', 'life', 'living', 'simply', 'official', 'team', 'group',
  'network', 'tips', 'facts', 'guide', 'journey', 'hub', 'kitchen', 'academy',
  'school', 'institute', 'center', 'centre', 'for', 'and', 'with', 'about',
  'education', 'educator', 'explained', 'care', 'fit', 'glow', 'vibes', 'club',
  'media', 'studio', 'page', 'balance', 'blood', 'sugar', 'whole', 'body', 'mind',
  'guru', 'expert', 'nerd', 'girl', 'gal', 'guy', 'lady', 'queen', 'king', 'boss', 'mentor',
  'wellbeing', 'nourish', 'nourished', 'thrive', 'vital', 'pure', 'clean', 'organic', 'plant',
]);

const HANDLE_TELLS = [
  'health', 'wellness', 'doctor', 'nurse', 'nutri', 'diet', 'clinic', 'medic',
  'functional', 'holistic', 'naturo', 'hormone', 'thyroid', 'gut', 'herb', 'coach',
  'fit', 'heal',
];

export function firstName(creator) {
  const cleaned = String(creator.nickname || '')
    .replace(EMOJI_RE, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\b(dr|doctor|md|do|nd|nmd|dc|rn|np|fnp|pa|rd|rdn|ldn|cns|pharmd|phd|lac|ifmcp|official|the)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const nameLike = (tok) => {
    const lower = tok.toLowerCase().replace(/[.'’-]/g, '');
    return (
      tok.length >= 3 &&
      tok.length <= 12 &&
      /^\p{L}/u.test(tok) &&
      !/\d/.test(tok) &&
      !tok.includes('.') &&
      !/[\u{1D400}-\u{1D7FF}]/u.test(tok) &&
      !NOT_A_NAME.has(lower) &&
      !HANDLE_TELLS.some((t) => lower.includes(t)) &&
      !(tok === tok.toUpperCase() && tok !== tok.toLowerCase())
    );
  };

  // Walk past recognised role words ("Functional Dietitian Sarah") but stop at
  // the first token we don't understand.
  for (const tok of cleaned.split(' ').filter(Boolean).slice(0, 3)) {
    if (nameLike(tok)) return tok[0].toUpperCase() + tok.slice(1);
    if (!NOT_A_NAME.has(tok.toLowerCase().replace(/[.'’-]/g, ''))) break;
  }
  return 'there';
}

export function pickTemplate(creator) {
  if (!creator.email) return 'tier-c-dm';
  if (creator.tier === 'A') return 'tier-a-manager-email';
  return 'tier-b-direct-email';
}

/**
 * Render a template for one creator. `link` is their tracked link once it
 * exists; before approval the placeholder stands in.
 */
export function renderDraft(creator, { template, link = LINK_PLACEHOLDER } = {}) {
  const name = TEMPLATES[template] ? template : pickTemplate(creator);
  const { meta, body } = TEMPLATES[name];
  const vars = {
    first_name: firstName(creator),
    display_name: cleanName(creator),
    handle: creator.handle,
    followers_readable: readableCount(creator.followers),
    link,
    company: outreach.company_name,
    offer: outreach.offer,
    sender_name: outreach.sender_name,
    sender_title: outreach.sender_title,
    sender_email: outreach.sender_email,
    mailing_address: outreach.mailing_address,
    product_url: outreach.product_url,
    partners_url: outreach.partners_url,
  };
  const fill = (s) => (s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return {
    template: name,
    channel: meta.channel || 'email',
    subject: fill(meta.subject),
    message_text: fill(body),
  };
}

export { TEMPLATE_NAMES };
