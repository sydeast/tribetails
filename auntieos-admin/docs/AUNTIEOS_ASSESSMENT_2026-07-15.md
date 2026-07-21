# AuntieOS full assessment, 2026-07-15

Scope: why issues and UI requests are not landing; live-readiness vs MyTribe;
Twilio Studio configuration; Compose to React conversion; desktop and Android.

Method: five parallel read-only audits, every cited claim re-verified by hand in
this session before it entered this document. Corrections to the audits are noted
inline. Nothing was modified.

---

## 1. Two premises in the request are not supported by the code

### "Android has natural limitations, so some features get locked to web/desktop"

Measured, this runs backwards.

| Capability | Web/wasm | Desktop | Android |
|---|---|---|---|
| PDF generation | server-side callable `generateInvoicePdf` | same callable | same callable (`InvoiceDetailViewModel.kt:294`) |
| Printing | absent | absent | absent |
| CSV export | absent | absent | absent |
| Large tables (`AuntieTable`) | DEAD CODE | dead | DEAD CODE |
| GPS / breadcrumbs / live tracking | n/a | STUBBED | real |
| Calls / audio / camera | n/a | STUBBED | real |

`AuntieTable` is defined at `web/.../ui/components/AuntieTable.kt:34` and
`android/.../ui/components/AuntieTable.kt:34` with **zero call sites in either
tree**. Verified. PDF is generated server-side and consumed as a URL everywhere,
so it is not platform-bound. Printing and CSV do not exist anywhere, so there is
nothing to lock.

Android has **45 screens to web's 34**, 1,148 `@Test`, real `addSnapshotListener`
realtime (20 sites), and native hardware. The only evidence-backed platform split
is Android-only by hardware: GPS, calls, camera. Desktop stubs exactly those.

**Nothing currently needs locking to web/desktop.** If a specific feature does,
name it and it can be checked, but the general premise does not hold.

### "Desktop Firestore and callables are stubbed"

False and stale. Retire this note.

- `jvmMain/.../JvmFirestoreRest.kt:506` real callable over REST with Bearer token
- `:495` real atomic `:commit` batch
- `AuthInterop.jvm.kt:113` real Identity Toolkit sign-in
- ~40 `platform*Stream` actuals hit live REST

The real desktop constraint is architectural, not a stub: `JvmFirestoreRest.kt:61`
sets `POLL_MS = 8_000L`. Firestore's Listen channel needs gRPC, which plain JVM
Ktor cannot do, so desktop reads are 8-second polls. Documented at `:47-49`.

Desktop gap list is 13 items, 8 of which fail loud via `WriteResult.Err` and are
policy-compliant. **One real defect:** `Platform.jvm.kt:3`,
`openInMaps` throws `UnsupportedOperationException("JVM stub")` instead of failing
loud. The comment directly below it records that throwing from these was already
a crash source once.

---

## 2. Why issues and UI requests do not get implemented

Five causes, all verified in source.

### 2.1 Wrong findings get written into the source as comments, which blocks re-discovery permanently

The traced chain, one bug, 44 days, three IDs, still live:

`DenScreenKit.kt:328`
```kotlin
"sit" in s || "house" in s || "overnight" in s -> AuntieStatusTone.Purple
```
`"visit_60"` contains `"sit"`. Every visit paints house-sitting purple.

| Date | Where | Claim |
|---|---|---|
| 06-01 | `docs/2026-06-01-web-audit.md:234` | "falls through to the else branch -> orange". WRONG. |
| (then) | `ScheduleScreen.kt:1102-1104` | the wrong conclusion copied into a doc comment |
| 06-23 | `PUNCHLIST_2026-06-23:230` | re-found, deferred on the strength of the false comment |
| 07-15 | plan doc AO-19 | re-found a third time |

The comment at `ScheduleScreen.kt:1102-1104` reads: *"free-text keys with no match
(e.g. "visit_60") resolve to Orange via [serviceTone]; the legend's "Other /
unmapped" swatch is honest about that."* It is false. A wrong comment answers the
question a reader came to ask, so nobody re-checks. The review process
manufactured its own blindfold.

### 2.2 Status fields are dead, so nothing is provably closed

- `AuntieOS_Fix_Backlog_2026-06-02.md`: 81 items, **81 unchecked, 0 checked**. Its
  own header says the checkboxes "are NOT maintained and do not reflect current
  state" (it also says MOSTLY SHIPPED and redirects elsewhere, so the work may be
  done; it is *uncountable*, not undone).
- `PUNCHLIST_2026-06-23:25` says `☐ B7 ... hard-set and wrong`. Line 227 of the
  same file says `B7 ... CODE-COMPLETE (web)`. One file, two answers.

### 2.3 Every session re-audits from scratch under a fresh ID namespace

Six docs, six schemes, ~335 items logged, no doc maps to its predecessor:
untagged severities (06-01), `[ ]` phases (06-02), `B*/N*/K*` (06-23),
`WARNING-*/NOTE-*` (06-18), `AO-*/O-*` (07-16). AO-19 and the 06-01 `visit_60`
entry are the same defect and share no identifier.

### 2.4 Fixes land per-file, not per-concept

`sortServiceTypesByDuration` is defined at `BookingScreen.kt:708`, called at
`:776`, and **not imported into `ScheduleScreen.kt`**, whose legend at `:255`
passes raw unsorted keys. B9 was closed as "ANDROID PARITY COMPLETE" on 06-24
with Android correct and web still broken. The checkbox could not express that.

AO-12 is the same disease in money: `InvoiceFilters.kt:43` derives paid by
negation and calls itself "Canonical" in the comment at `:42`, while MyTribe's
`invoiceFormat.ts` enumerates states. Two apps, one invoice, opposite answers.

### 2.5 "Deferred on a wrong premise" is indistinguishable from "deferred for cause"

Real external blockers are correctly rare and correctly named (O-33 needs a
physical device, `adb devices` empty; O-29 needs a 14-day quiet window). Since
07-15 every wasm finding is parked by policy as "A8 deletes it anyway". That
triage is defensible and it guarantees the backlog grows and never closes.

### 2.6 The structural cause under all five

**There is no git repo and no CI.** No history, no diff, no cycle time, no gate.
Throughput is not slow, it is unmeasurable. Unmeasurable work silently repeats.
Nothing would have caught item 3.1 below.

**UPDATE 2026-07-15, same day:** the owner reversed the no-git rule and this
tree is now a local repo (initial commit 1,659 files, secrets excluded by a
.gitignore written before the first commit, so no rotation was needed). Two
things this immediately exposed, both instances of the causes above:
- `sotu-hosting/bootstrap-admin.js:21` carried the SAME wholesale-replace claim
  bug as `setAdminClaim`. Fixed in one file on 07-15; it survived in the other.
  That is 2.4 (fixes land per-file, not per-concept) caught in the act.
- `CODE_REVIEW_2026-06-18.md:73` had ALREADY reported the `_workflow_snapshots`
  API-key exposure, correctly and with evidence, 27 days earlier. It was never
  actioned and had to be rediscovered from scratch. That is 2.2 and 2.3.
MyTribe and auntieos-admin still have no repo (see 3.5).

---

## 3. Live blockers

### 3.1 BLOCKER: deploying Firestore rules from the AuntieOS tree breaks the live MyTribe portal

Both trees' `.firebaserc` default to the **same project, `auntieos-ttpc`**. Both
`firebase.json` declare `firestore.rules`.

| | AuntieOS `web/firestore.rules` | MyTribe `firestore.rules` |
|---|---|---|
| Lines | 635 | 643 |
| Modified | 2026-06-22 | 2026-07-13 |

Live (MyTribe): `allow read: if isAuntie() || (isKinfolk() && kinfolkId == request.auth.token.kinfolkId);`
Stale (AuntieOS): `allow read: if isAuntie();`

The July change added the scoped kinfolk read that the portal's Messages
`onSnapshot` listener depends on. `firebase deploy --only firestore` from the
AuntieOS tree reverts it and kills live realtime messaging. No CI exists to catch
this. The memory note "two mirror rules synced" is no longer true.

Fix: one source of truth, or stop deploying firestore from the AuntieOS tree.

### 3.2 BLOCKER: `setAdminClaim` wipes other claims

`web/functions/index.js:93`
```js
await admin.auth().setCustomUserClaims(uid, { admin: isAdmin });
```
Wholesale replace. MyTribe's `lib/kinfolkClaim.ts:26` merges, with the comment
"Preserve any other claim (e.g. admin), never replace wholesale." Same project
means same auth users, so granting admin to a uid holding `kinfolkId` or
`testTribeId` silently destroys it.

### 3.3 BLOCKER (both apps): no send suppression anywhere

`smsChannel.ts:47` sends to the live customer phone. There is **zero `process.env`
in MyTribe's entire `notifications/` subtree**. AuntieOS's `sendMessage` posts to
a hardcoded prod URL (`web/functions/index.js:549`, `N8N_SEND_URL`).

MyTribe's "beta" shares prod Firestore, functions, and Twilio secrets. It is a
second URL, not an environment. A booking on beta texts a real customer today.
Copying that beta into AuntieOS imports the hazard rather than solving it.

Narrowest fix: env-gated check in `lib/twilio.ts` and `lib/email.ts`, the two
chokepoints every send funnels through, plus a distinct env var on non-prod.

### 3.4 BLOCKER for live ops: wasm crash reporting is blind (AO-9)

`reportError` has exactly one call site in the whole tree, in `jvmMain`
(`AuthInterop.jvm.kt:158`). None in commonMain or wasmJs. Kotlin/Wasm exceptions
escape to `window.onerror` and stringify to `[object WebAssembly.Exception]`, so
type, message and frames are all lost. Live evidence: AUNTIEOS-ADMIN-11, 5 events,
2 users, undiagnosable.

### 3.5 Major gaps

- **No CI anywhere, in any repo. CORRECTED 2026-07-15.** This document
  originally credited MyTribe with CI ("lint + build + test on push/PR") and
  listed its absence as an AuntieOS gap. That was wrong, and wrong the same way
  section 2.1 describes: the claim came from reading
  `MyTribe/.github/workflows/functions-ci.yml` without checking it was wired.
  Measured: **`MyTribe/.git` does not exist**, `auntieos-admin/.git` does not
  exist, and there is no repo anywhere above them in `CascadeProjects/`. The
  workflow file has therefore never run and cannot run. As of 2026-07-15 the
  AuntieOS tree is the ONLY git repo of the three, and it is local-only, so
  nothing gates any deploy in any product.
- **Zero rules tests** against a 635-line rules file. No `rules-unit-testing`.
- **`firestore.indexes.json` and `storage.rules` do not exist** anywhere in the
  AuntieOS tree. Indexes are console-managed, undeployable, unreviewable.
- **No structured logging** in AuntieOS functions: 12 raw `console.log/error`
  across 11 exported functions, no requestId correlation.
- **No alerting, uptime checks, or health endpoints in either app.** Nothing pages
  anyone. Shared gap, not a delta.

### 3.6 What is NOT a gap

AuntieOS is **not test-poor**: 2,281 Kotlin `@Test` against MyTribe's 387, plus a
Playwright visual harness. The gaps are rules tests and CI, not volume.

Android has **zero instrumented tests** (`androidTest`), which is the gap that
matters there, because item 5.1 is exactly the bug class unit tests cannot see.

---

## 4. Twilio: not configured for live

### 4.1 The flow cannot run

`studio_flow_v2.json:2`, its own description: *"AUDIO TODO: all 6 assets
(after_hours_greeting, open_hours_greeting, open_hours_retry, gather_intro,
try_text_suggestion, thank_you_vm) require recording + upload to Twilio Assets
before flow goes live."* `twilio-service/assets/` is empty.

### 4.2 Inbound SMS dies silently

`studio_flow_v2.json:8`: `incomingMessage` has no `next`. `incomingCall` does. If
the number's messaging webhook points at this flow, texts vanish with no error.

### 4.3 Deploy footgun: two disjoint trees, one service name

| | `twilio-functions/` | `twilio-service/` |
|---|---|---|
| Functions | 13 (incl. `screen-ui`, `get-token`, `screen-action`, which Android calls) | 4 |
| `notify-recording.js` (flow needs it) | absent | present |
| `assets/` | none | **empty** |
| Deploy config | **none** | `.twilioserverlessrc:5` + `package.json:8` |

Android hardcodes `tribetailsattendant-8587.twil.io` (`CallScreenActivity.kt:36`,
`CallsViewModel.kt:209`, `TwilioApi.kt:7`). Running `twilio-run deploy` from
`twilio-service/` publishes 4 functions and 0 assets to that live service,
deleting the 10 functions Android depends on plus any uploaded audio. The tree
Android depends on is the one with no deploy config.

### 4.4 A2P 10DLC is entirely absent

`grep -rni 'messagingServiceSid|10dlc|a2p'` across both trees and
MyTribe/functions returns **zero hits**. Sends go out as `from: <bare number>`
(`smsChannel.ts:47`, `sendExternalMessage.ts:180`). US carriers filter
unregistered A2P traffic on long codes.

**This is the hardest gate and it is operator-physical:** Twilio console, brand
registration, campaign vetting, a fee, and carrier review time. No code change
unblocks it. This is the one item that fits the CLAUDE.md "external thing the
operator must provide" exception.

### 4.5 Working

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` all present in
GCP Secret Manager, bound to `sendExternalMessage`. Outbound SMS credentials are
complete. Nothing Twilio-side points at n8n.

### 4.6 Other Twilio gaps

- Inbound webhooks (`twilioInbound.ts`) are **deployed but not activated**: the
  three URL env pins are unset, so it derives the URL from `req.hostname`, which
  its own comment at `:120-125` warns drifts and 403s. Until Twilio points at
  them, `calls_log`/`voicemails`/`sms_messages` are written by the Android client
  from spoofable unauthenticated FCM pushes. That is the open WARNING-8 hole, and
  the fix is already shipped and waiting on console config.
- Opt-out state diverges: carrier STOP never writes back into
  `message_suppressions` (`sendExternalMessage.ts:154` acknowledges this).
- `smsChannel.ts:47` sends with no `statusCallback`: notification SMS has zero
  delivery telemetry.
- `notify-voicemail.js:87` returns HTTP 200 on FCM failure, so Twilio never
  retries. A dropped voicemail notification is lost silently. Violates fail-loud.

---

## 5. Android

### 5.1 Tap-swallow bug: confirmed, and the destination is orphaned

`android/.../ui/admin/ScheduleViewScreen.kt:466`
```kotlin
onDateClick     = { date -> viewModel.selectDate(date); viewModel.changeViewMode(CalendarViewMode.DAY) },
onTimeSlotClick = {},
```
The param is declared (`:1287`, `:1341`), threaded (`:1323`), and fired by a real
gesture at `:1402`: `Modifier.clickable { blockedSlots.firstOrNull()?.let(onTimeSlotClick) }`.
That `.clickable` sits **inside** the day cell that already has
`.clickable { onDateClick(date) }` at `:1360`. The child wins the gesture, routes
to an empty lambda, and day navigation never fires. Tapping the "Nblk" strip does
nothing and suppresses day-select.

Compounding, all verified:
- **`TimeSlotManagementDialog` is defined at `:1641` and called from nowhere.**
  The destination the handler should reach has no reachable entry point.
- Zero tests reference `onTimeSlotClick`, `EnhancedMonthView`, `EnhancedDayCell`,
  or `TimeSlotManagementDialog`. With 0 instrumented tests, nothing could catch it.
- `:1389` puts `onBookingClick` on a `Modifier.size(4.dp)` dot, far under the 48dp
  minimum touch target.

Still blocked on one product answer: should the strip select the day, or jump to
the blocked slot? Android is permanent, so this is real work either way.

### 5.2 Second dead handler

`ui/Navigation.kt:224`: `onLoginSuccess = {}`, the sole call site of
`AdminLoginScreen`, which declares the param at `:34` and fires it at `:59`.

### 5.3 Android is otherwise clean

5 `TODO(`, zero `NotImplementedError`, zero `UnsupportedOperationException` in
`src/main`. Cleaner than desktop on that axis. The two `false` feature flags at
`AdminSettingsScreen.kt:125,127` ship behind disclosed banners gated on an
external operator action, which is policy-compliant.

---

## 6. Compose to React

### 6.1 The rebuild is a spike, not a migration in progress

| | Compose (live) | `auntieos-admin` (React) |
|---|---|---|
| Screens | **34** (26,987 LOC) | **0** |
| Callables reachable | 65 | **0** (`grep httpsCallable src/` finds nothing) |
| Platform `expect` surface | 119 (89 in `FirestoreClient.kt`) | 0 |
| `Auntie*` primitives | 37 in `ui/components` | 5 |
| Directories | | `components/`, `lib/`, `styles/`. No `screens/`, no router, no `api/` |

What exists is a disciplined token + primitive spike with 13 test files, zero
product surface, and no server reachability. `firebase.ts` initializes app, auth,
db and functions, then stops.

### 6.2 Sizing

~145 work units, ~50,200 Compose LOC, banded shell -> data -> theme -> primitives
-> screens. `SettingsScreen.kt` (3,380 LOC) and `FirestoreClient.kt` (3,004 LOC)
together are 12.5% of everything and will dominate the schedule.

Dependency root is app shell plus router; nothing else is browser-testable
without it. First honest end-to-end vertical: `FeatureFlagsScreen.kt`, 129 LOC,
two callables.

### 6.3 Three findings that change the plan, not just the estimate

1. **A React port of `web/` buys Android nothing.** There is no `androidMain`
   under `web/composeApp/src` (source sets: `commonMain`, `commonTest`, `jvmMain`,
   `jvmTest`, `wasmJsMain`). Android is a **separate 78,384-LOC hand-written
   tree** with no dependency on `composeApp`. Zero code sharing, zero
   expect/actual. Tri-platform parity today means writing every feature twice, and
   after the port, still twice. **The port does not fix that and is not intended
   to. Decide it separately.**
2. **Lift `MyTribe/web/src/lib/fns.ts` verbatim.** It is the exact React
   equivalent of `platformInvokeCallable`: one typed choke point, 20s timeout,
   `CallableTimeoutError`. And lift `invoiceFormat.ts`. Sharing that module **is
   the AO-12 fix**, not merely reuse. Deriving invoice status twice in two
   languages is how AO-12 happened.
3. **Do not share MyTribe's `api/` layer.** Callable overlap is **3 of 65**.
   MyTribe targets kinfolk-scoped `getMy*`; admin targets a disjoint surface.
   Share `fns.ts` and the formatters under it, nothing above.

### 6.4 A trap for the port

`firebase-bridge.js:247,265,282` calls `triageOrphanReport` **directly, bypassing
`platformInvokeCallable`**. It is a 65th callable invisible to the
"everything routes through one seam" model. A port working from the seam alone
drops it silently.

---

## 7. Verdict

**Status: BLOCK on going live. Not on effort, on four items that make live usage
unsafe or undiagnosable.**

The headline is not that AuntieOS is behind MyTribe. On client tests it is 6x
ahead. The problems are: one live prod collision, one credential-destroying
callable, no send suppression in *either* app, and a primary surface whose crashes
cannot be read.

"Get AuntieOS ready like MyTribe" is the wrong target. MyTribe is live today with
unsolved send-suppression and no alerting. Matching it does not make AuntieOS safe.

### Sequence

**Gate 0, before any other work, none of it optional:**
1. Resolve the rules collision (3.1). One source of truth for `firestore.rules`.
2. Fix `setAdminClaim` to merge (3.2). Four-line change, mirrors
   `kinfolkClaim.ts:26`.
3. Env-gate sends in `lib/twilio.ts` and `lib/email.ts` (3.3). Fixes both apps.
4. git init. Not for hosting. For diff, history, and the ability to answer "did we
   already do this?" This is the root cause under section 2, and it is the
   cheapest item on this list.

**Gate 1, make the work countable:**
5. One backlog, one ID namespace, reconciled against the six existing docs.
   ~335 items logged, true open count currently unmeasurable.
6. Delete the false comment at `ScheduleScreen.kt:1102-1104` and fix
   `DenScreenKit.kt:328`. Then audit for other confidently-wrong comments, because
   that pattern is the single highest-leverage cause in section 2.
7. CI: lint, build, test, and a rules-deploy guard. Nothing would have caught 3.1.

**Gate 2, parallel tracks:**
- **Twilio:** operator registers A2P 10DLC (long lead, start now, blocks nothing
  else). Merge the two serverless trees before anyone runs a deploy. Record the 6
  audio assets. Activate the inbound webhooks and close WARNING-8.
- **Observability:** wire `reportError` from commonMain (AO-9). Without it the
  React cutover is flying blind on both sides.
- **React port:** band A (shell, router, auth) then band B-1 (`fns.ts`). Do not
  start screens before the data layer contract exists.

**Deferred, needs an owner answer, not engineering:**
- Android tap-swallow (5.1): should the "Nblk" strip select the day or open the
  slot?
- Android/web duplication (6.3.1): two hand-written trees, ~130K LOC total,
  permanent double-write. The React port makes this concrete rather than causing
  it.
- Whether any feature actually needs locking to web/desktop. Current evidence:
  none does.

### Only true external blocker

**A2P 10DLC brand and campaign registration.** Twilio console, operator identity,
a fee, carrier review. Everything else on this list is buildable.
