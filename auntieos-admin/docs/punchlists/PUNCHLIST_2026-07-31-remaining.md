# Remaining work after the 2026-07-31 batch

**Date:** 2026-07-31, blocked-work section updated 2026-08-01
**Baseline:** `origin/main` at `5fba1d6`, after every PR from #139 to #183 that
merged. #184, #185 and #186 were open when this was written and are tracked
under "Blocked right now" rather than counted as landed.
**Grounded against:** live source on `origin/main`, re-checked line by line for this
document. Where an item disagrees with the 2026-07-31 mock-adherence audit, the
source won and the difference is stated.

## How to read this

Every item names the file and line that proves it, what already exists on the
backend, and what is actually missing. An item is only here if it survived a
direct read of current `main`. Three items from the audit's top ten shipped
during the batch and are recorded as closed at the bottom, so this list is not
mistaken for the whole backlog standing still.

Sizes are S (under a day), M (one to three days), L (a week or more).

---

## Blocked right now

### main was RED on Android. PR #187 merged 2026-08-01 and it is green.

Kept in full because the three defects it describes are the reason to run a
local Android build after any grouped dependency bump, not just history.

`origin/main` at `5fba1d6` failed `:app:testDebugUnitTest`, and the CI run for the
#181 merge reports it. PR #180 bumped 36 Android dependencies at once and broke
three separate things. CI only ever reported the first, because the build stops
there.

1. `androidx.core` 1.19.0 and `androidx.lifecycle` 2.11.0 declare a minimum
   compileSdk of 37 in their AAR metadata. `build.gradle.kts` pinned 36, and
   `checkDebugAarMetadata` fails rather than warns.
2. `AuntieAvatarStack.kt:132` matched `painter.state` against
   `AsyncImagePainter.State` subtypes, but in coil3 that property is a
   `StateFlow<State>`. No branch has ever matched, so a broken avatar url has
   been rendering nothing instead of the initials monogram since the coil3
   upgrade. Kotlin 2.4.10 promoted the warning to an error, which is the only
   reason it surfaced.
3. `GrpcVersionRegressionTest` asserted a class that grpc-api 1.83.0 does not
   contain, while `build.gradle.kts:229` has forced 1.83.0 since the initial
   commit. It passed anyway because `configurations.all` did not reach the
   unit-test classpath before AGP 9.3.1, so the test measured a classpath the
   shipped APK never had. It now asserts the real invariant, which is that
   grpc-api and grpc-core agree.

Merged as `436b3ac`. 1899 tests, 0 failures.

### PR #185, visual harness retirement, is re-scoped and no longer a full retirement

Operator ruling 2026-08-01, overruling the wider scope this PR shipped with:
delete the wrong designs, keep the machinery. `visual/mockups/` and
`visual/baselines/` go, because they are the superseded Compose captures and the
pre-ruling concept round an agent should never read. The Playwright harness under
`web/visual/`, the roborazzi wiring and `auntieos-admin/e2e/` all stay.

So the `.github/workflows/ci.yml` edit is out of scope now, which also removes
the push blocker: the earlier branch could not be force-pushed from a background
session, because the available OAuth token has no `workflow` scope.

### PR #184, scripts migrated to modular firebase-admin, has never run CI

`mytribe/scripts` still calls the legacy `admin.firestore()` namespace, which
`firebase-admin ^14` removed, so every backfill and seed script throws at
runtime. The fix is written and open. Its checks sit at `action_required`:
GitHub holds workflow runs on pull requests from the Copilot agent until a
maintainer approves them, and nobody has. The PR is also still a draft.
Needs one click on "Approve and run workflows", then a normal review.

---

## A. Money and safety

These are first because each one either hides money or risks a wrong answer in an
emergency.

### A1. Invoice Detail shows neither its linked sessions nor its payments

**Size M. The largest regression in the audit, and it is money visibility.**

`auntieos-admin/src/screens/InvoiceDetail.tsx` contains zero references to
`sessionIds` or to the `payments` subcollection. Both are real:

- `src/api/invoices.ts:110` declares `sessionIds: string[]` on the invoice model,
  and `:290` normalizes it defensively.
- `src/api/invoicesWrite.ts:282` exports `listUninvoicedSessions`, and
  `invoices.ts:38` documents `linkInvoiceSessions` as the callable that returns
  both sides.
- The `payments` subcollection is written by `recordPayment`, whose generated
  contract sits at `src/contracts/invoiceContracts.generated.ts:376`.

So an operator opening an invoice cannot see which visits it bills or what has
been paid against it. Android shipped exactly this panel in the same batch, which
is where the shape should come from.

**Second half of the same problem:** web's "record payment" calls only
`markInvoicePaid`, never `recordPayment`. `recordPayment` appears in
`invoiceContracts.generated.ts` and in no call site under `src/`. The payments
ledger is therefore written from Android only, and read nowhere in web.

Needs the operator's re-mock first (see F2): `invoiceNEEDSupdate.html` is stale.

### A2. The vet is authored in two places that cannot agree

**Size M. Pet-safety-adjacent.**

Two independent stores hold the same real-world fact, with no tie between them:

- `src/screens/KinfolkEdit.tsx:120-123` and `:278-281` read and write
  `vetClinicName`, `vetClinicAddress`, `vetClinicPhone`, `vetClinicId` on the
  kinfolk doc, picked from the `vet_clinics` catalog via `VET_CLINICS_QUERY`.
- `src/lib/householdDataSchema.ts:99-105` defines `primaryVetName`,
  `primaryVetPhone`, `primaryVetAddress`, `primaryVetHours`, `emergencyVetName`,
  `emergencyVetPhone`, `emergencyVetAddress` as free text on the household
  record, with zero tie to the catalog.

`HouseholdData.tsx:44` describes that screen as the one someone reads "the
emergency vet's number off" under pressure. Right now that number can be older
than, and different from, the catalog-linked one on the profile, and nothing in
either screen says so.

This needs a decision before code: which store is canonical. `KinEdit.tsx:52-53`
already asserts one answer in a comment ("The canonical household vet is
`kinfolk.vetClinicName` / `vetClinicPhone` / `vetClinicAddress`"), so the
cheapest correct fix is to make Household Data's veterinary section read that
record instead of holding its own copy, and migrate whatever free text exists.

### A3. Booking status writes bypass the audit trail

**Size S to M.**

`src/api/bookingsWrite.ts:84` is a raw client `updateDoc` on `kin_care_sessions`,
gated only by `isAuntie()`. No state machine, no `writeAuditEntry`.
`approveBooking`, `rejectBooking`, `cancelBooking` and `markBookingCompleted` all
route through it. This is the one money-adjacent path left unguarded, and the
file discloses it in its own comments rather than hiding it.

The fix is a callable that owns the transition and audits it, matching the
pattern `createKinCareSession` already uses. Distinct cancel-versus-reject
semantics were preserved deliberately and must survive the move.

### A4. Every callable failure is audited as a success

**Size S. Small fix, wide blast radius.**

`mytribe/functions/src/lib/writeAuditEntry.ts:112`:

```ts
const status = args.status ?? (args.severity === 'critical' ? 'FAILURE' : 'SUCCESS');
```

`wrapCallable.ts:78-84` writes its `ERROR_FUNCTION_FAILURE` entry with
`severity: 'warn'` and no `status`. Warn is not critical, so the default lands on
`SUCCESS`. Every audited function failure in the system is stamped as a success,
which means an audit query filtering on `status` returns a clean history for a
period that contained failures.

Fix is one argument at the call site. Worth checking the other
`writeAuditEntry` callers for the same omission while in there.

---

## B. Backend fully built, zero surface

Each of these is a callable that exists, is registered, is tested, and that no UI
ever calls. Under the flags-ship-functional ruling these are the same class of
problem as a flag with no backing: something that reads as available and is not.

### B1. Members and Invites has no UI anywhere

**Size M to L. Blocks onboarding anyone.**

`mintInvite`, `revokeInvite`, `inviteKinfolkToPortal`, `setMemberPermissions` and
`expireStaleInvites` are all real. Zero matches for `mintInvite`,
`revokeInvite` or `setMemberPermissions` anywhere under `auntieos-admin/src`.

There is no screen, no route, no button. Adding a second Auntie or inviting a
household to the portal is not possible from any shipped surface.

### B2. Web KinTale Logs cannot triage an orphan report

**Size M. Unbilled work stays invisible.**

`triageOrphanReport` is a real audited callable that Android calls. Zero matches
under `auntieos-admin/src`. An orphaned report is completed work with no session
to bill it against, so on web it simply does not surface.

### B3. Portal: Share the Love is absent, and three more callables are inert

**Size M. The share one reads as broken to a paying household.**

`mytribe/web/src/api/callables.ts` allowlists all four, and no screen calls any
of them:

| Callable | Line | What the kinfolk cannot do today |
|---|---|---|
| `createShareLink` | `:34` | Share a KinTale. The UI says "Coming soon" although the callable and the guest page are both fully built. |
| `requestBookingCancellation` | `:24` | Cancel their own booking. It routes as a support call. |
| `addBookingNote` | `:25` | Leave a note on a booking. Same. |
| `addKin` | `:27` | Add a pet. The "+ Add New" control is inert. |

The booking pair additionally has no drill-in route at all, so there is no screen
they could be wired into yet. `createShareLink` and `addKin` are pure wiring.

### B4. Vet Clinics has a picker and no manager

**Size S to M.**

`mytribe/functions/src/portal/` contains exactly two vet-clinic callables:
`getVetClinics.ts` (read) and `submitVetClinic.ts` (create). There is no update
and no delete, on any platform.

A clinic entered with a wrong phone number cannot be corrected today, and the
wrong number is what someone reads in an emergency. This compounds A2: fixing the
double-authoring is worth less while the surviving store cannot be edited.

Note the dependency doc claims this shipped. It did not.

---

## C. Silent defects

Things that look correct and are not. None of these produce an error.

### C1. Company holidays are stored and read by nothing

`src/lib/closureRecurrence.ts:63` says it plainly: "as of this writing, nothing
reads `companyHolidays` to..." The yearly-recurrence work in PR #150 made the
entries correct and durable. It did not connect them to availability, so marking
a US national holiday closed still leaves the day bookable.

Size M. The consumer is booking availability, which is where the busy-import
guard from PR #183 already sits.

### C2. Web's default dashboard substitution persists and clobbers the phone layout

`src/lib/dashboardLayout.ts:121-123`: the effective dashboard at load is the
saved layout, or `DEFAULT_DASHBOARD` when nothing is stored. PR #158 fixed the
paint-order flash. The remaining defect is that the substituted default can be
written back, so a web session can overwrite a layout the operator arranged on
the phone. Size S to M.

### C3. Android's bulk booking action has never worked

`AuntieRepository.kt:1442` calls `batchUpdateBookings` with visit ids. The
callable resolves ids only against `collectionGroup('kinCares')`, so the
bookings-list ids it is handed never match. This has been broken since it was
written; nothing regressed. Web's equivalent (PR #156) works because it writes
both sides of the split. Size M, and it needs the callable fixed, not the client.

---

## D. Platform parity

### D1. Android booking create is still a single page

Web got the mock's five-step wizard in PR #157.
`android/.../ui/admin/scheduling/NewBookingRequestDialog.kt` is still the
single-page form on `createMultiDateBookingRequest`. Per NON-NEGOTIABLE #1 this
feature is not done until Android matches. Size L.

Blocked behind the same backend gaps as web was: no billing-arrangement field, no
communication-preferences field, no per-visit location field, and no support for
multiple visits per day. Those are schema additions in `requestBooking.ts`.

### D2. Twelve Home widgets exist on Android and not on web. DONE 2026-08-01

Closed by the D2 port. The operator ruled that waiting on the F1 re-mock was the
wrong call and that parity plus the shipped design system was enough to build
from, so all twelve were ported as they stand on the phone: the stat row,
Today's Pack, KinTales pending, Cash Flow, Gatekeeper, Weather Watchdog, Heat
Stroke Index, Weekly capacity, Overdue visits, Kin by type, Frequent flyers and
Holiday runway.

The React admin now draws all nineteen keys. `WEB_WIDGETS` is a total record
over `DashKey`, so a key added to the model cannot ship without a component, and
the web-only seven-card default is gone: an un-customized operator now sees the
same board on both surfaces.

Home is NOT redesigned by this. Whether the widget dashboard is the Home the
product wants is still F1's question, and the port does not answer it.

Not ported, and named rather than left as a silent gap: the in-field lifecycle
buttons on Today's Pack (On My Way / Arrived / Departed). Each drives android's
foreground `LocationTrackingService` and a local `VisitNotifier` notification,
neither of which a browser tab has. Acting on a visit on this surface goes
through Auntie Time, as it always has.

---

## E. Deferred on purpose

### E1. TypeScript 7 migration

`typescript-eslint@8.65` peer-requires TypeScript below 7.0, so `npm ci` fails on
the TS 7 majors. Ignored on all three workspaces (`auntieos-admin`,
`mytribe/web`, `mytribe/functions`) via `@dependabot ignore this major version`.
Revisit when typescript-eslint ships TS 7 support. This is a deliberate
cross-workspace migration, not a bump. Size M.

### E2. Booking callables are not in the generated contracts

ADR-0001 covers invoice callables. The booking family is still hand-mirrored on
each client, which is exactly the drift the ADR exists to prevent. Needs a
decision rather than an implementation: bring them in, or write down why not.
Size S for the decision, M for the migration.

---

## F. Needs the operator, not an engineer

Work that cannot start correctly until a ruling or an asset arrives.

### F1. Home: is the widget dashboard the intended design?

Both existing Home mocks are rejected, and the spec's cited replacement
(`auntieos-redesign.html`) is not in the repo. What shipped is a 19-key widget
dashboard unrelated to the spec's stat-row baseline. Still open, and still the
highest-urgency re-mock.

NO LONGER GATES D2. The operator ruled on 2026-08-01 that the parity was worth
building without waiting, so the twelve widgets were ported onto the dashboard
as it stands. That decision unblocked D2; it did not answer F1. A re-mock that
changes the concept now changes nineteen cards on two surfaces rather than
nineteen on one, which raises the cost of the answer without changing the
question.

### F2. Invoice Detail re-mock

`invoiceNEEDSupdate.html` is stale. This scopes A1, the biggest regression on the
list, so it is the second-highest urgency.

### F3. Invoices list re-mock

`Killinvoice2-needupdate.html` is stale.

### F4. Notifications has no mock at all

Not stale, absent. Needs a first mock. The shipped screen is more complete than
the spec credits (read flags, bulk mark-read, archive, booking approve and deny
quick actions), so the mock should start from what exists.

### F5. Payments review surface

The spec is archived and the standalone screen was correctly not built. What has
no mock is the resolved information architecture: reviewing payments in kinfolk
or invoice context. A1's second half has nowhere to land until this exists.

Low urgency, code already fine: Kinfolk Edit (05), Template Assignment (25),
Business Hours (29).

### F6. Can a household reschedule, or only request one?

Raised 2026-08-01 during B3, and it is a policy call before it is a build.

Two controls in the portal do nothing: **Reply to Auntie** and **Reschedule
visit**. The reschedule half is not a missing callable in the usual sense.
`rescheduleBooking` exists at `mytribe/functions/src/admin/rescheduleBooking.ts:83`
and is wrapped in `wrapAdminCallable`, so it is admin-only and absent from the
portal allowlist (`mytribe/web/src/api/callables.ts`). A household cannot reach
it by design.

So the question is what a household is allowed to do:

- **Request, not act.** A new `requestBookingReschedule` mirroring
  `requestBookingCancellation`, which #194 just wired: the household proposes,
  the operator disposes. Consistent with how cancellation already works, and it
  never lets a household move a visit onto a slot the operator cannot staff.
- **Act directly, inside rules.** Extend the callable to admit a kinfolk caller
  under constraints (own booking only, outside the cutoff window, no busy
  conflict). More capable, more ways to be wrong, and it needs the busy-conflict
  guard from #183 applied to a caller who cannot see the calendar.

Reply to Auntie needs the same kind of ruling about inbound messaging, which
touches the Twilio path rather than bookings.

Under the flags-ship-functional ruling, leaving both inert is not an option. The
only question is which of the two shapes gets built.

### F7. What does `createdAt` mean on a KinTale?

Raised by the operator 2026-08-01: every KinTale in the system today is a
historical visit report imported from the previous system, and `createdAt` should
belong to reports created in AuntieOS.

The field is worse than ambiguous, it is currently two formats in one column.
Verified against prod on 2026-08-01:

- Legacy rows carry free text, `"September 3, 2025 2:02pm"`, written by
  `migrate_visit_logs_to_kin_care_reports.py:90` from `visit_logs.submitted`.
- Everything else carries ISO, `"2025-12-02T19:00:00.000Z"`.

Firestore orders strings by UTF-8 byte, so letters beat digits: every legacy row
sorts ABOVE every ISO row in a `createdAt desc` query, and the legacy block sorts
among itself **alphabetically by month name**. The first page of the KinTales
list in prod today is September, September, September, and onward through the
alphabet. That ordering is not a nuance, it is the list being wrong.

The operator's proposal, which resolves both problems, is to redate the legacy
rows to their date added. The ingest stamp is already on every row as
`_migratedAt` (`"2026-05-16T20:36:39Z"`), and the original human date is already
preserved twice, in `visitDate` and `sentAt`, so nothing is lost.

Two open sub-questions before anyone writes to prod:

1. Should `visitDate` also be parsed from free text into ISO, so the real visit
   order is sortable? Otherwise the legacy block collapses to one identical
   ingest timestamp and their true sequence is only readable by a human.
2. The migration script still writes free text at line 90. It must be corrected
   in the same change, or a re-run reintroduces exactly this.

This is a prod data write, so it needs the operator's explicit go-ahead and
belongs in the runbook rather than an improvised session.

---

## Closed during this batch

Recorded so this list is not read as the whole backlog standing still. From the
audit's top ten:

| Audit item | Closed by |
|---|---|
| 1. Bookings tap opens `BookingDetailModal` | PR #155 |
| 5. Booking-create five-step wizard (web) | PR #157 |
| 8. Bookings bulk-select UI | PR #156 |

Also landed: the breed and vet-clinic dropdowns (#151, #152), yearly company
holidays (#150), gallery uploads without a kinfolk (#144), the merged Calendar
section (#145), Home widget flash (#158), the busy-import booking guard (#183),
feature flags shipping functional (#153, #154), and the CI and release-tagging
work (#142, #143).

The Integrations report (#182) was written during the batch, sat open while this
list was, and merged 2026-08-01 once #187 had unblocked its Android job.

## Sequencing

Green main first, then money and safety, then the built-but-unreachable
backends, because those are the cheapest ratio of operator pain to engineering
time.

0. PR #187, main is red (merged 2026-08-01)
1. A4, one argument, restores audit truth (S)
2. A1, once F2 lands (M)
3. A2 plus B4 together, since fixing the authoring is worth less than fixing it
   in a store nobody can edit (M)
4. B1, Members and Invites (M/L)
5. A3, booking writes behind an audited callable (S/M)
6. B2 and B3's wiring half, both pure wiring (M)
7. C1, C2, C3 (M each)
8. D1, after the `requestBooking.ts` schema additions (L)
