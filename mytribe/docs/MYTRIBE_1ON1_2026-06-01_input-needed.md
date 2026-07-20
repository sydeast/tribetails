# MyTribe 1:1 Input Needed, 2026-06-01

Agenda for our next working session. Each item is a decision only you can make
(data ownership, product behavior, security policy, or a value I do not have).
For every item I list: the context, the options, my recommended default, and what
I shipped in the meantime so nothing is blocked waiting on you.

Everything in the companion section "Completed autonomously this session" was done
without needing any of these answers. The items below are the ones I deliberately
did not guess on.

How this maps to your brief:
- "save all input needed items into a document we'll go over 1:1" -> this file.
- "I like all the Suggested items, implement or wire it and give me feature flags"
  -> built the flag system; each Suggested item is gated and listed in D8 to D14.
- "Booking = the whole request envelope, may contain 1+ KinCare" -> this is D1, and
  it is the single biggest decision because the code currently models the inverse.

Legend: [SEC] security, [DATA] data model / ownership, [PROD] product behavior,
[VALUE] a value/credential I need from you, [BUILD] build/tooling choice.

---

## D1. Booking envelope vs per-visit. The terminology is currently inverted. [DATA][PROD]

This is the most important one.

What you said: a Booking is the whole request envelope created at once and may
contain one or more KinCare; a KinCare is the individual visit/session/service.

What the code actually does today:
- One Firestore doc at `families/{kinfolkId}/bookings/{bookingId}` IS one visit
  (one start time, one service, one status, one note editor). That doc is your
  "KinCare", but the code calls it a "booking".
- The booking wizard does NOT create one envelope. `requestBooking.ts` explodes the
  wizard's date list into N separate `bookings/{id}` docs, one per visit
  (lines 88 to 112), and returns `bookingIds: string[]`.
- The only thing linking those N docs is a write-only string `requestBatchId`
  (`req_<ts>_<rand>`). It is never read back: `getMyBookings.ts` does not select it,
  no DTO exposes it, the Kotlin `Booking` model has no batch field.
- `BookingDetailsScreen` therefore correctly renders a single visit. It is "mislabeled"
  only against your desired model, not against the current code.
- Notification keys for these docs are already named `kincare.*`
  (`kincare.requested`, `kincare.booking.confirm`, ...), which actually agrees with
  your naming: one doc == one KinCare.

So to get your model we need a real parent envelope. Options:

- Option A (recommended): introduce a real envelope. Add a read-back grouping by
  `requestBatchId` first (cheap, no schema change): `getMyBookings` returns visits
  grouped by batch, MyTribe shows one "Booking" card that expands to its KinCares,
  and `BookingDetailsScreen` becomes the envelope view with a child `KinCareDetailScreen`.
  Rename the per-visit detail to KinCare to match `kincare.*`. No new collection,
  AuntieOS keeps writing the same per-visit docs.
- Option B: add a true parent doc `families/{kinfolkId}/bookings/{batchId}` with a
  `kinCares` subcollection. Cleaner long term, but AuntieOS writes/reads these docs
  too (it sets status, auntie name, etc.), so it must change in lockstep.

Questions for you:
1. Option A (group by existing `requestBatchId`, no schema change) or Option B
   (new parent doc, AuntieOS changes in lockstep)?
2. Confirm naming: per-visit detail screen becomes "KinCare", the envelope is
   "Booking". Keep notification keys `kincare.*` as is?
3. Can AuntieOS change in lockstep, or must MyTribe stay read-compatible with the
   current per-visit docs for now?

Interim shipped: I did NOT restructure the data model (too risky to guess). I left
`BookingDetailsScreen` rendering the single visit, but I added an internal
`requestBatchId` pass-through in the read path behind the flag
`mytribe.booking.envelope` (default off) so Option A is a small follow-up once you pick.

---

## D2. Invoices are split across two collections with no sync. [DATA][SEC-adjacent]

MyTribe `getMyInvoices` / `payInvoice` / `redeemCredit` read and write the FLAT
`invoices` collection (`where kinfolkId == id`). But `postInvoiceEvent` (AuntieOS
admin write), `stripeWebhook`, and the `onInvoicesWrite` trigger all target
`families/{familyId}/invoices/{invoiceId}`. Two different collections, no bridge.
Result: an invoice created or updated on the AuntieOS side may never appear in
MyTribe, and a MyTribe payment may not reflect back.

Also (D17): `redeemCredit` reads the credit doc from flat `invoices` but increments
the balance on `families/{id}.accountBalanceCents`. Split brain between credit
source and balance target.

Question: where does AuntieOS actually write invoices in production, flat `invoices`
or `families/{id}/invoices`? Once you confirm, I will write the bridge (a trigger that
mirrors, or switch one side to the other collection) plus a backfill.

Interim shipped: nothing destructive. Added demo seed coverage for BOTH locations so
the screen renders in testing, and a characterization test that documents the split so
we do not accidentally "fix" the wrong side.

---

## D3. Pet/Kin records are not bidirectional. [DATA]

MyTribe owns `families/{kinfolkId}/kin` (structured, what `addKin`/`updateKin` write
and `getMyKin` reads). AuntieOS owns the flat `kin/{docId}` plus `the_411/{kinId}`.
No function mirrors between them; the only link is a one-directional read-only
`legacyKinId` pointer used to pull the AI blurb. So a Kin edit a parent makes in
MyTribe is invisible to AuntieOS, and an AuntieOS pet edit may not reach MyTribe.

Question: where does AuntieOS read and write structured pet records? If it reads
`families/{kinfolkId}/kin`, parent edits are already visible and we only need the
reverse. If it only uses flat `kin/{docId}`, we need a two-way bridge.

Interim shipped: nothing. This is a data-ownership question I cannot answer from the
MyTribe repo alone.

---

## D4. Operator and admin cross-tenant authority is invisible to Firestore rules. [SEC]

Operator power is enforced ONLY by the `AUNTIE_OPERATOR_UIDS` env var
(`isAuntieOperator`); `resolveKinfolkAccess` lets an operator request ANY `kinfolkId`,
and `getMyAccess` returns the union of all kinfolk ids to operators. Separately,
`addBookingNote` and `getKinTaleComments` bypass the membership check entirely when
`req.auth.token.admin === true`, trusting a client-supplied `kinfolkId`.

Questions:
1. Is `AUNTIE_OPERATOR_UIDS` intended to be a genuine cross-tenant superuser?
2. Is the `admin` custom claim staff-only, and is trusting a client-supplied
   `kinfolkId` for admin callers acceptable, or should it be re-derived server-side?

Interim shipped: I did NOT change operator/admin behavior (could break staff tooling).
I DID fix the unrelated and critical client-side hole in D-SEC1 below.

---

## D-SEC1 (FIXED THIS SESSION, flagging for your awareness). [SEC]

Before this session, `firestore.rules` let a kinfolk self-assign arbitrary
`kinfolkIds` / `familyIds` on their own `clients/{uid}` doc. The portal's entire
tenant boundary trusts `clients/{uid}.kinfolkIds`, so any signed-in user could write
that array directly through the Firestore SDK and read every other tribe's data.

Fix shipped: tightened the `clients/{uid}` update rule so `kinfolkIds` and `familyIds`
can never be changed by the client (only Cloud Functions via the Admin SDK, e.g.
`acceptInvite`, may change them). Added rules tests for the tamper path. Details in
the Completed section. Please confirm this matches intent (legit client writes to
that doc never touch those arrays, so the fix is safe).

---

## D5. Multi-tribe active-tribe switching (Phase 3B). [DATA][PROD]

`onClientsWrite` only mints the custom claim `kinfolkId = kinfolkIds[0]` (first tribe).
There is no callable to switch the active claim, so a user in multiple tribes can only
see their first tribe for the direct-Firestore reads (e.g. live GPS breadcrumbs). The
callable reads (invoices, kintales, visits, bookings) DO honor the picked tribe, so
this only bites the rules-gated direct reads.

Question: do you want active-tribe switching now (a `setActiveTribe` callable that
re-mints the claim after TribePicker), or defer? If now, confirm it is fine for the
claim to change at runtime.

Interim shipped: nothing; documented the limit. TribePicker still works for callable reads.

---

## D6 + D7. Schema-driven Account and Kin forms. [DATA][PROD]

Your rule: kinfolk cannot add fields; AuntieOS admin CRUDs all field definitions;
MyTribe renders whatever the schema defines. The infra exists (`SchemaFormRenderer`,
`getFormSchema`, `formSchemas/{schemaId}`), and `TribeScreen` already consumes schemas
`tribeProfile` and `homeAccess`. But:
- `AccountSettingsScreen` and the Kin screens (`AddEditKinDialog`, `KinDetailScreen`)
  are hardcoded, not schema-driven, despite server comments saying schemas should
  drive them.
- No schemas are seeded anywhere, so `getFormSchema` currently throws not-found and
  every screen falls back to its hardcoded form.

Questions:
1. Migrate Account Settings and Kin to the schema renderer now? If yes, what are the
   canonical `schemaId`s and field keys AuntieOS authors (e.g. `account`, `kinProfile`)?
2. Do Kin docs need a `customFields[]` persistence mechanism (like Tribe profile/home
   have) so admin-defined Kin fields actually save, or should Kin stay fixed-shape?

Interim shipped: I removed the one real violation of your rule (see D-FORM1 below) and
seeded starter `formSchemas` for `tribeProfile` and `homeAccess` so the dynamic path
actually exercises instead of always falling back. I did NOT migrate Account/Kin to
schema-driven yet because the field catalog is yours to define.

---

## D-FORM1 (FIXED THIS SESSION). [PROD]

`TribeScreen`'s static fallback had a `CustomFieldList` that let a kinfolk type a label
and value and click "Add Profile Field" / "Add Home Field", generating random field
keys. That is the one place the app violated "kinfolk cannot add fields." Removed it
behind the flag `mytribe.tribe.legacyCustomFields` (default OFF = removed). When a
schema is present the schema drives the form; when absent the form is read-only
hardcoded with no add control. Please confirm removal is what you want.

---

## D8 to D14. The eight Suggested items (all gated by feature flags). [PROD]

I built the flag system (D16) and wired each Suggested item to a flag so you can flip
them on per tester. Three are cosmetic and on-by-default-safe; two already exist; three
need a backend decision and ship dark.

| # | Suggested item | Screen | Flag key | State shipped | Needs from you |
|---|---|---|---|---|---|
| D8 | Sign-in show-password toggle | SignInScreen | `mytribe.auth.showPasswordToggle` | Built, default ON | none, cosmetic |
| D9 | Claim-invite "Enter MyTribe" CTA copy | ClaimInviteScreen | `mytribe.claim.enterCtaCopy` | Built, default ON | none, cosmetic |
| D10 | Launch-error reassurance copy | LaunchErrorScreen | `mytribe.launchError.reassuranceCopy` | Built, default ON | none, cosmetic |
| D11 | Kin Memorial state | KinDetailScreen | `mytribe.kin.memorial` | Already implemented; flag added for staged rollout | confirm: gate or treat as shipped |
| D12 | Schedule Reminders notif category | NotificationSettingsScreen | `mytribe.notifications.scheduleReminders` | Relabel of existing `kincare.upcoming.reminder` category, default ON | confirm copy; this is NOT a new category |
| D13 | After-hours emergency vet block | TribeScreen | `mytribe.tribe.afterHoursVet` | UI built, default OFF, stored as HomeAccess customFields (zero backend) | approve storage path (customFields) vs a real VetClinic DTO field + AuntieOS write |
| D14a | Schedule "Good to know": Message Auntie | ScheduleScreen | `mytribe.schedule.messageAuntie` | UI built, default OFF, action disabled | is there a kinfolk messaging endpoint? |
| D14b | Schedule "Good to know": recurring visit | ScheduleScreen | `mytribe.schedule.recurringVisit` | UI built, default OFF | reuse `requestBookingMultiVisit` Weekly, or new weekly-confirm contract? |
| D14c | Invoice Download PDF | InvoiceDetailScreen | `mytribe.invoice.downloadPdf` | UI built, default OFF, action disabled | signed Storage/Cloudinary URL vs bytes; does AuntieOS PDF generation exist? |

For D13, D14a, D14b, D14c: the UI is in place and flag-gated; flipping the flag on
reveals the control, and the action is wired to a clearly-marked stub until you pick
the backend. Nothing fake renders to a real user while the flag is off.

---

## D15. Demo data and tester linking. [VALUE]

`seedDemoKinfolk.ts` writes `demo-family-001/002` but never creates a `clients/{uid}`
doc, so a tester sees NOTHING until their auth uid is linked to a demo family. Also,
there is only one Firebase project (`auntieos-ttpc`) for prod and test.

Questions:
1. What is the tester's Firebase Auth uid (or uids)? I will link it to a demo family.
2. Seed strictly against the Firestore emulator, or also seed live `auntieos-ttpc`
   with `_demo: true`? There is no separate test project.

Interim shipped: extended the seed to cover bookings, invoices (both collections from
D2), `families/{id}` doc, and starter form schemas, all `_demo: true`. Added an opt-in
`--link-uid=<uid>` flag so the moment you give me a uid it is one command. Seed still
defaults to dry-run and refuses prod writes without `--allow-prod`.

---

## D16. Feature-flag scope. [BUILD] (built; confirm the model)

No flag system existed. I built one in commonMain that resolves in this order:
compile-time default (all OFF) -> global `business_settings/feature_flags` doc ->
per-tester `clients/{uid}.featureFlags` override. This mirrors the existing
`BusinessContact` runtime-doc pattern and works on android/web/desktop with no app
release. Confirm you want both the global doc and the per-tester override (I built
both so you can dark-launch globally and enable per QA account).

---

## D-ROUTE1. Routing to Jetpack Compose Navigation. [BUILD][PROD]

You asked to update routing to Jetpack Compose, citing AuntieOS wrapups. Two findings:
1. The AuntieOS `den-routing-plan` is for a different module
   (`com.tribetails.auntieos.web`) and deliberately chose a hand-rolled hash router,
   explicitly NOT AndroidX navigation-compose.
2. MyTribe today has no nav library and no back stack: the signed-in shell is one
   `var route by mutableStateOf(...)` plus a `when`, and in-tab detail screens
   (invoice/kin/booking/kintale) live in per-screen local state invisible to the shell.

So "Jetpack Compose Navigation" needs a real choice, and `navigation-compose` on the
`js(IR)` target (not wasmJs) is unverified for this Compose 1.10.1 / Kotlin 2.2.20 setup.

Questions:
1. Adopt AndroidX `org.jetbrains.androidx.navigation:navigation-compose`, or replicate
   the AuntieOS hash-router pattern (lighter, known to work on js)?
2. Back-button semantics once a real back stack exists: back from a non-Home tab goes
   to Home, to the previously visited tab, or exits? Should in-tab detail pushes be on
   the same stack?

Interim shipped: I ran a `js(IR)` compatibility spike for `navigation-compose` (result
in the Completed section). I did NOT migrate routing yet, because the library choice and
back semantics are yours and a blind migration on a prod app is high risk. I did lift
the in-tab detail state to an explicit route model so whichever option you pick is a
smaller, safer change.

---

## D-FONTS1. Brand fonts hosting. [BUILD] (proceeding with a default)

`Theme.kt` uses `FontFamily.Serif` / `SansSerif` placeholders, so Young Serif,
Bricolage Grotesque, and DM Mono never render. All three are OFL-licensed (free to bundle).

My default: self-host. Bundle the .ttf files into `commonMain/composeResources/font`
and load via `Res.font.*`, plus add the Google Fonts link to the web `index.html`. This
keeps all three platforms identical (parity) and works offline. The alternative
(Google Fonts at runtime) adds a network dependency and does not help desktop.

Question: any objection to self-hosting the bundled OFL fonts? If not, I proceed.

Interim shipped: see Completed section for exactly how far I took the font work.

---

## D-TEST1. Visual-regression harness. [BUILD]

AuntieOS has a Roborazzi + desktop-Compose-screenshot visual harness (stage 2, 59
golden baselines). MyTribe has none (114 Kotlin behavior tests + 27 TS contract tests,
no screenshots). For the redesign, behavior tests catch logic but not pixel drift.

Question: port the AuntieOS visual harness into MyTribe (desktop-JVM screenshot proxy is
the cheap path), or stay behavior-only and eyeball the redesign?

Interim shipped: stayed behavior-only and extended the existing test layers. Did not
stand up a screenshot harness without your call (it is a meaningful build investment).

---

## D-SYNC-NOTIF. NotificationCatalog static mirror vs runtime fetch. [BUILD]

`NotificationCatalog.kt` is a hand-maintained mirror of
`functions/src/notifications/catalog.ts` (drift risk). A `getNotificationCatalog`
callable exists to replace it (TODO E5b) but is not wired into the Kotlin client.

Question: switch the client to the runtime `getNotificationCatalog` now, or keep the
static mirror for this release?

Interim shipped: kept the static mirror; added a contract test that fails if the Kotlin
catalog and the TS catalog drift, so the mirror cannot silently rot before you decide.

---

## Quick-answer checklist (so the 1:1 is fast)

1. D1 Booking envelope: Option A (group by requestBatchId) or B (new parent doc)?
2. D2 Invoices: which collection does AuntieOS write in prod?
3. D3 Kin: where does AuntieOS read/write structured pet records?
4. D4 Operator/admin: genuine cross-tenant superuser? Re-derive kinfolkId server-side?
5. D5 Multi-tribe switching: build `setActiveTribe` now or defer?
6. D6/D7 Schema forms: migrate Account+Kin now? canonical schemaIds + field keys?
   Kin customFields persistence yes/no?
7. D13 After-hours vet: customFields storage OK, or real DTO + AuntieOS write?
8. D14a/b/c: messaging endpoint? recurring contract? invoice PDF shape?
9. D15: tester uid(s)? emulator-only or seed live with `_demo`?
10. D16: confirm global + per-tester flag model.
11. D-ROUTE1: AndroidX navigation-compose or hash-router? back-button semantics?
12. D-FONTS1: self-host bundled OFL fonts OK?
13. D-TEST1: port visual harness or behavior-only?
14. D-SYNC-NOTIF: runtime catalog fetch now or keep static mirror?

---

## Completed autonomously this session

All of the below is implemented and verified green. Verification layers run:
Kotlin `./gradlew jvmTest` (whole commonTest suite), `functions` `npm run build`
(tsc), the Firestore rules suite (`npm run test:rules`, 53 passing including the
new clients tests), and the demo seed suite (36 passing).

Security (the blocker):
- Closed the `clients/{uid}` tenant-boundary tamper. `firestore.rules` now forbids
  a client from writing `kinfolkIds` / `familyIds` on create or update (only Cloud
  Functions via the Admin SDK may change them). Added `functions/test/rules/clients.test.ts`
  (9 cases) that pin the tamper paths. Rules suite went 44 to 53 passing, no regressions.

Feature-flag system (new, the prerequisite you asked for):
- `src/commonMain/.../config/FeatureFlags.kt`: typed flags + a pure resolver
  (DEFAULT < global < per-tester), unknown remote keys ignored. Defaults: cosmetic
  and relabel and already-shipped items ON, backend-pending and structural OFF.
- `PortalApi.getFeatureFlags()` + server `functions/src/portal/getFeatureFlags.ts`
  (merges `business_settings/feature_flags` with `clients/{uid}.featureFlags`),
  exported in `index.ts`.
- `LocalFeatureFlags` CompositionLocal, provided at the app root
  (`KinfolkPortalAppGuarded`), fetched on sign-in, fail-soft to defaults.
- Tests: `FeatureFlagsTest` (7) + `PortalApiFeatureFlagsTest` (3).
- To flip a flag for a tester: set `clients/{their-uid}.featureFlags.<key> = true`.
  To dark-launch for everyone: `business_settings/feature_flags.flags.<key> = true`.

The eight Suggested items, each flag-gated (see the D8 to D14 table for keys):
- Sign-in show-password eye toggle. Note: I also fixed a latent issue where the
  password field was unmasked; the password is now ALWAYS masked and the flag only
  controls the reveal eye.
- Claim-invite "Enter MyTribe" CTA copy.
- Launch-error reassurance line.
- Kin Memorial wrapped in a flag for staged rollout (it was already built).
- Notification "Schedule Reminders" relabel of the existing schedule category (no
  new category, no new prefs key).
- After-hours emergency vet on TribeScreen, stored in HomeAccess customFields (zero
  backend), default off.
- Schedule "Good to know": Message Auntie + recurring-visit shortcuts, default off,
  actions stubbed (no endpoint invented).
- Invoice Download PDF action, default off, stubbed (no endpoint invented).

Kinfolk-cannot-add-fields rule:
- Removed the TribeScreen add-custom-field controls (the violation) behind
  `tribeLegacyCustomFields` (default off = removed). Saved custom fields still show
  read-only; the schema renderer drives the form when a schema is present.
- Seeded starter `formSchemas` (`tribeProfile`, `homeAccess`) so the dynamic path
  exercises instead of always falling back.

Demo data:
- Extended `seedDemoKinfolk.ts` to cover `families/{id}`, bookings, invoices (both
  the flat and family-scoped collections from D2), and the starter form schemas, all
  `_demo: true`. Added `--link-uid=<uid>` to link a tester to a demo family. Seed
  still defaults to dry-run and refuses prod without `--allow-prod`. Tests grew to 36.

Brand fonts:
- Bundled Young Serif, Bricolage Grotesque, and DM Mono (OFL) into
  `commonMain/composeResources/font` and wired `Theme.kt` to load them via
  `Res.font`, replacing the `FontFamily.Serif/SansSerif` placeholders. DM Mono now
  carries the monospaced "meta" texture. Self-hosted so all three platforms match
  (no runtime Google Fonts dependency). This is the most visible identity upgrade.

Housekeeping found and fixed along the way:
- Five pre-existing test rot failures surfaced once the suite actually ran green
  (the catalog titles had drifted from stale test expectations, a KinTales badge
  gained a " . view" suffix, and two screens needed scroll-to in a tall form). These
  were not caused by this session's changes; I updated the stale assertions to match
  shipped behavior so the suite is clean.

## Resolved via the AuntieOS investigation (your four answers, 2026-06-01)

You chose: AndroidX navigation-compose, a new booking envelope doc, investigate
AuntieOS for sync, investigate AuntieOS for form fields. I read the AuntieOS repo
(`web/composeApp`, its own `web/functions`, `android`) and the shared MyTribe
functions. Findings and the resulting plan:

D-ROUTE1 Routing (AndroidX nav): CONFIRMED viable. `navigation-compose:2.9.2`
resolves and compiles on js(IR), jvm, and android with this Compose 1.10.1 /
Kotlin 2.2.20 setup (spike built clean). The dependency is added. The migration
itself (replace the `TabShell` state machine with a `NavHost`, lift the in-tab
detail screens onto the back stack, wire deep links + web URL sync) is the next
routing task. Big but unblocked.

D2 Invoices: NOT actually a two-sided sync gap. The production source of truth is
the FLAT top-level `invoices` collection, and AuntieOS (Android `AuntieRepository`
+ web `FirestoreInterop`) writes only there. MyTribe's portal callables
(`getMyInvoices`, `payInvoice`, `redeemCredit`) already read the correct flat
collection. The problem is MyTribe-only:
  - `postInvoiceEvent.ts`, `stripeWebhook.ts`, `onInvoicesWrite.ts` target a
    PHANTOM nested `families/{id}/invoices` that nothing on either side writes, so
    they are dead.
  - Real bug: `payInvoice.ts` writes Stripe `metadata.kinfolkId` but
    `stripeWebhook.ts` reads `metadata.familyId`, so a portal Stripe payment is
    never recorded anywhere (silent drop).
  Fix (MyTribe-only, no AuntieOS change) but billing-sensitive, so I want your
  sign-off before touching money paths: repoint those three functions to flat
  `invoices`, add `familyId: kinfolkId` to the payInvoice metadata, have the
  webhook mark the flat invoice paid (zero `amountDue` / set `status: paid`) and
  write a mirror flat `payments/{id}` doc to match AuntieOS bookkeeping, plus a
  one-off backfill for any stray nested docs. `accountBalanceCents` and the credit
  model are MyTribe-only inventions (AuntieOS has no equivalent), so they stay.

D3 Pet/Kin sync: AuntieOS pets live ONLY in flat `kin/` + `the_411/`; it never
touches `families/{id}/kin`. The `legacyKinId` link is MyTribe-only and AuntieOS
never sets it, so the AI-blurb join breaks for any staff-created pet. This needs a
real two-way bridge (cross-app): a MyTribe `onFamilyKinWrite` trigger that mirrors
to flat `kin/` and stamps a symmetric `familyKinPath`/`legacyKinId`, an
`onFlatKinWrite` trigger mirroring staff edits back (one writer per field, guarded
by an `_mirrorOrigin` flag to avoid echo loops), and an AuntieOS client change to
write the FK on create/update. Cross-app, banked below.

D1 Booking envelope: bigger than it looked. AuntieOS does NOT read MyTribe's
`families/{id}/bookings` at all; it runs its own pipeline (`enhanced_bookings` to
`kin_care_sessions`, FK `sourceBookingId`) and reads `kin_care_sessions` for its
Bookings screen. So MyTribe's bookings collection is invisible to staff today
except for notes. The envelope you want (`bookings/{batchId}` parent + a `kinCares`
subcollection) is a one-commit migration across BOTH apps: MyTribe rewrites
`requestBooking`/`getMyBookings`/`onBookingsWrite`/`addBookingNote` + `firestore.rules`,
and AuntieOS ingests each `kinCares/{visitId}` into its scheduling pipeline and
writes status back onto the kinCare doc (rules already allow `isAuntie()` update),
plus a backfill wrapping existing per-visit docs into single-visit envelopes.
Cross-app, banked below.

D6/D7 Schema forms: DONE this session (it was MyTribe-only). AuntieOS authors no
account/kin schema and its spec scopes rendering to TribeScreen, but its FormSchema
admin editor is shipped and can CRUD any free-text schema id. So MyTribe now seeds
`account` + `kinProfile` schemas and renders Account Settings + Kin editing through
`SchemaFormRenderer` (schema drives layout/labels, the existing typed endpoints
still persist, static fallback when no schema is seeded). An operator can now edit
those fields live in the AuntieOS editor with zero code change. This is the
"admin CRUDs fields, MyTribe renders dynamically" behavior you wanted.

Recommended next order: (1) approve + ship the D2 invoice fix (small, fixes dropped
payments), (2) routing migration to AndroidX nav, (3) booking envelope (D1,
cross-app, schedule with AuntieOS), (4) pet bridge (D3, cross-app), (5) finish the
visual component adoption.

## Program execution (the "all" pass, 2026-06-01)

After you said "all", I executed the whole program. Everything below is implemented
and verified green on the MyTribe side (Kotlin jvmTest, functions tsc + non-rules
vitest, and the Firestore rules emulator suite). The booking envelope read path is
gated by `mytribe.booking.envelope` (default OFF), so the live app is unchanged until
you flip it after the AuntieOS deploy.

Done + verified (MyTribe):
- Invoice fix (#12): repointed the three dead nested-path functions to the canonical
  flat `invoices`, fixed the `payInvoice`/`stripeWebhook` metadata key bug that was
  silently dropping portal Stripe payments, made the webhook mark paid + mirror a
  `payments/{id}` doc, and added a backfill. 509+ functions tests.
- Component adoption (#8): app-wide `KinfolkBackground` radial wash, Home Tribe-gradient
  live hero, and KinButton/KinGhostButton/KinField/KinChip across all core screens.
- Schema forms (#6/#7): seeded `account` + `kinProfile` schemas, Account + Kin render
  via SchemaFormRenderer.
- Booking envelope, MyTribe side (#14): `bookings/{batchId}` + `kinCares` model in the
  functions (transaction write, `getMyBookings` returns `envelopes[]`, rollup trigger,
  note paths, back-compat resolver), the rules, the Kotlin DTOs + decoders, the
  Booking/KinCare detail split (BookingEnvelopeScreen + KinCareDetailScreen), Schedule
  envelope grouping, and a backfill. All behind the flag.
- Pet bridge, MyTribe side (#15): `onFamilyKinWrite` now mirrors to flat `kin/` with a
  symmetric `familyKinPath`/`legacyKinId` link, plus a new `onFlatKinWrite` reverse
  mirror, with `_mirrorOrigin` loop guards. 561 functions tests.
- Routing migration (#13): moved off the hand-rolled TabShell state machine to AndroidX
  Compose Navigation with type-safe `@Serializable` routes, detail screens lifted onto
  the back stack, deep links + browser back/forward + shareable URLs on web. Compiles
  on jvm, android, and js.

Remaining (cross-app, needs the AuntieOS build + a coordinated deploy): the AuntieOS
side of the envelope (ingest kinCares, write status/auntie back onto the kinCare docs,
move note paths) and the pet FK (AuntieOS writes `familyKinPath` on create/update).
These are written up as a ready-to-apply spec in `docs/AUNTIEOS_CROSSAPP_CHANGES.md`
with the safe deploy order. I did not edit the AuntieOS repo because it is a separate,
non-git-tracked prod app I cannot build-verify from here, and the change needs a
lockstep deploy anyway. Routing detail is in `docs/ROUTING_MIGRATION_BLUEPRINT.md`.

## Banked for a focused next pass (larger, and one is gated on your input)

- Full visual redesign to the mockups (Track 8): the screens are now color-correct
  and use the real brand fonts, but the per-screen layout is still a generation
  behind the mockups (no orb/radial animated background, no full-bleed Tribe-gradient
  live-visit hero, core screens still use some raw Material buttons instead of
  KinButton/KinChip/KinField, and the shell is a drawer + bottom-nav rather than the
  mockup's responsive top nav). The top-nav IA change is entangled with the routing
  decision below, which is why it is banked rather than done blind.
- Routing to Jetpack Compose Navigation (Track 9 / D-ROUTE1): gated on your choice of
  AndroidX `navigation-compose` vs the lighter hash-router that the sibling AuntieOS
  app deliberately chose (and that is known to work on the js target). Recommendation:
  hash-router, for js-target safety and consistency with AuntieOS, unless you want the
  AndroidX back-stack semantics. I also recommend lifting the in-tab detail screens
  (invoice/kin/booking/kintale) out of per-screen local state into an explicit route
  model first, so whichever option you pick is a small, safe change.
</content>
</invoke>
