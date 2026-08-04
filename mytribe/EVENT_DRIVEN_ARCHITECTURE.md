# MyTribe Portal, Event-Driven Architecture

Current as of 2026-06-18, verified against firestore.rules and functions/src.

## Overview

MyTribe (the kinfolk-facing portal) and AuntieOS (the staff/operator app) share one
Firebase project, `auntieos-ttpc`. The two apps never read each other's Firestore
shapes directly. MyTribe Cloud Functions are the translation and event layer between
them. Kinfolk-facing reads go through `getMy*` callables that scope every request by
`clients/{auth.uid}.kinfolkIds`. Writes go through callables (Admin SDK bypasses
client rules). Firestore document triggers turn writes into notifications, envelope
rollups, and cross-app mirrors. FCM push, email, and SMS delivery are live.

This document describes the event flows as shipped. For the exact authorization on
every collection, read `firestore.rules`. For the full handler inventory, read
`functions/src/index.ts`.

## Collections (current)

Bookings use the envelope model. A parent envelope doc tracks the request batch and
its rollups; each individual visit is a nested KinCare doc.

```
families/{familyId}
  ├── members/{uid}
  ├── kin/{kinId}                              pet profiles (MyTribe-owned)
  ├── kinfolk/{kinfolkId}                       human profiles
  ├── bookings/{batchId}                        booking ENVELOPE (status rollups, counts, kin/service identity)
  │     └── kinCares/{visitId}                  one per visit (status, title, window, notes)
  │           ├── notes/{noteId}                kinfolk-visible note (server-written)
  │           └── internalNotes/{noteId}        staff-only note (server-written)
  ├── invoices/{id}                             family-scoped invoice mirror (admin-written)
  ├── homeAccess/{id}                           gate code, key location, wifi
  ├── messages/{threadId}/items/{msgId}         in-tribe direct/group messaging
  ├── ratings/{ratingId}                        server-written via submitRating
  ├── mediaGallery, themeConfig, secrets        misc tribe data

kin_care_reports/{reportId}                     flat KinTale / visit-report collection (kinfolkId is a field)
  └── comments/{commentId}                      server-written via callables

clients/{uid}                                   uid -> kinfolkIds tenant boundary (Functions-only write of those arrays)
invoices/{invoiceId}                            FLAT canonical invoices (kinfolkId field); Stripe + portal read/write here
payments/{eventId}                              flat payment mirror, keyed by Stripe event id
fcm_tokens/{tokenId}                            push targeting (one doc per device, uid field)
notifications/{id}/channels/{channel}           per-dispatch fan-out (server-only writes)
pendingNotifications, scheduledNotifications, notificationBatch/{uid}/...   debounced/scheduled/batched queues
```

### Legacy / dead paths (do not use)

These rules exist defensively but have no active readers or writers. They are
`allow ... if false` or admin-reserved only:

- `families/{fid}/kinTales/{taleId}` (and its `comments`), superseded by the flat
  `kin_care_reports` collection.
- `families/{fid}/visitEvents/{id}`, `allow create/update/delete: if false`.
- `families/{fid}/bookingLocks/{id}`, `allow create/update/delete: if false`.

### AuntieOS-owned collections (read-only to MyTribe)

These are written by AuntieOS staff and read by MyTribe only through admin-gated or
server-bound paths. All are gated `if isAuntie()` (admin claim) in `firestore.rules`:

| Collection | Key | Contents |
|---|---|---|
| `dossiers/{kinfolkId}` | kinfolkId | HUMAN / Kinfolk personality summary |
| `the_411/{kinId}` | kinId | PET / Kin personality + care blurb (note the name is `the_411`, NOT `411`) |
| `household_data/{kinfolkId}` | kinfolkId | operational household facts: vet, access, item locations |
| `training_documents/{id}` | auto | Tribal Intel; writes only via the create/update/delete training-document callables |

`getMyKin` reads `the_411/{legacyKinId}` for the AI blurb, joined to the structured
`families/{kinfolkId}/kin/{kinId}` doc via the `legacyKinId` link stamped by the kin
mirror trigger.

## Cloud Functions and triggers (inventory)

Names below are the actual exports in `functions/src/index.ts`. This is the event
spine; the full callable list is longer (read `index.ts`).

### Booking / KinCare triggers

- `onBookingsWrite`, on `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`.
  Emits notifications keyed on the per-visit `status`:
  create with `requested` to `kincare.requested`; transition to
  `confirmed`/`approved` to `kincare.booking.confirm`; to `cancelled` to
  `kincare.booking.cancel`; to `unavailable` to `kincare.unavailable`; a non-status
  edit on a confirmed visit to `kincare.changed`.
- `onKinCareRollup`, on the SAME per-visit path. Recomputes the PARENT envelope's
  `envelopeStatus` + counters (`visitCount`, `confirmedCount`, `completedCount`,
  `cancelledCount`) from the full set of visit statuses, writing only the parent doc
  (so it cannot re-fire `onBookingsWrite`). Has a re-entry / no-op guard.
- `onBookingNoteCreate`, fires `kincare.note.kinfolk` only when a note's
  `authorRole == 'kinfolk'`.
- `onRatingCreate`, branches a rating score to `rating.submitted.bad` (score 3 or
  lower) or `rating.submitted.good` (4 or higher).

### KinTale (visit report) triggers, on the flat `kin_care_reports` collection

- `onKinTaleCreate`, fires `kintale.published` only when a report is created
  ALREADY `SENT` (kinfolkId is a field on the doc, not a path parameter). Every
  admin client creates a DRAFT first, and a draft is invisible to the household,
  so a DRAFT create is silent.
- `onKinTaleUpdate`, fires `kintale.published` on the DRAFT → SENT send, the
  moment the report becomes visible to the household, and `kintale.note.added`
  when an already-SENT report gains more body text or more media. One update
  produces at most one of the two. Notes are debounced + content-digest
  idempotent via a parallel `kinTaleNotifications/{reportId}` tracker; the send
  claims `publishedNotifiedAtMs` on that same tracker so it is announced once
  per report however many times a trigger is replayed.
- `onKinTaleCommentCreate`, fires `kintale.comment.added` for a post in the
  comment box under a report (the `comments` subcollection). Distinct from
  `kintale.note.added`, which is the report body growing.

A send reaches the notification system from up to two directions, and the
household must hear about it once. Android and the wasm admin `sendReport` path
call the `dispatchVisitNotification` callable (`report_sent`) on the send tap and
stamp `sentVia: 'catalog'` in the same write that flips the status; the trigger
sees that marker and stays silent. The React admin and the wasm compose screen do
not call the callable (`sentVia: 'pending'`), so there the trigger is the only
announcement.

The callable enqueues under the retired key `kincare.report.sent`. Since
2026-07-24 that key is an ALIAS of `kintale.published` (see
`NOTIFICATION_KEY_ALIASES` in `functions/src/notifications/catalog.ts`): one
catalog row, one switch, both emitters. Both emitters now fire at the same
moment, the send, so the alias collapses what used to be two toggles for one
event. Until 2026-07-24 `onKinTaleCreate` announced on the DRAFT write instead,
which notified households about drafts they could not open.

### Kin (pet) mirror triggers

- `onFamilyKinWrite`, on `families/{kinfolkId}/kin/{kinId}`. Mirrors parent-owned
  fields to the flat `kin/{docId}` collection (so AuntieOS staff and the `the_411`
  join see the same pet), stamping a symmetric `legacyKinId` / `familyKinPath` link
  on both docs. Also emits `pets.updated` (debounced) or `pet.marked.inactive`.
- `onFlatKinWrite`, the reverse mirror. Copies staff-editable fields from a flat
  `kin/{docId}` doc back into the canonical `families/{kinfolkId}/kin/{kinId}` record.
  Both triggers carry a `_mirrorOrigin` stamp plus a real-change guard to prevent the
  mirror loop.

### Other triggers

- `onClientsWrite`, on `clients/{uid}`. Mirrors `kinfolkIds[0]` into Firebase Auth
  custom claims (`role: 'kinfolk'`, `kinfolkId`) so AuntieOS Firestore + Storage rules
  recognize the user, and backwrites the uid onto the AuntieOS `kinfolk/{id}` doc.
- `onInvoicesWrite`, reacts to invoice writes (notification dispatch).
- `onMembersWrite`, `onFamilyProfileWrite`, `onAuthUserCreate`, `onInviteRequestCreate`,
  membership / lifecycle triggers.

## Payments (live Stripe Checkout)

Stripe is real, not a mock.

- `payInvoice` (callable). Loads the flat `invoices/{invoiceId}` doc, authorizes the
  caller against `clients/{uid}.kinfolkIds`, and creates a real Stripe Checkout Session
  (`mode: 'payment'`, card, amount from `amountDue`). Returns the hosted `checkoutUrl`
  the client opens in the platform browser. Stamps `pendingCheckoutSessionId` on the
  invoice. Requires the `STRIPE_SECRET_KEY` secret.
- `stripeWebhook` (HTTPS). Verifies the Stripe signature, then runs an idempotent,
  out-of-order-safe Firestore transaction keyed by `stripeEvents/{event.id}`. On a
  paid event (`invoice.paid` or `payment_intent.succeeded`) it marks the flat
  `invoices/{invoiceId}` `status: 'paid'`, sets `amountDue: 0` + `paidAt`, mirrors a
  `payments/{event.id}` doc, writes an audit entry, and enqueues
  `invoice.payment.applied`. A failed event enqueues `invoice.charge.failed`. Requires
  `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.

## Notifications (live multi-channel)

A catalog + dispatcher subsystem (`functions/src/notifications/`) drives all
auto-notifications. Server-only writes; recipients read their own dispatches.

- `enqueueNotification(args)` is the single entrypoint. It resolves the notification
  definition from the catalog, resolves recipients, applies per-user prefs +
  per-business overrides to pick channels (email / sms / push), and routes by
  `deliveryMode`:
  - `trigger`, writes `notifications/{id}`.
  - `debounced`, writes `pendingNotifications/{uid}_{key}` and bumps `fireAfterMs`.
  - `batched`, appends to `notificationBatch/{uid}/{batchKey}/...`.
  - `scheduled`, writes `scheduledNotifications/{id}` with `fireAtMs`.
- `onNotificationCreate` fans a new `notifications/{id}` doc into per-channel subdocs
  `notifications/{id}/channels/{channel}` (status `pending`); `onNotificationChannelCreate`
  then processes each channel independently, so one channel's failure does not block
  the others.
- Channel senders live in `functions/src/notifications/senders/`. The push sender
  (`pushChannel.ts`) renders the `pushTemplates/{key}` template, multicasts via
  firebase-admin `messaging().sendEachForMulticast` to every `fcm_tokens` doc owned by
  the recipient, and prunes tokens FCM reports as invalid. Email and SMS senders cover
  the other two channels.
- Scheduled sweeps (`notificationDebounceSweep`, `notificationScheduledSweep`,
  `notificationBatchSweep`, `scheduleDigestCron`) flush the deferred queues.

Client wiring: kinfolks register devices via `registerFcmToken` / `unregisterFcmToken`;
web and Android both register FCM tokens.

## Copy generation

The AI generator lives in MyTribe Cloud Functions. `generate` is a callable at
`functions/src/portal/generate.ts:159`, exported from `functions/src/index.ts`,
holding `ANTHROPIC_API_KEY` in its `secrets` list. The key is provisioned; the
migration off the n8n webhook `auntie-generate` was completed, and this section
described the state before it.

Three more AI paths sit alongside it: `functions/src/lib/aiCopy.ts`, the
`aiBackfillTaleTitles` admin callable, and the `aiBatchPollCron` scheduled
function. `mytribe/functions/` is the canonical home for new callables, which is
what the migration was for.

## Security rules enforcement (summary)

`firestore.rules` is the single source of truth. Highlights:

- Tenant boundary: `clients/{uid}.kinfolkIds` / `familyIds` are writable ONLY by
  Cloud Functions (Admin SDK). A signed-in client may never self-assign them.
- Family subcollections gate on `activeMember(fid)` / `isPrimary(fid)` / `hasPerm(fid, ...)`.
- Booking envelope + nested kinCares: members create requests; per-visit field edits
  (`status`, `notes`, `title`, `window`) are allowed to members when invoice and sitter
  fields are untouched; the `isAuntie()` branch is the AuntieOS write-back path.
- A scoped collection-group rule `match /{path=**}/kinCares/{visitId}` grants admins
  read so the AuntieOS Incoming-requests queue can run
  `collectionGroup('kinCares').where('status','==','REQUESTED')`. It is read-only and
  scoped to `kinCares` so it cannot override any `allow ... if false` deny.
- All notification, audit-log, rate-limit, and Stripe-dedupe collections are
  server-only writes; admins read for monitoring.
- AuntieOS-owned collections (`dossiers`, `the_411`, `household_data`,
  `training_documents`, and the operational set) are admin-gated.
