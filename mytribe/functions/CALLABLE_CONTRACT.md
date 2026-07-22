# Cross-app callable contract (AO-8)

MyTribe callables are the contract. Three clients hand-mirror them: the AuntieOS
admin (React `auntieos-admin/src/api/*.ts`), the Compose app (`web/composeApp`
`FirestoreClient.kt`), and android (`AuntieRepository.kt`). This file is the
single human source those mirrors are built from.

`functions/test/callableContract.test.ts` freezes the REQUEST field set of the
widget callables below and fails on drift. When you change a shape on purpose:
edit that test's frozen set, edit this file, and edit all three client mirrors in
the same change. Response shapes are not zod-introspectable, so this doc is their
review anchor.

Frozen request shapes:

- Widget callables (AO-35/39/40/41): `optimizeRoute`, `logExpense`, `listExpenses`,
  `adjustSupply`, `upsertSupply`, `upsertExpiration`. (`listSupplies` /
  `listExpirations` take no args.)
- Money + state mutations (added 2026-07-21): `createInvoice`, `createQuote`,
  `markInvoicePaid`, `assignTemplate`. Flat shapes, so a top-level key freeze is
  accurate.

Coverage reality, so nobody over-trusts this: the admin invokes ~50 MyTribe
callables; the above 10 are frozen. The measured surface, not the stale "~26":

- NEXT TRANCHE (highest blast radius, needs a DEEPER guard than top-level keys):
  `broadcastMessage` (a `.superRefine` ZodEffects, so `.shape` needs unwrapping),
  `saveTemplate` (nested `sectionDefinitions`), `saveFormSchema` (3-level nested
  `sections[].fields[]`, where a nested rename is exactly what a top-level freeze
  misses). Freeze these with a recursive key-path signature, not `shapeKeys`.
- The remaining ~36 are lower-complexity (2 to 3 flat fields); freeze as they churn.

The guard only checks REQUEST top-level keys today. It catches an added / removed /
renamed top-level field, which is the common drift, but not a nested rename or a
value-type change. See `docs/2026-07-18-AO5-AO8-shared-contract-design.md` for the
shared-package vs. guarded-mirror options.

## Widget callables (admin-gated)

### optimizeRoute (AO-35)
- req `{ date: string /* YYYY-MM-DD */ }`
- res `{ stops: Array<{ order: number, sessionId: string, kinfolkId: string, household: string, address: string, arrivalEta: string /* HH:MM */ }>, totalMiles: number, totalMinutes: number, unroutable: Array<{ sessionId: string, household: string, reason: string }> }`

### logExpense (AO-40)
- req `{ kind: 'gas'|'parking'|'supplies'|'other', amountCents: number, note?: string, occurredAt?: string /* ISO */ }`
- res `{ id: string }`

### listExpenses (AO-40)
- req `{ sinceIso?: string }` (default: last 30 days)
- res `{ expenses: Array<{ _id: string, kind: string, amountCents: number, note: string, occurredAt: string }>, weekTotalCents: number, monthTotalCents: number }`

### listSupplies (AO-41)
- req `{}`
- res `{ supplies: Array<{ _id: string, name: string, onHand: number, par: number, unit: string }>, lowCount: number }`

### adjustSupply (AO-41)
- req `{ supplyId: string, delta: number }`
- res `{ onHand: number }` (clamped at 0)

### upsertSupply (AO-41)
- req `{ supplyId?: string, name: string, onHand: number, par: number, unit: string }`
- res `{ id: string }`

### listExpirations (AO-39)
- req `{}`
- res `{ expirations: Array<{ _id: string, label: string, dateIso: string, kinfolkId: string, kind: string }> }` (server-sorted by dateIso asc)

### upsertExpiration (AO-39)
- req `{ expirationId?: string, label: string, dateIso: string, kind: 'gateCode'|'vetRecord'|'card'|'license'|'other', kinfolkId?: string }`
- res `{ id: string }`
