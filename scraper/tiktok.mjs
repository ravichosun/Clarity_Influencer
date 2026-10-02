/**
 * Reading TikTok. Read-only by design: nothing here posts, follows or messages.
 *
 * What works without a login (re-check with `npm run access-check`):
 *   - Profile pages. The #__UNIVERSAL_DATA_FOR_REHYDRATION__ JSON carries
 *     followers, following, total likes, video count, bio, bio link, verified.
 *   - /search/user?q=<term>. Around 10 handles per query, sometimes flaky.
 * What does not:
 *   - Hashtag pages (/tag/<x>) render empty.
 *   - The per-video grid on a profile, so per-video view counts need a
 *     logged-in profile. See engagementFromTotals below.
 *
 * TikTok changes its web app often. If a run suddenly finds nothing, run
 * `npm run access-check` first: it reports which of these still work.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

/** Human-ish pacing between page loads. */
export const pace = () => sleep(jitter(4000, 9000));

const CAPTCHA_RE = /verify to continue|captcha|security check|slide to verify|drag the slider/i;

async function captchaShown(page) {
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
  return CAPTCHA_RE.test(text);
}

const ERROR_RE = /something went wrong|something wrong with the server/i;

/**
 * Open TikTok's home page once before searching. A brand-new browser profile
 * has none of the cookies TikTok sets on a first visit, and its search answers
 * a cold profile with "Something went wrong". One ordinary page view fixes that.
 */
export async function warmUp(page) {
  try {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(jitter(6000, 9000));
  } catch { /* a failed warm-up just means the first search may need its retry */ }
}

const collectHandles = (page) => page.evaluate(() => {
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/@"]')) {
    const m = (a.getAttribute('href') || '').match(/\/@([\w.\-]{2,30})(?:$|[/?])/);
    if (m) seen.add(m[1].toLowerCase());
  }
  return [...seen];
});

/**
 * Search TikTok's Users tab for a term. Returns unique handles. Retries once:
 * TikTok intermittently returns an empty results shell.
 */
export async function searchUsers(page, term, { scrolls = 3, attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(`https://www.tiktok.com/search/user?q=${encodeURIComponent(term)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(jitter(5000, 8000));
    if (await captchaShown(page)) return { captcha: true, handles: [] };
    // TikTok's own error panel has a "Try again" button that usually works.
    if (ERROR_RE.test(await page.evaluate(() => document.body?.innerText || ''))) {
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /try again/i.test(b.innerText))?.click());
      await sleep(jitter(6000, 9000));
    }
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await sleep(jitter(2500, 4500));
    }
    const handles = await collectHandles(page);
    if (handles.length) return { captcha: false, handles };
    if (attempt < attempts) await sleep(jitter(8000, 15000));
  }
  return { captcha: false, handles: [] };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const IG_RE = /(?:instagram|ig|insta)\s*[:@]?\s*@?([\w.]{3,30})/i;

/** The facts about one creator, from their profile page. */
export async function fetchProfile(page, handle) {
  await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(jitter(3500, 6000));
  if (await captchaShown(page)) return { ok: false, reason: 'captcha' };

  const raw = await page.evaluate(() => {
    const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return null;
    let scope;
    try { scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__ || {}; } catch { return null; }
    const info = scope['webapp.user-detail']?.userInfo;
    if (!info?.user?.uniqueId) return null;
    const u = info.user, s = info.stats || {};
    return {
      nickname: u.nickname,
      signature: u.signature || '',
      bioLink: u.bioLink?.link || null,
      verified: !!u.verified,
      privateAccount: !!u.privateAccount,
      avatar: u.avatarMedium || u.avatarThumb || null,
      followers: s.followerCount ?? null,
      following: s.followingCount ?? null,
      // `heart` is reliable; `heartCount` overflows int32 on huge accounts.
      totalLikes: s.heart ?? s.heartCount ?? null,
      videoCount: s.videoCount ?? null,
    };
  });
  if (!raw) return { ok: false, reason: 'not found or blocked' };

  const bio = raw.signature || '';
  const ig = bio.match(IG_RE);
  return {
    ok: true,
    profile: { ...raw, bio, email: (bio.match(EMAIL_RE) || [null])[0], ig_handle: ig ? ig[1] : null },
  };
}

/**
 * ENGAGEMENT
 *
 * Without a login, per-video views are not visible, so engagement is average
 * likes per video divided by followers. It still exposes bought-follower
 * accounts (huge followings, tiny like totals), but it is a lifetime average,
 * so one old viral video flatters an account that has gone quiet. The scoring
 * config distrusts implausibly high values for that reason.
 */
export function engagementFromTotals({ totalLikes, videoCount, followers }) {
  if (!followers || !videoCount || !totalLikes || videoCount <= 0) {
    return { avg_likes: null, engagement_rate: null, engagement_source: 'unknown' };
  }
  const avg = totalLikes / videoCount;
  return { avg_likes: avg, engagement_rate: avg / followers, engagement_source: 'lifetime_likes_proxy' };
}
