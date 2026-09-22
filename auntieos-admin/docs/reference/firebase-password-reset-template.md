# Firebase Auth: password reset email template

**Where this goes:** Firebase Console, Authentication, Templates, Password reset.
**Who changes it:** the operator. The agent writes this page and makes no console change.
**Format:** Firebase's own tokens only (`%DISPLAY_NAME%`, `%EMAIL%`, `%LINK%`, `%APP_NAME%`). Firebase strips most HTML.
**Voice dial:** Security / Account. Gracious-formal, first person, no minimising.

> Rewritten 2026-09-22 for #905. What is below matches what PR #903 (#892)
> shipped. The version before this one documented a second CTA at
> `https://tribetails.com/account/secure-reset?source=unauthorized_attempt&email=%EMAIL%`,
> a URL nothing generates on a host no Firebase link uses.

---

## Read this before editing the template

Identity Toolkit holds **one** email action URL for the whole project:

```
https://kinfolk.tribetails.com/account/secure-reset
```

Every Firebase auth email opens it. Password resets from the portal web, the
portal Android app, the admin site, admin Android and admin desktop; email
verification; email-change confirmations and rollbacks. Staff land there too,
which is why the page never says "your household" and why its header reads
"Tribe Tails" rather than "MyTribe".

`%LINK%` is the only link this template needs. It already carries what the page
reads:

| Param | Meaning |
|---|---|
| `mode` | `resetPassword` here. Absent on the oldest links, which the page reads as a reset |
| `oobCode` | The code. The page verifies it and takes the account from it |
| `continueUrl` | Where the sender said this account signs in, when the sender said |

**There is no `email` param, and the page would ignore one.** The address on the
page is whatever `checkActionCode` reports for the verified code. A URL cannot
name an account.

### The "I did not ask for this" path is a button on that page

It is not a second link in the email. Tapping it is the only thing that calls
`confirmSecureReset`, which records a security incident and alerts the team. A
routine reset from the same page files nothing.

A hand-written second URL would break that. Without an `oobCode` the page calls
it incomplete; with one pasted in it does the same reset under worse copy. Let
`%LINK%` do the work and describe the choice in words.

### The portal Android app claims the same URL

`mytribe/src/androidMain/AndroidManifest.xml` declares an App Link for
`kinfolk.tribetails.com` on `/account/secure-reset` and `/account/action`, so on
a phone with the portal app installed the link opens the app's own handler
instead of a browser. Same contract, same copy, same refusal to trust a URL.

Verification needs the app's SHA-256 signing fingerprint registered on the
Firebase project, which is a console change. Until it is, the link opens a
browser, which still works.

---

## Sender

| Field | Value | State |
|---|---|---|
| Sender name | Auntie at Tribe Tails | Set |
| From | `noreply@auntieos-ttpc.firebaseapp.com` | The custom email domain is `NOT_STARTED`, so mail still comes from the firebaseapp.com sender. Operator item |
| Reply-to | An address a person reads | The verify-email template's reply-to is the literal string `noreply`. Operator item |

---

## Subject

```
%DISPLAY_NAME%, somebody asked to reset your password. Was that you?
```

---

## Message (HTML body)

```html
<p>Hey %DISPLAY_NAME%,</p>

<p>Somebody asked to reset the password on the Tribe Tails account tied to <strong>%EMAIL%</strong>. I take that seriously when it comes to your family and the Kin we all love, so I need you to tell me which of these it was.</p>

<h3 style="margin-top:28px;">That was me. I asked for a reset.</h3>

<p>Open the link below and set a new password:</p>

<p style="margin: 20px 0;">
  <a href="%LINK%" style="background:#2E5D4F;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
    Set a new password
  </a>
</p>

<p>That link stays open for about an hour, and it works once. If it runs out on you, the page it opens will send you a fresh one.</p>

<hr style="border:none;border-top:2px solid #C45A3A;margin:32px 0;">

<h3 style="color:#C45A3A;margin-top:0;">That was NOT me. I did not ask for this.</h3>

<p>Then we are addressing this right now. Somebody may be trying to get into your account, and I will not have it. Not on my watch.</p>

<p><strong>Open the same link above.</strong> On that page, choose <strong>"I did not ask for this reset"</strong> before you set your new password. That choice locks the account with your new password AND alerts me and the Tribe Tails team, so we can look into who tried to get in.</p>

<p>Please do not delay. The longer the gap, the more room somebody has to keep trying.</p>

<p>If the link does not open, reply to this email and I shall see it. Do not hesitate to reach out, even if you are not sure. I would much rather chase down a false alarm than miss a real one.</p>

<p style="margin-top:32px;">With care,<br>
<strong>Auntie</strong><br>
%APP_NAME%</p>
```

---

## Plain-text fallback

```
Hey %DISPLAY_NAME%,

Somebody asked to reset the password on the Tribe Tails account tied to %EMAIL%. I take that seriously when it comes to your family and the Kin we all love, so I need you to tell me which of these it was.


THAT WAS ME. I asked for a reset.

Open the link below and set a new password:

%LINK%

That link stays open for about an hour, and it works once. If it runs out on you, the page it opens will send you a fresh one.


----------

THAT WAS NOT ME. I did not ask for this.

Then we are addressing this right now. Somebody may be trying to get into your account, and I will not have it. Not on my watch.

Open the same link above. On that page, choose "I did not ask for this reset" before you set your new password. That choice locks the account with your new password AND alerts me and the Tribe Tails team, so we can look into who tried to get in.

Please do not delay. The longer the gap, the more room somebody has to keep trying.

If the link does not open, reply to this email and I shall see it. Do not hesitate to reach out, even if you are not sure. I would much rather chase down a false alarm than miss a real one.

With care,
Auntie
%APP_NAME%
```

---

## Voice and compliance notes

- **Dial:** Security / Account. Gracious-formal register pulled forward for gravity.
- **No minimising language.** Nothing that says "don't worry", "no harm done", "no big deal", or **"you can ignore this email"**. The voice rules forbid all of them on security mail, and the live template still carries the last one. Operator item.
- **Two named paths, neither of them inaction.** It was me, or it was not me. Doing nothing is never offered as an answer.
- **The breach path is a mechanism,** not a reassuring sentence: the choice on the page is what files the incident.
- **First person throughout.** "I", never "we".
- **No em dashes, no en dashes.**
- **Colour signalling:** green for the routine path, alert orange `#C45A3A` for the breach path, with an orange rule between them. Both are placeholders for real brand tokens.

---

## What this page used to say, and why it is gone

| Was | Now |
|---|---|
| A hand-written second CTA to `https://tribetails.com/account/secure-reset?source=unauthorized_attempt&email=%EMAIL%` | A named choice on the page `%LINK%` opens. That host is not the action host, and nothing ever generated that URL |
| `&email=%EMAIL%` carried the account | The account comes from the verified code. PR #903 made the server derive it too, and it ignores a client-sent address |
| "The `/account/secure-reset` endpoint needs to exist" (open question 1) | It exists. `mytribe/web/src/screens/SecureReset.tsx` is the page, `mytribe/functions/src/security/confirmSecureReset.ts` the endpoint, `security.breach_attempt.kinfolk` and `security.breach_attempt.staff` the alerts. All shipped in PR #903 |
| "Decide on rate-limiting" (open question 6) | `confirmSecureReset` limits per IP (10 in 15 minutes) and per account (3 applied attempts), both in Firestore transactions, both with a TTL |
| A subject reading "BREACH ATTEMPT", reply-to `security@tribetails.com` | Dropped 2026-05-18. One subject, one reply-to |

## Still open, all of it in the console

1. The live template is still Firebase's default (`method: DEFAULT`). The body above has never been pasted in.
2. The live reset text says "you can ignore this email".
3. The custom email domain is `NOT_STARTED`, so mail comes from the firebaseapp.com sender.
4. The verify-email template's reply-to is the literal string `noreply`.
5. `%APP_NAME%` should read "Tribe Tails", not "AuntieOS" or "MyTribe", since this email reaches households and staff alike.
6. No SHA-256 fingerprint is registered for `com.kinfolk.portal`, so `https://kinfolk.tribetails.com/.well-known/assetlinks.json` serves `[]` and Android App Links verification fails.
7. `callbackUri` still points at `/account/secure-reset`. The page answers at `/account/action` as well, so it can move whenever the operator wants the tidier URL. Nothing breaks either way.
