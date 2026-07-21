# Firebase Auth: Password Reset Email Template

**Where this goes:** Firebase Console → Authentication → Templates → Password reset
**Catalog key (dormant):** `auth.password.reset`
**Format:** Firebase-native variables only (`%DISPLAY_NAME%`, `%EMAIL%`, `%LINK%`, `%APP_NAME%`)
**Voice dial:** Security / Account (gracious-formal gravitas, not nonchalant)

> Firebase strips a lot of HTML and only honors its four built-in tokens. The "secure my account and notify Tribe Tails" CTA is therefore a hardcoded URL, not a Firebase placeholder. That URL must point to a Tribe Tails endpoint that (a) starts a password change flow AND (b) fires an internal alert to the team for investigation. Spec for that endpoint is in the Open Questions section at the bottom.

---

## Sender

| Field | Value |
|---|---|
| **Sender name** | Auntie at Tribe Tails |
| **From** | `noreply@auntieos-ttpc.firebaseapp.com` (or your verified domain sender) |
| **Reply-to** | admin inbox (configure in Firebase project settings or SendGrid sender) |

---

## Subject

```
%DISPLAY_NAME%, somebody just asked to reset your password. Was that you?
```

---

## Message (HTML body)

```html
<p>Hey %DISPLAY_NAME%,</p>

<p>Somebody just asked to reset the password on the Tribe Tails account tied to <strong>%EMAIL%</strong>. I take that seriously when it comes to your family and the Kin we all love, so I need you to confirm one of two things below.</p>

<h3 style="margin-top:28px;">1. Yes, that was me. I asked for a reset.</h3>

<p>Tap below and I shall set you up with a fresh password right quick:</p>

<p style="margin: 20px 0;">
  <a href="%LINK%" style="background:#2E5D4F;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
    Reset my password
  </a>
</p>

<p>That link stays open for about an hour. If it runs out on you, head back to the login screen, hit "forgot password" again, and I shall send a fresh one.</p>

<hr style="border:none;border-top:2px solid #C45A3A;margin:32px 0;">

<h3 style="color:#C45A3A;margin-top:0;">2. No. That was NOT me. I did not ask for this.</h3>

<p>Then we are addressing this right now. Somebody may be trying to get into your account, and I will not have it. Not on my watch.</p>

<p><strong>Please use the secure link below.</strong> It will walk you through changing your password AND immediately alert me and the Tribe Tails team so we can investigate who tried to get in:</p>

<p style="margin: 20px 0;">
  <a href="https://tribetails.com/account/secure-reset?source=unauthorized_attempt&email=%EMAIL%" style="background:#C45A3A;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
    Secure my account and notify Tribe Tails
  </a>
</p>

<p>Please do not delay. The longer the gap, the more room somebody has to keep trying.</p>

<p>If the button does not work, simply reply to this email and I shall see it. Do not hesitate to reach out, even if you are not sure. I would much rather chase down a false alarm than miss a real one.</p>

<p style="margin-top:32px;">With care,<br>
<strong>Auntie</strong><br>
%APP_NAME%</p>
```

---

## Plain-text fallback

```
Hey %DISPLAY_NAME%,

Somebody just asked to reset the password on the Tribe Tails account tied to %EMAIL%. I take that seriously when it comes to your family and the Kin we all love, so I need you to confirm one of two things below.


1. YES, THAT WAS ME. I asked for a reset.

Open the link below and I shall set you up with a fresh password right quick:

%LINK%

That link stays open for about an hour. If it runs out on you, head back to the login screen, hit "forgot password" again, and I shall send a fresh one.


----------

2. NO. THAT WAS NOT ME. I did not ask for this.

Then we are addressing this right now. Somebody may be trying to get into your account, and I will not have it. Not on my watch.

Please use the secure link below. It will walk you through changing your password AND immediately alert me and the Tribe Tails team so we can investigate who tried to get in:

https://tribetails.com/account/secure-reset?source=unauthorized_attempt&email=%EMAIL%

Please do not delay. The longer the gap, the more room somebody has to keep trying.

If the button does not work, simply reply to this email and I shall see it. Do not hesitate to reach out, even if you are not sure. I would much rather chase down a false alarm than miss a real one.

With care,
Auntie
%APP_NAME%
```

---

## Voice & compliance notes (v3 rules applied)

- **Dial:** Security / Account. Gracious-formal register pulled forward for gravity. "I shall," "Please do not delay," "Do not hesitate," "I will not have it. Not on my watch." All carry weight without veering corporate.
- **No minimizing language.** Zero instances of "don't worry," "no harm done," "if it wasn't you just ignore," "no big deal," or "you can safely ignore." Voice rules v3 forbid these in Security / Account communications.
- **Two explicit paths, no default to inaction.** Confirm-it-was-you OR secure-and-investigate. Neither path is "ignore."
- **Secondary CTA is the actual security mechanism**, not just an informational note. The orange button is a working URL pattern that should change the password AND fire an investigation alert server-side.
- **Expedite channels still present** but reframed for breach signal: subject line is "BREACH ATTEMPT" not "NOT ME," reply-to header is `security@tribetails.com` not `support@`.
- **Auntie's protective fire:** "I will not have it. Not on my watch." Pulls from the rules' defending-Kin posture and the gracious-formal register.
- **First person throughout.** "I" never "we."
- **No em dashes. No en dashes.** Grepped clean.
- **Color signaling:** Primary green CTA for the benign path, alert-orange `#C45A3A` for the breach-response path, with an alert-orange horizontal rule separating them. Inbox preview also shifts: subject ends in a question Kinfolk must engage with, not a casual "let's get you back in."

---

## Open questions and engineering dependencies

> **STATUS BANNER (added 2026-05-17):** All 6 items below STILL OPEN. Verified:
> - #1 `/account/secure-reset` endpoint: grep across `web/functions/` confirms NOT built.
> - #2 SMS short number: still placeholder.
> - #3-#6: operator/config decisions.


1. **`/account/secure-reset` endpoint needs to exist.** Required behavior:
   - Verifies the email token, walks user through password change
   - On submission, fires `notification.security.breach_attempt` (or equivalent) to the Tribe Tails team channel + creates an investigation record in Firestore
   - Logs: timestamp, IP, user agent, geolocation if available, original reset request timestamp
   - Suggested catalog addition: new key `security.breach_attempt.kinfolk` with `recipientResolver: businessAdmins`, channels `e,s,p`, alwaysEnabled
2. ~~Real SMS short number~~ — Dropped 2026-05-18: user confirmed email + push + in-app (auto via dispatcher) sufficient.
3. ~~Confirm `security@tribetails.com` mailbox~~ — Dropped 2026-05-18: user will create as alias if/when needed; reply-to on the breach email is enough.
4. **Brand colors:** `#2E5D4F` (primary green) and `#C45A3A` (alert orange) are placeholders. Sub in your real brand tokens.
5. **Confirm `%APP_NAME%`** is set to "Tribe Tails" (not "AuntieOS" or "MyTribe") in Firebase project settings since this email goes to kinfolk.
6. **Decide on rate-limiting.** If someone is hitting the reset endpoint repeatedly, the breach-attempt notification should not flood the team. Suggest dedupe by `(email, 24h window)` on the investigation record.
