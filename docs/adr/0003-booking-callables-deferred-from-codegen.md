# ADR-0003: Booking callables stay out of the generated Contracts module, for now

Date: 2026-08-01
Status: Accepted. Amends ADR-0001 by scoping its Contracts module to the
invoice surface until the precondition below is met; does not reopen ADR-0001
decisions 1-3.

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
