# RULING O-6 — Operator/admin cross-tenant trust model (D4 resolution)

**Date:** 2026-07-13
**Author:** Fable 5 (security ruling gate, per DEVELOPMENT_PLAN_2026-07-10.md model doctrine, line 25)
**Resolves:** docs/MYTRIBE_1ON1_2026-06-01_input-needed.md decision D4 (open since 2026-06-01)
**Implements in:** S6 (Opus-driven session; this document is the spec)

---

## The ruling, in one paragraph

Cross-tenant staff authority is the **correct and intended** model for MyTribe — this
is a single business whose staff legitimately service every household, and no
per-operator household-assignment scoping should be built in this repo. The actual
defect D4 found is not "operators are superusers" but that **superuser status is
granted by two independent, divergent mechanisms** (the `AUNTIE_OPERATOR_UIDS` env
var and the `admin` custom claim) and exercised with **no per-access audit trail and
no server-side derivation of the household being touched**. The fix is: unify on the
`admin` claim as the single staff signal (finishing the H11 unification that
`wrapAdminCallable` already started), re-derive `kinfolkId` from the target resource
instead of trusting the client argument wherever a target resource exists, verify
existence + audit-log every cross-tenant access where it doesn't, and put the env
var on an explicit decommission path. No new authorization *semantics* are added;
one mechanism, one derivation rule, one audit trail.

---

## Q1 ruling: Is `AUNTIE_OPERATOR_UIDS` a genuine cross-tenant superuser?

**Yes — cross-tenant staff authority stays. No — the env var does not stay as the
grant mechanism.**

### The semantic (cross-tenant power) is correct

- The operator population today is Tribe Tails' own aunties plus the owner. Staff
  answering a client call must be able to open any household's schedule, invoices,
  and KinTales without a pre-provisioned assignment record. That is the product.
- MyTribe has no visibility into AuntieOS's staff-to-household assignment model
  (peer repo, separate data). Building per-operator scoping here would require
  either inventing a parallel assignment store in MyTribe (guaranteed to drift from
  AuntieOS's real one) or a cross-repo sync that does not exist. **Ruling: do not
  build either.** MyTribe's backend assumes: *staff = full cross-tenant authority,
  compensated by audit logging and revocable identity*, until the owner says the
  staff population includes people who should NOT see every household (see
  "Owner input required" below — that day, the assignment data must come FROM
  AuntieOS, not be invented here).

### The mechanism (env var) is wrong, and the codebase already knows it

- `functions/src/lib/operatorAllowlist.ts:3-8` — pure env-var string match. An env
  var is set at deploy time: revoking a departed staff member requires a redeploy,
  grants leave no per-user audit trace in Firebase Auth, and the var's own edit
  history is invisible to the app.
- `functions/src/lib/wrapAdminCallable.ts:9-19` already ruled this (H11 unification,
  2026-05-19): *"Primary signal is the `admin` custom claim... The env-allowlist is
  preserved as a transition fallback during rollout... emit a deprecation log so we
  can spot and fix the gap before removing the fallback entirely."* It logs
  `admin.allowlist.fallback.used` at lines 31-40.
- Firestore rules agree: `firestore.rules:16-17` — `isAuntie()` is
  `request.auth.token.admin == true`. The claim is minted by AuntieOS-side
  `setAdminClaim` (referenced at `firestore.rules:15`; the callable lives in the
  peer repo, not here).
- But the read path never got the H11 treatment: `resolveKinfolkAccess.ts:32` and
  `getMyAccess.ts:38` gate on `isAuntieOperator(uid)` (env var) ONLY, while
  `addBookingNote.ts:64`, `getKinTaleComments.ts:30`, and
  `kinTaleEngagement.ts:58` gate on the `admin` claim ONLY. **Two grant systems,
  two potentially different uid sets, per surface — exactly the CWE-863 gap H11
  closed for admin callables, still open across the portal.** A uid on the env
  list but without the claim is an operator in `getMyHome` but not in
  `addBookingNote`; a uid with the claim but not on the list is the reverse.

### Ruling for Q1

1. Create one helper — `isStaff(req: CallableRequest): boolean` in
   `functions/src/lib/staffGate.ts` (or fold into `operatorAllowlist.ts`) — that
   mirrors `wrapAdminCallable`'s exact semantics: `admin` claim primary,
   `AUNTIE_OPERATOR_UIDS` fallback, `admin.allowlist.fallback.used` warn-log on
   fallback hits. Every portal-side staff check (`resolveKinfolkAccess`,
   `getMyAccess`, the three claim-checking callables above, and the
   notification callables' `isAdminReq`) switches to it. Note the notification
   callables also accept `role === 'admin'` (`archiveNotification.ts:29`) — that
   third variant is folded into `isStaff` too, or deleted if no token ever
   carries it (verify against real staff tokens before deleting).
2. `AUNTIE_OPERATOR_UIDS` enters formal decommission: after the owner confirms
   every operator uid carries the `admin` claim (mint via AuntieOS
   `setAdminClaim`) AND `admin.allowlist.fallback.used` has been silent in logs
   for 14 days, delete the env-var branch, `operatorAllowlist.ts`, and the
   secret binding. Until then the fallback stays — nobody gets locked out
   mid-migration.
3. `resolveKinfolkAccess` keeps returning `isOperator` (renamed or not —
   implementer's call, keep the wire behavior), but computed via `isStaff`.

---

## Q2 ruling: should admin-trusts-client-`kinfolkId` be replaced with server-side re-derivation?

**Yes — but be precise about what it fixes.** First, the honest threat assessment:

- `addBookingNote.ts:75-83`: the client `kinfolkId` is a **path locator** —
  `resolveKinCareRef` (`resolveKinCareRef.ts:31-35`) builds
  `families/{familyId}/bookings/{batchId}/kinCares/{visitId}` from it. A wrong
  `kinfolkId` yields `not-found`, not cross-household writes under a false label.
- `getKinTaleComments.ts:39-42` and `kinTaleEngagement.ts:70`: the tale doc's own
  `kinfolkId` field is compared against the claimed one; mismatch → `not-found`.
- So **no caller — admin or not — can act on household A while the system records
  household B.** The current pattern is not an exploitable forgery hole. What it
  IS: (a) a second, redundant copy of the authorization input that every future
  callable must remember to cross-check (the check at `getKinTaleComments.ts:40`
  is the only thing standing between "locator" and "trusted assertion" — one
  forgotten check in a new callable and it becomes a real hole); (b) a worse API
  (admin clients must fish out and echo back a value the server already has);
  (c) inconsistent with the read path, which centralizes this in
  `resolveKinfolkAccess`.

### Ruling for Q2 — the re-derivation rule

**The source of truth is the target resource, not the client argument and not a
staff-membership list.** Concretely:

- **Tale-scoped callables** (`getKinTaleComments`, `addKinTaleComment` in
  `kinTaleEngagement.ts`, and the reaction handlers if they share the pattern):
  load `kin_care_reports/{taleId}` FIRST, derive
  `kinfolkId := taleSnap.data().kinfolkId`, then authorize:
  `isStaff(req) || derivedKinfolkId ∈ clients/{uid}.kinfolkIds` → else
  `not-found` (keep `not-found` over `permission-denied` to avoid an existence
  oracle). The `kinfolkId` arg becomes optional for everyone; if supplied it is
  validated for equality against the derived value (`invalid-argument` on
  mismatch) purely to catch confused clients, never used as the authority.
- **Booking-scoped callable** (`addBookingNote`): `kinfolkId` remains required as
  a locator (the doc path needs it — `resolveKinCareRef.ts:32`), but the
  authorization flow inverts to match: resolve the visit doc, then authorize
  `isStaff(req) || kinfolkId ∈ clients/{uid}.kinfolkIds`. Net behavior change for
  admins: their gate becomes `isStaff` (claim OR env-fallback) instead of
  claim-only — closing the CWE-863 split — and the audited `kinfolkId` is
  path-verified by construction (it already was; now it's structural).
- **Do NOT re-derive from a staff-assignment list** — per Q1, no such
  server-verifiable relationship exists in this repo, and inventing one is
  ruled out. "Re-derivation" in the S6 scope line means *from the target
  resource*, and this ruling makes that binding.
- The local `resolveKinfolkId` copy in `addBookingNote.ts:31-38` (duplicating
  `resolveKinfolkAccess`'s non-operator branch) is deleted in the process —
  one resolver, one staff gate.

---

## Q3 ruling: does this touch `resolveKinfolkAccess`'s operator-any-id behavior?

**The semantic stays; two hardenings land; nothing else.** Explicit boundary:

- **Stays:** operator may resolve any `kinfolkId`
  (`resolveKinfolkAccess.ts:36-37`). That is Q1's ruling applied — staff support
  requires arbitrary household lookup. This is NOT an operator-model rewrite.
- **Hardening 1 — existence check:** line 37 returns `requested` verbatim without
  confirming `kinfolk/{requested}` exists. Add the doc-exists check for the
  operator branch (`not-found` otherwise). Cost: one read, only on operator
  cross-tenant calls. Benefit: garbage ids fail loudly instead of producing
  empty-result queries and misleading logs.
- **Hardening 2 — audit trail:** when the operator branch resolves an id NOT in
  the caller's own `clients/{uid}.kinfolkIds`, emit a `logEvent` +
  `writeAuditEntry` (`operator.crosstenant.access`, actorRole `AUNTIE`, payload:
  function name, kinfolkId). Today `getMyAccess` logs its enumeration
  (`getMyAccess.ts:68-74`) but individual cross-tenant resolutions are invisible.
  Since cross-tenant power is total, the audit trail is the compensating control
  — it is not optional.
- **Also in scope, because it is a one-line falsehood:** the doc comment at
  `resolveKinfolkAccess.ts:24-26` claims writes don't get operator override, but
  `sendKinfolkMessage.ts:115,235,274` and `requestBookingCancellation.ts:51` are
  write callables using this resolver. Ruling: the *behavior* is intended (staff
  act on households — messages, cancellations — as part of the job); the
  *comment* is stale and gets rewritten to state the real contract. The audit
  entries from Hardening 2 cover these writes automatically.
- **Out of scope, explicitly:** per-operator household scoping; any change to
  which uids are staff (that's Q1's mechanism unification, not this resolver);
  Firestore rules changes (rules already use the claim; callables use admin SDK
  and bypass rules — unchanged).

---

## Q4 ruling: `getMyAccess` full-collection enumeration for operators

**Acceptable as-is; keep it.** (`getMyAccess.ts:63-66`.)

- It returns doc IDs only — no household data leaks beyond existence.
- It exists to feed the TribePicker operator path (documented at
  `getMyAccess.ts:14-24`; O-21 tracks live-verifying that path). Scoping it
  would break the staff directory UX for no security gain: any operator can
  already resolve any id individually via `resolveKinfolkAccess`, so
  enumeration adds convenience, not authority.
- It already logs the enumeration with counts (`getMyAccess.ts:68-74`).
- Two mechanical changes ride along: its gate switches from `isAuntieOperator`
  to `isStaff` (Q1), and the full-collection `.get()` should become
  `.select()` (ids only, no field payloads) — a cost/read-size nicety, not a
  security requirement. If the kinfolk collection ever grows past
  low-thousands this becomes a paginated directory endpoint; that is a scale
  problem for future-MyTribe, not this ruling.

---

## Implementation sequence (for the Opus session)

Ordered so every step is independently shippable and testable:

1. **`isStaff` helper** (`functions/src/lib/staffGate.ts`): claim-primary,
   env-fallback, deprecation log — extracted so `wrapAdminCallable` and portal
   callables share one implementation. Refactor `wrapAdminCallable` onto it.
   *Tests:* claim-only uid passes; env-only uid passes AND emits
   `admin.allowlist.fallback.used`; neither fails; `role === 'admin'`-only token
   behavior pinned (pass or fail per the verification in Q1.1).
2. **`resolveKinfolkAccess` hardening:** switch to `isStaff`; add operator-branch
   existence check; add cross-tenant audit entry; fix the stale write-path
   comment. *Tests:* operator + nonexistent id → `not-found`; operator +
   foreign id → resolves AND audit entry written; operator + own id → no
   cross-tenant audit entry; non-operator branch byte-identical behavior
   (existing tests must not change).
3. **Tale-scoped re-derivation:** `getKinTaleComments`, `kinTaleEngagement`
   handlers — load tale first, derive `kinfolkId` from the doc, authorize
   `isStaff || membership`, equality-validate a supplied `kinfolkId`. *Tests:*
   admin with no `kinfolkId` arg succeeds (new capability — currently
   `invalid-argument` per `getKinTaleComments.ts:33`); admin with mismatched
   arg → `invalid-argument`; non-member non-staff → `not-found`; member without
   arg succeeds; audit `kinfolkId` equals the tale doc's value in all cases.
4. **`addBookingNote`:** delete local `resolveKinfolkId`, invert to
   resolve-then-authorize with `isStaff || membership`. *Tests:* env-only
   operator can now add a note (closes the CWE-863 split — currently claim-only
   per line 64); wrong-household locator → `not-found`; member path unchanged;
   3-hour cutoff untouched.
5. **`getMyAccess` + notification callables:** switch gates to `isStaff`;
   `.select()` on the enumeration. *Tests:* env-only and claim-only uids both
   get the full directory; non-staff gets own ids only.
6. **Decommission (separate, later PR — gated on owner confirmation):** remove
   env-var fallback + `operatorAllowlist.ts` + secret bindings
   (`getMyAccess.ts:80` and every `secrets:` list naming
   `AUNTIE_OPERATOR_UIDS`) after the 14-day-silent-logs criterion in Q1.2.

Steps 1-5 are one S6 work item; step 6 is its own tracked follow-up
(suggest logging as O-26). Full suite green after each step; no Firestore
rules or client changes required (clients may DROP sending `kinfolkId` on
tale callables afterward, but nothing forces them to).

## What proves it's correct

- The step tests above, plus: grep proves zero remaining call sites of
  `req.auth?.token?.admin === true` / `role === 'admin'` / `isAuntieOperator`
  outside `staffGate.ts` (+ `operatorAllowlist.ts` until step 6).
- Live: one env-only-allowlisted test account and one claim-only account each
  exercise `getMyHome` (foreign id), `addBookingNote`, `getKinTaleComments` —
  identical results, and the cross-tenant audit entries appear in
  `activity_log`. This doubles as the O-21 operator-path live check the plan
  already owes (`DEVELOPMENT_PLAN_2026-07-10.md:370-375`).

## Owner input required (not rulable from code)

1. **Population confirmation:** is every uid in `AUNTIE_OPERATOR_UIDS` today
   supposed to hold the `admin` claim, and vice versa? Code says they're meant
   to converge (H11); only the owner knows if the two lists actually match.
   Mint missing claims via AuntieOS `setAdminClaim` before step 6.
2. **Future staff tiers:** if a partially-trusted operator tier (e.g. contract
   aunties limited to assigned households) is ever planned, say so NOW — it
   changes Q1's answer from "no assignment model in MyTribe" to "sync
   AuntieOS assignments into a server-verifiable MyTribe store," which is a
   different, larger project. Absent that signal, this ruling stands.
3. **Decommission timing** for the env var (step 6) is the owner's call once
   the 14-day criterion is met — it's a lockout risk, not a code question.
