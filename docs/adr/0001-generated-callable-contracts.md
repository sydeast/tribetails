# ADR-0001: Generated callable contracts

Date: 2026-07-28
Status: Accepted. Supersedes the Option C (guarded hand-mirror) choice in
`auntieos-admin/docs/2026-07-18-AO5-AO8-shared-contract-design.md`.

## Context

Request shapes are machine-frozen (26 of ~50 admin-invoked callables in
`test/callableContract.test.ts`), but response shapes have no machine guard at
all: no callable defines a response zod schema, and `CALLABLE_CONTRACT.md`
names itself the "review anchor" for responses. The mirror discipline Option C
relies on has measurably drifted:

- `auntieos-admin/src/lib/invoiceMath.ts:4` claims a byte-identical twin while
  the server copy has three exports the mirror lacks (`settleInvoice`,
  `invoiceTotalCentsOf`, `isPartiallyPaid`, added 2026-07-25).
- The Android `createInvoice` payload map (`AuntieRepository.kt:1528-1542`) is
  inspected by no test.
- `CALLABLE_CONTRACT.md:29-30` reports its own coverage as 10 frozen shapes;
  the test freezes 26.

A rename in a 20-field response DTO (`getMyInvoices.ts:41-90`, transcribed
field-for-field in `mytribe/web/src/api/invoicesApi.ts:43-88`) ships a
silently broken portal today.

## Decision

The server zod schema is the single authority for both directions:

1. Every cross-app callable defines a response schema and validates outbound.
2. A codegen step produces the Contracts module: TypeScript types for both web
   clients and Kotlin data classes plus decoders for Android.
3. Generated artifacts are committed. CI regenerates and fails on any diff, so
   a schema change and its generated fallout land in one reviewable commit.

## Consequences

- Hand mirrors are deleted as each client adopts: web `api/*.ts` DTO
  transcriptions, admin api mirrors, `AuntieRepository` payload maps and
  `decode*` functions.
- `callableContract.test.ts` shrinks from a 628-line frozen-key ledger to the
  regen-is-clean check plus any deliberate freeze of the zod source itself.
- The response half of `CALLABLE_CONTRACT.md` retires; the doc becomes prose
  about semantics, not shapes.
- A new callable cannot ship a cross-app response without a schema, which is
  the point.
- Sequenced after ADR-0002 so the invoice response surface is stable before it
  is generated.
