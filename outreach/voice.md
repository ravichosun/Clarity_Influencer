# Outreach voice

These are the rules the templates in `templates/` follow. Keep to them when you
edit a template or rewrite a draft on the pipeline page.

1. **Be honest about how you found them.** "I came across your TikTok" is true.
   "I loved your video on X" is only true if someone watched it. Never invent
   a detail.
2. **Short beats complete.** Three short paragraphs, one link, a sign-off.
3. **One link.** Always the tracked `{{link}}`. A second link splits attention
   and is not tracked.
4. **State the offer plainly, once.** Whatever partners earn, say it in one
   sentence, with no hype words ("insane", "life-changing", "passive income
   machine").
5. **No pressure.** No deadlines, no "spots are limited" unless that is true.
6. **No medical claims.** ClarityTX supports clinician judgment. It does not
   diagnose or treat, and letters must not imply it does.
7. **Make it easy to say no.** Every email ends with a plain opt-out line, and
   anyone who asks not to be contacted gets **Block** on the pipeline page.
8. **One follow-up only.** After that, leave it.
9. **No emoji** in subjects or bodies. Display names are cleaned of emoji
   automatically before they go into a letter.
10. **Real sender.** Letters go out from a real person's mailbox, by hand, at
    human volume (tens a day, not hundreds).

## Placeholders

| Placeholder | Filled with |
|---|---|
| `{{first_name}}` | The creator's first name when their display name clearly contains one, otherwise "there" |
| `{{display_name}}` | Display name without emoji, or `@handle` |
| `{{handle}}` | TikTok handle without the @ |
| `{{followers_readable}}` | e.g. `48k`, `1.2M` |
| `{{link}}` | Their personal tracked link. It is created when you click **Approve**; before that the draft shows a placeholder |
| `{{company}}`, `{{offer}}`, `{{sender_name}}`, `{{sender_title}}`, `{{sender_email}}`, `{{mailing_address}}`, `{{product_url}}`, `{{partners_url}}` | From `config/outreach.json` |

## Which template a creator gets

- No email address found: `tier-c-dm` (sent as a TikTok DM)
- Tier A (250k+ followers) with email: `tier-a-manager-email` (written to a manager)
- Everyone else with email: `tier-b-direct-email`
- Follow-up: `followup`

To add a template, drop a new `.md` file in `templates/` with the same
frontmatter, add it to the list in `app/src/templates.js`, and redeploy.
