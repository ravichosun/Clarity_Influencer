# Connecting sign-ups to the pipeline (optional)

**You can skip this whole page.** Without it, the pipeline still finds
creators, drafts letters, tracks who clicked their link and reminds you about
follow-ups. When someone signs up, you mark them yourself with the
**They signed up** button.

Connecting sign-ups does that marking automatically. It also stops anyone who
has already joined from getting a letter or a follow-up.

---

## How matching works

The partners page at `https://meetclaritytx.com/partners` is open to anyone,
and it doesn't know who a visitor is. The pipeline therefore matches each
sign-up to a creator using the details the person typed into the form, trying
the strongest evidence first:

| Order | Field | How it matches |
|---|---|---|
| 1 | `ref` | The tracked link sends people to `…/partners?ref=<tiktok handle>`. If the form saves that value (Option C below), the match is exact. |
| 2 | TikTok handle | The handle they typed, cleaned up first: `@Dr.Jane`, `dr.jane` and `https://www.tiktok.com/@dr.jane` all count as the same. |
| 3 | Email | The email they typed, compared without regard to case against the email address we wrote to. |

When a sign-up matches a creator:

- that creator moves to **Signed**;
- their pending follow-up is cancelled;
- if the scraper finds them again later, they are never re-pitched.

This also applies to someone who signs up on their own before you ever
contacted them. They are already a partner, so the pipeline records them that
way and doesn't write to them.

A sign-up that matches nobody appears under **Sign-ups → Unmatched**. These
are usually people who found the page by themselves. If you recognise one,
type the creator's handle and click **Link**.

New creators and newly found emails are checked against unmatched sign-ups
automatically, so a sign-up that arrives before the scraper has found that
creator still gets matched later.

**The better the form, the better the matching.** If the partners form asks
for a TikTok handle, most sign-ups will match. If it asks only for an email,
only creators whose email we found (and wrote to) will match. Adding a
"TikTok handle" field, and ideally the hidden `ref` field, is worth it.

---

## Option A: upload a CSV (no developer needed)

1. Export your partner sign-ups as a CSV from wherever the form saves them:
   your database, your CRM, a Google Sheet, Typeform, HubSpot, and so on.
2. On the pipeline page, open **Sign-ups** and click **Upload sign-ups CSV**.

Columns are recognised by name, so the export can be used as it is:

| What | Column names that are recognised (examples) |
|---|---|
| Email | `email`, `Email Address`, `E-mail` |
| TikTok handle | `tiktok`, `TikTok Handle`, `TikTok Username`, `handle`, `username`, `social handle` |
| Name | `name`, `Full Name`, `First Name` |
| Ref | `ref`, `referral`, `referral code`, `utm_content` |
| Date | `created_at`, `Submitted At`, `date`, `timestamp` |

Each file needs a header row, plus at least an email, TikTok or ref column.
Re-uploading the same people is harmless, because duplicates are recognised
and skipped. Upload a fresh export as often as you like.

---

## Option B: webhook (automatic)

Each new sign-up is sent to the pipeline the moment it happens.

### 1. Turn the webhook on

```bash
cd app
npx wrangler secret put SIGNUP_WEBHOOK_SECRET   # paste a long random value, e.g. from: openssl rand -hex 32
```

### 2. Send sign-ups to it

```
POST https://<your-pipeline-address>/hooks/signup
Authorization: Bearer <SIGNUP_WEBHOOK_SECRET>
Content-Type: application/json

{ "email": "jane@example.com", "tiktok_handle": "@dr.jane", "name": "Jane Smith", "ref": "dr.jane" }
```

- Every field is optional, but each sign-up needs at least an email, a
  TikTok handle or a ref.
- Field names are flexible: `tiktok`, `TikTok Username`, `Email Address` and
  similar names all work, as in the CSV.
- You can send one object or an array of up to 100.
- Form-encoded posts (`application/x-www-form-urlencoded`) are also accepted.
- Some tools can't set headers. For those, put the secret in the URL instead:
  `…/hooks/signup?key=<SIGNUP_WEBHOOK_SECRET>`.

**Keep the secret on a server.** Send the webhook from your backend or from
an automation tool, never from code running in the visitor's browser,
because anyone can read browser code.

Test it with curl:

```bash
curl -X POST "https://<your-pipeline-address>/hooks/signup" \
  -H "Authorization: Bearer $SIGNUP_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","tiktok_handle":"@someone"}'
# -> {"ok":true,"results":[{"status":"unmatched", ...}]}
```

The response reports `matched`, `unmatched` or `duplicate` for each sign-up.

### Sending it from your site's backend

If the partners form posts to your own server, add the call wherever a
sign-up is saved. For example, in a Next.js route handler or server action:

```js
// After the partner sign-up has been saved:
await fetch(`${process.env.CREATOR_PIPELINE_URL}/hooks/signup`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.CREATOR_PIPELINE_WEBHOOK_SECRET}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ email, tiktok_handle: tiktokHandle, name, ref }),
}).catch((e) => console.error('creator pipeline webhook failed', e)); // never block the sign-up on this
```

### Sending it from Zapier or Make

If the form saves sign-ups to a CRM, a Google Sheet, Airtable or a form tool:

1. **Trigger:** "New row", "New submission" or "New contact" in that tool.
2. **Action:** *Webhooks by Zapier → POST*, or Make's *HTTP → Make a request*.
   - URL: `https://<your-pipeline-address>/hooks/signup?key=<SIGNUP_WEBHOOK_SECRET>`
   - Payload type: JSON
   - Data: `email` → the email field, `tiktok_handle` → the TikTok field,
     `name` → the name field, `ref` → the ref field (if you have one)

---

## Option C: capture `ref` on the partners form (recommended add-on)

Every tracked link lands on:

```
https://meetclaritytx.com/partners?ref=<tiktok handle>&utm_source=tiktok&utm_medium=creator_outreach
```

If the form saves `ref` along with the sign-up, the match is exact even when
the person signs up with a different email and leaves the handle blank.
This works with Option A or B.

Add a hidden field, and fill it from the URL when the page loads. Keep the
value for the rest of the browser session in case they navigate away first:

```html
<input type="hidden" name="ref" id="partner-ref">
<script>
  (function () {
    var fromUrl = new URLSearchParams(location.search).get('ref');
    try { if (fromUrl) sessionStorage.setItem('partner_ref', fromUrl); } catch (e) {}
    var ref = fromUrl;
    try { ref = ref || sessionStorage.getItem('partner_ref'); } catch (e) {}
    if (ref) document.getElementById('partner-ref').value = ref;
  })();
</script>
```

The same thing in a React or Next.js form component:

```jsx
const [ref, setRef] = useState('');
useEffect(() => {
  const fromUrl = new URLSearchParams(window.location.search).get('ref');
  if (fromUrl) sessionStorage.setItem('partner_ref', fromUrl);
  setRef(fromUrl || sessionStorage.getItem('partner_ref') || '');
}, []);
// ...inside the form:
<input type="hidden" name="ref" value={ref} />
```

Then include `ref` in the CSV export or the webhook body.

The `utm_source` and `utm_medium` parameters also let your analytics tool
(Google Analytics, PostHog, and so on) report traffic from these letters
without any further setup.
