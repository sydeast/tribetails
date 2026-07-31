# Mocks vs shipped UI: structural and functional audit

**Date:** 2026-07-31
**Scope:** AuntieOS React admin (`auntieos-admin/src`), AuntieOS Android, Kinfolk portal (`mytribe/web`), against `page-specs/*.md` and `ui-ideas/` (both gitignored, main checkout only).
**Method:** five parallel read-only reviewers plus a direct booking-workflow pass, every claim re-checked against live React/Android source rather than the specs' stale "Current" citations. Rejected mocks in `ui-ideas/WrongUIDesigns-UpdateKill/` were treated as operator rulings and NOT audited against.

## Why the page-specs cannot be trusted for "current state"

All 29 specs cite "current code" under `web/composeApp/.../screens/*.kt`, the superseded Compose tree. The shipped surfaces are `auntieos-admin/src/screens/*.tsx` and `auntieos-admin/android/app/`. Same on the portal side: the live portal is `mytribe/web/`, not `mytribe/src/`. Everything below is grounded against the live code and the specs' "Desired" prose. In several places the specs understate what shipped (Communicate, Training Documents, Settings security); in others they miss a port regression (Invoice Detail's Linked Sessions panel).

## Part 1: Per-screen findings

### Directory, Kinfolk, Kin, Household (specs 01 to 07)

| Screen | Mock/spec source | Structural gaps (frontend) | Functional gaps (backend/data) | Severity | Size |
|---|---|---|---|---|---|
| 01 Home | No live mock; both existing Home mocks rejected; spec's cited `auntieos-redesign.html` absent from repo | Pivoted to a 19-key widget dashboard unrelated to the spec's stat-row baseline. Shell topbar has no search or bell. | No weekly-revenue callable. `StatCard` has no `trendTone`. | Medium; needs operator call on whether the widget pivot is intended | L |
| 02 Sign-in | Live mock, matches | None | None; real HTML form so autofill/tab order are native | Low | S |
| 03 Directory | Live mock | No "New" badge, no last-visit footer, "A -> Z" labels, kinfolk-tab chips ignore `Kin.profilePictureUrl` | No `createdAt`/`isNew`/`lastVisitAt`/neighborhood/KinTale-count fields | Low | M |
| 04 Kinfolk Profile | Live mock | One long panel stack, no tabs; no Call/Text/New-KinTale actions; **no Invoices tab** (payments IA ruling depends on it) | No KinTales/Upcoming-visits/Invoices-by-kinfolk feeds. **Vet double-authoring live**: catalog-linked vet fields disagree with Household Data's free-text vet fields for the same household | High (pet-safety-adjacent integrity + blocks payments IA) | L |
| 05 Kinfolk Edit | Only mock is `kinfolkedit-needupdate.html` (stale); audited against spec prose | serviceAddress + Emergency contact not grouped under Identity | Most spec complaints already resolved (on-blur validation, required fields, phone rule, Preferred-contact removed) | Low | S |
| 06 Kin Detail | Live mock | KinView/KinEdit split exists (spec gap closed). No checklist panel, no 411/dossier, no KinTales-by-kin. Label still "Sex" not "Gender" | Breed is a real searchable dropdown (478 dog + 103 cat via `getBreeds`). Species still free text. `profilePictureUrl` renders, no upload UI. Free-text `Kin.checklist` dropped, not migrated | Medium | M |
| 07 Household Data | Live mock | Operator's one-source-address decision not built; screen has no address/access fields | **Vet double-authoring confirmed independently here**: free-text vet fields, zero tie to `vet_clinics`. No `saveHouseholdData` callable; raw Firestore writes | High | M |

### Care visits, KinTales, Scheduling (specs 08 to 14)

| Screen | Source | Structural gaps | Functional gaps | Severity | Size |
|---|---|---|---|---|---|
| 08 KinCare Detail | Live mock | No hero/photos, no lifecycle rail, one generic notes field, no address/map, no KinTales-sent list | Session type has no rate and no `invoiceId` field; `sourceBookingId` never read | High | L |
| 09 KinTale Logs | Live mock | Flat tab list; no orphan triage on web | `triageOrphanReport` is a real audited callable, used by Android, zero web wiring | High, clean fix | M |
| 10 KinTale Composer | Live mock | Headline+body+save/send only: no cover-photo, photo strip, GPS, checklist chips, recipient rail, preview | "Send to the Walls" hardcode gone; `title` wired. No `coverImageId`/`visibility`/autosave stamp; `deliveryReceiptId` placeholder never filled | Medium | L |
| 11 KinTale Report | Live mock | No per-comment Reply UI (server supports `parentCommentId`), no share-link, no GPS, no mood pills | More complete than spec assumed: kin/species join, comments, reactions all live | Low-Medium | S-M |
| 12 Template Editor | Live mock | None major | `FieldCondition` editor actually built; leftover: `vetInfo` never removed from field engine | Low | S |
| 13 Schedule | Live mock | Day/week/month picker-strip + single-day agenda, not the mock's hour-positioned week grid | Old complaints resolved (busy blocks live, reschedule wired). `createKinCareSession` exists, zero call sites | Low-Medium | M/S |
| 14 Auntie Time | Live mock | No lifecycle controls (on-my-way/arrived/departed), no `RouteMap`; screen discloses web out-of-scope | `optimizeRoute` exists (used on Home widget), not wired here | High if web runs field ops, low if Android owns it; operator call | M |

### Billing (specs 16 to 18)

| Screen | Source | Structural gaps | Functional gaps | Severity | Size |
|---|---|---|---|---|---|
| 16 Invoices | No live mock (`Killinvoice2-needupdate.html` stale) | No kin/pet sub-line; middle card still "Billed total" not "Paid this month" | `linkInvoiceSessions` never called from web (visits attach at creation only; Android just shipped exactly this). `redeemCredit` and `generateInvoicePdf` exported, uncalled. Kinfolk facet filter actually built | Medium | M |
| 17 Invoice Detail | No live mock (`invoiceNEEDSupdate.html` stale) | **No Linked Sessions panel; no payment-history list**, despite `sessionIds`, `linkInvoiceSessions`, and the `payments` subcollection all being real | 8-state classifier + `editScope` correctly read from server stamp; reminder/mark-paid/receipt/review-and-send all wired | High: the largest regression in this audit, and it is money visibility | M |
| 18 Payments | Spec ARCHIVED; standalone mock rejected | No standalone screen (correct per ruling). Kinfolk Profile has no invoice/payment content, so the "individual kinfolk admin view" path was never built | Web "record payment" calls only `markInvoicePaid`, never `recordPayment`, so the payments ledger is written from Android only. No payment-history view anywhere in web admin | Medium: recordable, not reviewable | S-M |

Payments IA ruling check: standalone removal matches; invoice-context recording matches; kinfolk-context reachability never built; no review surface exists.

### Communications (specs 19 to 22)

| Screen | Source | Structural gaps | Functional gaps | Severity | Size |
|---|---|---|---|---|---|
| 19 Communicate | Mocks pre-date build | Template Bank no longer pulled into either composer (regression, zero "template" refs) | broadcast/segments/generateDraft/sendExternalMessage all real; exceeds its spec | Low | S |
| 20 Inbox | Mock pre-dates design | "Mark all read" for channels absent | `markVoicemailRead` no longer called; rest wired | Low | S |
| 21 Notifications | **Mock does not exist anywhere in repo** | Shell topbar has no bell/badge/global search (confirmed: account chip + Sign out only). Notifications is a rail destination, not glanceable | More built than spec credits: read flags, bulk mark-read, archive, booking approve/deny quick actions | Medium | S |
| 22 Activity Log | Live mock, matches | Rows not clickable, no detail overlay, no destination resolver | `seq`/`entryHash` rendered, chain verification live; listener capped 200, no pagination | Medium | S-M |

### Content and admin tooling (specs 23 to 28)

| Screen | Source | Structural | Functional | Severity | Size |
|---|---|---|---|---|---|
| 23 Tribal Intel | Live mock | None | Fully wired: CRUD, Kinfolk+Kin picker, Cloudinary, reconcile status | Low | done |
| 24 Template Bank | Live mock | Plain textareas (no rich text/image insert); no drag-and-drop categorize (checkbox bulk-bind covers it) | `listCategories` wired; `deleteTemplate` refuses while bound | Medium | M |
| 25 Template Assignment | Mock rejected | None of note; merged into Templates.tsx as a tab | `unassignTemplate` wired. `listCatalogKeys` uncalled and cannot compute "unbound" against the real catalog | Low | S |
| 26 FormSchema List | Live mock | None | `dynamic_fields` duplication resolved by never porting it; `saveFormSchema` absorbs legacy `appliesTo` | Low | done |
| 27 FormSchema Editor | Live mock | Live preview absent (not even gated); placement entity-level only | Field-key derivation client-side only; sole `getFormSchema` consumer hardcodes two ids | Medium | M |
| 28 Media Gallery | Live mock | Static caption block vs hover overlay (cosmetic) | `uploadedBy` stamps real uid; profile-photo badge rendered | Low | S |

### Settings (spec 29)

Appearance/Customization absent entirely. Integrations panel absent. **Vet Clinics has no catalog manager anywhere** (picker only), and the backend is create+read only (no update/delete) despite the dependency doc claiming shipped. **Members/Invites has zero UI anywhere while the full backend exists** (`mintInvite`, `revokeInvite`, `inviteKinfolkToPortal`, `setMemberPermissions`, `expireStaleInvites`). Notification matrix, hours/rates/time-off, login security: done, beyond spec. Severity medium; size L.

### Kinfolk portal (vs ANDROID-STYLE-MOCKS + mytribe/ui-ideas)

| Area | Structural gaps | Functional gaps | Severity | Size |
|---|---|---|---|---|
| Home | None | Fully wired | Low | S |
| Schedule/Booking | Booking-detail drill-in (timeline, note, reschedule/cancel) has no route at all | `addBookingNote` + `requestBookingCancellation` real, called from nowhere; a kinfolk cannot note or cancel their own booking | High | M |
| KinTales | Mock's "Handled Tasks"/arrived-departed stats have no model fields | Share hardcoded "Coming soon" though `createShareLink`/`revokeShareLink` + guest page fully built; "Reply to Auntie" inert though `/messages` works | High (Share) | M |
| Invoices/Billing | Minor | No-refund ruling enforced server-side; gap: no update-payment-method callable | Low | S |
| Kin/Tribe roster | None major | "+ Add New" pet inert though `addKin` is real and registered | Medium-High | S |
| Sharing | Entire "Share the Love" flow absent from React portal | Not a backend gap: all of it exists and matches the mock | High | M |
| Notifications | None vs mock chrome | Granular per-type ruling unmet: backend models `byKey`, screen writes `byCategory` only | Medium | M |
| Sign-in/Account | Minor | TribePicker shown to any 2+ household kinfolk, not admin-only per mock filename ruling (needs operator decision); stale Account affordances | Low | S |

Housekeeping: `ANDROID-STYLE-MOCKS/EmailTemplateAssignment.png` and `TemplateBank.png` are admin mocks, `KinTaleCreation.png` is Auntie-side; none are portal screens.

## Part 2: Booking workflow gap analysis

Authoritative flow (`ui-ideas/BookingWorkFlow/*.png`, both platforms): 5-step wizard.
1. Select Client & Pets
2. Choose Service: searchable, categorized, price ranges, category badges
3. Schedule Dates: Individual vs Repeating toggle, two-month multi-select calendar, per-date editable time/location panel, multiple visits per day ("Add another visit")
4. Invoice Options (its own step; appears in no HTML mock or spec)
5. Review & Confirm: summary, total with surcharge note, Billing section (new invoice, Edit), Communication section (email confirmation + time visibility, off by default), private notes, then one Create Booking

Shipped today: `NewBookingDialog.tsx` (web) and `NewBookingRequestDialog.kt` (Android) are at parity with each other: single-page form on `createMultiDateBookingRequest`. Household picker (no per-kin selection by design), service chips from real `serviceRates`, Specific-dates/Weekly toggle, real calendar with live availability (business hours, Google busy imports, existing visits, timezone disclosure the mock lacks), ONE shared start time for all dates.

Missing on both platforms, confirmed against `requestBooking.ts` `VisitArgs`/`MultiArgs`:
- Multiple visits per day / per-date time or service (schema takes per-visit values; clients only produce one shared time)
- Per-visit location selector (no schema field exists)
- Invoice Options step (no billing-arrangement field exists; full-stack gap)
- Communication preferences step (no field exists)
- Review & Confirm step (form submits directly)

Cards directive (`auntieos-manage-bookings-...-cardsShouldOpenDisplayingFullerDetails.html`): Bookings.tsx row tap opens the thin `BookingActions` dialog, while the rich `BookingDetailModal` (kinfolk link, address, services, staffing picker, KinTale link, reschedule, separate kinfolk-facing and internal note threads) already exists, wired only into Schedule.tsx. Unmet on the one screen the filename names; fix is pure wiring.

Bulk actions: mock shows Select toggle + floating bulk bar. `batchUpdateBookings` exists; Android calls it; web Notifications quick actions call it. Bookings.tsx has none of it.

Audit-trail finding: `approveBooking`/`rejectBooking`/`cancelBooking`/`markBookingCompleted` in `api/bookingsWrite.ts` are raw client `updateDoc` writes on `kin_care_sessions`, gated only by `isAuntie()`, no state machine, no `writeAuditEntry`. Disclosed in code comments; distinct cancel-vs-reject semantics deliberately preserved. The one money-adjacent path this unguarded.

Portal: booking-detail drill-in absent, `addBookingNote`/`requestBookingCancellation` uncalled.

Build split: wiring-only (BookingDetailModal tap, bulk bar, portal note/cancel) vs backend-first (billing arrangement, communication prefs, per-visit location, multi-visit-per-day) vs the wizard UX on top.

## Part 3: Top 10 build order (operator pain)

1. Bookings tap opens `BookingDetailModal` (named by the operator's own mock filename; component exists). S/M
2. Invoice Detail: Linked Sessions panel + payment history (largest regression; money visibility). M
3. Vet double-authoring fix (live, pet-safety). M
4. Members/Invites UI (full backend, zero surface; blocks onboarding anyone). M/L
5. Booking-create wizard (largest lift; needs new backend fields first). L
6. Web KinTale Logs: wire `triageOrphanReport` (unbilled work invisible). M
7. Portal Share the Love UI ("Coming soon" reads as broken). M
8. Bookings bulk-select UI (`batchUpdateBookings` ready). S/M
9. Vet Clinics manager: update/delete (cannot correct a wrong phone today). S/M
10. Portal booking note/cancel wiring (today it routes as a support call). M

Honorable mentions: shell bell/badge, Activity Log click-through, portal per-type notification prefs, portal Add Kin.

## Part 4: Mocks ruled stale, operator re-mocks needed

- 01 Home: both mocks rejected, cited replacement absent; HIGH urgency, the widget pivot needs an intent ruling
- 17 Invoice Detail: `invoiceNEEDSupdate.html`; HIGH urgency (scopes the biggest regression fix)
- 16 Invoices: `Killinvoice2-needupdate.html`
- 21 Notifications: mock genuinely does not exist; needs a FIRST mock
- 18 Payments: spec archived; no mock exists for the resolved IA (kinfolk/invoice-context review surface)
- 05 Kinfolk Edit, 25 Template Assignment, 29 Business Hours: stale/rejected, low urgency, code already fine
