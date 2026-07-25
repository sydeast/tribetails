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

- Nested / effects shapes (added 2026-07-21), frozen by RECURSIVE signature:
  `saveFormSchema` (3-level `schema.sections[].fields[]`), `saveTemplate`
  (`sectionDefinitions[]`), `broadcastMessage` (a `.superRefine` ZodEffects wrapping
  a nested `criteria`). The `shapeSignature` walker unwraps optional/nullable/
  default/effects and descends arrays, so a rename at ANY depth (e.g.
  `schema.sections[].fields[].required`) fails the guard.
- The remaining ~34 are lower-complexity (2 to 3 flat fields); freeze as they churn.

Two freeze levels now exist: `shapeKeys` (top-level, for flat shapes) and
`shapeSignature` (recursive dotted key-paths, for nested/effects shapes). Both
catch an added / removed / renamed field; neither checks a value-TYPE change
(string vs number on the same key). See
`docs/2026-07-18-AO5-AO8-shared-contract-design.md` for the shared-package vs.
guarded-mirror options.

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
- req `{}`
- res `{ clinics: Array<{ id: string, name: string, phone: string, address: string, website: string, googleMapsUrl: string, isEmergency: boolean }> }`
- Returns APPROVED clinics only: a doc is withheld iff `verified === false`. A
  missing `verified` field reads as approved (legacy curated data). The AuntieOS
  admin reads `vet_clinics` directly instead, so it still sees pending entries.
- req `{ name: string, phone?: string, address?: string, website?: string, isEmergency?: boolean }`
- res `{ clinicId: string, created: boolean, pending: boolean }`
- Deduped by normalized name (lowercased, whitespace collapsed). A match returns
  the EXISTING id with `created: false`, so a caller selects that clinic rather
  than writing a duplicate.
- `isEmergency` added 2026-07-25 for the AuntieOS picker's emergency-vet field.
  Optional, defaults false, so every payload the kinfolk portal has ever sent
  stays valid. Frozen as the superset in `test/callableContract.test.ts`.
- Staff callers (`isStaff`, RULING O-6) land `verified: true` / `pending: false`:
  an operator typing a clinic into a household record IS the curation step.
  Kinfolk submissions still land `verified: false` for operator approval.
- req `{ query: string, sessionToken: string, limit?: number, country?: string }`
- res `{ suggestions: Array<{ name: string, full_address: string, mapbox_id: string, place_formatted: string }>, signedBy: 'mapboxSearch' }`
- A query under 2 characters returns an empty list rather than an error.
- req `{ mapboxId: string, sessionToken: string }`
- res `{ feature: unknown | null, signedBy: 'mapboxRetrieve' }` (raw Mapbox GeoJSON feature)
- Mapbox session billing: the caller generates ONE 32-hex `sessionToken`, reuses
  it across every keystroke's `mapboxSearch`, passes the SAME token to
  `mapboxRetrieve`, and only then rotates it. A fresh token per keystroke bills
  each keystroke as its own session.
