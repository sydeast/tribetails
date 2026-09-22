> **STATUS BANNER (added 2026-05-17):** Items 1 + 2 in Section 7 CLOSED.
> - #1 Template authorship: Firestore now has `emailTemplates: 45`, `pushTemplates: 35`, `smsTemplates: 34`, `kintale_templates: 1` (verified 2026-05-17 via firestore stream).
> - #2 Test deployment: functions deployed multiple times since 2026-05-12; `nightly_reconcile` python313 added 2026-05-17.
> - #3 UI surfaces (KinTale comment/note/booking-note/rating): **STILL OPEN.** Backends wired, UI sites not built.
> - #4 sotu-hosting rules drift reconciliation: **MOOT as of 2026-08-04.** There
>   is no `sotu-hosting/firestore.rules`; that directory is hosting only. The
>   two rules files are `mytribe/firestore.rules` (source of truth) and
>   `auntieos-admin/web/firestore.rules` (byte-identical mirror, guarded by a
>   test and the pre-commit hook).
> - #5 Smoke-test plan: testing scope, excluded from this audit.
>
> **Counts re-checked 2026-08-04:** the catalog holds 43 entries, not the 37
> stated below. Treat every number in this audit as of its 2026-05-12 date.
> **2026-08-18:** 42, after `account.welcome.business` was retired at the
> operator's request (Section 1.1).

# Notification System Audit — Fresh (2026-05-12 evening, post deferred-orphan sprint)

Catalog source of truth: `mytribe/functions/src/notifications/catalog.ts`. **37 entries as of 2026-05-12** (`kintale.note.added` removed that day: ambiguous semantics, no implementation, no spec). It holds **43** as of 2026-08-04.
Shared Firestore: `auntieos-ttpc`.

Supersedes prior audits. Reflects state after BOTH the morning orphan sprint AND the deferred-orphan sprint completed 2026-05-12.

**Grouping note**: Quote is an *Invoice status*. `quote.accepted` / `quote.denied` live under Invoice.

**Future-feature note**: `recipientResolver: 'auntieAssignedToKincare'` is reserved for future staff expansion.

---

## SECTION 1 — Catalog keys by feature area

Legend: ✓ wired catalog path, ⚪ Firebase-native (no catalog dispatch by design). `Req` = required channels. `AE` = alwaysEnabled.

### 1.1 Auth & Account

| Key | Resolver(s) | Audience | Channels | Mode | Req | AE | Status | Call Site |
|---|---|---|---|---|---|---|---|---|
| `auth.failedLogin.attempts` | specificUid | kinfolk | e,s,p | trigger | email | ✓ | ✓ | `loginSecurity.ts` `sendWarningAlerts`, from `recordFailedLoginHandler` at 5 failures in 10 min. The household's copy only; business admins get `security.failedLogin.attempts.operator` (#877) |
| `auth.account.locked` | specificUid | kinfolk | e,s,p | trigger | email | ✓ | ✓ | `loginSecurity.ts` `sendLockAlerts`, from `recordFailedLoginHandler` at 10 failures in 20 min. The household's copy only; the lock clears after 30 min, on admin unlock, or on a password reset |
| `auth.password.reset` | specificUid | kinfolk | e | trigger | email | ✓ | ⚪ | Firebase Auth native `sendPasswordResetEmail()`. Catalog entry kept dormant for future custom-flow option |
| `account.welcome.kinfolk` | specificUid | kinfolk | e | trigger | email | ✓ | ✓ | `acceptInvite.ts` post-accept |
| ~~`account.welcome.business`~~ | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **RETIRED 2026-08-18.** The operator does not want this notification. Catalog row, both emitters (`setKinfolkClaim.ts`, `acceptInvite.ts`) and seed template all removed; see `RETIRED_NOTIFICATION_KEYS` in `mytribe/functions/src/notifications/catalog.ts` |

### 1.2 KinCare visit lifecycle

| Key | Resolver(s) | Audience | Channels | Mode | Status | Call Site |
|---|---|---|---|---|---|---|
| `kincare.requested` | businessAdmins | business | e,s,p | trigger | ✓ | `onBookingsWrite.ts` (create, status=requested) |
| `kincare.booking.confirm` | kinfolkAcct + businessAdmins | both | e,s,p | trigger | ✓ | `onBookingsWrite.ts` (status→confirmed/approved) |
| `kincare.booking.cancel` | kinfolkAcct + businessAdmins | both | e,s,p | trigger | ✓ | `onBookingsWrite.ts` (status→cancelled) |
| `kincare.unavailable` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `onBookingsWrite.ts` (status→unavailable) |
| `kincare.changed` | businessAdmins | business | e,s,p | trigger | ✓ | `onBookingsWrite.ts` (non-status edit on confirmed/approved) |
| `kincare.note.kinfolk` | businessAdmins | business | e,p | trigger | ✓ | `onBookingNoteCreate.ts` (note where authorRole=kinfolk) — kinfolk callable: `addBookingNote` |
| `kincare.auntie.on_my_way` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `dispatchVisitNotification.ts` |
| `kincare.auntie.arrived` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `dispatchVisitNotification.ts` |
| `kincare.auntie.departed` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `dispatchVisitNotification.ts` |
| `kincare.report.sent` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `dispatchVisitNotification.ts` |
| `kincare.upcoming.reminder` | kinfolkAcct | kinfolk | e,s,p | scheduled | ✓ | `scheduled/kincareReminderCron.ts` (hourly) |
| `schedule.upcoming.digest` | businessAdmins | business | e,p | scheduled | ✓ | `scheduled/scheduleDigestCron.ts` (daily 07:00 ET) |

### 1.3 KinTale

| Key | Resolver(s) | Audience | Channels | Mode | Status | Call Site |
|---|---|---|---|---|---|---|
| `kintale.published` | kinfolkAcct | kinfolk | e,s,p | trigger | ✓ | `onKinTaleUpdate.ts` on the DRAFT → SENT send; `onKinTaleCreate.ts` only for a straight-to-SENT create. Suppressed when the client already announced the send itself via `dispatchVisitNotification` (`sentVia: 'catalog'`), so a KinTale is announced once |
| `kintale.comment.added` | kinfolkAcct | kinfolk | e,p | batched 5min | ✓ | `onKinTaleCommentCreate.ts` — callable: `addKinTaleComment` |

### 1.4 Invoice (Quote = Invoice status)

| Key | Resolver(s) | Audience | Channels | Mode | Status | Call Site |
|---|---|---|---|---|---|---|
| `invoice.new` | kinfolkAcct + businessAdmins | both | e,p | trigger | ✓ | `createInvoice.ts`, `createQuote.ts`, `resendQuote.ts`, `reviewAndSendDraftInvoice.ts` (which `postInvoiceEvent` delegates the draft send to since #906) |
| `invoice.updated` | kinfolkAcct + businessAdmins | both | e,p | trigger | — | **never fires since #906**: its only emitter was `postInvoiceEvent`'s arbitrary merge. Row, template and toggles kept; see `notifications/provenance.ts` NEVER_FIRES |
| `quote.accepted` | kinfolkAcct + businessAdmins | both | e,p | trigger | ✓ | `portal/quoteDecision.ts`, callable: `acceptQuote` |
| `quote.denied` | businessAdmins | business | e,s,p | trigger | ✓ | `portal/quoteDecision.ts`, callable: `denyQuote` |
| `invoice.charge.failed` | kinfolkAcct + businessAdmins | both | e,s,p | trigger | ✓ | `stripeWebhook.ts` (payment_failed) |
| `invoice.payment.applied` | kinfolkAcct | kinfolk | e,p | trigger | ✓ | `stripeWebhook.ts` (payment_succeeded) |
| `invoice.reminder` | kinfolkAcct | kinfolk | e,s,p | scheduled | ✓ | `scheduled/invoiceRemindersCron.ts` (daily 09:00 ET) |
| `invoice.overdue` | kinfolkAcct | kinfolk | e,s,p | scheduled | ✓ | `scheduled/invoiceRemindersCron.ts` (daily 09:30 ET) |

### 1.5 Pets & Profile

| Key | Resolver(s) | Audience | Channels | Mode | Status | Call Site |
|---|---|---|---|---|---|---|
| `pets.updated` | businessAdmins + kinfolkAcct | both | e,p | debounced 30min | ✓ | `onFamilyKinWrite.ts` |
| `profile.updated` | businessAdmins + kinfolkAcct | both | e,p | debounced 30min | ✓ | `onFamilyProfileWrite.ts` |
| `pet.marked.inactive` | businessAdmins | business | e,p | trigger | ✓ | `onFamilyKinWrite.ts` (status→inactive transition) |

### 1.6 Ratings

| Key | Resolver(s) | Audience | Channels | Mode | Status | Call Site |
|---|---|---|---|---|---|---|
| `rating.submitted.bad` | businessAdmins | business | e,s,p | trigger | ✓ | `onRatingCreate.ts` (score ≤ 3) — callable: `submitRating` |
| `rating.submitted.good` | businessAdmins | business | e,p | trigger | ✓ | `onRatingCreate.ts` (score ≥ 4) — callable: `submitRating` |

### 1.7 Marketing (opt-in gated)

| Key | Resolver(s) | Audience | Channels | Mode | MarketingCat | Status | Call Site |
|---|---|---|---|---|---|---|---|
| `newsletter.announcement` | specificUid | kinfolk | e,p | scheduled | `newsletter` | ✓ | `admin/scheduleMarketingBlast.ts` |
| `survey.event` | specificUid | kinfolk | e,p | scheduled | `survey` | ✓ | `admin/scheduleMarketingBlast.ts` |
| `marketing.optin` | specificUid | kinfolk | e | scheduled | `marketing` | ✓ | `admin/scheduleMarketingBlast.ts` |

### 1.8 Security

Every `security.*` key in the catalog as of 2026-09-14. All five go to business admins only, from the `businessSettings/admins.uids` roster as staff, and sit under Account and security on the Business tab.

| Key | Resolver(s) | Audience | Channels | Mode | Req | AE | Status | Call Site |
|---|---|---|---|---|---|---|---|---|
| `security.account.locked.operator` | businessAdmins | business | e,s,p | trigger | email, push | ✓ | ✓ | `loginSecurity.ts` `sendLockAlerts`, same call as the household's `auth.account.locked` (#869). Dedupe key per lock start |
| `security.failedLogin.attempts.operator` | businessAdmins | business | e,s,p | trigger | email, push | ✓ | ✓ | `loginSecurity.ts` `sendWarningAlerts`, same call as the household's `auth.failedLogin.attempts` (#877). Dedupe key per warning burst |
| `security.failedLogin.budgetExhausted.operator` | businessAdmins | business | e,s,p | trigger | email, push | ✓ | ✓ | `loginSecurity.ts` `sendReportBudgetAlert`, when `recordFailedLoginHandler` refuses a real account's 16th report in 24 hours (#891). Once per account per exhaustion; addresses that are not accounts never alert |
| `security.account.locked.spike.operator` | businessAdmins | business | e,s,p | trigger | email, push | ✓ | ✓ | `loginSecurity.ts` `recordLockForSpike`, when 3 or more distinct accounts lock within 30 minutes (#891). Once per spike, state on `securitySignals/lockSpike` |
| `security.breach_attempt.kinfolk` | businessAdmins | business | e,p | trigger | email, push | ✓ | ✓ | `security/confirmSecureReset.ts`, when a secure-reset confirmation is attempted against an account that did not ask |
| `security.breach_attempt.staff` | businessAdmins | business | e,p | trigger | email, push | ✓ | ✓ | `security/confirmSecureReset.ts`, the same flow when the account holds the admin claim (#892) |

---

## SECTION 2 — Dispatch infrastructure

### 2.1 Triggers

| Trigger | Path | Catalog Keys Dispatched |
|---|---|---|
| `onBookingsWrite` | `families/{id}/bookings/{id}` | `kincare.requested`, `kincare.booking.confirm`, `kincare.booking.cancel`, `kincare.unavailable`, `kincare.changed` |
| `onBookingNoteCreate` | `families/{id}/bookings/{id}/notes/{noteId}` | `kincare.note.kinfolk` (only if authorRole=kinfolk) |
| `onFamilyKinWrite` | `families/{id}/kin/{id}` | `pets.updated`, `pet.marked.inactive` |
| `onFamilyProfileWrite` | `families/{id}` | `profile.updated` |
| `onInvoicesWrite` | `invoices/{invoiceId}` | `invoice.payment.applied`, `invoice.overdue` |
| `onKinTaleCreate` | `kin_care_reports/{reportId}` | `kintale.published`, only when the report is created already `SENT` (a DRAFT create is silent) |
| `onKinTaleUpdate` | `kin_care_reports/{reportId}` | `kintale.published` on the DRAFT → SENT send; `kintale.note.added` on a post-publish body/media edit. Never both from one write |
| `onKinTaleCommentCreate` | `families/{id}/kinTales/{id}/comments/{cid}` | `kintale.comment.added` (batched) |
| `onRatingCreate` | `families/{id}/ratings/{ratingId}` | `rating.submitted.bad` / `good` (branched on score) |
| `onAuthUserCreate`, `onClientsWrite`, `onInviteRequestCreate`, `onMembersWrite` | various | — (no notification dispatch) |

### 2.2 Admin callables dispatching

| Callable | Catalog Keys |
|---|---|
| `postInvoiceEvent` | *(none directly since #906: it delegates the draft send to `reviewAndSendDraftInvoice`, which dispatches `invoice.new`)* |
| `dispatchVisitNotification` | `kincare.auntie.on_my_way` / `arrived` / `departed` / `kincare.report.sent` |
| `setKinfolkClaim` | *(none: it dispatched `account.welcome.business`, retired 2026-08-18)* |
| `acceptInvite` (member) | `account.welcome.kinfolk` |
| `scheduleMarketingBlast` | `newsletter.announcement` / `survey.event` / `marketing.optin` |

### 2.3 Kinfolk-facing callables (write doc → trigger fires notification)

| Callable | Writes To | Fires Via Trigger |
|---|---|---|
| `addKinTaleComment` | `kinTales/{tid}/comments/{cid}` | `kintale.comment.added` |
| `addBookingNote` | `bookings/{bid}/notes/{nid}` (authorRole=kinfolk) | `kincare.note.kinfolk` |
| `submitRating` | `families/{kid}/ratings/{bid}` (deterministic id = bookingId, one per booking) | `rating.submitted.bad` / `good` |

### 2.4 Cron jobs

| Cron | Schedule | Keys |
|---|---|---|
| `invoiceRemindersCron` | daily 09:00 ET | `invoice.reminder` |
| `invoiceOverdueCron` | daily 09:30 ET | `invoice.overdue` |
| `kincareReminderCron` | hourly | `kincare.upcoming.reminder` |
| `scheduleDigestCron` | daily 07:00 ET | `schedule.upcoming.digest` |

Each uses a `*NotifiedAtMs` field on source doc to prevent re-dispatch.

### 2.5 Other dispatch entry points

| File | Key |
|---|---|
| `auth/loginSecurity.ts` (`sendLockAlerts`) | `auth.account.locked`, `security.account.locked.operator` |
| `auth/loginSecurity.ts` (`sendWarningAlerts`) | `auth.failedLogin.attempts`, `security.failedLogin.attempts.operator` |
| `auth/loginSecurity.ts` (`sendReportBudgetAlert`, `recordLockForSpike`) | `security.failedLogin.budgetExhausted.operator`, `security.account.locked.spike.operator` |
| `billing/stripeWebhook.ts` | `invoice.charge.failed`, `invoice.payment.applied` |

### 2.6 Sweepers

| Sweeper | Cadence |
|---|---|
| `notificationDebounceSweep` | 1 min |
| `notificationBatchSweep` | 5 min |
| `notificationScheduledSweep` | 5 min |

### 2.7 Recipient resolvers

| Resolver | Status |
|---|---|
| `specificUid` | live |
| `kinfolkAcct` | live |
| `businessAdmins` | live (reads `businessSettings/admins.uids[]`) |
| `auntieAssignedToKincare` | future (staff expansion) |

---

## SECTION 3 — Catalog-bypassing email senders (unchanged)

Invite + recovery + error-digest flows still use `sendFromTemplate` directly. Intentional — predates catalog system. See prior audit.

---

## SECTION 4 — Template authorship needed

37/38 keys need templates (everything except `auth.password.reset` which is Firebase-native). Per allowedChannels, you need to author SMS templates (`smsTemplates/{key}`) + Push templates (`pushTemplates/{key}`) in Firestore, plus SendGrid email templates registered under their template id alias.

Grouped tiers carried forward from prior audit. Now add new tier:

**Tier-new — Schema-design wave:**
- `kincare.unavailable` (e,s,p) — booking-status path
- `kincare.note.kinfolk` (e,p) — booking note
- `kintale.comment.added` (e,p) — batched digest
- `kintale.note.added` (e,p)
- `rating.submitted.bad` (e,s,p)
- `rating.submitted.good` (e,p)

---

## SECTION 5 — Firestore rules added

`firestore.rules` updated for the new subcollections:

```
families/{fid}/bookings/{id}/notes/{noteId}    — read: member/auntie, write: server-only
families/{fid}/ratings/{ratingId}              — read: member/auntie, write: server-only
families/{fid}/kinTales/{id}/comments/{cid}    — read: member/auntie, write: server-only
families/{fid}/kinTales/{id}/notes/{nid}       — read: member/auntie, write: server-only
```

All writes go through Cloud Functions (admin SDK), not client direct writes. Synced to both `MyTribe/firestore.rules` and `sotu-hosting/firestore.rules`.

NOTE: `sotu-hosting/firestore.rules` had pre-existing drift from `MyTribe/firestore.rules` (vet_clinics, business_settings, breadcrumbs, clients fields). That drift is OUT OF SCOPE for this sprint — file separately if/when consolidating rules.

---

## SECTION 6 — Final metrics

| Metric | Day-start | After morning sprint | After deferred sprint | After kintale.note cleanup |
|---|---|---|---|---|
| Catalog keys | 38 | 38 | 38 | **37** |
| Wired keys | 2 | 31 | 37 | **36** |
| Orphan keys | 24 | 7 | 0 (1 ⚪ Firebase-native) | 0 (1 ⚪ Firebase-native) |
| Triggers dispatching | 1 | 5 | 9 | **8** |
| Admin callables dispatching | 1 | 5 | 5 | 5 |
| Kinfolk callables dispatching (via triggers) | 0 | 0 | 4 | **3** |
| Cron jobs dispatching | 0 | 4 | 4 | 4 |
| Catalog coverage | 5% | 82% | 97% | **97%** (36/37 wired; 1 Firebase-native) |

`auth.password.reset` is the sole "uncovered" key. By design — Firebase Auth's built-in password reset email is the production path. Catalog entry retained dormant in case product later wants a custom reset flow.

---

## SECTION 7 — Open follow-ups

1. **Template authorship** — author SMS + Push template docs for all 37 wired keys; register SendGrid email templates per key id.
2. **Test deployment** — run `firebase deploy --only firestore:rules,functions` and verify the 4 new triggers + 4 new callables + 4 new crons are registered.
3. **UI surfaces** — KinTale comment/note input UI, booking-note input UI, rating UI not yet built in MyTribe or AuntieOS. Backends are ready when UI ships.
4. **sotu-hosting rules drift** — separate consolidation pass to reconcile pre-existing diff between MyTribe and sotu-hosting rule files.
5. **Smoke test plan** — run sections 2–6 in `MyTribe/functions/docs/NOTIFICATION_SMOKE_TESTS.md` once templates are seeded.
