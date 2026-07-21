# AuntieOS Development Plan — 2026-07-16

Prepared the same way as MyTribe's plan (MyTribe/docs/DEVELOPMENT_PLAN_2026-07-10.md),
off a deep recon of this repo. Owner decision on record (2026-07-10 / S8+ note):
**AuntieOS admin moves to the same React+Vite+Firebase stack as the MyTribe
portal, in its own repo, with a shared primitives package.** OWNER-4
(2026-07-15): this review happens right after MyTribe — that is now.

## What AuntieOS is today (recon summary)

- Kotlin Compose Multiplatform in `web/` with two live targets: wasmJs
  (browser admin, Firebase Hosting site auntieos-ttpc) and JVM desktop (DMG,
  owner-personal — PERMANENT per owner ruling 2026-07-15). Separate native
  Android app in `android/` (~217 files / ~58K LOC, first-class surface).
- commonMain is ~164 files / ~47K LOC across 18 screen areas; biggest:
  kintales (4.5K), settings (4K), directory (3.8K), admin (3.5K).
- **The backend is already MyTribe's**: ~40 callables invoked from
  `data/FirestoreClient.kt` (a single ~130KB monolith) are defined and tested
  in MyTribe/functions. AuntieOS owns only 10 plumbing functions
  (`web/functions/index.js`: setAdminClaim, listAdmins, cloudinary sign,
  mapbox, sendMessage, generate, n8n draft endpoints) + a python reconcile
  codebase.
- Auth: email/password + `admin` custom claim + `admins/{uid}` mirror.
  Desktop uses Identity Toolkit REST.
- Tests: ~987 @Test fns incl. a visual screenshot harness against the
  emulator suite. Functions tests nearly absent (1 file).
- **No git repo, no CI.** History = ad-hoc backups/ dirs.
- **Secrets exposed in working tree**: root `.env` (19 secrets incl.
  ANTHROPIC_API_KEY, Baserow creds, AUNTIE_SHARED_SECRET) + a Firebase
  admin-SDK service-account JSON at repo root.
- App Check: none (expected — O-30 says AuntieOS ships its own later).
- n8n legacy coupling mid-migration (writeDraft/getDraft shared-secret
  endpoints, N8nClient.kt).

## The strategic shape

The rebuild is a re-implementation of the FRONTEND only. The backend
(callables + firestore.rules) is ~90% built and battle-tested by both apps.
True scope: React admin app + shared primitives package + repo/CI hygiene +
AuntieOS-owned functions cleanup + App Check.

Three surfaces ruling (owner): desktop DMG is permanent (owner-personal);
Android app stays first-class; wasm web admin is what the React app replaces.

## Sessions

### A0 — Hygiene + git (FIRST, blocking everything)
1. **Secrets sweep**: move root `.env` values into Firebase Secret Manager /
   local untracked env; DELETE the service-account JSON from the tree and
   rotate that key in GCP IAM (it is a live admin credential sitting in a
   non-versioned folder); audit backups/ + archive/ for more copies.
2. git init + .gitignore (env, service accounts, build/, backups/), initial
   commit. Hosting stays deferred if owner wants, but LOCAL git is
   non-negotiable before a migration touches 47K LOC.
3. Inventory the n8n endpoints still in use; kill-list for the rest.

### A1 — Shared primitives package (`@tribetails/shared` or similar)
Extract from MyTribe/web + MyTribe/functions, consumed by both React apps:
- Typed callable contracts for the ~40 shared callables (source of truth:
  MyTribe/functions zod schemas + tests).
- Firestore collection map + doc types (source of truth: web/firestore.rules
  — the best single schema reference in either repo).
- Auth/claims helpers (`admin` claim, admins/{uid}), the
  MYTRIBE_UID_INTEGRATION_CONTRACT types (kinfolk↔uid↔fcm_tokens).
- Brand tokens: Den redesign (Fraunces / Hanken Grotesk / Spline Sans Mono,
  mesh gradients) as CSS tokens + base React components so admin matches the
  portal's look. Portal may adopt the package retroactively later.

### A2 — React admin shell + auth + read screens I
New repo (auntieos-admin), Vite+React+TS, same conventions as MyTribe/web
(call() wrapper w/ timeout, inline-error mappers, vitest+jsdom, fake-editor
patterns). Sign-in (admin claim gate), app shell/nav, Home dashboard,
Directory (kin/kinfolk/client read), Sessions views. Deploy to a new beta
hosting target; wasm admin stays live in parallel (same side-by-side pattern
as the portal cutover).

### A3 — Read screens II
Invoices (list/detail/PDF/receipts), Schedule/calendar, Bookings + series,
Inbox (conversations, admin side), Notifications center, Activity log
(hash-chain viewer via verifyActivityLogChain).

### A4 — Write surfaces I (the operator's daily loop)
Booking manage (batchUpdateBookings, createKinCareSession,
rescheduleBooking, manageBookingSeries), invoice create/remind/receipt
(createInvoice, sendInvoiceReminder, generateReceipt, postInvoiceEvent),
conversation reply (replyToConversation, markConversationRead), notification
ops (mark/bulk/archive).

### A5 — KinTale authoring + media
The hardest port: tale composer + condition engine (KinTaleConditionEngine
logic → TS), media gallery/albums, Cloudinary signed upload
(signCloudinaryUpload), setMediaProfilePhoto, share links (createShareLink),
addKinTaleComment. AI assist: reuse MyTribe's `generate` brand-voice pattern
for tale drafting (AuntieOS already has its own `generate` fn + voice/ bible
— consolidate to ONE generate implementation, decide which codebase owns it).

### A6 — Communicate + admin + settings
Broadcasts (audience segments CRUD, broadcastMessage, sendExternalMessage,
suppression list), invites (inviteKinfolkToPortal / mintInviteAdmin), feature
flags UI, form-schema editor, checklist bank, training docs (n8n replacement
lands here), MyTribeSettingsPanel (portal home/theme config), business
settings.

### A7 — AuntieOS-owned functions consolidation
Port the 10 web/functions into the MyTribe functions codebase or a properly
tested sibling codebase (tests currently ~zero): setAdminClaim/listAdmins,
cloudinary sign, mapbox, sendMessage, generate. Retire n8n endpoints.
Add the secrets: arrays correctly (AUNTIE_OPERATOR_UIDS gotcha applies).

### A8 — Cutover (gate session, like MyTribe S7)
Side-by-side smoke wasm-admin vs react-admin, flip the auntieos-ttpc hosting
site, keep wasm build as rollback release, decommission wasm target after a
quiet week. THEN: AuntieOS App Check web registration (O-30 Phase 2 partner
work — remember the reCAPTCHA collision lessons: unify loaders BEFORE any
enforcement).

### A9+ — Post-cutover
Android admin app strategy (keep native Compose vs align), desktop DMG
maintenance mode (owner-personal, exempt), engagement/reporting features.

## Standing rules (inherited from MyTribe plan)
- Every session: tests green, deploy if shippable, findings appended here,
  memory updated. No silent scope growth.
- Fable = gate/ruling passes, not driver.
- Full vertical slices; a missing callable means build the callable.
- Never re-ask settled owner decisions (no app store, desktop permanent).

## Open items registry (AuntieOS-side, day one)

> **The live, reconciled open-item registry moved to
> [docs/BACKLOG_2026-07-16.md](BACKLOG_2026-07-16.md)** (one AO-### namespace, all
> six old docs mapped, every item re-verified against source). This plan stays as
> the session ladder + rulings; track open work in the backlog. The AO-1..AO-8
> list below is kept for the A0/A1 narrative only.
- AO-1 — service-account JSON in tree: delete + ROTATE key (A0, urgent).
- AO-2 — root .env secrets: relocate + rotate Baserow/shared-secret values
  still live (A0).
- AO-3 — no git: init locally (A0).
- AO-4 — n8n endpoints kill-list (A0 inventory, A6 replacement).
- AO-5 — duplicate `generate` implementations (AuntieOS index.js vs MyTribe
  aiCopy.ts): consolidate, one brand-voice source (A5/A7).
- AO-6 — web app never registered as its own Firebase Web app (bridge uses
  an Android appId); register properly during A2 config.
- AO-7 — functions test coverage ~zero on AuntieOS-owned fns (A7).
- AO-8 — cross-app contract doc lives only on MyTribe side; make the shared
  package the single source (A1).

## Immediate next actions
1. Owner: green-light A0 (secrets rotation touches live credentials).
2. A0 session first — nothing else starts before the tree is safe + gitted.
3. A1 package skeleton can start the same day A0 lands.
See the block delivered in the 2026-07-16 session wrapup; canonical copy
lives here. Update the session ID + scope line each time.

---

# Session 2026-07-15: carryover sweep (A0 DEFERRED by owner)

Owner deferred A0: keys/tokens get cleared and rotated before git hosting,
"we are not there yet". No secrets touched, no git init, no rotation.
Scope became the carryover watch-list instead.

## AO-0 (NEW, blocks the recon numbers above): this plan was written against a stale tree

There are TWO AuntieOS trees, not one, and they are separate directories
(different inodes, not a symlink):

- `/Users/sydeast/Projects/Deployed/AuntieOS`: source frozen at **2026-06-17**.
  The only 2026-07-15 file in it is this plan doc.
- `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS`: live,
  source to **2026-07-03**, SOTU/HANDOFF to **07-07**. This is the tree
  CLAUDE.md and project memory both name as canonical.

The 2026-07-16 recon read the frozen copy, so its counts (164 commonMain
files / 47K LOC, ~40 callables, 217 android files) describe the tree as of
06-17 and are ~4 weeks stale. Re-run recon against the Documents tree before
A1 sizing depends on those numbers.

**A0 consequence:** the service-account JSON and root `.env` exist in BOTH
trees. The secrets sweep must cover both, and rotation must assume the key
leaked from either. AO-1/AO-2 are two-tree problems.

### Corrected recon (measured against the LIVE tree, 2026-07-15)

Replaces the "What AuntieOS is today" numbers at the top of this doc. Every
figure below is measured, not estimated.

| Metric | This doc says (stale tree) | Live tree, measured |
|---|---|---|
| commonMain .kt files | 164 | **179** |
| commonMain LOC | ~47K | **51,096** |
| android main .kt files | 217 | **224** |
| android main LOC | ~58K | **61,122** |
| `FirestoreClient.kt` | ~130KB | **143.5KB, 3,004 lines** |
| Shared MyTribe callables invoked | ~40 | **52** (49 node + 3 python) |
| `@Test` fns | ~987 | **2,264** (web 1,125 + android 1,139) |
| `web/functions` tests | "nearly absent (1 file)" | **2 files, 53 passing** |

Two of these are worth calling out, because they change decisions:

**The "~987 @Test fns" figure is exactly the stale tree's WEB count.** Measured:
stale-tree web = 987. Live = 1,125 web + 1,139 android = 2,264. So the recon
counted one target of one stale tree and reported it as the project total. That
is the clearest proof that the recon needs redoing wholesale rather than
patching, and it is why AO-0 blocks A1 sizing.

**AO-7 is substantially wrong and should be rewritten, not actioned as stated.**
"Functions test coverage ~zero on AuntieOS-owned fns" describes the stale tree,
whose `web/functions/test/` holds only `generate.test.js`. The live tree has
`generate.test.js` + `index.test.js`, 53 passing tests via `node --test`,
covering `resolveAnthropicModel` (NOTE-48 allowlist), `validateUploadFolder`
(WARNING-12 folder boundary) and `assertAdminRemovalAllowed` (NOTE-51 lockout).

The real, smaller AO-7 gap: those 53 tests cover PURE HELPERS only. No exported
handler is exercised directly (`setAdminClaim`, `listAdmins`,
`signCloudinaryUpload`, `searchMapbox`, `retrieveMapbox`, `sendMessage`). The
codebase's own convention for fixing that is visible in `generate.js`: extract a
`runGenerate()`-style injectable core and let the `onCall`/`onRequest` wrapper
stay thin, then test the core hermetically with no admin SDK and no network.
Worth folding into A7's port rather than doing twice, since A7 moves this code
into MyTribe/functions anyway.

### AO-4 addendum: callable count

The 52 callables AuntieOS invokes via `platformInvokeCallable` include three
python-codebase ones (`clear_dossier_household_notes`, `recap_recent_comms`,
`synthesize_kinfolk_profile`). A1's "typed callable contracts" package therefore
spans two backend codebases, not one. The plan's A1 bullet assumes
"MyTribe/functions zod schemas + tests" is the single source of truth; for those
three it is not.

## AO-4: n8n kill-list (COMPLETE; evidence-backed)

Method: static call-graph across web (Kotlin/wasm), android, and
`web/functions/index.js`, plus Cloud Logging traffic on the live endpoints.
Traffic evidence is a controlled query. The identical filter shape against
`getMyHome` returns per-request entries, so an empty result means no traffic
rather than a broken query.

### Server: the three n8n shared-secret HTTP endpoints (`web/functions/index.js`)

All three are deployed and reachable by direct Cloud Run URL (no hosting
rewrite, so n8n posts straight at them with `x-auntie-key`).

| Endpoint | Auth | Requests, 2026-04-15 → 07-15 | stdout, 2025-09-01 → 07-15 | Verdict |
|---|---|---|---|---|
| `writeDraft` | `N8N_SHARED_SECRET` | **0** | none | KILL |
| `getDraft` | `N8N_SHARED_SECRET` | **0** | none | KILL |
| `getTrainingDoc` | `N8N_SHARED_SECRET` | **0** | none | KILL |

Note the happy paths never log, so stdout silence alone proves only "no
errors". The Cloud Run *request* logs are what prove zero traffic.

Killing all three also retires: the `N8N_SHARED_SECRET` secret itself,
`n8nKeyAuth` + `n8nIpAllowed`, the `n8nIpRateLimits` collection, and its
firestore.rules entry. That deletes AO-2's `AUNTIE_SHARED_SECRET` rotation
target rather than rotating it, which is cheaper than rotating a secret nothing uses.

### Client web: `web/composeApp/.../data/N8nClient.kt`

| Method | Target | Callers | Verdict |
|---|---|---|---|
| `pingProfileUpdate` | `n8n /webhook/auntie-update-profiles` | **0** | KILL (dead) |
| `sendMessage` | `/api/send-message` **on the n8n host** | **0** | KILL (dead) |
| `generate(useFunction=false)` | `n8n /webhook/auntie-generate` | branch only | KILL branch |
| `generate(useFunction=true)` | `auntieos-ttpc.web.app/api/generate` | 2 live | KEEP |

`sendMessage` is worth a look before deleting: `defaultRequest` pins the host
to `n8n.tribetails.com`, and its path is relative, so it resolves to
`n8n.tribetails.com/api/send-message`, not the Firebase function. Android's
equivalent uses an absolute Firebase URL. It is dead code today, so this is
latent, not live. But reviving it as-is would send messages at n8n.

### Client android: `android/.../data/api/N8nApi.kt`

| Method | Target | Callers | Verdict |
|---|---|---|---|
| `generate` | `webhook/auntie-generate` (relative → n8n) | **0** | KILL |
| `updateProfiles` | `webhook/auntie-update-profiles` (relative → n8n) | **0** | KILL |
| `generateViaFunction` | absolute Firebase URL | live | KEEP |
| `sendMessage` | absolute Firebase URL | live | KEEP |

**Android already makes zero live n8n calls.** `AuntieRepository` only calls
the two absolute-URL methods. Once the two webhook methods go, `N8nApi` is
misnamed and `RetrofitClient.buildN8n`'s `https://n8n.tribetails.com/` baseUrl
is vestigial (both live methods override it). Rename to something honest and
drop the baseUrl.

### Latent risk this removes

`FeatureFlags.communicateGenerateViaFunction` carries the comment "ALWAYS_ON:
a stale remote `false` must never re-route generation back to a dead n8n".
but `ALWAYS_ON` only means "no toggle row in the admin screen" (see the set's
own docstring: a remote override can still kill-switch one in an emergency),
and `fromMap` still reads the key from remote. So a stale remote `false`
CAN route generation to the dead webhook. Deleting the `useFunction=false`
branch makes the comment true.

### Blockers

None in code. MyTribe's backend has zero n8n references. The one thing this
inventory cannot see is whether an n8n workflow still exists and is pointed at
those three endpoints. It has sent nothing in three months. Operator
confirms, then Phase B deletes (this is the evidence the n8n retirement plan's
Phase B was gated on).

## Carryover items closed / assessed

- **O-36 (sign-out busy state): FIXED, MyTribe portal. Not deployed.**
  New `useSignOut()` in `web/src/lib/auth.ts` owns the busy flag for all ~17
  call sites. A `useRef` guard, not the state flag, is what swallows the double
  tap (React batches state, so two clicks in one tick both read `false`).
  Success deliberately leaves the flag set, because `signOut()` ends in a full page
  reload, so re-enabling would flash a live button onto an unloading page.
  Also removed the now-dead `navigate({to:'/signin'})` hop from 12 screens
  (the reload + router guard already do that).
  Covered the non-button sign-outs too: `PortalNav`'s avatar is a `<div>` and
  `NoTribes`/`TribePicker` use `<a>`. None honor `disabled`, so the hook's
  guard is their only real defence.
  Web 271→277 tests, tsc + lint clean.
- **O-36 on AuntieOS: NOT APPLICABLE, with evidence.** AuntieOS sign-out has
  no multi-second wait to guard: wasm goes to `window.__fb.signOut` and android
  to `auth.signOut()` + `clearTestModeCache()`, both local SDK calls. There is
  no push-unregister on sign-out anywhere in either target (MyTribe's
  `unregisterForPush` round trip is the whole reason O-36 exists). The one
  AuntieOS surface where an operator could notice (`SettingsScreen`) already
  does `if (signingOut) "Signing out"`. Adding busy states to `App.kt` /
  `AppShell.kt` / `Navigation.kt` would guard a wait that does not exist.
- **O-37 (claim-stamping consistency): CONFIRMED A REAL BUG, FIXED. Not deployed.**
  See below.
- **O-29: CANNOT RUN YET.** The quiet-window check needs Logs Explorer to show
  no `admin.allowlist.fallback.used` for ~14 days, i.e. on/after ~07-27.
  Today is 07-15. Running it now proves nothing.
- **O-33: CANNOT RUN.** Needs a real device; `adb devices` is empty.
- **O-32: OWNER'S CALL, untouched.** `BRAND_VOICE_SYSTEM` is frozen for prompt
  caching; edits invalidate the cache, so it is not something to change on spec.

## O-37: what it actually was

The plan asked whether "acceptInvite claim-stamping raced before relying on
those claims anywhere". It does, and the `{}` vs `{role, kinfolkId}` difference
between fixtures was just *when* each was inspected relative to the trigger.
The bug underneath is real:

1. `acceptInvite` never stamped claims at all. It writes `clients/{uid}` and
   leaves `role`/`kinfolkId` to the async `onClientsWrite` trigger.
2. The kinfolk's ID token was minted at account-creation, BEFORE that trigger.
   The O-35 reload restores the session but will not refresh a minutes-old token.
3. `ensureAccess` auto-picks the sole tribe for a single-tribe kinfolk in local
   state only, with no `setActiveTribe` and no `getIdToken(true)`. The manual picker
   path does both, but a single-tribe kinfolk never sees a picker.

`firestore.rules:23` and `storage.rules:9` both gate kinfolk reads on
`token.role == 'kinfolk' && token.kinfolkId != null`. So a freshly-accepted
kinfolk's claim-gated DIRECT reads (realtime Messages
on `conversations/{kinfolkId}`, and live GPS on
`kin_care_sessions/{id}/breadcrumbs`) were denied until their token happened
to age out, up to an hour. Callables
kept working, so history loaded and only the LIVE features died, quietly:
`messagesListener` just `console.warn`s. That is the silent degradation the
fail-loud policy forbids.

**Fix (owner picked: server stamp + conditional client refresh):**
- `functions/src/membership/acceptInvite.ts` calls `syncKinfolkClaim(uid)` after
  the transaction, the same way `setActiveTribe` already does. Best-effort: the
  tx has committed by then, so throwing would report "joining didn't finish"
  about work that finished. The trigger stays as the backstop, and the failure
  path logs `claim.sync.failed` at warn rather than swallowing.
- `web/src/lib/activeTribe.ts` gets `reconcileClaim()`, cheapest-correct in
  order: read CACHED claims (no network, warm boot stops here) → on mismatch
  force ONE refresh (enough now that acceptInvite stamps server-side) → only if
  it STILL disagrees spend a `setActiveTribe` re-mint. So a normal boot pays
  nothing and a broken one self-heals. Awaited, not fire-and-forget: screens
  attach their claim-gated `onSnapshot` as soon as access resolves, and a
  listener that starts on a stale token is denied without retrying.

functions 1415→1417 tests, web 271→277, both tsc clean.

## State at session end

- **DEPLOYED LIVE 2026-07-15** (owner approved both):
  - `functions:mytribe:acceptInvite` updated (targeted deploy, not bulk).
  - web built and released to BOTH `mytribe_beta` and `kinfolk_portal` (prod).
  - Artifacts verified rather than trusted: compiled `lib/membership/acceptInvite.js`
    carries `syncKinfolkClaim` + `claim.synced`/`claim.sync.failed`; the live prod
    origin serves `index-DMmbGLyH.js` containing `reconcileClaim`, and the live
    `ClaimInvite` chunk contains "Signing out".
  - Prod signed-out boot smoked clean (loads, redirects `/signin`, zero console
    errors). **Signed-in boot NOT yet driven** (see below).
- MyTribe web 277/277, functions 1417/1417, both tsc + lint clean.

### Verification still owed on O-37

Two gaps, both needing a human at the keyboard:

1. **Signed-in boot.** `ensureAccess` now awaits `reconcileClaim` on every boot
   with an active tribe, so a regression there hits every kinfolk. Unit tests
   cover all branches incl. the throw path, and signed-out boot is clean, but
   nobody has driven a signed-in prod boot. Note the sandbox operator account
   would NOT exercise it: operators resolve `activeKinfolkId: null` and go to
   `/pick`, so `reconcileClaim` is skipped for them. It needs a real kinfolk.
2. **The actual O-37 claim E2E.** Fresh invite → create account → accept →
   confirm realtime Messages/live GPS work IMMEDIATELY rather than after a token
   ages out. That is the behaviour the fix exists for, and it is unverified in
   prod. Requires minting a new fixture.
- AuntieOS untouched, correctly: O-36 does not apply there, and A0 is deferred.
- E2E fixture teardown NOT done: authorized, but irreversible, so it waits on an
  explicit go. Real uids, recovered from this doc's own log since the session
  prompt truncated one: `EA4QezhZSNY99W940ZueLH4NA9R2` (e2e-claim-prod) and
  `IOpWNGd9FkSJrCriE3uzVhi22lf2` (e2e-o35@tribetails.test). Both already DISABLED.

## O-19 (MyTribe): dead getMyHome stub fields removed. CODE DONE, NOT DEPLOYED.

`currentVisit`/`upcomingBookings`/`recentBookings` were Phase-2A placeholders
typed `null`/`never[]`. Home has long since gotten that data from
getMyBookings/getMyKinTales/getMyKin. Removed from the callable result type, the
response, `web/src/api/types.ts`, and the Account test fixture; the stale Home.tsx
comment describing them is gone too. New test pins their ABSENCE so nobody
re-adds a stub nothing reads. functions 1417 to 1418, web 277, tsc + lint clean.

All three consumer surfaces checked before touching the contract:
- MyTribe web: type-only, zero reads (a `never[]` cannot carry data anyway).
- Legacy Compose (still one Hosting rollback away until O-2): its `MyHomeResult`
  does not declare these fields, and `PortalApi.getMyHome` decodes by explicit
  key lookup, so a missing key is a no-op, not a decode failure. **O-19 is NOT
  gated on O-2.**
- AuntieOS: not a consumer. Its only tie to getMyHome is the shared `portal`
  sub-object (`MyTribePortalConfig`), which is untouched.

Web needs no redeploy for this: the web edits are types, a comment, and a test
fixture, none of which change runtime JS. Only `functions:mytribe:getMyHome`
needs to ship.

## AO-9 (NEW, from the read-only sweep): every wasm crash reports blind

`reportError(throwable, context)` in `CrashReporter.wasmJs.kt` already does the
right thing: it unwraps `throwable.message` AND
`throwable.stackTraceToString()`, then captures that. **Nothing in commonMain
ever calls it.** The only matches for `reportError`/`CrashReporter.` in
commonMain are two doc comments in `CrashReporter.kt`.

So every Kotlin exception in the wasm admin escapes uncaught to
`window.onerror`, where `sentry-bridge.js` stringifies `ev.message`. A
Kotlin/Wasm exception stringifies to the literal `[object
WebAssembly.Exception]`, and the Kotlin stack is discarded. Sentry receives a
constant string with no type, no message, no frames.

Evidence: **AUNTIEOS-ADMIN-11**, `[web] Uncaught [object WebAssembly.Exception]
(https://auntieos-ttpc.web.app/#/directory:0:0)`, 5 events / 2 users,
2026-06-14 to 06-17, silent since. It is a real crash on the Directory screen
that took out the screen for someone, and it is NOT diagnosable from the
report. Neither will the next one be. Left OPEN in Sentry deliberately: closing
it would imply it was understood.

This is an instrumentation gap, not a single bug. It costs a whole class of
production visibility on the app's primary surface, and it silently devalues
every future wasm Sentry issue.

**Fix shape:** call the existing `reportError` from a Kotlin-side boundary so
the throwable is captured where it is still typed, rather than after wasm has
flattened it. Options, cheapest first:
1. Wrap the composition root / each screen's coroutine launches in a
   `runCatching { } .onFailure { reportError(it, "screen:X") }` boundary.
2. Install a `CoroutineExceptionHandler` on the app scopes (most wasm crashes
   here will come from a launched coroutine, not the composition itself).
3. Only then consider improving `sentry-bridge.js`; it cannot recover what wasm
   already threw away, so it is the wrong layer to fix this in.

Cannot ship this session: it is wasm, and the owner ruled no wasm admin deploy.
Verification when it does ship must be runtime, not unit: force a throw behind a
debug affordance and confirm Sentry shows a real Kotlin frame. A green unit test
proves nothing here, since the bug IS the missing call.

## Exploratory review 2026-07-15: findings are the REBUILD SPEC, not a patch list

Owner reconfirmed mid-session: "we will need to rebuild the auntieos ui in another
language like we did with mytribe". That is already the standing decision at the
top of this doc (2026-07-10), so nothing changes about the ladder. But it changes
what this review is FOR.

**Triage rule this produces:** the split that matters is not wasm-vs-android, it is
**does the code survive A8**.

- **wasm web UI: throwaway.** A8 deletes it. Do not polish. Fix only what actively
  misleads the operator between now and cutover, since that could be months.
- **android: permanent.** The owner's ruling keeps the Android app first-class
  native Compose; it is NOT part of the React rebuild. Android bugs are real work.
- **The findings themselves outlive both.** Every defect below is a requirement
  for the React admin. The MyTribe portal already gets several of these right
  (its Home carries `hasReadError`), which is the proof the rebuild can inherit
  the answers rather than rediscover the bugs.

### The review method that worked, for the record

Static sweep alone could not have proven any of this. Four parallel finders hunted
named bug classes (dead controls, silent error swallowing, Flow-without-remember,
UI wired to absent callables), then EVERY hit was re-verified by hand before being
believed. Roughly a third of what came back did not survive verification. Then the
live drive as the Stage 0I test admin turned one static finding into a confirmed
production defect. Neither half was sufficient alone.

Note the sandbox turned out to be SAFE for this, contrary to the harness analysis
earlier in this session: a test admin holds `testTribeId` but never `admin:true`,
so Firestore rules scope its reads to the sandbox household AND every admin
callable rejects it. Broadcasts, SMS and invoices structurally cannot fire. The
review needed no new harness at all. What it needs is an operator to sign in,
because entering credentials is not something the agent will do.

### AO-10 (NEW, LIVE-VERIFIED, FIXED, not deployed): Home rendered a failed read as zero

Caught by driving production, not by reading code. Console showed
`listenWhereEq kin_care_sessions status` returning `Missing or insufficient
permissions`. That query is `platformBookingRequestsStream()` verbatim
(`whereEqStream("kin_care_sessions", "status", "DRAFT")`), which feeds
`bookingsState`. `openBookings` is `(bookingsState as? Data)?.value?.size ?: 0`,
so the Error collapsed to 0 and the card rendered:

> **Open bookings: 0** / "needs a reply"

Home renders no bookings panel, so that card was the ONLY possible surface for the
failure. Nothing anywhere said it broke. An operator with real requests waiting
sees a confident zero.

Three of the four stat cards had no Error branch (Today's pack, KinTales to
review, Open bookings). "This week" already had one, which is what the fix
generalises into `statCardValue` / `statCardTrend` / `statCardNumeric` pure
helpers in HomeScreen.kt, tested in `StatCardStateTest` (8 cases). `statCardNumeric`
also suppresses the count-up roll on Error, since animating to 0 performs the lie
rather than just printing it. Fixed a latent copy bug in passing: "This week"'s
error trend said "see error above" pointing at a panel that does not exist.

Web jvm suite 1125 to 1133, green.

**A false lead worth recording**, because it nearly shipped: the first read of this
was "Today's Pack says 'Nothing on the books today. Enjoy the quiet.' while the
read failed". Wrong. In test mode `sessionsStream()` routes to
`platformSessionsForKinfolkStream(scope)`, a different query, which succeeded and
genuinely returned nothing. That panel already handles Error correctly (line ~329).
The real defect was one card over. Verifying which stream actually failed is what
separated them.

### AO-12 (NEW, LIVE-VERIFIED): AuntieOS and the MyTribe portal disagree about money

The single most important finding of the review, and the concrete argument for A1.

Sandbox invoice `test-kinfolk-001-invoice-credit` is stored as:
`invoiceStatus: "credit"`, `total: -2000`, `creditRedeemedAt: null`, line item
"Credit for cancelled visit". An unredeemed $2000 credit the household is OWED.

| Surface | Renders it as |
|---|---|
| MyTribe portal (React, kinfolk-facing) | **CREDIT** (correct) |
| AuntieOS admin (wasm, operator-facing) | **PAID**, with a Receipt button |

The portal is right because `web/src/lib/invoiceFormat.ts:82-85` ENUMERATES the
real states and checks `creditRedeemedAtMs` to split Credit from Redeemed.

AuntieOS is wrong because `InvoiceFilters.kt` INFERS paid by negation:

```kotlin
fun invoiceIsOutstanding(i) = !statusSaysPaid(i) && i.amountDue > 0.0
fun invoiceIsPaid(i)        = !invoiceIsDraft(i) && !invoiceIsOutstanding(i)
```

`status="credit"` is not "paid" and not "draft", and `-2000 > 0` is false, so the
credit falls through to PAID by elimination. A zero-total invoice classifies as
paid too. The file's own docstring says "We never claim a state we cannot prove",
which is precisely what the negation does.

Consequences: PAID badge on an unredeemed credit, the credit files under the Paid
filter tab, and it offers generateReceipt. If a kinfolk asks about the credit
their portal is showing them, the operator's screen says it was paid.

Not fixed: it is wasm, so A8 deletes it, and the correct implementation already
exists portal-side. **This is what A1's shared primitives package is for.** The
two surfaces drifted because the same money question was answered twice, in two
languages, from two premises. The rebuild must IMPORT `invoiceStatusInfo`, not
re-derive it.

### AO-11 (NEW, LIVE-VERIFIED): Directory cards silently hide pets

The sandbox household has 4 kin (3 active, 1 inactive; verified in Firestore, all
`kinfolkId: test-kinfolk-001`, none archived). Its Directory card shows **2**,
with no overflow indicator.

`DirectoryScreen.kt` computes the right thing: `kin.take(3)` plus a
`"+$overflow more"` chip. But the card is `.height(CARD_HEIGHT)` (196.dp) and
`.clip(RoundedCornerShape(20.dp))`, fixed deliberately "so heights are uniform
across the whole grid" (line ~451). Each chip carries a 28.dp avatar, so only
about two fit per row: the second row, INCLUDING the overflow chip that exists to
signal truncation, is clipped away unseen.

The affordance that would have said "there are more pets" is itself what gets
hidden. For a pet-care business, "how many animals live here" is the product, not
a detail. Rebuild requirement: a fixed-height card must reserve room for its own
overflow affordance, or the count moves out of the clipped region.

### Full walk: all 18 screens, 2026-07-15, as the Stage 0I test admin

Every screen in the rail, plus Account. Driven on production. The headline is NOT
that error handling is bad. It is that the SAME codebase contains both the best
and the worst error handling in the product, and nothing forces consistency.

**The spread, worst to best:**

| Screen | Behaviour on a failed read |
|---|---|
| Home | **Silent zero.** "Open bookings: 0 / needs a reply". No error anywhere. (AO-10, fixed) |
| Bookings | Panels say "Couldn't load", but the stat card says **0** and both panel counts say **0**. Screen contradicts itself 3 ways. |
| Templates | Error banner + stat cards spinning **"..."** forever + **"Loading templates..."** that never ends + "All 0". Three states at once. |
| Tribal Intel | Error banner AND **"No Tribal Intel yet"** empty state, stacked. Two answers. |
| Gallery | "Preview unavailable" on the thumbnail. Honest. |
| Schedule | "Couldn't load busy blocks". Clean. |
| Notifications / Activity Log | Correct error, but takes ~50s of skeletons to appear. |
| Inbox | **Excellent.** Three panels, three honest errors, one naming "Admin claim required", and a "**4 FAILED**" count with each failure listed. |
| Form Schemas | **Gold standard.** Names the callable ("listFormSchemas failed: Admin claim required"), offers a **Retry** button, and replaces the empty state with "Schemas unavailable while the load is failing" rather than claiming zero. |

Form Schemas proves the team knows exactly how to do this. It names the failing
callable, offers recovery, and refuses to render a false empty state. Home does
none of the three. The difference is not knowledge, it is that each screen
re-implements error handling by hand and about half get it wrong. **That is a
missing shared component, which is precisely an A1 deliverable.**

### AO-13 (NEW): error and empty-state render simultaneously

Distinct from AO-10 (silent zero). Here the error IS surfaced, and the empty
state renders anyway, directly beneath it:

- **Tribal Intel**: "Couldn't load training documents / Missing or insufficient
  permissions" followed by "No Tribal Intel yet: Training materials and guides
  will appear here once uploaded".
- **Templates**: error banner, plus "Loading templates..." that never resolves,
  plus "All 0", plus stat cards stuck on "...".

Cause is structural: `if (error) ShowError()` and an independent
`if (list.isEmpty()) ShowEmpty()`, both true at once, because `list` is
`?: emptyList()`. Form Schemas is the counter-example that gets it right, by
making the list region's empty branch aware of the error state.

### AO-14 (NEW): the app takes 10 to 50 seconds to say anything

Measured on production, test admin, warm bundle:

| Screen | Time to first meaningful state |
|---|---|
| Invoices | ~10s |
| Schedule | ~16s |
| Bookings | ~18s |
| Gallery | ~36s |
| Notifications | ~50s (to show an ERROR) |
| Activity Log | ~50s (to show an ERROR) |

Fifty seconds of skeletons before the app admits a read failed is worse than the
failure. The Firestore listener retries before surfacing, so the failure path is
the SLOWEST path. Rebuild requirement: bound the wait, and show the error when it
is known rather than after the retry budget drains.

### AO-15 (NEW): no accessibility tree at all

The wasm admin renders to a canvas. Its accessibility tree contains no navigation
elements, no buttons, no labels: only generic containers. Screen readers get
nothing. This also makes the app un-automatable by element (only by pixel), which
is why the review below could not use element-level clicking, and why two false
positives nearly got filed. A React admin is automatable and screen-readable by
default. Add this to the A8 case.

### Smaller findings from the walk

- **Account**: profile chip labels the test admin as "**Admin**". It is
  specifically NOT an admin (`testTribeId`, never `admin:true`). The sidebar gets
  it right ("Test admin, sandbox"); the profile card does not.
- **Invoices**: every invoice renders `#(none)`. Honest, not a bug: the model has
  `invoiceNumber` and the seed writes docs directly rather than through
  `createInvoice`, so it is never assigned. Seed artifact.
- **KinTales / Bookings**: rows show the raw key `visit_60` as the service label.
  Schedule's legend renders the same concept as "60Minute". Raw ids leak to the
  operator on two screens and are mapped on a third.
- **Schedule**: duration legend is unsorted (90Minute, 60Minute, 30Minute, 2Hrs,
  Half-Day 6Hrs, 45Minute).
- **Settings / Feature Flags**: business-global config, so NOT kinfolk-scoped.
  The sandbox account reads live production business profile (real name, email,
  phone) and live feature flags, and the toggles appear interactive. Not tested
  (that would be a write). Worth deciding whether the 0I sandbox should be able
  to see, let alone flip, production business config.
- **Auntie Time**: best empty state in the app: "Nothing in flight right now.
  Approved Kin Cares for today and the next two weeks land here... New bookings
  show up once you approve them on the Bookings screen." It says what belongs
  here AND where it comes from. This is the bar "Enjoy the quiet" should meet.

### Two false positives, recorded deliberately

Both were caught before being reported as fact, and both share a cause worth
remembering: with no accessibility tree, the only tool is pixel-clicking a
canvas, and misreading the aftermath is easy.

1. **"Today's Pack renders a failed read as 'Enjoy the quiet'"**: wrong. In test
   mode `sessionsStream()` routes to a different query that succeeded and
   genuinely returned nothing. The real defect was the Open bookings card.
2. **"The nav rail is dead"**: wrong. Four items, seven synthetic clicks, zero
   navigation, hover working every time. Looked conclusive. The owner clicked it
   with a real mouse and it worked fine. Compose canvas does not accept the
   synthetic clicks; the app is fine.

The discipline that caught both: check WHICH query failed rather than assuming,
and ask the human to try the thing before calling it broken.

### AO-16 (NEW, found by porting): the glass rim is hardcoded white, so it breaks in dark

`AuntieGlass.kt:39` draws its rim with `Color.White.copy(alpha = rimAlpha)`, a
literal, not a theme role. On the cream-light default this reads as intended. In
DARK mode the background is Brand Navy `#11131F` and every glass surface gets a
white halo, because nothing re-points that colour when the scheme flips.

Not noticed in the live review because the app ships light by default. Found only
by porting the component and refusing to hardcode a colour: the React version
uses `var(--color-border)`, which follows the scheme.

Rebuild requirement: a literal colour anywhere in a component is a theming bug
waiting for someone to switch schemes. Tokens or nothing.

### AO-17 (NEW, found by porting): the shape scale describes half the app

Measured 2026-07-15 across the component library and screens:

| | |
|---|---|
| Uses of `AuntieTheme.shapes` (the token scale) | **11** |
| Component files declaring a raw `RoundedCornerShape(N.dp)` | **31** |
| Distinct radii actually in use | **17** |

The five named shapes (pill 999, card 8, cardLg 12, chip 6, tight 4) cover ~117
of ~219 measured usages. The rest are raw: 10dp appears **27 times** (second most
common non-pill radius, and it has no token at all), 20dp 17x, 11dp 15x, 16dp
11x (StatCard), 18dp 10x (DenPanel), plus a tail of 14/13/9/24/22/15/50.

So `AuntieShapes.kt` is not the design system, it is what the design system was
going to be. Two independent porting agents hit this within minutes of each
other: one had to render AuntieIconButton's 10dp as 8dp, the other StatCard's
16dp and DenPanel's 18dp as 12dp. Both reported the gap rather than inventing a
value, which is how it surfaced.

`tokens.css` now carries the raw radii by frequency with deliberately numeric
names (`--radius-10`), so the port stays faithful and the drift is visible rather
than silently rounded away.

**OPEN DECISION for the owner, not for a porting agent:** consolidate to a real
scale (and accept small visual diffs across ~100 usages), or keep all 17.
Seventeen values is not a system. This is a design call and it should be made
once, deliberately, before the 53-component port goes wide, because every
component ported before the decision will need revisiting after it.

The same question almost certainly applies to spacing and motion: both agents
independently reported that no `--space-*` or duration/easing tokens exist, while
the source specifies raw 16dp/20dp padding, 6/8/14dp gaps, and `tween(160)`/
`tween(180)`. Not yet measured.

### AO-18 (NEW, found by porting, HIGHEST SEVERITY of the session): nowIso() is UTC on web and LOCAL on desktop

One `expect fun nowIso()`, two different meanings:

```kotlin
// wasmJsMain  @JsFun("() => new Date().toISOString().slice(0, 19) + 'Z'")   UTC
// jvmMain     java.time.LocalDateTime.now()                                 LOCAL
```

18 call sites in commonMain consume it. The business operates in Austin (UTC-5
CDT, per Settings > Weather area), so **every evening after 19:00 local, UTC has
already rolled to tomorrow** and the web admin's idea of "today" is wrong:

- **Money.** `InvoiceFilters.invoiceIsOverdue(invoice, todayIso)` compares
  `due < todayIso`, and its own docstring instructs callers to pass
  `nowIso().take(10)`. After 19:00 local, `todayIso` is TOMORROW, so invoices
  that are due today render **OVERDUE five hours early, every single evening**.
- **The operator's daily driver.** `KinCareSessionsScreen.kt:272`,
  `val today = nowIso().take(10)`. Auntie Time is the day-of view ("Clock in,
  clock out, every Kin Care in flight"). After 19:00 local it is showing
  tomorrow's day.
- **Cosmetic tell.** The Home greeting says "Good morning" at 7pm. That is the
  symptom that led here, and it is the least of it.

**Root cause worth stating precisely, because the fix depends on it:** the
function is not simply wrong, it is serving two incompatible purposes.
`completedAt = nowIso()` is CORRECT: stored timestamps should be UTC.
"What day is it for the operator" must be LOCAL. Web gets storage right and UI
wrong; desktop gets UI right and storage wrong. Both are half broken, in
opposite directions, which is why neither surfaced as an obvious defect.

Fix shape: split the concern. `nowInstantUtc()` for anything persisted, and
`todayLocal()` / `currentHourLocal()` for anything the operator reads. Do NOT
"fix" wasm's nowIso to local: that would silently start writing local times into
Firestore alongside years of UTC ones, which is far worse than the display bug.

Not fixed here (wasm, A8 deletes it) but **the React port must not inherit the
ambiguity**, and the ANDROID app should be checked for the same split since it is
permanent. Also worth an operator check: whether any server-side cron or callable
consumes a client-sent "today".

Found by a porting agent that took the brief's "no Date.now() inside a function,
take the instant as a parameter" rule seriously, went looking for the clock, and
noticed the two actuals disagreed.

### AO-19 (NEW, found by porting): serviceTone substring-matches "sit" inside "visit"

```kotlin
fun serviceTone(serviceType: String): AuntieStatusTone {
    val s = serviceType.lowercase()
    return when {
        "walk" in s -> Teal
        "drop" in s -> Orange
        "sit" in s || "house" in s || "overnight" in s -> Purple   // "vi-SIT-_60"
        ...
        else -> Orange
    }
}
```

`"visit_60"` contains `"sit"`, so every visit-shaped service key paints as
house-sitting Purple across the legend, the service pills, and the schedule grid
blocks.

The reason it survived: `ScheduleScreen.kt:1103` documents the opposite in a
comment, confidently.

> "free-text keys with no match (e.g. "visit_60") resolve to Orange via
> [serviceTone]; the legend's "Other / unmapped" swatch is honest about that."

It does not resolve to Orange. A wrong comment is worse than no comment: it
answers the question a reader came to ask, so nobody re-checks. Ported faithfully
into `denFormat.ts` WITH a test pinning the surprising behaviour, so the rebuild
decides deliberately rather than "fixing" it by accident.

The project already has a standing rule against substring matching in tests. It
applies to product code too.

### AO-20 (NEW): `visit_60` vs `60Minute` is two data sources, not a missing mapping

Correcting the review's earlier read. Schedule does NOT map service keys:
`ScheduleScreen.kt:255` passes `scheduleSettings.serviceRates.keys` straight to
the legend, which renders them verbatim. Every other screen prints raw
`session.serviceType`.

So there is no label mapping anywhere to bypass. The two strings come from two
different sources (session documents vs the `serviceRates` map in Business
Settings), both leaking raw keys to the operator. Fixing it means authoring a
mapping AND reconciling two key spaces, which is a product decision, not a port.

### Requirements this hands the React rebuild

1. **A failed read must never render as a zero, an empty list, or a friendly
   empty-state.** This is the single most common defect found, across web AND
   android, on money, bookings, pets, and invoices. "Enjoy the quiet" and
   "No media uploaded yet" are what a broken read looks like today.
2. **Absent data and unreadable data are different answers.** Both fixes this
   session turn on that one distinction.
3. **Every count needs an error state, not just the panel under it.** A card with
   no panel is the only surface its failure has.
4. **A required `onClick` invites `{}`.** Android's `AuntieChip` takes a
   non-nullable `onClick` and always applies `.clickable`, so callers pass `{}` to
   render a static badge and ship a dead control. The web `AuntieChip` gets this
   right with `onClick: (() -> Unit)? = null`. The React components must make
   "static" expressible.
5. **Unwrap exceptions where they are still typed** (AO-9). Do not let the
   platform flatten them before the reporter sees them.
6. **Enumerate states, never infer them by negation** (AO-12). "Paid" must mean
   paid, not "whatever is left after draft and outstanding". Every money state
   the data can hold (paid, open, draft, quote, credit, redeemed, zero) gets an
   explicit arm. The portal's `invoiceStatusInfo` is the reference.
7. **One answer per question, shared across surfaces** (AO-12). The operator app
   and the kinfolk portal must never compute "is this paid" independently. That
   divergence is not hypothetical: it is live today, on a real credit, in
   opposite directions.
8. **A fixed-height card must fit its own overflow affordance** (AO-11), or the
   truncation signal gets truncated.
9. **ONE shared load-state component, not per-screen hand-rolling** (AO-13). The
   review's central lesson: Form Schemas already does this perfectly (names the
   failing callable, offers Retry, suppresses the false empty state) while Home
   does none of it. Same repo, same team. The fix is not education, it is a
   single `<AsyncPanel>`-style primitive that makes the right thing the only
   easy thing, and it belongs in A1's package. Error, loading and empty must be
   mutually exclusive BY CONSTRUCTION, because today all three render at once on
   Templates.
10. **Bound the wait** (AO-14). Fifty seconds of skeletons before admitting a
    read failed is worse than the failure. Surface the error when known.
11. **Keep the accessibility tree** (AO-15). The wasm canvas exposes nothing to
    screen readers and cannot be automated by element. React restores both for
    free; do not give that back.

## Next

1. Owner: deploy `functions:mytribe:getMyHome` for O-19? Function-only.
2. O-37 verification still owed (see above): signed-in prod boot + the real
   claim E2E. Deferred by owner to a session where they are at the keyboard.
2. Owner: confirm no live n8n workflow targets writeDraft/getDraft/
   getTrainingDoc, then Phase B deletes them + `N8N_SHARED_SECRET`.
3. Re-run AuntieOS recon against the Documents tree (AO-0) before A1 sizing.
4. O-29 on/after ~07-27.
