# MyTribe Scheduling and Payments Architecture

Current as of 2026-06-18, verified against firestore.rules and functions/src.

## Scope

This describes the live scheduling / bookings model and the invoices + payments flow
as shipped. The old wireframe-era repositories (`WireframeBookingRepository`,
`KFireBookingRepository`, `KFirePorts`) and the `bookingLocks` lock scheme no longer
exist. Scheduling runs against real Firebase through MyTribe Cloud Functions on web,
desktop (JVM), and Android.

## Bookings: the envelope model

A booking request is stored as an ENVELOPE plus one nested KinCare doc per visit:

- Parent envelope: `families/{familyId}/bookings/{batchId}`. Tracks the request batch:
  `envelopeStatus`, `pattern` (`individual` or `weekly`), `serviceId` / `serviceName`,
  `kinIds` / `kinNames`, `notes`, the rollup counters (`visitCount`, `confirmedCount`,
  `completedCount`, `cancelledCount`), and `firstStartTime` / `lastStartTime`.
- Per-visit child: `families/{familyId}/bookings/{batchId}/kinCares/{visitId}`. Holds
  the individual visit's `status`, `title`, `serviceName` / `serviceType`,
  `startTime` / `endTime`, `kinIds` / `kinNames`, `priceCents`, `notes`,
  `visitProgress`, and the AuntieOS back-references `sourceBookingId` / `sessionId`
  (null until AuntieOS writes them).
- Visit notes: `.../kinCares/{visitId}/notes/{noteId}` (kinfolk-visible) and
  `.../internalNotes/{noteId}` (staff-only). Both are server-written via callables;
  client writes are denied at the rule level.

Per-visit `status` values: `requested`, `confirmed`, `enRoute`, `active`, `completed`,
`cancelled`. Envelope `envelopeStatus` values: `requested`, `partiallyConfirmed`,
`confirmed`, `inProgress`, `completed`, `cancelled`.

### Kin vs Kinfolk

A booking targets either a pet or a person via `targetType` (`KIN` or `KINFOLK`),
enforced on create in `firestore.rules`. Kinfolk-initiated requests written by
`requestBooking` are stamped `targetType: 'KIN'`.

## Booking lifecycle (functions)

- `requestBooking` (callable). Kinfolk-initiated. Accepts a multi-visit payload
  (`{ visits: [...], kinIds, pattern, weeklyDays }`) or a legacy single-visit payload
  (stored as a one-visit envelope). It authorizes the caller against
  `clients/{uid}.kinfolkIds`, validates future start times, then writes the parent
  envelope plus one `kinCares/{visitId}` per visit inside a single Firestore
  transaction. Envelope fields are rolled up from the visit list. Writes a
  `BOOKING_SUBMITTED` audit entry. If the operator setting
  `business_settings.autoConfirmRepeatKinfolk` is on and the kinfolk has booked
  before, it calls the same approve core as the admin path to auto-confirm; any failure
  fails safe and leaves the request in the manual queue.
- `getMyBookings` (callable, read-only). Queries
  `collectionGroup('kinCares').where('familyId','==', kinfolkId)` for the per-visit
  docs, reads each parent envelope for envelope-level fields, and returns
  `{ liveVisit, upcoming[], recent[], envelopes[] }`. Bucket logic: live = any
  `active` / `enRoute`; upcoming = `requested` / `confirmed` with a future start;
  recent = `completed` / `cancelled`.
- `onKinCareRollup` (trigger). Recomputes the parent envelope's `envelopeStatus` +
  counters whenever a visit's status changes (see EVENT_DRIVEN_ARCHITECTURE.md).
- `onBookingsWrite` (trigger). Emits the per-visit booking notifications.
- Admin / AuntieOS side (in `functions/src/admin/`): `manageBookingSeries`,
  `approveBookingSeriesCore`, `batchUpdateBookings`, `rescheduleBooking`,
  `createKinCareSession`, `addBookingNote`, `addInternalBookingNote`. These confirm,
  reschedule, and write back session linkage. The Admin SDK bypasses client rules, so
  the `isAuntie()` update branch on the booking/kinCare rules is the write-back path.

### The booking envelope is day-one and always-on

The booking envelope is a day-one ship feature. It is NOT behind a feature flag and
never has been: no flag, kill-switch, or gate guards it. It is the live, default
scheduling model on all three platforms (web, desktop, android). `config/FeatureFlags.kt`
is intentionally empty (no `mytribe.*` client flags), so nothing can gate the envelope
off.

## Availability and calendar

- `getServiceCatalog` / `getVetClinics` / `getBreeds` feed the booking wizard.
- `booking_time_slots/{id}` holds Google Calendar "Busy" blocks, written server-side by
  `syncGoogleCalendarBusyEvents` (admin SDK). The Schedule grid reads them; admin read
  only, client writes denied. Calendar provider keys are an external secret.

## Invoices and payments

Canonical invoices live in the FLAT top-level `invoices/{invoiceId}` collection
(`kinfolkId` field). A per-family mirror also exists at `families/{fid}/invoices/{id}`
(admin-written). Payments are real Stripe Checkout, not a mock.

- `getMyInvoices` (callable, read-only). Queries the flat `invoices` collection by
  `kinfolkId` and splits open vs paid (a doc resolves as paid when `amountDue` is 0 or
  less; see `resolveStatus`).
- `payInvoice` (callable). Creates a real Stripe Checkout Session for the invoice and
  returns the hosted `checkoutUrl` the client opens in the platform browser. Authorized
  against `clients/{uid}.kinfolkIds`. Requires `STRIPE_SECRET_KEY`.
- `stripeWebhook` (HTTPS). Signature-verified, idempotent (deduped via
  `stripeEvents/{event.id}`), out-of-order-safe. Marks the flat invoice paid
  (`status: 'paid'`, `amountDue: 0`, `paidAt`), mirrors `payments/{event.id}`, writes a
  billing audit entry, and enqueues the paid/failed notification. Requires
  `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.
- Admin invoice callables: `createInvoice`, `createQuote`, `postInvoiceEvent`,
  `sendInvoiceReminder`, `generateReceipt`, `generateInvoicePdf`; kinfolk-side
  `getMyInvoicePdf` and `redeemCredit`. Reminder crons: `invoiceRemindersCron`,
  `invoiceOverdueCron`.

## Security model

`firestore.rules` is the single source of truth.

- Booking envelope + nested kinCares: `read` for active members and admins; `create`
  for active members when `familyId == fid`, `targetType` is `KIN`/`KINFOLK`, and
  invoice/sitter fields are untouched (unless the member has `billing_full`); member
  `update` limited to `status` / `notes` / `title` / `window` with invoice + sitter
  fields unchanged; the `isAuntie()` branch is the AuntieOS write-back.
- Family-scoped invoices (`families/{fid}/invoices/{id}`): members read; only
  `isAuntie()` may create/update/delete.
- Flat `invoices` + `payments`: members reach them only through the callables; the
  Admin SDK (in Stripe webhook + admin callables) bypasses rules. Direct client writes
  are not the path.
- `stripeEvents` (dedupe ledger): admin read, no client writes.
- Dead paths: `families/{fid}/bookingLocks` and `families/{fid}/visitEvents` are
  `allow ... if false`. There is no `bookingLocks` transaction anymore; double-booking
  protection now lives in the AuntieOS approve/scheduling flow, not a client lock doc.
