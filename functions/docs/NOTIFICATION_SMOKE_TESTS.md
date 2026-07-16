# Notification System Smoke Test Plan

End-to-end happy-path + failure-mode tests for the notification subsystem
(catalog → dispatcher → channel triggers → SendGrid/Twilio/FCM).

Run after every new catalog key, dispatcher logic change, or channel sender
change. Each test maps to a real Firebase emulator or staging interaction —
unit tests alone don't exercise the Firestore trigger fan-out.

## Setup checklist (one-time per environment)

- [ ] Firebase emulator suite running: `firebase emulators:start --only functions,firestore,auth`
- [ ] SENDGRID_API_KEY + SENDGRID_FROM secrets set (staging keys, NOT prod)
- [ ] TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER secrets set
- [ ] At least one FCM token registered for the test kinfolk uid (`fcm_tokens/{token}` w/ `uid` field)
- [ ] At least one `clients/{uid}` doc with `email` + E.164 `phone` populated
- [ ] At least one `staff/{uid}` doc with `email` populated
- [ ] `businessSettings/admins.uids` populated with at least one admin uid
- [ ] All template docs authored for the keys you're exercising
      (`emailTemplates/{key}`, `smsTemplates/{key}`, `pushTemplates/{key}`)
- [ ] AUNTIE_OPERATOR_UIDS env var contains your admin uid

## 1. Catalog integrity

Already covered by `test/notificationCatalog.test.ts`. Re-run on every
catalog edit:

```bash
cd MyTribe/functions && npm test -- notificationCatalog
```

Verify: every allowedChannels entry has a template id, batched mode has
batchKey + batchWindowMs, marketing-class keys live in marketing category.

## 2. Trigger-mode dispatch (immediate fan-out)

**Notification under test**: `kincare.auntie.arrived`

1. Sign in as kinfolk in MyTribe web; ensure `clients/{uid}.notificationPrefs.byKey['kincare.auntie.arrived']` has all three channels true.
2. Author / verify `emailTemplates/kincare.auntie.arrived`, `smsTemplates/kincare.auntie.arrived`, `pushTemplates/kincare.auntie.arrived`.
3. From an admin callable harness (or `firebase functions:shell`):
   ```js
   enqueueNotification({
     key: 'kincare.auntie.arrived',
     recipientUid: '<kinfolk uid>',
     data: { kinfolkFirstName: 'Sam', kincareId: 'kc-001', auntieFirstName: 'Avery' },
   })
   ```
4. Expect:
   - `notifications/{id}` doc created with `status: 'pending'` → flips to `'dispatched'`.
   - Three subdocs `notifications/{id}/channels/{email|sms|push}` created.
   - Within a few seconds each subdoc has `status: 'sent'` + `providerMessageId`.
   - Email arrives at the kinfolk inbox.
   - SMS arrives at the kinfolk phone.
   - Push arrives on a device with a registered FCM token.

## 3. Channel preference filtering

**Notification under test**: any kinfolk-facing key (e.g. `kintale.published`)

1. Set kinfolk prefs `byCategory.kintale = { email: true, sms: false, push: false }`.
2. Override per-key: `byKey['kintale.published'] = { push: true }`.
3. Enqueue `kintale.published`.
4. Expect: `notifications/{id}.channels = ['email', 'push']`. No SMS subdoc.

## 4. Required channel enforcement

**Notification under test**: `auth.password.reset` (email is required)

1. Set kinfolk prefs `byKey['auth.password.reset'] = { email: false }`.
2. Enqueue `auth.password.reset`.
3. Expect: notifications/{id}.channels INCLUDES `'email'` regardless. `required.email = true` overrides user opt-out.

## 5. Admin override suppression

**Notification under test**: `kintale.comment.added`

1. As admin, call `saveBusinessNotificationOverride({ key: 'kintale.comment.added', override: { enabled: false } })`.
2. Enqueue `kintale.comment.added`.
3. Expect: dispatcher logs `notification.suppressed` reason `no-channels-after-prefs`. No `notifications/{id}` doc created.
4. Clean up: `deleteBusinessNotificationOverride({ key: 'kintale.comment.added' })`.

## 6. Admin override of alwaysEnabled notification

1. As admin, call `saveBusinessNotificationOverride({ key: 'invoice.overdue', override: { enabled: false } })`.
2. Expect: HttpsError `alwaysEnabled.*cannot be disabled`.

## 7. Marketing opt-in gating

**Notification under test**: `newsletter.announcement`

1. Set kinfolk prefs `marketingOptIn.newsletter = false`.
2. Enqueue `newsletter.announcement`.
3. Expect: dispatcher logs `notification.suppressed`. No notification doc.
4. Flip prefs `marketingOptIn.newsletter = true`.
5. Re-enqueue. Expect: notification dispatches via allowed channels.

## 8. Failed-login lockout flow

1. From `recordFailedLogin` callable, post failures with `email` of a test kinfolk:
   - 4 fails → no notification, `remainingBeforeLock = 6`.
   - 5th fail within 10 min → `auth.failedLogin.attempts` notification fires; `remainingBeforeLock = 5`.
   - Continue to 10 fails within 20 min → `auth.account.locked` notification fires to kinfolk AND business admins (resolver dispatches twice). `clients/{uid}/security/loginAttempts.lockedUntilMs` set to `MAX_SAFE_INTEGER`.
2. Attempt Firebase Auth sign-in for the locked kinfolk → `beforeSignIn` blocking function rejects with `permission-denied: This account is locked.`
3. Trigger Firebase Auth password reset for the kinfolk (out of band).
4. Sign in successfully → `beforeSignIn` detects `tokensValidAfterTime > lockStartedAtMs`, clears the lock + counter, allows sign-in.
5. Call `unlockKinfolkAccount({ uid })` as admin to also test manual clear path.

## 9. Channel sender failure (fail-loud)

**Email**: temporarily set `SENDGRID_API_KEY` to a malformed value. Enqueue
`account.welcome.kinfolk`. Expect channel subdoc status `failed`, error
captured in Sentry, retry exhausts. Restore key.

**SMS**: enqueue a notification where the recipient has no phone on file.
Expect channel subdoc `failed` with error `recipient ... has no phone on
file`. Sentry receives the error.

**Push**: enqueue a notification for a recipient with no registered FCM
token. Expect channel subdoc `failed` with `no registered fcm tokens`.

## 10. FCM stale-token pruning

1. Insert a stale token doc in `fcm_tokens/STALE_TOKEN` for the kinfolk uid.
2. Enqueue any push-enabled notification.
3. Expect: `STALE_TOKEN` doc deleted (FCM returns
   `registration-token-not-registered`).

## 11. SOTU function migration sanity (post-deploy)

After deploying both Functions codebases together:

1. From AuntieOS admin web: trigger the "link kinfolk" action.
2. Expect: `setKinfolkClaim` resolves (now from MyTribe codebase). Kinfolk user receives `role: 'kinfolk'` + `kinfolkId` claim. `kinfolk/{kinfolkId}.uid` populated.
3. Same flow for unlink → `revokeKinfolkClaim`.

## Pending follow-ups (not testable until built)

- Phase 4 schedulers: debounce drainer, batch digest emitter, scheduled
  fire-at promoter. Once they ship, add tests for:
  - debounced `pets.updated`: rapid fires within window collapse to one notification with latest snapshot.
  - batched `kintale.comment.added`: 5-min trailing digest groups multiple comments into one email/push.
  - scheduled `invoice.reminder`: fires at `fireAtMs`, no earlier.
- `recordFailedLogin` rate limit / App Check.
- E5b admin Wasm UI hits the new admin callables and renders catalog + per-key toggles.

## CI hook (suggested)

Wire `npm test` into the predeploy step:

```jsonc
// firebase.json
"functions": [{
  "source": "functions",
  "predeploy": [
    "npm --prefix \"$RESOURCE_DIR\" run build",
    "npm --prefix \"$RESOURCE_DIR\" test"
  ]
}]
```

This catches catalog/template drift before a deploy reaches the cluster.
