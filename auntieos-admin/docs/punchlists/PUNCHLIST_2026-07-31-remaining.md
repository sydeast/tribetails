# Remaining work after the 2026-07-31 batch

**Date:** 2026-07-31
**Baseline:** `origin/main` at `5fba1d6`, after PRs #139 to #184 merged.
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

### PR #185, visual harness retirement, is CONFLICTING

Opened after main absorbed the dependabot run, so it conflicts on `ci.yml` and
`android/gradle/libs.versions.toml`. Both conflicts are mechanical: #185 deletes
roborazzi entries and CI comments that #180 and #170 also touched. Needs a rebase
onto `5fba1d6` before it can merge. Nothing else waits on it.

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

### D2. Twelve Home widgets exist on Android and not on web

Feature work, not a defect. Size L. Worth sequencing after F1, because the
operator ruling on whether the widget dashboard was the intended pivot decides
whether this is 12 ports or a redesign.

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
dashboard unrelated to the spec's stat-row baseline. Highest-urgency re-mock: it
also gates D2.

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
section (#145), Home widget flash (#158), the Integrations report (#182), the
busy-import booking guard (#183), feature flags shipping functional (#153, #154),
and the CI and release-tagging work (#142, #143).

## Sequencing

Money and safety first, then the built-but-unreachable backends, because those
are the cheapest ratio of operator pain to engineering time.

1. A4, one argument, restores audit truth (S)
2. A1, once F2 lands (M)
3. A2 plus B4 together, since fixing the authoring is worth less than fixing it
   in a store nobody can edit (M)
4. B1, Members and Invites (M/L)
5. A3, booking writes behind an audited callable (S/M)
6. B2 and B3's wiring half, both pure wiring (M)
7. C1, C2, C3 (M each)
8. D1, after the `requestBooking.ts` schema additions (L)
