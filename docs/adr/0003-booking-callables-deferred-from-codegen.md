# ADR-0003: Booking callables stay out of the generated Contracts module, for now

Date: 2026-08-01
Status: Superseded by its own follow-up, same day. The precondition Decision 1
named was met (PR #197, PR #195) and the migration it deferred has landed; see
Update below. The Context, Decision and Consequences sections stand as the
historical record of why the migration waited; they describe a state that no
longer holds and are kept unedited rather than rewritten to look prescient.

## Context

Punchlist item E2 asks the question ADR-0001 left open: the booking family (9
callables: `getMyBookings`, `requestBooking`, `requestBookingCancellation`,
`addBookingNote`, `addInternalBookingNote`, `createMultiDateBookingRequest`,
`rescheduleBooking`, `manageBookingSeries`, `batchUpdateBookings`) is still
hand-mirrored on every client, and the punchlist calls for a decision rather
than an implementation.

`mytribe/functions/scripts/contracts/registry.ts`'s `CallableContract` requires
a non-null zod `result` for every entry; there is no "request only" mode. That
is not an oversight, it is ADR-0001 decision 1 stated as a type: "every
cross-app callable defines a response schema." The registry's own header
already names the consequence: "the remaining ~150 callables have no response
schema yet, so there is nothing to generate from; they arrive as their schemas
do."

Checked against source, every one of the 9 booking callables is in that
remainder:

- `getMyBookings` (`mytribe/functions/src/portal/getMyBookings.ts:62`),
  `rescheduleBooking` (`admin/rescheduleBooking.ts:24`), `manageBookingSeries`
  (`admin/manageBookingSeries.ts:29`) and `batchUpdateBookings`
  (`admin/batchUpdateBookings.ts:37`) return a hand-written `interface`, never
  a zod schema.
- `requestBooking`, `requestBookingCancellation`, `addBookingNote`,
  `addInternalBookingNote` and `createMultiDateBookingRequest` return an
  inline object type annotated on the handler's `Promise<...>`, same
  situation.
- No booking `Result` is passed through `validateResponse` (compare
  `admin/createInvoice.ts:213`, which is how the 19 invoice callables became
  eligible ahead of ADR-0001). Nothing on the response side of this family has
  ever been checked against a schema, machine or human.

Request shapes fare a little better (7 of 9 already have a local zod `Args`)
but are not exported, so `test/callableContract.test.ts` cannot freeze them
either; `CALLABLE_CONTRACT.md:734-761` is their only review anchor today,
doc-only, same as every response in this family.

`requestBooking` additionally has no SINGLE request shape to export:
`requestBookingHandler` (`portal/requestBooking.ts:370-444`) tries `MultiArgs`
first and falls back to `LegacyArgs` on failure, neither exported. The
registry models one `args` schema per callable; representing this pair would
mean a union (a construct `readModel.ts`'s `type()` switch has no case for and
would refuse) or a registry redesign. That is a second, independent decision,
not a generation detail to paper over.

Making any booking `Result` real (not just declaring a zod schema, but wiring
`validateResponse` the way every generated invoice callable does) is a runtime
behavior change: a response that stops matching its schema starts logging at
`error` severity and, for a `.strict()` schema, reporting an added field it
does not today. That lands squarely in "callable semantics," which this task
was scoped to leave alone. It would also touch the exact handler bodies and
return statements two other in-flight changes are editing right now:
`admin/rescheduleBooking.ts`, `admin/manageBookingSeries.ts` and
`admin/batchUpdateBookings.ts` are mid-edit for audited status transitions
(punchlist A3/A4) and the `batchUpdateBookings` id fix (punchlist C3). A
contracts change that rewrites those same return statements is a guaranteed
collision on the lines that matter, not a parallel-safe edit.

The hand mirrors this would replace are real and, per the enumeration attached
to the PR, already drifted in places ADR-0001 predicts: Android's
`createMultiDateBookingRequest` payload omits `priceCents`, `location`,
`billing`, `communication` and `overrideBusyConflict` entirely
(`BookingRepository.kt:78-92`); its `manageBookingSeries` decode never reads
`ok`, `action` or the `batchId` echo (`AuntieRepository.kt:2479-2492`); its
`rescheduleBooking` call discards the response outright
(`KinCareRepository.kt:276-282`). This is exactly the drift ADR-0001 exists to
end. It is also exactly why rewiring 9 response contracts in the middle of two
other engineers' in-flight edits to those same callables would compound the
risk it is meant to reduce.

## Decision

Booking callables are not added to `INVOICE_CONTRACT_REGISTRY` (or a sibling
registry) in this change. The blocker is structural and applies uniformly, not
callable by callable: none has a zod `Result`, and giving one a `Result` means
wiring `validateResponse` into a handler body that is presently being edited
for unrelated reasons.

This is deferred, not abandoned:

1. Once the audited-status-transition and `batchUpdateBookings` id work lands,
   each booking callable earns a zod `Result` and a `validateResponse` call in
   its own reviewable PR, the same sequencing ADR-0001 used for the 19 invoice
   callables (PR #112 gave them `Result` schemas before any codegen read one).
   `requestBooking`'s dual-shape request gets its own decision at that point:
   collapse `LegacyArgs`/`MultiArgs` into one schema, or teach the registry a
   per-callable union.
2. Only after every booking `Result` exists and is wired does adding the
   family to a contracts registry become a codegen change instead of a
   response-schema-authoring change wearing a codegen change's name.
3. Until then, `CALLABLE_CONTRACT.md` remains the review anchor for this
   family, as it already is, and the file:line enumeration in this PR is the
   standing evidence of where every current mirror lives, so the eventual
   migration has a checklist instead of a fresh search.

## Consequences

- The Contracts module (`PORTAL_TYPES_PATH`, `ADMIN_TYPES_PATH`,
  `ANDROID_KOTLIN_PATH`) is unchanged by this PR: it still covers only the
  invoice surface.
- Punchlist E2's "Size S" decision half is closed by this ADR. Its "Size M"
  migration half is re-opened as the prerequisite in Decision 1 above, sized
  per callable once response schemas exist to generate from.
- The drift already found in the Android mirrors (above) is not fixed here.
  It is out of scope for a contracts-and-types task per this task's own
  instructions (fixing it means changing what `manageBookingSeries` and
  `rescheduleBooking` decode, which is client behavior, not a generated type),
  and is reported here so it is not lost between this PR and the eventual
  migration.
- A future reader asking "why isn't booking generated like invoices" finds
  this document instead of re-deriving the answer from `registry.ts`'s
  comments.

## Update, 2026-08-01: the follow-up landed

The precondition in Decision 1 was two PRs: #197 (audited status transitions,
touching `rescheduleBooking.ts`, `manageBookingSeries.ts`) and #195
(`batchUpdateBookings` id resolution). Both are on `main`. This update records
what happened once they were, in the same ADR voice rather than a fresh
document, because the question a future reader asks here is "did the deferred
work happen," not "why was it deferred" a second time.

**Every one of the 9 booking callables now exports a `Result` and validates
outbound through it**, the same `validateResponse('name', Result, value)` call
`createInvoice.ts:213` used as the pattern this ADR cited. None changed what
it returns; each `Result` was written by reading the handler's existing
return statements, not by redesigning them:

- `getMyBookings` -- `{ liveVisit, upcoming, recent, envelopes }`, with the
  per-visit and per-envelope shapes as nested objects. No `Args`: it still
  reads one optional string off `req.data` with no zod authority, the
  `getMyInvoices` situation this ADR already named as precedent.
- `requestBooking` -- `{ batchId, bookingIds, bookingId }`, `bookingId`
  narrowed from optional to required: both write paths have always set it.
- `requestBookingCancellation` -- `{ ok, visitId, alreadyPending }`.
- `addBookingNote` / `addInternalBookingNote` -- `{ noteId }` each.
- `createMultiDateBookingRequest` -- `{ batchId, visitIds, visitCount }`.
- `rescheduleBooking` -- `{ ok, sessionId }`.
- `manageBookingSeries` -- `{ ok, action, batchId, affectedVisits,
  sessionsCreated, failedVisits }`.
- `batchUpdateBookings` -- `{ ok, action, updated, failed: [{ id, error }] }`.

**`requestBooking`'s dual-shape problem: collapsed, not unioned.** Decision 1
named the choice and left it open. The registry's `readModel.ts` refuses a
root that is not a single `z.object` -- a `z.union` hits its `default` case
and throws naming the construct -- so a union was never actually available
without teaching the generator a new construct for a fork this ADR could not
show was real. Checked against the only live caller
(`mytribe/web/src/api/bookingApi.ts`, the kinfolk portal): every request it
builds is `MultiArgs` shaped. Nothing sends the legacy single-visit shape
today. `requestBooking.ts` keeps `LegacyArgs`/`MultiArgs` exactly as they
were, unexported, doing the real parsing unchanged, and adds a third,
exported `Args`: a superset covering both shapes, used only by the registry.
Two fields (`visits[].endTimeMs`/`priceCents`/`location`, and the legacy flat
`endTimeMs`) needed narrowing to satisfy `readModel.ts`'s other rule --
`.nullable()` and `.optional()` together are refused, because Kotlin's one
`T?` cannot distinguish an omitted key from an explicit `null`, which matters
on a PATCH but not on this CREATE, where the two already mean the same thing
to the handler. The exported `Args` sends the key with an explicit `null`
where the internal schemas would have allowed omitting it; every payload the
exported schema can build still parses under the real internal one.
`createMultiDateBookingRequest.ts` hit the identical nullable-and-optional
construct in its own visit schema (it mirrors `requestBooking`'s `VisitArgs`
field for field, by design) and took the same fix, `HandlerArgs` kept
unexported and unchanged, `Args` exported and narrowed.

**The family is generated.** `scripts/contracts/registry.ts` gained
`BOOKING_CONTRACT_REGISTRY`, sitting beside `INVOICE_CONTRACT_REGISTRY`
rather than merged into it, so the 19 invoice callables PR #112 originally
scoped stay exactly that set. `artifacts.ts` generalized from one hardcoded
path triad to an `ArtifactPaths` parameter, so each registry renders into its
own files: `bookingContracts.generated.ts` (kinfolk portal, React admin) and
`BookingContracts.generated.kt` (Android), alongside the existing
`invoiceContracts.generated.*`. `contracts:check` is green across all six
generated artifacts.

**All three clients moved.** The hand mirrors the original PR's enumeration
found are deleted or repointed at the generated types:

- Kinfolk portal (`mytribe/web/src`): `api/types.ts`'s `GetMyBookingsRequest`/
  `BookingDto`/`EnvelopeDto`/`GetMyBookingsResult` hand transcription is gone;
  the response half comes from `contracts/bookingContracts.generated.ts`, the
  request half stays hand-written next to `getMyBookings()` in `api/portal.ts`
  (no zod `Args` to generate from, same as `getMyInvoices`). `api/bookingApi.ts`
  no longer declares `RequestBookingRequest`/`Result`,
  `RequestBookingCancellationRequest`/`Result`, or `AddBookingNoteRequest`/
  `Result`; all three now come from the generated module.
- React admin (`auntieos-admin/src`): `api/bookingsWrite.ts` no longer
  declares `NewBookingVisit`/`NewBookingBilling`/`NewBookingCommunication`/
  `CreateMultiDateBookingArgs`/`Result`, `BatchUpdateBookingsResult`,
  `RescheduleBookingResult`, or `AddNoteResult`; all now come from
  `contracts/bookingContracts.generated.ts`. The wizard's second, independent
  mirror (`lib/bookingWizard.ts`'s `WizardVisit`) is now a type alias for the
  generated `CreateMultiDateBookingRequestArgsVisit` rather than its own
  interface. `lib/bookingDetailFormat.ts`'s `RescheduleTimes` is a `Pick` off
  the generated `RescheduleBookingArgs`. `manageBookingSeries` stays
  unreached from this client, as `bookingsWrite.ts` already documented; that
  is unchanged.
- Android (`auntieos-admin/android`): `BookingNotesRepository.kt`
  (`addBookingNote`, `addInternalBookingNote`), `BookingRepository.kt`
  (`createMultiDateBookingRequest`), `KinCareRepository.kt`
  (`rescheduleBooking`) and `AuntieRepository.kt` (`manageBookingSeries`,
  `batchUpdateBookings`) all build their request through the generated
  `*Args.toPayload()` and decode through the generated `decode*Result`
  functions instead of a hand `mapOf` and a hand cast. `getMyBookings`,
  `requestBooking` and `requestBookingCancellation` are still not called from
  Android (it reads the underlying `kinCares` Firestore docs directly for its
  own booking views, a separate problem this follow-up did not touch).

**The three drift bugs this ADR reported and deliberately did not fix are
fixed now:**

1. `createMultiDateBookingRequest` (`BookingRepository.kt`) used to build its
   own payload map by hand, and that map had no slot at all for `priceCents`,
   `location`, `billing`, `communication` or `overrideBusyConflict` -- not "the
   UI doesn't collect them," but "there was nowhere on the wire for them to
   go even if it did." The repository now takes `billing`, `communication`
   and `overrideBusyConflict` as real parameters (default `null`/`false`) and
   sends `priceCents`/`location` as an honest `null` per visit, since no
   Android screen collects either today. `EnhancedSchedulingViewModel`'s
   `createBookingRequest` threads `overrideBusyConflict` through, default
   `false`; nothing calls it `true` yet, but a future "force past a busy
   conflict" affordance on this dialog now has a real parameter to reach
   instead of another repository rewrite.
2. `rescheduleBooking` (`KinCareRepository.kt`) used to discard the response
   entirely (`Result<Unit>` built from nothing but "the call did not throw").
   It now decodes the response and fails the call when `ok` is not `true` or
   the echoed `sessionId` does not match what was requested.
3. `manageBookingSeries` (`AuntieRepository.kt`) decoded `ok`, `action` and
   `batchId` off the raw response and never looked at any of the three again.
   It now fails the call when `ok` is not `true`, or when the echoed
   `action`/`batchId` do not match what was requested.

None of the three changes what a healthy server response contains; all three
change what the client does with an unhealthy one, from "reported as success"
to "reported as failure." No new transition, no new gate, no new UI screen.

**Android decoders have real unit tests**, not just compilation:
`BookingContractsGeneratedTest.kt` exercises the fail-soft decode contract
(null payload, empty payload, wrong-typed payload, real payload) for the
family's more complex shapes, and three repository-level test files
(`KinCareRepositoryRescheduleTest.kt`, `AuntieRepositoryManageBookingSeriesTest.kt`,
`BookingRepositoryCreateMultiDateTest.kt`) exercise the three drift fixes and
the wire payload each repository now sends, mocking `FirebaseFunctions` the
way `KinCareRepositoryTransitionTest.kt` and
`AuntieRepositoryBatchUpdateBookingsTest.kt` already did.

**`CALLABLE_CONTRACT.md` is in step.** The booking family's response half
stops being doc-only; the doc says so at the top and at each callable, and a
new section documents the six callables (`getMyBookings`, `requestBooking`,
`requestBookingCancellation`, `createMultiDateBookingRequest`,
`rescheduleBooking`, `manageBookingSeries`) that had no entry there at all
before this follow-up.

Punchlist E2's "Size M" migration, reopened by Decision 1 as a prerequisite,
is closed by this update.
