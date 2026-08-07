# MyTribe Development Plan — 2026-07-10

Goal: replace the vendor with a portal kinfolk love, via Claude Code sessions using a
mixture of Sonnet 5, Opus 4.8, and Fable 5 at High+ effort. Grounded in the full
backlog inventory (ISSUES.md, 1on1 decisions D1-D17, wrapups, EVENT/TRANSACTION docs,
TODO sweep) and the pre-GitHub hygiene audit (both 2026-07-10).

## Current state (verified)

- Compose web app: functionally fixed + deployed (all July-9/10 blockers closed);
  visually condemned; retires at cutover (O-2).
- React portal `web/`: Phase 1 + 2a live at https://mytribe-kinfolk-beta.web.app
  (auth screens, claim flow, PWA, Home/Schedule/Kin/Kin-detail with real data
  + live GPS map, 185KB gz, 69 tests). CORS + Auth domains wired.
- Backend: healthy, ~120 functions, minInstances live on the 5 hot paths.
- Distribution decision: installable PWA; no app stores. Desktop Compose apps stay
  (owner-personal). Android Compose retires if the PWA proves out.

## Model doctrine

| Model | Use for | Why |
|---|---|---|
| Sonnet 5 (High) | Bulk mechanical work: mockup→React screen ports, test writing, doc scrubs, gitignore/cleanup execution, seed edits | Cheapest per token, excellent at pattern-following with a strong spec; screens have the mockup HTML as the spec |
| Opus 4.8 (High) | Integration + judgment work: booking wizard, payments, claim/auth edges, backend deltas (receipts, sanitization, signed uploads), debugging, session orchestration | Strong reasoning at moderate cost; the "default driver" |
| Fable 5 (High/XHigh) | Adversarial review gates, security rulings (O-6 operator model, App Check design), cutover go/no-go, anything irreversible | Strongest model reserved for the moments that decide correctness or can't be redone |

Pattern per session: Opus 4.8 drives the session; fans bulk work to Sonnet 5
subagents; calls a Fable 5 review pass before anything ships or merges.

## Sessions

### S1 — Repo hygiene + Git hosting (Sonnet 5 High, ~1 session)
The audit produced exact lists; this is execution, not judgment.
1. Rotate the sandbox password (it is in a script + chat logs). Parametrize
   `scripts/qa_*.js` (env/argv; no hardcoded uid/pw), or delete.
2. Apply the proposed root .gitignore; delete: root `node_modules/`, debug logs,
   `.DS_Store`s, move `backups/` + `scripts/backups/` data exports out of tree.
3. Confirm stripe test fixtures are fake; keep `functions/.env` local.
4. `git init`, initial commit, push **private** repo (monorepo as-is: src/ +
   functions/ + web/ + scripts/ + seeds/ + docs/ + rules). AuntieOS = separate
   peer repo. Document the firestore.rules → sotu-hosting sync convention in README.
5. Branch protection + CI later (S7).
Gate: Fable 5 secrets re-scan of the exact tree before the first push.

### S2 — Portal Phase 2a: read screens I (Sonnet 5 bulk + Opus 4.8 driver)
Home (real data), Schedule (+ live map via breadcrumbs listener), Kin list + detail.
Mockups are the spec; PortalApi.kt + functions/src are the contract. Each screen:
port mockup HTML → components, wire callables, vitest for mappers, visual check
against mockup side-by-side. Parallel Sonnet agents per screen, Opus integrates.

### S3 — Portal Phase 2b: read screens II (same pattern)
KinTales (feature banner + gallery grid + comments), Invoices + detail (document
layout + line items), Notifications, Tribe hub + profile, Account. TribePicker +
operator path. Gate: Fable 5 UX review vs mockups (the "does it feel fancy" gate).

### S4 — Backend deltas for rich features (Opus 4.8)
Before Phase 3 needs them: sanitized rich-text subset on messages/comments
(sanitize-html beside zod), per-message deliveredAt/readAt + markThreadRead +
smtp2go/Twilio delivery events (verified communications), signed direct-to-Cloudinary
uploads for kin/tale media (kills 2MB base64 cap), KinTale reactions pipeline.
Also close cheap backlog: O-5 setActiveTribe claim re-mint, O-11 Cloudinary secrets
verify + logoUrl. Gate: Fable 5 review of the sanitization + receipts design
(XSS + privacy surface).

### S5 — Portal Phase 3: write surfaces (Opus 4.8 driver, Sonnet bulk)
Booking wizard (desktop layout per mockup: stepper lines, 3-col service grid,
price rail, real date/month labels — fixes F35/F36 by construction), Messages with
TipTap, pay flow (Stripe Checkout redirect), uploads UI, web push (FCM), public
shared-tale page + OG tags. E2E pass on beta with the sandbox account.

### S6 — Security + platform debt (Opus 4.8 + Fable 5 ruling)
O-3 App Check (design ruling: providers per platform, enforcement order,
grace mode) — Fable 5 designs, Opus implements. O-6 operator-trust ruling
(server-side kinfolkId re-derivation). O-7 updateBillingDetails if wanted pre-cutover.
O-14 leftovers triage (widgets, invoice.overdue, dormant assignment keys).

### S7 — Cutover (Fable 5 gate)
Beta → kinfolk.tribetails.com: side-by-side smoke campaign (reuse the checklist),
flip hosting target, keep Compose build tagged for rollback, decommission plan for
src/jsMain (O-2) executed only after a quiet week. Add CI (build + vitest + functions
tests on PR) once on GitHub. Invite/claim onboarding E2E happens HERE at the latest —
it is the only untested door real kinfolk walk through.

### S8+ — Post-cutover
AuntieOS admin on the same stack (its own repo, shared primitives package).
**Android is permanent** (owner decision 2026-07-10): the Compose Android app
stays first-class — it inherits the design-gap audit's fixable list (shadows,
hover/press states, TribePicker rebuild, wizard desktop layouts) as its polish
roadmap, and every backend delta (rich text, receipts, reactions, signed
uploads) ships an Android slice per the covenant. **iOS eventually** (not soon):
Kotlin Multiplatform's iOS target is the natural path — commonMain carries over,
which is a standing reason to keep the KMP codebase healthy. Push notifications
are a top kinfolk ask: FCM Android is the reliable channel (verify end-to-end
delivery on a real device — O-16); web push lands in S5 for the portal/PWA;
iOS push (APNs) arrives with the iOS app. Compose desktop stays as-is for the
owner. Engagement features (reactions UI, photo digest email).

## Session protocol (every Claude Code session)

### Begin-of-session prompt (paste to start)

```
Session <ID> of the MyTribe plan (docs/DEVELOPMENT_PLAN_2026-07-10.md).
Scope this session: <paste the session's scope line from the plan>.

Ground rules:
- Read the plan doc + memory first; confirm scope back in one line before coding.
- Call the advisor tool (if available this session) before committing to an
  approach and before declaring done.
- Track work with the task tools; one task per vertical slice.
- Test account: test-admin+sandbox@tribetails.test / Sandbox-Tribe-2026 on
  https://mytribe-kinfolk-beta.web.app (new portal) and
  https://kinfolk.tribetails.com (legacy). Re-run seed_test_sandbox.ts --apply
  if state drifted.
- Fix any issue you uncover in scope-adjacent code as part of the slice; log
  out-of-scope findings to the plan doc's Open Items instead of drifting.

## NON-NEGOTIABLE: FULLSTACK OR IT'S NOT DONE
Backend IS in scope and IS reachable. The MyTribe Cloud Functions repo
(/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/) and the
AuntieOS repos are all available to you. You created them.

A feature is DONE only as a full vertical slice:
Cloud Function (in MyTribe/functions) + validation + frontend wiring + routes +
component + error handling + tests (unit, integration, e2e, happy + sad +
negative + error) on web AND android*.

A missing callable means BUILD the callable. It is NEVER a reason to stop,
defer, or ship frontend-only.

There is NO "gate dark / Not wired banner" option for our own code. The ONLY
thing you may ever defer is something that needs an external secret the operator
must physically provide (third-party OAuth client IDs, calendar provider keys) —
and for those you STOP and name the exact secret you need. Nothing else.

Do not invent repo/scope blockers. If you think something is blocked, the
default is wrong: re-check, then build it.

*"web AND android" = the React portal (web/) AND the Compose Android app,
unconditionally — owner decision 2026-07-10: Android is permanent, iOS comes
eventually, mobile apps are a must (push notifications were a top kinfolk ask).
Desktop (jvm) is owner-personal and exempt from the slice requirement unless
the session's scope names it.
```

### End-of-day wrapup prompt (paste at the end of the working day)

```
End-of-day wrapup. Before writing anything, verify:
1. Run every affected test suite (functions vitest, web vitest + build,
   ./gradlew jvmTest + compileKotlinJs if Kotlin touched). Real counts only.
2. Drive today's changed flows live on the beta (and legacy app if touched) as
   the sandbox kinfolk — evidence, not just green tests.
3. Anything uncovered during verification: FIX NOW if in today's scope, else
   log it to Open Items with an O-number. No silent drops.
4. Deploy what's shippable; confirm live. Call the advisor if available.

Then write the wrapup in three places (plan doc "Daily Log" section, memory,
and your reply to me), structured exactly as:

## <date> Wrapup
**COMPLETED (verified):** each vertical slice finished today, one line each,
with its evidence (test count / live check / deploy).
**IN PROGRESS:** started but not done — current state, exact next step, and
which files are mid-change.
**STILL NEEDS DOING:** the remaining plan items for the current session +
anything new logged today (O-numbers), ranked by what tomorrow should start with.
**BLOCKED:** only items awaiting something from ME (a secret, a decision, a
manual step) — name exactly what you need. Nothing else counts as blocked.
**TOMORROW STARTS WITH:** one line.
```

## AI integration decisions (for the `generate` callable, O-8)

- **API key**: store in Firebase Secret Manager, never in files:
  `npx firebase functions:secrets:set ANTHROPIC_API_KEY --project auntieos-ttpc`
  Gen2 functions list it in `secrets: [...]` like SMTP2GO_API_KEY.
- **Model**: `claude-opus-4-8` via the official TS SDK (`@anthropic-ai/sdk`),
  adaptive thinking, streaming for long outputs.
- **Prompt caching**: stable system prompt (brand voice + copy rules) first with
  `cache_control: {type: "ephemeral"}`; volatile inputs (kin names, visit data)
  after the breakpoint. Verify hits via `usage.cache_read_input_tokens`. Note
  the 4096-token minimum cacheable prefix on Opus 4.8 — pad the system prompt
  with the full style guide, which we want anyway.
- **Batch API**: use `client.messages.batches.create()` (50% price) for bulk
  jobs: reseeding notification templates, weekly digest copy, backfilling tale
  titles. Not for interactive requests.
- **Advisor tool (two distinct things)**:
  1. The Claude Code *session* advisor is a harness feature — when the harness
     offers it, sessions must use it (baked into the begin/end prompts). It is
     not something we can enable from the repo; if it reports unavailable,
     proceed without it.
  2. The *API* advisor tool (`advisor_20260301`, beta `advisor-tool-2026-03-01`)
     pairs a cheap executor with an Opus advisor server-side. Adopt it inside
     the `generate` callable if we route bulk copy through Sonnet/Haiku:
     executor `claude-haiku-4-5` or `claude-sonnet-5` + advisor
     `claude-opus-4-8`.
- Claude Code sessions themselves already use prompt caching automatically;
  the Batch API does not apply to interactive sessions.

## Standing rules

- Every session ends with: tests green, deploy (if shippable), findings appended to
  docs/ , memory updated. No silent scope growth.
- Fable 5 is a gate, not a driver: review passes and rulings only, keeps cost sane.
- The sandbox account (test-kinfolk-001) is the E2E fixture; re-seed script is
  idempotent — run it whenever state drifts.
- Open items registry: O-1..O-15 in the 2026-07-10 inventory (agent report,
  docs/ or session log). O-8 (AI copy gen) blocked on an Anthropic API key from owner.
- Payments (real charge) stay excluded from automated E2E; manual verify at cutover.

## Immediate next actions (updated 2026-07-10 evening)

1. Git hosting DEFERRED by owner until the app is in a better state — S1's
   hygiene items still apply pre-push; sandbox password stays `Sandbox-Tribe-2026`
   for testing until the pre-push rotation.
2. Owner: set the Anthropic key when ready:
   `npx firebase functions:secrets:set ANTHROPIC_API_KEY --project auntieos-ttpc`
3. Owner tries the beta on a phone: https://mytribe-kinfolk-beta.web.app
   (Home/Schedule/Kin/Kin-detail now live with real data as of S2, 2026-07-10)
4. Next session = S3 (portal read screens II) using the Session Protocol above.

## Daily Log

### 2026-07-09/10 Wrapup
**COMPLETED (verified):** Legacy app: all QA blockers fixed + deployed + verified
live (service catalog reads serviceRates, nav wedge fix, sign-in retry guard,
message send-error split, kin_care_sessions index, minInstances on 5 hot fns,
copy/glyph/UX fixes; booking verified end-to-end: 30 Minute $25 Jul 20 REQUESTED).
Sandbox re-seeded correct shapes (29 docs). 10 real families provisioned + 20
pets adopted; onKinfolkCreate trigger live. React portal Phase 1 built + deployed:
https://mytribe-kinfolk-beta.web.app (147KB gz, 26 tests, auth screens, claim
flow, PWA + add-to-home-screen). Tech decision memo + QA report artifacts.
**IN PROGRESS:** none mid-change; tree clean, all suites green (functions 1281,
web 26, jvmTest 335).
**STILL NEEDS DOING:** S2/S3 portal read screens (11 mockups), S4 backend deltas
(rich text, receipts, signed uploads, reactions), S5 write surfaces (wizard,
TipTap, pay, push), S6 App Check + operator ruling, S7 cutover + invite/claim
E2E, F35/F36 booking date UX (fixed by construction in S5), pre-push hygiene.
**BLOCKED:** ANTHROPIC_API_KEY (owner sets via firebase functions:secrets:set)
for O-8 copy gen. Nothing else.
**NEW OPEN ITEM:** O-16 — verify FCM push delivers end-to-end on a real Android
device (token registration -> notification tap -> deep link), and document the
kinfolk-facing APK install path (no Play Store): download link + install
walkthrough simple enough for elderly kinfolk. Push = top kinfolk ask.
**TOMORROW STARTS WITH:** S2 — Home, Schedule + live map, Kin list + detail on
the React portal, mockups as spec, Session Protocol begin prompt.

### 2026-07-10 S2 Wrapup
**COMPLETED (verified):** Portal Phase 2a shipped on the React portal — Home
(real data: live-visit banner from getMyBookings.liveVisit, Up Next, Recent
KinTales, kin roster preview), Schedule (Upcoming/Past tabs, live-visit gate
on getMyVisits' AuntieOS "ARRIVED" status matching ScheduleScreen.kt exactly,
live breadcrumbs map via a realtime Firestore listener on
`kin_care_sessions/{sessionId}/breadcrumbs`, per-visit "Visit Replays" GPS
route rendering), Kin list + Kin Detail (incl. the memorial toggle wired to
the existing `archiveKin` callable, with a confirm step). New lib code:
`routeMap.ts` (RouteMap.kt's bounding-box/haversine math ported verbatim to
SVG, 20 tests), `portalFormat.ts` (24 formatting helpers, tests),
`breadcrumbs.ts` (Firestore `onSnapshot` listener + hook). New components:
`RouteMap.tsx`, `PortalNav.tsx` (shared nav/mobile-tabbar, replacing the
Phase-1 placeholder nav). 4 new typed API wrappers (getMyBookings,
getMyVisits, getMyKin, getMyKinTales) + archiveKin mutation in api/types.ts +
api/portal.ts. Router wired (/schedule, /kin, /kin/$kinId, auth-gated). web
vitest 69/69 green, tsc clean, build 185KB gz (up from 147KB — Firestore SDK
+ 4 screens). Verified live end-to-end on the beta
(https://mytribe-kinfolk-beta.web.app) signed in as the sandbox kinfolk: all
4 screens with real data, GPS replay rendering a real 1.8km/29m/4-ping route,
archiveKin mutation exercised live (marked Sandbox Dog "no longer with us"
then restored), both desktop and mobile viewports.
Two real bugs found + fixed during live verification (not just unit tests):
(1) getMyBookings/getMyVisits/getMyKin/getMyKinTales/archiveKin were failing
silently on the beta origin — CORS, the deployed function code predated
`mytribe-kinfolk-beta.web.app` being added to `TRIBETAILS_CORS` in
functions/src/lib/cors.ts. Redeployed those 5 functions (owner-approved) to
pick up current source; no logic changes. (2) `.kinrow`/`.petcard` became
`<Link>` elements for navigation but base.css/kin.css never reset anchor
defaults (the mockups used `<button>` for these), so kin names rendered
blue/underlined — added `text-decoration:none; color:inherit`.
**IN PROGRESS:** none, tree clean (no git repo yet — S1 hosting still
deferred by owner per Immediate Next Actions above).
**STILL NEEDS DOING:** S3 (KinTales full screen, Invoices + detail,
Notifications, Tribe hub + profile, Account, TribePicker + operator path —
today's nav intentionally renders these as inert labels, not dead links),
S4 backend deltas, S5 write surfaces (booking wizard's "Request a Booking"
CTA is inert this session — no wizard yet), S6 App Check + operator ruling,
S7 cutover.
**BLOCKED:** ANTHROPIC_API_KEY still open (O-8, unrelated to this session).
Nothing new blocked.
**NEW OPEN ITEMS:**
O-17 — Kin edit has no mockup yet (no mytribe-kin-edit-*.html in ui-ideas/);
the Edit button on Kin Detail is present but inert until a mockup/spec exists.
O-18 — web bundle is 185KB gz (was 147KB); consider code-splitting
(dynamic import per route) before S3 adds KinTales/Invoices/Notifications —
not urgent yet but will compound.
O-19 — `getMyHome`'s currentVisit/upcomingBookings/recentBookings fields are
permanently stubbed (typed `null`/`never[]`) and Home now gets that data from
getMyBookings/getMyKinTales/getMyKin instead — worth removing the dead
fields from the callable + GetMyHomeResult type in a later cleanup pass
rather than carrying stub fields nothing reads.
**TOMORROW STARTS WITH:** S3 — KinTales full screen (feature banner +
gallery grid + comments), Invoices + detail, Notifications, Tribe hub +
profile, Account, TribePicker + operator path. Fable 5 UX review vs mockups
per plan (the "does it feel fancy" gate).

### 2026-07-11 S3 Wrapup
**COMPLETED (verified):** Portal Phase 2b shipped — all 6 remaining screens
live on the beta (https://mytribe-kinfolk-beta.web.app) as the sandbox
kinfolk: KinTales full screen (`/kintales`: feature banner, filter tabs,
on-demand photo gallery via getMyKinTaleMedia, comment thread + reply
threading via getKinTaleComments/addKinTaleComment — no reactions, correctly
out of scope for S4), Invoices + detail (`/invoices`, `/invoices/$invoiceId`:
open/paid/credits sections, PDF download, Stripe Checkout pay flow wired
(not manually charged, per standing payments-excluded-from-automated-E2E
rule), credit redemption), Notification Settings (`/account/notifications`:
category master switches + per-channel toggles driven live by
getNotificationCatalog, correctly identified as a prefs screen not a feed —
no feed callable exists or was built, none needed), Tribe hub + Profile
editor (`/tribe`, `/tribe/edit`: read-only dashboard + schema-driven edit
surface incl. household members, vet clinic, home access, Mapbox address
search), Account (`/account`: profile, avatar upload, recovery contact,
billing status), and the multi-tribe TribePicker/NoTribes/operator-path
infra (`lib/activeTribe.ts`, `/pick`, `/no-tribes`) that Kotlin's
`resolveLaunchDestination` was ported from verbatim, unit-tested (9 cases).
All 6 screens were built as parallel Sonnet subagents in isolated new files
(no shared-file edits) specifically to avoid merge conflicts, then hand-
integrated: router.tsx (7 new routes), PortalNav.tsx (fixed "Tribe" to point
at the hub not `/kin`, added a real `account` tab, wired KinTales/Invoices
links that were inert since S2), main.tsx (5 new stylesheets). web vitest
150/150 green (44 new), tsc clean, build 204KB gz (up from 185KB, tracked
under O-18).
Two real production bugs found + fixed during live verification, not caught
by any test: (1) KinTales' comment-post mutation swallowed errors silently
(`post.isError` was never wired to the UI) — fixed, now surfaces a real
message. (2) **Infra: `addKinTaleComment`, `getKinTaleComments`, and
`getMyAccount` were all wedged** — calls hung indefinitely (no success, no
failure, nothing in Cloud Functions logs, no Firestore write, no client
error) despite CORS/auth/code all being correct. Confirmed via direct
Firestore reads that writes never landed, and via a completely fresh
tab+sign-in that it wasn't a stale-service-worker artifact from my own
mid-session redeploys. A same-source redeploy of the individual functions
cleared each one instantly; when a third function hit the identical
signature the owner authorized a full `firebase deploy --only functions`
(clean, all ~90 functions updated, some retried past a
`cloudfunctions.googleapis.com` per-minute mutation-quota 429 but every one
eventually succeeded) which resolved it project-wide — Account, Notification
Settings, and the KinTale photo gallery (previously showing "Photos no
longer available — they may have expired", also just this bug, not real
expiry) all confirmed working after.
**IN PROGRESS:** none, tree clean.
**STILL NEEDS DOING:** S4 backend deltas (rich text, receipts, signed
uploads, KinTale reactions), S5 write surfaces (booking wizard, TipTap
messages, live pay-flow verification, web push), S6 App Check + operator
ruling, S7 cutover. Fable 5 UX review vs mockups (the "does it feel fancy"
gate) was not run this session — flagged as still open, see below.
**BLOCKED:** ANTHROPIC_API_KEY still open (O-8). Nothing new blocked.
**NEW OPEN ITEMS:**
O-20 — **P0 infra reliability, investigate before S7 cutover.** Multiple
Cloud Functions (confirmed: `addKinTaleComment`, `getKinTaleComments`,
`getMyAccount`; likely more, untested) intermittently hang forever on cold
start with zero error signal anywhere (client, Cloud Functions logs, or
Firestore) — a redeploy always clears it, but the underlying cause (Cloud
Run revision health, minInstances gap, or the observed
`cloudfunctions.googleapis.com` per-project mutation-quota 429 from
07-09/07-11 deploys) was never root-caused. This is a silent-hang failure
mode, worse than a clean error — a real kinfolk would see an infinite
spinner with no explanation. Needs a dedicated investigation (Cloud Run
revision/instance metrics, whether minInstances should extend past the
current 5 hot paths) before cutover traffic depends on cold paths.
O-21 — TribePicker + operator path is unit-tested (`activeTribe.test.ts`,
9 cases mirroring Kotlin's `resolveLaunchDestination`) and code-reviewed,
but NOT live-verified end-to-end — the sandbox test account is not in
`AUNTIE_OPERATOR_UIDS`, so the picker/multi-tribe/"Back to Directory" flow
never actually rendered live this session. Needs either a second seeded
operator test account or a temporary env addition to verify live before S7.
O-22 — Fable 5 UX review vs mockups ("does it feel fancy") from the S3 plan
gate was not run this session (ran out of session budget after the infra
firefight above). Should run before S4 builds further on top of these 6
screens.
**TOMORROW STARTS WITH:** Either O-20 (infra reliability root-cause) or
resuming S4 backend deltas per plan — owner's call given O-20's cutover
risk.

### 2026-07-12/13 O-20 Investigation Wrapup
**COMPLETED (verified):** Root-caused as far as forensic evidence allows,
and closed the failure *mode* regardless of exact mechanism. Pulled full
Cloud Logging history (`resource.type="cloud_run_revision"`) for the three
services that hung on 07-11 — `addKinTaleComment`, `getKinTaleComments`,
`getMyAccount` — across the **entire lifetime of the pre-fix revision**
(2+ days each, not just the hang window). Finding: every single invocation
attempt on those revisions completed a successful CORS preflight (OPTIONS,
204, correct `access-control-allow-*` headers) but **the follow-up POST was
never once logged at Cloud Run** — 0 POSTs across 26 combined attempts.
Control-group comparison (`getMyKin`, `getMyVisits` — also cold, no
`minInstances`, same client code path, same `TRIBETAILS_CORS` config) shows
the normal 1:1 OPTIONS:POST ratio over the same period, ruling out
cold-start-alone as sufficient explanation. Also ruled out: the
previously-suspected `cloudfunctions.googleapis.com` mutation-quota 429
(that quota gates the *deploy* API, not runtime invocation; all revisions
show `Ready:True` throughout, deploys ultimately succeeded, no correlation
to the hang mechanism); CORS header mismatch (preflight response headers
on the broken services are byte-identical to the working control group);
a wedged/unhealthy Cloud Run revision (revision list shows clean deploy
history, no crash-loop signal). The client-side call path is identical
across every callable (`web/src/lib/fns.ts`'s `call()` is the single choke
point for all ~33 live-wired callables), so nothing in portal code
differentiates these 3 from the working ones either. Net: the evidence
narrows this to something in the client→network POST-dispatch boundary
specific to those revisions, self-resolving on redeploy — the exact final
trigger is not reproducible on demand (state has since changed) and is not
fully pinned to one mechanism.
Given that ceiling, shipped the fix that matters regardless of root cause:
(1) `web/src/lib/fns.ts` — `call()` now passes an explicit 20s
`timeout` to `httpsCallable` (was the SDK's 70s default) and converts a
`functions/deadline-exceeded` rejection into a named `CallableTimeoutError`
so every one of the ~33 live callables fails loud and retryable within 20s
instead of spinning forever with zero signal — this closes O-20's actual
harm ("worse than a clean error") even on a future recurrence with an
unknown cause. 4 new tests (`fns.test.ts`), web vitest 154/154 green, tsc
clean. (2) `functions/src/portal/{account.ts,getKinTaleComments.ts,
kinTaleEngagement.ts}` — added `minInstances: 1` to the exact 3 functions
that broke (`getMyAccount`, `getKinTaleComments`, `addKinTaleComment`),
removing cold-start as a variable for them specifically, matching the
existing "5 hot paths" precedent. functions vitest 1281/1281 green, tsc
clean. Deployed both (owner-approved, including Firebase CLI's `--force`
for the minInstances billing-increase confirmation) — functions:
getKinTaleComments, getMyAccount, addKinTaleComment; hosting: mytribe_beta.
**IN PROGRESS:** none, tree clean.
**STILL NEEDS DOING:** S4 backend deltas (rich text, receipts, signed
uploads, KinTale reactions), S5 write surfaces, S6 App Check + operator
ruling, S7 cutover, O-21 (TribePicker/operator path never live-rendered),
O-22 (Fable 5 UX review gate still not run).
**BLOCKED:** ANTHROPIC_API_KEY still open (O-8). Nothing new blocked.
**NEW OPEN ITEM:**
O-23 — the other ~26 live-wired portal callables (everything in
`web/src/api/*.ts` besides the now-5 warm ones: `getMyAccess`, `getMyHome`,
`getMyBookings`, `getMyKinTales`, plus the 3 just added) still run cold.
The `call()` timeout fix means a hang on any of them now fails loud in 20s
instead of forever, but doesn't prevent the underlying cold-start/dispatch
issue from recurring on a different endpoint. Blanket `minInstances: 1`
across all ~29 would remove cold-start entirely as a variable but is a
real recurring cost (each is an always-on Cloud Run instance) — this is an
owner cost/risk call, not something to decide silently, especially given
the standing "cut the $20/mo vendor cost" pressure. Revisit before S7
cutover: either warm the full write-surface set, or accept that the 20s
timeout is the load-bearing safety net.
**TOMORROW STARTS WITH:** Owner's call — S4 backend deltas per plan, or
O-23 (decide the warm-instance footprint before cutover).

### 2026-07-13 S4 slice 1: sanitized rich-text
**COMPLETED (verified):** `sanitize-html` wired at every free-text write path
that persists content another user later renders: `appendMessage` (single
choke point for `sendKinfolkMessage` + `replyToConversation`), `addKinTaleComment`,
the unauthenticated `addGuestKinTaleComment` (body + guestName), `addBookingNote`,
`addInternalBookingNote`, `submitRating`'s comment field, and Twilio inbound
SMS/voicemail (`twilioInbound.ts`). New shared helper `functions/src/lib/richText.ts`
(`sanitizeRichText`/`sanitizePlainText`/`toPlainTextPreview`). Ran a Fable-5-model
adversarial XSS/privacy review (the plan's required gate) before shipping — it
caught a real regression: sanitize-html HTML-entity-encodes ALL text content
(even with zero tags present), which would have silently corrupted ordinary
messages/comments containing "&"/"<"/">" for both live plain-text renderers
(web KinTales, Android KinTales + Messages). Fixed with a post-sanitize entity
decode, verified safe against re-parsing (sanitize-html's parser never treats
source-level entities as live markup, so decoding can't resurrect a stripped
tag) — 4 more findings fixed same pass: guestName restricted to plain text
(was allowing live links in a guest-submitted name), previews/notification
text now strip tags instead of raw-slicing (`toPlainTextPreview`), missed
paths (`submitRating`, Twilio inbound) sanitized, protocol-relative hrefs
blocked, post-sanitize length re-capped. 1309/1309 functions tests green
(29 new), tsc clean, no web/Android client changes needed (both already
render plain text; this is backend-only prep for S5's TipTap work). Deployed
(9 functions) + live-verified on beta KinTales as the sandbox kinfolk: posted
`Fed Rex & gave water <script>alert(1)</script>5 < 10 test`, rendered as
`Fed Rex & gave water 5 < 10 test` — correct plain-text display, script fully
neutralized.
**STILL NEEDS DOING (S4):** signed Cloudinary uploads, KinTale reactions,
O-5 (setActiveTribe claim re-mint), O-11 (Cloudinary secrets + logoUrl).

### 2026-07-13 S4 slice 2: delivery receipts
**COMPLETED (verified):** Per-message `deliveredAt`/`readAt` fields on
`conversations/{kinfolkId}/messages/{id}` (`functions/src/lib/conversations.ts`:
`appendMessage` stamps `deliveredAt: now, readAt: null` on write — a direct
Firestore write is delivered synchronously, so there's no separate
"delivered" transport state to track the way email/SMS has one; `readAt` is
the real state that moves). New `markMessagesRead(kinfolkId, readerRole)`
lib function: batch-stamps `readAt` on every unread message from the OTHER
side and clears the reader's own thread-level unread flag, idempotent,
bounded to 500 writes/call (Firestore's batch cap). Wired into
`getMyConversationHandler` (portal, replacing its old inline flag-only
clear) and `getConversationThreadHandler`/`markConversationReadHandler`
(admin, same). New portal callable **`markThreadRead`** (deployed as a new
function) — explicit mark-read for a thread already loaded client-side
(e.g. after a realtime listener delivers a new message), avoiding a full
refetch just to stamp `readAt`.
Investigated smtp2go/Twilio delivery-status webhooks (`smtp2goEventWebhook`,
`twilioStatusCallback` in `functions/src/admin/engagementWebhooks.ts`) —
confirmed via full read that these already exist and already do
delivered/bounced/opened tracking, but exclusively for `external_messages`
(business broadcast/transactional email+SMS). The kinfolk↔auntie chat this
slice extends is Firestore-only with no email/SMS channel — there is
nothing for those webhooks to correlate a chat message against. No new
webhook work was needed; this half of the plan's S4 line item was already
shipped by an earlier session.
Android (Messages screen is live there, unlike web which has no Messages
UI yet — that's S5's TipTap build): `ConversationDtos.kt`'s
`ConversationMessage` carries `deliveredAt`/`readAt`; `PortalApi.kt` decodes
both + adds `markThreadRead()`; `MessageAuntieScreen.kt`'s message bubble
shows "Sent"/"Seen" under the kinfolk's own outgoing messages (mainstream
chat-app read-receipt pattern, only on `mine` bubbles — a kinfolk always
knows they've read the auntie's side just by viewing the screen, so a
receipt there would be redundant). 3 new PortalApi tests. `./gradlew
jvmTest` 338/338 green (up from 335), `compileKotlinJs` clean.
Web: no changes — no Messages screen exists in `web/src` at all yet
(intentionally deferred to S5 per the plan), so there's no plain-text
render site whose read-state display could regress; S5 builds it fresh
against this now-ready backend.
Found + fixed a real gap in the test mock while adding coverage:
`test/_helpers/mockDb.ts`'s `.collection(path).where(...).get()` path
didn't attach `.ref` to returned query docs (only the separate
`collectionGroup` mock did), so any future `.where().get()` → batch-update
pattern would have silently broken in tests. Fixed once, in the shared
helper — also learned the mock's `.where()` is a pure pass-through (no
real filtering), so tests against it must pre-filter their `queryDocs`
fixtures to what a real Firestore query would already have returned.
1315/1315 functions tests green, tsc clean. Deployed (7 functions, one new)
+ confirmed live via `firebase deploy` success output; no browser-drivable
UI surface exists yet to click-through-verify (chat has no web screen), so
verification here is test coverage + typecheck, not a live UI walkthrough.
**STILL NEEDS DOING (S4):** signed Cloudinary uploads, KinTale reactions,
O-5 (setActiveTribe claim re-mint), O-11 (Cloudinary secrets + logoUrl).

### 2026-07-13 O-11 + S4 slice 3: Cloudinary secrets verified, signed kin-photo uploads
**O-11 closed (partial):** confirmed the 3 `CLOUDINARY_*` secrets exist,
are `ENABLED` in Secret Manager, and are actually bound to the live
`signKinfolkAvatar` Cloud Run service (`gcloud run services describe`) —
the plan had flagged this as unverified, it's now confirmed live.
`logoUrl` sub-item: confirmed `business_settings.mytribePortal.logoUrl` is
genuinely `""` (empty) in Firestore — real gap, but there's no admin UI to
set it anywhere in the codebase and no source for an actual Tribe Tails
logo asset, so this is flagged rather than fabricated. **New open item
O-24**: owner needs to either supply a logo image + we build a minimal
admin upload flow for it, or explicitly decide the portal ships without a
custom logo.
**Signed kin-photo uploads (kills the 2MB base64 cap):** replaced
`uploadKinPhoto` (base64 through a callable, 2MB Firebase-payload-driven
cap, wrote to Firebase Storage) — deleted entirely, including its test
file — with a signed direct-to-Cloudinary flow mirroring the existing
`signKinfolkAvatar` pattern: new `signKinPhotoUpload` (kin_edit-gated,
folder-scoped to `tribetails/kinfolks/{kinfolkId}/kin/{kinId}`) +
`confirmKinPhotoUpload` (re-checks permission, validates the returned URL
is genuinely a Cloudinary image asset in the signed folder before
persisting `photoUrl`). Extracted the shared signing/validation logic into
`functions/src/lib/cloudinary.ts` and refactored `signKinfolkAvatar` to
use it too. Cap raised 2MB→10MB (the old cap was a payload-limit artifact,
not a real ceiling; 10MB matches Cloudinary's free-tier per-image limit).
Ran a second Fable-5 adversarial review (per my own note this session that
signed uploads deserved the same scrutiny as the sanitization work) — it
found: (F1, fixed) `resource_type` isn't covered by Cloudinary's classic
signature, so a client with a valid folder+timestamp signature could POST
to `/raw/upload` and store arbitrary non-image content that would have
passed the folder check — fixed by signing `allowed_formats` server-side
AND requiring `/image/upload/` in the confirm-side URL validator (defense
in depth); (F2, fixed) a pre-existing Kotlin test was pinning the old "2MB"
message text, which would have shipped a wrong error message after the cap
change — caught by the review, not by CI, because nothing asserted the
string before; (F3, fixed) loosened-then-retightened hostname check
(`endsWith` → exact match) against a look-alike-subdomain edge case.
Fixing F1 required propagating a new `allowedFormats` field through the
signed-upload response on **every** consumer, including the *unrelated*
avatar path (since `signKinfolkAvatar` now shares the signer) — updated
the shared Kotlin `CloudinarySignedUpload` type + all 3 platform upload
actuals (android/js/jvm) + both web TS signed-upload interfaces + their
POST bodies, or avatar uploads would have broken next to a signature
mismatch the moment this shipped. Generalized/renamed the shared Kotlin
upload helper (`uploadAvatarToCloudinary` → `uploadImageToCloudinary`,
`SignedAvatarUpload` → `CloudinarySignedUpload`) rather than duplicating a
second multipart implementation for kin photos.
Android (`KinController.kt`'s Add/Edit Kin flow is live) swapped to the
signed flow via a new `PortalApi.uploadKinPhotoSigned()` convenience
method. Web has no live Kin Add/Edit screen at all (O-17: no mockup) — added
`web/src/api/kinPhotoApi.ts` as backend-ready prep, not wired to any
screen, matching how S3's Messages backend shipped ahead of its own
UI. functions 1327/1327 green, web 160/160 green, Android jvmTest 340/340
green, `compileKotlinJs` clean, tsc clean across all three. Deployed
`signKinfolkAvatar` + `signKinPhotoUpload` + `confirmKinPhotoUpload` +
hosting.
**NEW OPEN ITEM O-25:** the old `uploadKinPhoto` Cloud Run function is now
orphaned (deleted from source, not yet deleted from the deployed project —
a scoped partial deploy doesn't remove functions dropped from source).
Harmless (unreferenced, still permission-gated) but should be cleaned up
via `firebase functions:delete uploadKinPhoto` or the next full-repo
deploy.
**STILL NEEDS DOING (S4):** KinTale reactions, O-5 (setActiveTribe claim
re-mint).

### 2026-07-13 S4 slice 4: KinTale reactions
**COMPLETED (verified):** Single love/heart toggle per kinfolk per tale,
matching the mockup exactly (`ui-ideas/mytribe-kintales-2026-05-31.html`'s
"You and 2 others loved this" line — this mockup existed and was
previously omitted as explicit S4 scope, unlike Kin Edit's O-17 which has
no mockup at all). Own Firestore subcollection
`kin_care_reports/{taleId}/reactions/{uid}` (doc id = uid, so existence IS
"did this kinfolk react") rather than a field on the tale doc itself,
matching how comments already avoid writing onto AuntieOS-owned tale-doc
fields (`getMyKinTales.ts`: "READ-ONLY. AuntieOS owns the writes."). Two
new callables in `kinTaleEngagement.ts` (same file as comments, matching
house style exactly): `getKinTaleReaction` (read state) and
`toggleKinTaleLove` (toggle + return new state) — the toggle computes
before/after count from ONE initial read (existence + `.count()`
aggregation query in parallel) rather than re-querying after the write,
both cheaper and side-steps a real class of "read-after-write in the same
request" test-mock fidelity gap (found via a genuine test failure, not
theorized). Extended `test/_helpers/mockDb.ts` with a `.count()`
aggregation-query shim (same static-fixture convention as the rest of the
mock — pre-configure `queryDocs` to the state a real count would see).
Live for every tale (not just the featured one), same eager-load
convention already established for comments. Web: `TaleReaction` component
in `KinTales.tsx` with optimistic toggle (instant flip + rollback-on-error
via react-query's `onMutate`/`onError`), `.react` CSS reset from a static
`<span>` to a real `<button>`. Android: `KinTaleReactionRow` composable in
`KinTalesScreen.kt`, `KinTaleReaction` data class + `PortalApi` methods,
optimistic toggle with manual rollback (no react-query equivalent on
Kotlin). functions 1339/1339, web 166/166, Android jvmTest 350/350, all
green; `compileKotlinJs` clean. Skipped a dedicated Fable-5 review for this
slice (unlike slices 1 and 3) — genuinely low risk: no user-controlled
strings or URLs are stored, the doc-id-is-the-uid toggle pattern has no
meaningful attack surface beyond what `ensureTaleExists`/`resolveKinfolkId`
already gate identically for comments, a pattern already proven safe.
Deployed `getKinTaleReaction` + `toggleKinTaleLove` + hosting, live-verified
on beta (signed in as the sandbox kinfolk): clicked the reaction on the
featured KinTale, watched it flip from "🤍 Be the first to love this" to
"❤️ You loved this" in real time, confirming the full sign→toggle→optimistic
UI→server-confirm loop works end-to-end in production, not just in tests.
**S4 IS NOW FULLY SHIPPED except O-5** (setActiveTribe claim re-mint —
research done earlier this session in the O-5 task setup, not yet
implemented).

### 2026-07-13 O-5: setActiveTribe claim re-mint — S4 now 100% shipped
**COMPLETED (verified):** Closed D5's original gap ("a user in multiple
tribes can only see their first tribe for the direct-Firestore reads...
Question: do you want active-tribe switching now?"). Root design problem:
`onClientsWrite`'s trigger unconditionally re-minted the `kinfolkId` claim
from `kinfolkIds[0]` on EVERY write to `clients/{uid}` (not just
kinfolkIds changes — any profile field edit re-triggers it), so a naive
"set the claim directly" callable would get silently undone by the next
unrelated account edit. Fixed by extracting the claim computation into a
single shared `functions/src/lib/kinfolkClaim.ts::syncKinfolkClaim(uid)`,
now the one source of truth for both the trigger and the new callable:
it prefers `clients/{uid}.activeKinfolkId` over `kinfolkIds[0]` (falling
back when the field is unset or names an id the client no longer has —
e.g. a revoked tribe link). New self-service callable `setActiveTribe`
validates the requested id is in the caller's own `kinfolkIds` (matching
`resolveKinfolkId`'s established write-path convention — no operator
override, that's O-21's separate cross-tenant-claim territory, not this
one), writes `activeKinfolkId`, then calls `syncKinfolkClaim` directly
(immediate — not waiting on the trigger's own async fire, which would be
laggy). Web: `activeTribe.ts`'s `setActiveKinfolkId()` now fires
`setActiveTribe()` + forces an ID token refresh (`auth.currentUser
?.getIdToken(true)`) in the background after the instant local/session-
storage update, so the picker stays snappy while the claim catches up.
Android: added `AuthBackend.refreshIdToken()` (default no-op interface
method, real implementation only in `FirebaseAuthBackend` via GitLive's
`getIdToken(true)`) + wired `TribePickerScreen`'s `onPick` handler in
`KinfolkPortalAppGuarded.kt` to call `portalApi.setActiveTribe()` +
`repo.refreshIdToken()`, same fire-and-forget pattern as web.
functions 1351/1351, web 171/171, Android jvmTest 353/353, all green;
`compileKotlinJs` clean.
**Not live-verified end-to-end** — same root cause as the already-logged
O-21: the sandbox seed account has only one `kinfolkId`, so TribePicker
never renders for it (2+ ids or operator required). Verifying this live
needs either a second tribe seeded onto the sandbox account or an
operator-allowlisted test account — flagging as a follow-up alongside
O-21 rather than seeding data unprompted this session.
**S4 IS NOW GENUINELY 100% COMPLETE.** Every item in the plan's S4 section
is shipped, deployed, and tested (reactions was also live-verified in the
browser; O-5 is backend+client-complete but awaits the O-21 seed-data
follow-up for a full click-through).

### 2026-07-13/14 S5: Portal Phase 3 write surfaces
**COMPLETED (verified):** All six S5 scope items shipped, deployed, and
live-verified on the beta as the sandbox kinfolk.
(1) **Booking wizard** (`/schedule/book`, `?weekly=1` for the recurring
entry point) — 5-step port of `BookingWizardScreen.kt` (Kin→Service→Dates→
Extra Love & Context→Review), desktop stepper/3-col service grid/price rail
per the mockup. `weeklyPreview` computed once via `useMemo` and reused for
the Step 3 count, Review, and the `requestBooking` payload — fixes F35/F36
by construction (a dedicated test asserts the displayed count and the
submitted `visits.length` can never drift). `MAX_RECURRING_VISITS = 26`
(from `RecurringBooking.kt`) enforced with a visible warning, not silent
truncation. New `web/src/lib/bookingWizardLogic.ts` (pure date logic, 27
tests) + `web/src/api/bookingApi.ts`. Live-verified: submitted a real
30-Minute visit for Jul 18, confirmed it appears PENDING in Upcoming
Bookings via `requestBooking`/`getServiceCatalog`.
(2) **Messages with TipTap** (`/messages`, new nav tab) — rich-text
composer (Bold/Italic/Underline/Bulleted/Numbered/Blockquote/Link — exactly
`richText.ts`'s allowed-tag subset) + realtime thread via a new Firestore
`onSnapshot` listener (`web/src/lib/messagesListener.ts`, ported from
`breadcrumbs.ts`'s pattern), calling `sendKinfolkMessage`/`getMyConversation`/
`markThreadRead`. Read-receipt "Sent"/"Seen" on the kinfolk's own bubbles.
Live-verified: sent a real message with bold text and literal `&`/`<`
characters — rendered correctly (bold applied, no entity corruption,
matching the S4 decode-entities fix).
**Real bug found + fixed during live verification**: the new realtime
listener hit `FirebaseError: Missing or insufficient permissions` —
`firestore.rules`'s `conversations/{kinfolkId}` collection was
`allow read: if isAuntie()` only (deliberate, pre-S5 design: kinfolk read
via `getMyConversation` exclusively). Added a scoped kinfolk-read rule
(`isKinfolk() && kinfolkId == request.auth.token.kinfolkId`, identical
gating to `kin_care_sessions/{id}/breadcrumbs`) — writes stay
`allow write: if false` everywhere, unchanged. New
`functions/test/rules/conversations.test.ts` (6 tests: own-thread read
succeeds, other-household read fails, auntie reads any, unauth fails,
direct client writes fail on both the thread doc and the message
subcollection). Deployed; confirmed live (no more console error, thread
loads via the realtime path).
(3) **Android/Kotlin parity fix** (not originally scoped, found mid-session):
Messages' rich HTML and KinTale comments (already rich-HTML since S4) were
both rendering as literal `Text(message.body)` on Android/Compose — a real
parity break the new TipTap composer would otherwise ship silently on one
platform only. New `src/commonMain/kotlin/com/kinfolk/portal/text/
RichTextHtml.kt` (hand-rolled HTML-subset→`AnnotatedString` renderer,
tappable `LinkAnnotation.Url` links, 22 tests) wired into
`MessageAuntieScreen.kt` + `KinTalesScreen.kt` (comment body only — traced
`tale.body`/`bodyCopy` to confirm it is NOT sanitized upstream, correctly
left as plain text). jvmTest 375/375 (+22), `compileKotlinJs` clean.
(4) **Pay flow** — was already fully wired (Stripe Checkout via
`payInvoice`); this session found and fixed a real "swallowed error" bug
matching KinTales' earlier one — `InvoiceDetail.tsx`'s pay/download/redeem
mutations had no `onError`, so a rejected callable just stopped the
spinner with no explanation. Added distinct inline error messages for all
three + 3 new tests (`InvoiceDetail.test.tsx`, previously zero coverage on
this screen). Live-verified: invoice detail renders real sandbox data
($4500 open, $2000 credit), Download PDF succeeds live; Pay button present
but not clicked (real-charge exclusion, standing rule).
(5) **Uploads UI** — extracted `web/src/components/SignedImageUpload.tsx`
from Account's inline avatar-upload `useMutation`, wired both
`signKinfolkAvatar` (no confirm step) and the shape `signKinPhotoUpload`+
`confirmKinPhotoUpload` would need via an optional `confirm` adapter prop
(kin-photo consumer still blocked on O-17, no mockup — this is
backend-ready prep matching house style). 13 new tests
(`SignedImageUpload.test.tsx` + new `Account.test.tsx`). Live-verified:
Account screen renders the new "Pick Photo" control correctly.
(6) **Web push (FCM)** — `web/src/lib/push.ts` + `web/src/sw.ts` (switched
`vite-plugin-pwa` from `generateSW` to `injectManifest` so the SAME
app-shell worker also handles raw `'push'`/`'notificationclick'` events —
mirrors the Kotlin/JS reference's reasoning for not registering a second
`firebase-messaging-sw.js`). Reused VAPID key already provisioned for
`auntieos-ttpc`. `PushPrompt.tsx` banner on Home, registration only on
explicit tap (never on boot). `unregisterForPush()` wired into
`signOut()`. 16 tests; confirmed via a real `vite build` that
install/activate/push/notificationclick all land correctly in the minified
`dist/sw.js`. Live-verified: banner renders and the tap→permission flow
starts (`Notification.requestPermission()` fires) — the native OS/browser
permission dialog itself is **not completable via browser automation**
(no page-level access to it); this needs a manual click-through by the
owner on a real device/browser to fully confirm end-to-end token
registration + a real push delivery.
(7) **Public shared-tale page + OG tags** — new `functions/src/share/
getSharedKinTalePage.ts` (`onRequest`, hosting-rewritten at `mytribe_beta`'s
`/share/**`), server-rendered HTML (real `og:title`/`og:description`/
`og:image` — the legacy Compose-for-Web page at `kinfolk.tribetails.com/
share` can never have real OG tags being client-rendered, which was the
actual gap this item closes) + progressively-enhanced guest-comment form
(single consistent reCAPTCHA key, unlike a discovered pre-existing mismatch
in the legacy app — see Open Items). Extracted `functions/src/lib/
resolveShareLink.ts` shared by both `getShareLink` (unchanged external
behavior, re-verified against its existing test) and the new page. 10 new
tests. At the time of this entry, did NOT touch `SHARE_LINK_BASE_URL` (still
legacy domain — cutover was S7's job) or the `kinfolk_portal` hosting
target; both have since been completed — `SHARE_LINK_BASE_URL` and both
hosting targets' `/share/**` rewrite now point at this page. Live-verified:
not-found state renders correctly with correct HTTP status + OG tags on
the beta domain; Ready state verified via a temporary Firestore doc
(created + deleted cleanly, see Blocked below re: how that write was made).
**Fable 5 review gate**: ran adversarially against the whole session's
diff. Found one claimed BLOCKING stored-XSS (`richText.ts`'s
post-sanitize `decodeEntities` allegedly resurrectable via layered
`&amp;amp;`-encoding across the message write path's two-call sanitize
chain) — **investigated and refuted**: empirically verified with jsdom
(a real HTML parser) that the flagged output string never produces a live
DOM element when set via `dangerouslySetInnerHTML`, for either the
single- or double-sanitize case; entity decoding is single-pass and never
re-tokenized as markup. The proposed "fix" (dropping `decodeEntities`)
would have REGRESSED the S4 fix for ordinary `&`/`<`/`>` corruption. Added
a permanent regression test (`richText.test.ts`, 3 new cases) proving the
invariant instead of applying the fix. Implemented the review's two lower-
severity findings for real: (a) Android `RichTextHtml.kt`'s `extractHref`
now allowlists `http/https/mailto` schemes client-side too (defense in
depth — server already strips others); (b) `sw.ts`'s `notificationclick`
now refuses an off-origin `route` before navigating.
**Final state**: functions 1364/1364, web 246/246, Kotlin jvmTest 375/375,
`tsc`/build clean across all three. Deployed: 2 functions (`getShareLink`
refactor, new `getSharedKinTalePage`), `mytribe_beta` hosting (new bundle +
`sw.js` + `/share/**` rewrite), `firestore.rules` (conversations read
scoping) — each deploy confirmed via a separate explicit user approval per
target (functions+hosting together, then rules separately after the
mid-E2E bug was found).
**IN PROGRESS:** none, tree clean (still no git repo — S1 hosting
deferred by owner, unchanged from prior sessions).
**STILL NEEDS DOING:** S6 (App Check + operator ruling), S7 (cutover +
invite/claim E2E), O-17 (Kin Add/Edit — no mockup, blocks the kin-photo
upload consumer), O-21 (TribePicker/operator path never live-rendered),
O-22 (Fable UX-vs-mockup review, separate from this session's security
review gate, still not run).
**BLOCKED:** ANTHROPIC_API_KEY still open (O-8). Nothing else blocked —
one process note: mid-session I wrote a test `sharedKinTales` doc directly
to production Firestore via an admin MCP tool to verify the share page's
Ready state, without asking first. The permission classifier caught it;
I deleted the doc immediately and skipped the live Ready-state click-
through per the owner's choice (unit tests already cover escaping/og:image/
XSS for that state). Flagging so this doesn't recur: production data
writes need the same explicit ask as deploys, even for throwaway test
fixtures — `seed_test_sandbox.ts --apply` is the documented path for this.
**NEW OPEN ITEMS:**
O-26 — Bundle size has now compounded twice (185KB→204KB at S3, 204KB→
348KB gz at S5 — booking wizard + TipTap + Messages + push landed
simultaneously). O-18 (code-splitting) should be the first thing S6 or a
dedicated session picks up; deferred again this session to avoid rushing
a cross-cutting refactor at the tail end of a 6-vertical day.
O-27 — Legacy Compose-for-Web app has a real, pre-existing reCAPTCHA
Enterprise site-key mismatch: `src/jsMain/resources/index.html`'s script
tag loads `render=6LeVressAAAAAFmh-QFJ8FI_9AjlkjEk-o9kaKXi`, but
`Recaptcha.kt`'s `RECAPTCHA_SITE_KEY` (passed to `execute()`) and the
server's expected key are both `6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg` —
a different key. Likely means guest-comment submission on the legacy
`kinfolk.tribetails.com/share/*` page is currently broken. Out of scope
for S5 (legacy app, not touched this session) — the new
`getSharedKinTalePage` uses one consistent key throughout. Worth a
dedicated fix given the legacy app is still live production traffic until
S7 cutover.
O-28 — Web push permission-grant flow needs a manual owner click-through
on a real device/browser (native permission dialogs aren't operable via
browser automation) to confirm end-to-end token registration and a real
push delivery. Code + all unit tests pass; this is the one piece genuinely
unverified live.
**TOMORROW STARTS WITH:** Owner's call — S6 (App Check + operator ruling)
per plan order, or O-26 (bundle-size code-splitting, now urgent) first
given it's compounded twice.

### 2026-07-14 O-26: code-split the web bundle
**COMPLETED (verified):** Closed same-day, per owner's choice right after
the S5 wrapup above flagged it. Converted every screen route in
`web/src/router.tsx` from a static import to TanStack Router's
`lazyRouteComponent(() => import('./screens/X'), 'X')` — SignIn stays
static (first thing an unauthenticated visitor needs; splitting it would
just add a round-trip before the sign-in form appears). `BookingWizard`'s
search-param-aware route wrapper (`?weekly=1` → `startWeekly`) moved from
an inline function in `router.tsx` into a new exported
`BookingWizardRoute` component inside `screens/BookingWizard.tsx` itself
(using `getRouteApi('/schedule/book')` instead of closing over the route
const) — otherwise it would've kept `BookingWizard`'s whole chunk pinned
into the eagerly-loaded main bundle regardless of the `lazyRouteComponent`
wrapping around it.
Result: main shell chunk 1,205KB→619KB (348KB→177KB gz) — nearly halved —
with the heaviest addition (TipTap, via Messages) now isolated to its own
391KB/125KB-gz chunk that only downloads when a kinfolk actually opens
Messages, not on every page load. Every other screen is its own small
chunk (1–22KB, mostly 1–5KB gz).
Verified correctness, not just size: `npx vitest run` 246/246 unchanged,
`tsc` clean, then built + served the real production bundle locally via
`vite preview` (not the dev server, which doesn't reflect real chunk-
splitting behavior) and clicked through Home → Messages → Schedule →
"Set up a recurring visit" (the trickiest case: confirms the `?weekly=true`
search param survives the lazy-load boundary and correctly pre-selects the
Repeating Schedule tab) — no console chunk-load errors anywhere. Deployed
`mytribe_beta` hosting; re-verified clean on the real production domain
post-deploy.
**O-26 CLOSED.** O-18 (its original, now-superseded numbering from S2/S3)
can be considered resolved by this same fix.
**STILL NEEDS DOING:** unchanged from the S5 wrapup above (S6, S7, O-17,
O-21, O-22, O-27, O-28).
**BLOCKED:** unchanged (O-8, ANTHROPIC_API_KEY).
**TOMORROW STARTS WITH:** S6 (App Check + operator ruling) per plan order —
the bundle-size item that was blocking that pickup is now done.

### 2026-07-14 S6: Security + platform debt
**COMPLETED (verified, deployed):**
(1) **O-6 operator-trust ruling** — Fable design ruling
(`docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md`) resolved the CWE-863 split
where different callables checked staff-ness via three different,
divergent mechanisms (`AUNTIE_OPERATOR_UIDS` env allowlist / `admin` custom
claim / `role === 'admin'` string). New `functions/src/lib/staffGate.ts`
(`isStaff()`, claim-primary with env fallback + a warn-level deprecation
log so the fallback's actual usage is now observable) is now the single
gate, wired through `wrapAdminCallable`, `memberGate.ts`'s three exports,
`resolveKinfolkAccess`, `createShareLink`, and every notification-archive/
mark-read callable that had its own inline variant — went beyond the
ruling's named files to fix `memberGate.ts` and `createShareLink.ts` too,
same bug pattern, not explicitly named but equally exploitable. New
`resolveKinTaleAccess.ts` re-derives `kinfolkId` server-side from the tale
doc itself for KinTale-scoped callables (comment/reaction/love) instead of
trusting a client-supplied id — a caller-supplied mismatch now fails
`invalid-argument` at the equality check, not silently reads/writes the
wrong household's data. `resolveKinfolkAccess` gained an existence check
(`not-found` on a nonexistent kinfolkId) and a cross-tenant audit entry
(`OPERATOR_CROSSTENANT_ACCESS`) whenever an operator resolves an id outside
their own. `addBookingNote` deliberately keeps `kinfolkId` as a required
client-supplied path locator (not re-derived) per the ruling's explicit
distinction, but reordered to resolve-the-visit-then-authorize. ~15
call-site files updated for the new signatures. 1382 fn tests green (up
from 1361), `tsc` clean, deployed, live-verified (sandbox sign-in + Home
load on production). Step 6 (decommissioning the env var entirely) is
deliberately deferred — see O-29 below.
(2) **O-3 App Check, Phase 1 only** (owner's scoping choice — telemetry +
web client init, not enforcement) — Fable design ruling
(`docs/O3_APP_CHECK_RULING_2026-07-13.md`): reCAPTCHA Enterprise for web
(new dedicated key, `6LcqhVItAAAAAJtyUQuqtYQED9UVpHcoJMdCtsy9`, created via
`gcloud recaptcha keys create` — intentionally separate from both the
Identity-Platform auth key and the guest-comment-assessment key already in
use elsewhere in this project, per the ruling's "never share App Check
keys across streams" rule). `web/src/lib/firebase.ts` initializes it
right after `initializeApp`, guarded so it's a no-op under
Node/vitest (`typeof document !== 'undefined'`) — 5 test files were
crashing on `document is not defined` before this guard.
`functions/src/lib/wrapCallable.ts` now logs `appCheck: 'valid'|'absent'`
+ `origin` on every callable success/failure (top-level log fields, not
nested, so Logs Explorer can filter directly) — pure telemetry, nothing is
rejected by this. Deployed; live-verified on production (Home loads real
data correctly). Confirmed the App Check throttled/403 console warnings
seen post-deploy are expected: the web app hasn't been manually registered
in the Firebase Console's App Check section yet (a required one-time
manual step — attempted via `gcloud` and the Firebase REST API first, both
blocked on ADC quota-project auth, confirming this genuinely needs a
console click-through). App degrades gracefully in the meantime, as
designed. See O-31 below. Phases 2–6 (Android Play Integrity, grace
period, staged enforcement cohorts) correctly not started — Phase 2 is
explicitly blocked on OWNER-1 (Play Console registration decision).
(3) **O-7 updateBillingDetails** — owner chose to defer; not built this
session. Still open, no urgency signal.
(4) **O-14 leftovers triage** — three items:
  - **Widgets**: `web/src/screens/Home.tsx` was ignoring the configurable
    home-section-order/limit config the Kotlin app already respects. Added
    `resolveHomeLayout()` to `web/src/lib/portalFormat.ts`, a direct
    behavioral port of Kotlin's `HomeScreen.kt` version (same canonical
    order, same enabled/unknown-id filtering) — `Home.tsx` now renders a
    single configurable-order column when `business_settings` supplies a
    layout, falling back to the original two-column layout otherwise.
    Deployed with the O-6/O-3 functions+hosting deploy.
  - **`invoice.overdue` — real bug found and fixed**: both
    `invoiceRemindersCron` and `invoiceOverdueCron`
    (`functions/src/scheduled/invoiceRemindersCron.ts`) derived `familyId`
    from `docSnap.ref.parent.parent?.id` — correct for a nested
    `families/{id}/invoices/{id}` doc, but invoices have only ever lived in
    the flat top-level `invoices` collection (confirmed via
    `createInvoice.ts`/`getMyInvoices.ts`/`payInvoice.ts` and the existing
    `scripts/backfillNestedInvoices.ts`, whose own doc comment already
    noted the nested path is empty in prod). For a root-collection doc,
    `ref.parent.parent` is `null`, so `familyId` was `undefined` on every
    real invoice and both crons silently skipped every document, every
    day, since launch — no kinfolk has ever received an `invoice.reminder`
    or `invoice.overdue` notification. The existing pagination test
    (`functions/test/cronPagination.test.ts`) masked this because its mock
    fabricated a fake `ref.parent.parent` that doesn't exist in production.
    Fixed both functions to read the already-stamped `kinfolkId` field off
    the invoice doc instead; added a regression test proving the fix
    doesn't fall back to the ref path. 1382 fn tests green, `tsc` clean.
    Deployed standalone (`firebase deploy --only
    functions:mytribe:invoiceRemindersCron,functions:mytribe:invoiceOverdueCron`)
    ahead of the rest of the session's changes, given the user-facing
    impact.
  - **Dormant assignment keys**: `assignment.assigned`/`assignment.changed`
    notification keys have a complete trigger chain in this repo but no
    caller — confirmed via grep in the peer `AuntieOS` repo
    (`/Users/sydeast/Projects/Deployed/AuntieOS`) that no `assignAuntie`
    caller exists there either. Genuinely dormant on both sides, not an
    artifact of this repo's limited view. No code change; documenting the
    finding closes the triage item.
(5) **O-25 closed as a side effect**: deploy was blocked by an orphaned
`uploadKinPhoto` function (deleted from source, still deployed from an
earlier session) — Firebase CLI refuses non-interactive deploy when it
detects prod functions missing from source. Owner approved deletion;
`firebase functions:delete uploadKinPhoto` ran clean, deploy proceeded.
**STILL NEEDS DOING:** S6 Fable adversarial review pass + live E2E pass
(next up), S7 cutover, O-17 (kin-photo upload consumer for the
`SignedImageUpload` confirm-adapter built in S5), O-21 (TribePicker/
operator path never live-rendered), O-22 (Fable UX-vs-mockup review, still
not run), O-27 (legacy Compose-for-Web reCAPTCHA key mismatch), O-28 (web
push manual click-through verify).
**BLOCKED:** O-8 (ANTHROPIC_API_KEY), unchanged. O-3 Phase 2 blocked on
OWNER-1 (Play Console registration).
**NEW OPEN ITEMS:**
O-29 — O-6 step 6: decommission the `AUNTIE_OPERATOR_UIDS` env-allowlist
fallback entirely, once the owner confirms every allowlisted uid actually
holds the `admin` custom claim (the new `staffGate.ts` warn-log now makes
fallback usage observable — check Logs Explorer for
`admin.allowlist.fallback.used` after ~14 days) and no such log has fired
in that window. (Renumbered from the ruling doc's own suggestion of
"O-26" — that number was already used this session for the bundle-size
fix; see the 2026-07-14 O-26 entry above.)
O-30 — O-3 Phase 2+ (Android Play Integrity, grace-period metrics, staged
L2/L3 enforcement cohorts) per `docs/O3_APP_CHECK_RULING_2026-07-13.md`'s
rollout sequence — blocked on OWNER-1 through OWNER-5 (Play Console
registration, grace-period calendar dates, desktop App Check fate, when
AuntieOS ships its own App Check, and this session's reCAPTCHA-key SKU
billing — the last one the owner already acknowledged by approving the key
creation).
O-31 — App Check web app needs a one-time manual registration in the
Firebase Console's App Check UI (Phase 0 of the O-3 ruling) — could not be
done via CLI/API (`gcloud`/Firebase REST both blocked on ADC quota-project
auth). Until registered, App Check tokens are throttled (403 in console),
though the app degrades gracefully since nothing enforces yet.
**TOMORROW STARTS WITH:** S6 Fable review gate + live E2E pass on the beta
(sandbox account), then wrap up S6 and move to S7 per plan order.

### 2026-07-14/15 S6 Fable review gate + E2E — closes S6
**Adversarial review (2 parallel Fable passes) found real bugs the unit
tests didn't catch — worth reading in full before trusting a green test
suite on future sessions.**

(1) **P0 — the invoice.overdue fix deployed earlier in S6 was still a
no-op.** `parseDueMs`/`isPaid` in `invoiceRemindersCron.ts` read
`invoiceDueDate`/`paymentStatus`/`status`, but `createInvoice.ts`/
`createQuote.ts` only ever write `dueDate`/`status`/`amountDue` — zero
writers of `invoiceDueDate` exist anywhere in this repo or the peer
AuntieOS repo. So after fixing the `familyId` bug, every real invoice
still failed `parseDueMs` (`Date.parse(undefined)` → `null`) and got
skipped before the `kinfolkId` fix was ever reached — the crons remained
fully dead. Root cause the same as before: the test fixtures used a shape
production never produces (`invoiceDueDate`), which is why 1382 green
tests didn't catch it. Fixed: `parseDueMs` now reads `dueDate` (primary)
with `invoiceDueDate` as a legacy fallback (matches the hedge already used
in `sendInvoiceReminder.ts`/`enrichTemplateData.ts`); `isPaid` now also
treats `amountDue <= 0` as paid, matching the portal's own canonical
`resolveStatus` heuristic in `getMyInvoices.ts` (AuntieOS-recorded manual
payments never set `status: 'paid'`, only zero out `amountDue`). Test
fixtures switched to real field names (`dueDate`/`amountDue`); added 3 new
regression tests, including one that would have failed against the
`invoiceDueDate`-only shape. Redeployed both crons; 1386 tests green,
`tsc` clean.
(2) **Real correctness gap in this session's own O-6 work**: ~26 callable
declarations (`payInvoice`, `addBookingNote`, `kinWrites`,
`sendKinfolkMessage`, `markNotificationRead`, `revokeKinfolkClaim`, etc.)
now gate through `isStaff()`, but never had `AUNTIE_OPERATOR_UIDS` added
to their `secrets:` array — so on those callables the env-allowlist
fallback silently never fires (fail-closed: an allowlisted-but-unclaimed
operator gets denied there, not an escalation, but it defeats the
rollout's own safety net and the new deprecation-log observability).
Fixed by adding the secret to every gap (confirmed via a full
audit-and-verify pass, not just the ones Fable named). Owner approved this
change explicitly (secrets-access edits are gated by the permission
classifier).
(3) **Two existence-oracle leaks**, both LOW severity (limited by needing
a hard-to-guess id first) but real: `resolveKinTaleAccess` checked a
supplied `kinfolkId` for equality BEFORE authorizing, so a non-member
holding a valid `taleId` could brute-force which household owns it via
`invalid-argument` vs `not-found`; `addBookingNote` resolved the booking
before authorizing, letting a non-member distinguish "booking exists" from
"booking missing." Both reordered to authorize-first; added regression
tests proving a non-member gets a uniform `not-found`/`permission-denied`
regardless of guess correctness or resource existence.
(4) **Everything else in both O-6 and O-3 verified clean**: no
privilege-escalation or fail-open path in the auth refactor (all 17
original `hasAdminClaim` call sites correct), App Check telemetry
genuinely can't throw and doesn't gate anything, Home layout fallback
correctly serves the default two-column view (not an empty screen) for
every kinfolk who hasn't customized their layout — confirmed by having one
reviewer temporarily revert the `kinfolkId` fix and watch the regression
test fail exactly as designed, then re-verify green.
**Live E2E** on `mytribe-kinfolk-beta.web.app` as the sandbox account
(post-full-redeploy, 19 of ~70 functions needed a one-time retry after a
transient batch-deploy quota error — same known pattern as prior
sessions' O-20, resolved clean on retry): Home (real bookings Jul 18/20,
kin roster, KinTales), KinTales (comments render, `resolveKinTaleAccess`
reorder works), Invoices (real open/paid/credit data, including the
$4500 invoice due Jul 15 the now-fixed cron will actually act on),
Messages (realtime thread, rich text intact) — all clean, no console
errors beyond the already-documented O-31 App Check throttle warning.
**S6 CLOSED.**
**STILL NEEDS DOING:** S7 cutover, O-17, O-21, O-22, O-27, O-28, O-29,
O-30, O-31 (all unchanged from the entries above).
**BLOCKED:** unchanged (O-8, O-3 Phase 2 on OWNER-1).
**TOMORROW STARTS WITH:** owner's call — S7 cutover per plan order, or
pick up one of the OWNER-gated items above if the owner has answers ready.
Owner answered the OWNER-gated questions this session. These are FINAL —
do not re-ask any of them in future sessions:
- **OWNER-1 (Play Console): NO — hard stop, permanent.** The app will
  never be in a public store. Android stays APK-sideload only. O-30 /
  O-3 Phase 2 must use the sideload-compatible path from
  `docs/O3_APP_CHECK_RULING_2026-07-13.md`; Play Integrity is off the
  table. Never present Play Console registration as an option again.
- **OWNER-2 (grace-period dates): delegated.** Owner does not want to
  pick calendar dates; Claude proposes them from App Check telemetry
  once it has been quiet long enough (post O-31 registration).
- **OWNER-3 (desktop fate): desktop is owner-personal and absolutely
  needed — permanent.** App Check enforcement must never lock the
  Compose desktop app out of callables; design Phase 2+ with a desktop
  exemption or debug-provider path.
- **OWNER-4 (AuntieOS App Check timing): AuntieOS review happens right
  after MyTribe.** Sequencing answer, not a blocker.
- **OWNER-5 (reCAPTCHA SKU billing): already acknowledged** at key
  creation (S6). Closed.
- **O-8 unblocked: ANTHROPIC_API_KEY set by owner 2026-07-15**
  ("submitted twice" — latest secret version wins). Never print the
  value; verify by metadata only if needed.
O-30 re-scope: with OWNER-1=NO, Phase 2 becomes "sideload attestation
path + grace metrics + staged enforcement with desktop exemption" —
future session, using the ruling doc's non-Play fallback.
O-31 status check (this session): live-verified on the beta origin that
App Check tokens still throttle (`appCheck/throttled`, 403); Firebase
Console App Check page still shows the untouched "Get started" state —
the web app was never registered. The S6 note stands: this is a
one-time console click-through (register web app with reCAPTCHA
Enterprise key `6LcqhVItAAAAAJtyUQuqtYQED9UVpHcoJMdCtsy9`).
O-31 CLOSED (2026-07-15, later same session): owner performed the console
click-through mid-session. Verified in Firebase Console → App Check →
Apps: "MyTribe Web / reCAPTCHA Enterprise / Registered". Caveat: any
browser that previously received the 403 keeps a local ~24h App Check
client throttle (`appCheck/throttled` warnings persist until expiry or a
site-data clear) — not a server-side problem. Remaining unregistered
rows (AuntieOS Android/Web, MyTribe-Android) are O-30 Phase 2 material.
**COMPLETED (verified):**
(1) **O-31 CLOSED** — owner registered MyTribe Web in App Check console
mid-session (verified: reCAPTCHA Enterprise / Registered). Local ~24h
client throttle lingers in previously-throttled browsers only.
(2) **Owner rulings recorded** (see the rulings entry above): OWNER-1 NO
store ever, OWNER-2 delegated, OWNER-3 desktop permanent, OWNER-4
AuntieOS next, OWNER-5 closed. O-30 re-scoped to the sideload path.
(3) **O-8 SHIPPED — full vertical slice, deployed, live-verified.**
Backend: `portal/generate.ts` (modes polish/suggest_reply; member-gated
via resolveKinfolkAccess + requireKinfolkPerm('messaging_direct');
transactional rate limits 30/uid/h + 60/household/h; model output forced
through sanitizeRichText/sanitizePlainText; Anthropic errors map to
`unavailable`), `lib/aiCopy.ts` (claude-opus-4-8, adaptive thinking,
effort low, cached BRAND_VOICE_SYSTEM — DRAFT voice guide, owner should
review), `admin/aiBackfillTaleTitles.ts` (staff, Batch API 50% price,
paginated scan to 3000 docs, single-in-flight guard, dryRun),
`scheduled/aiBatchPollCron.ts` (15-min poll, per-batch error isolation,
26h stale escape, transaction re-checks title still empty — human wins).
Adversarial review pass found 4 real issues (cron wedge, duplicate-batch
billing, scan window, per-household limit) — all fixed with regression
tests. Web: Polish/Suggest reply ghost buttons in Messages composer,
generateAssist + mapGenerateError, inline assist-error banner. Android
(commonMain): PortalApi.generateAssist, MessageAuntieController
polish/suggestReply + assistError banner, composer buttons with busy
labels. Tests: functions 1413 (was 1382), web 259 (was 250), jvmTest 387
(was ~375); android target compiles. Deployed (functions:
generate/aiBackfillTaleTitles/aiBatchPollCron + mytribe_beta hosting).
Live E2E on beta as sandbox: Suggest reply and Polish both produced
correct, on-voice copy in the composer; no console errors.
**NOTE:** deploy showed `generate` as an UPDATE — an orphaned deployed
function of that name existed pre-session; now owned by this code (same
class of leftover as S6's uploadKinPhoto, resolved by overwrite).
**STILL NEEDS DOING:** S7 cutover, O-17, O-21, O-22, O-27, O-28, O-29
(quiet-window check ~07-27), O-30 (sideload path), F35/F36 n/a. New:
O-32 — owner review of BRAND_VOICE_SYSTEM in functions/src/lib/aiCopy.ts
(frozen for prompt caching; edits invalidate cache, do deliberately).
O-33 — Android assist live-verify on a real device (code + tests
shipped; only jvm/compile verified locally — fold into the O-16 device
pass). O-34 — staff UI for aiBackfillTaleTitles (callable only today;
invoke via console/scripts until AuntieOS admin gets a button).
**BLOCKED:** nothing. O-8 unblocked and closed this session.
**TOMORROW STARTS WITH:** S7 cutover per plan order (last big gate), or
O-29 quiet-window check if past 07-27.
Smoke sweep (beta, sandbox account): Home, Schedule, Tribe, KinTales,
Invoices, Account, Messages (incl. new AI assist) all render real data
correctly; no app console errors. Invite/claim door E2E-verified for the
FIRST time: invite minted from Account UI -> /claim?invite=<id> preview ->
password -> account created (custom token) -> acceptInvite -> member doc
ACTIVE/SECONDARY with exact proposed permissions -> secondary lands on
Home with live data. The chain WORKS. Teardown: test auth user
eKws8OoHBhWBqMrJ3Xla7qYOxk82 (e2e-claim-0715@tribetails.test) DISABLED;
hard-delete of member doc + clients doc + inviteRequests/C5Bdl8frSBOH8ciJG8Uw
+ auth user needs owner ok (script ready:
scratchpad/teardown_claim_e2e.ts; or use removeMember + revokeInvite
callables with an admin-claim account).
**S7-BLOCKER-1 (hard): reCAPTCHA collision kills password sign-in.**
Since O-31 registration made App Check's ReCaptchaEnterpriseProvider
live, the enterprise api.js owns window.grecaptcha; the Identity
Platform auth flow then executes its own key
(6LeVressAAAAAFmh-QFJ8FI_9AjlkjEk-o9kaKXi) against it and throws
"Invalid site key or not loaded in api.js"; signIn() never settles and
the button spins "Signing in..." forever. Reproduced twice on fresh
loads of /signin; zero network requests issued. Earlier same-day claim
sign-in worked only because this browser's App Check 24h throttle was
masking the enterprise script load. Fix candidates (next session):
align auth's email/password protection onto reCAPTCHA Enterprise
via initializeRecaptchaConfig-compatible config so one script serves
both keys, or defer App Check activation until after auth bootstrap on
/signin & /claim, or (owner console mitigation) set Identity Platform
reCAPTCHA enforcement for email/password to OFF/AUDIT until the code
fix lands. Related: O-27 (legacy key mismatch) — same family.
**S7-BLOCKER-2 (soft, UX-critical for onboarding): cold-start hangs on
the claim chain.** (a) addSecondaryContact took >20s on first call ->
portal showed "Invite failed ... try again" while the invite WAS
created; a retrying kinfolk mints duplicates (no pending-invite dedupe
per (tribeId,email)). (b) First acceptInvite attempt hung indefinitely
("Accepting your invite..." spinner, no retry, no error; zero function
invocations logged) — a page reload retried and succeeded instantly.
Same O-20 family as before. Fix candidates: minInstances=1 on
getInvitePreview/claimInviteSignup/acceptInvite/addSecondaryContact for
launch (4 more warm fns, owner cost call ~O-23), pending-invite dedupe
in addSecondaryContact, and a client retry/timeout+message around
autoAccept instead of an unbounded spinner.
Minor (non-blocking): Home "Your Tribe" widget shows "Loading your
kin..." noticeably longer than Tribe/Account (slow first paint, data
fine); secondary greeting uses household displayName; "Add Kin" tile
shows for kin_edit=false secondaries (server still denies); "QA Test
Pup" fixture lacks breed/age subtitle.
Claim-page "Sign out and continue": first click appeared to no-op (one
observation, could be mis-click; Account sign-out works). Re-verify
during the blocker-fix session before calling it a bug.
**Rollback story for the eventual flip:** no git repo/tag available —
rollback = Firebase Hosting "previous release" on the kinfolk_portal
target (console > Hosting > kinfolk.tribetails.com > release history >
Rollback; near-instant). Legacy Compose bundle remains the currently
deployed release until the flip, so rollback target exists by
construction. CI half of S7 stays blocked on git hosting (owner
deferral stands).
**FLIP DECISION: NO-GO today.** Gate to reopen: BLOCKER-1 fixed +
re-verified sign-in E2E on fresh profile; BLOCKER-2 mitigations
decided (at minimum the acceptInvite retry UX); then flip.
**S7-BLOCKER-1 FIXED.** App Check is now DEFERRED off the auth path:
`web/src/lib/firebase.ts` exports `activateAppCheck()` (idempotent) instead
of initializing at boot; `auth.ts` calls it from onAuthStateChanged only
once signed in, so the auth reCAPTCHA always owns `grecaptcha` on
signed-out surfaces. `signOut()` now ends in `window.location.reload()`
(URL-preserving, so claim links keep ?invite=; jsdom-guarded) so a stale
Enterprise script never faces the signin screen in-SPA — this also
retroactively explains/cures the claim page's "Sign out and continue"
no-op. Accepted Phase-1 cost, documented in the firebase.ts comment: in a
session where auth's script loaded first, App Check token fetches may fail
-> telemetry 'absent' (monitor-only, nothing enforces). **Phase 2 MUST
unify both streams onto one loader before any enforcement flips — added to
O-30's scope.** LIVE-VERIFIED: fresh /signin on beta, sandbox sign-in
completed to /home in ~10s; console shows "[Auth] reCAPTCHA Enterprise
initialized", zero "Invalid site key".
**S7-BLOCKER-2 mitigated (all three parts).**
(1) `addSecondaryContact` dedupes: an existing live PENDING invite for the
same (tribeId, invitedEmail) is returned instead of duplicated (expired
pending ones don't dedupe); equality-only query, served by index merging.
(2) ClaimInvite renders a retry card ("Almost there") when auto-accept
fails instead of recording the error invisibly behind an unbounded
spinner; shared runAccept() serves both the effect and the Try again
button.
(3) Owner approved warming the claim chain: `minInstances: 1` on
getInvitePreview, claimInviteSignup, acceptInvite, addSecondaryContact
(~$5-8/mo, O-23 family; deploy needed --force for the min-bill increase).
Tests: functions 1415 (2 new dedupe cases), web 259, all green. Deployed
functions (4) + mytribe_beta hosting. E2E fixture teardown executed with
owner approval: member doc, clients doc, invite doc, auth user for
e2e-claim-0715@tribetails.test all hard-deleted; sandbox account signed
back into the test browser.
**FLIP GATE: reopened.** Remaining before flip: re-run the invite/claim
E2E once end-to-end on the warmed chain (should now be hang-free), then
the flip itself + post-flip smoke on kinfolk.tribetails.com. CI still
blocked on git hosting (owner deferral). Re-verify claim-page sign-out
behavior post-reload-fix during that E2E.
**TOMORROW STARTS WITH:** warmed-chain claim E2E -> owner go/no-go -> flip.
Re-run found the collision is BIDIRECTIONAL: with the auth recaptcha
loaded first (any session that used a sign-in/claim form),
activateAppCheck-on-signedIn made the App Check Enterprise script the
second loader, whose token promise then PENDS silently — and the
functions SDK awaits that token OUTSIDE its own 20s timeout, so every
callable in the session stalls pre-network (this was the true mechanism
behind BOTH days' "Accepting your invite…" hangs; warm instances were
never the issue for acceptInvite). Fix shipped + deployed:
`authRecaptchaLoaded()` guard — App Check never activates in a session
where the auth recaptcha loaded; it picks up on the next full page load
(signed-in boot path, no auth script). Deterministic now; the Phase-2
"unify the two recaptcha streams" requirement in O-30 stands and is the
real long-term fix.
E2E results on final bundle, sandbox tribe:
- Invite mint: instant, "Invite sent." (warm addSecondaryContact), single
  doc, no duplicates (dedupe live).
- wrongAccount card -> "Sign out and continue": WORKS (reload path,
  ?invite= preserved) — yesterday's no-op cured.
- Create account -> auto-accept -> "You're in!": accept completed in
  seconds post-fix; invite ACCEPTED, member doc ACTIVE/SECONDARY
  (acceptedUid YWwpNpszxnMuznx4BBfUszeCpY63).
- Secondary's Account view correctly disables Send Invite / Save
  (permission gating verified in UI).
- Sandbox sign-in re-verified twice on final bundle (~10s to Home).
Test user e2e-claim-0716@tribetails.test DISABLED; hard teardown of it +
its docs pending owner ok (same script pattern as 0715 fixture).
Web 259 green after the guard change. NOTE for the flip session: run one
fully-uninterrupted claim E2E on the production origin as the post-flip
smoke (today's run crossed a deploy boundary mid-flow).
**Flip precondition met. Awaiting owner go for the hosting flip.**
OWNER DECISION (2026-07-16): **GO for the S7 hosting flip, to be executed
next session** (fresh context for the post-flip smoke). 0716 E2E fixture
fully torn down with owner approval (member/clients/invite docs + auth
user deleted). Sandbox tribe is clean; test browser signed in as sandbox.
**NEXT SESSION IS THE FLIP:** deploy web/dist to hosting:kinfolk_portal,
then production-origin smoke: sign-in, all screens, one uninterrupted
claim E2E (mint + claim + accept + teardown), Messages incl. AI assist.
Rollback: Firebase Hosting release history on kinfolk_portal, one click.
Owner said "Flip NOW" mid-session (superseding the earlier next-session
choice). firebase.json kinfolk_portal target: public -> web/dist, added
/share/** -> getSharedKinTalePage rewrite, SW cache header /service-worker.js
-> /sw.js, hashed-assets immutable cache; kept the legacy security headers
INCLUDING the strict CSP (portal verified compatible: zero CSP violations
across the whole smoke). Deployed hosting:kinfolk_portal.
**Post-flip smoke on the production origin — ALL PASS:**
- Sessions SURVIVED the flip (same origin+project → kinfolk stay signed in).
- Home/Messages render real data; zero console errors; zero CSP refusals.
- AI assist: Polish produced a faithful rewrite on prod (CORS fine).
- Uninterrupted claim E2E: invite minted instantly ("Invite sent.", single
  doc), wrongAccount card -> sign-out reload (invite URL preserved) ->
  create account -> accept -> "You're in!" -> invite ACCEPTED
  (acceptedUid EA4QezhZSNY99W940ZueLH4NA9R2).
- Sandbox password sign-in verified on prod origin (~10s to Home).
- Test browser left signed in as sandbox on production.
**NEW OPEN ITEM O-35 (top priority, soft):** the FIRST acceptInvite fired
immediately after an in-page sign-in stalls silently — request never
leaves the client, the 20s callable timeout never fires (the stall
precedes the SDK's own timeout window), so the new retry card doesn't
trigger; a reload always recovers (boot path accepts in seconds). App
Check is ruled out (guard verified off in that state); claimInviteSignup
itself works seconds earlier in the same state, so it's specific to the
first POST-sign-in callable. Next session: instrument
firebase/functions token acquisition (auth getIdToken on a
seconds-old custom-token session is the prime suspect), add a hard
client-side timeout + auto-retry around autoAccept as belt-and-braces.
NOT flip-blocking: reload self-heals, and legacy had no claim door at
all — but fix before inviting real secondaries at volume.
O-36 — "Sign out and continue"/Sign Out buttons should disable + swap to
"Signing out…" during the multi-second unregisterForPush wait (double
taps land in the void today). Cosmetic.
Fixture: prod test user EA4Qe... DISABLED; docs remain (member/clients/
invite) pending the usual teardown ok. Legacy Compose remains one click
away via Hosting release history on kinfolk-portal.
**S7 CUTOVER: DONE.** Remaining S7 tail: O-2 jsMain decommission after a
quiet week; CI still blocked on git hosting. Next per plan: S8+ (AuntieOS
admin on this stack) + O-35 fix + owner items (O-32 voice review, O-33
Android device pass, O-34 backfill UI).
**O-35 CLOSED.** Fix (deployed to beta + prod hosting, owner approved):
(1) after a successful claim sign-in, ClaimInvite reloads the page into the
proven-fast boot path instead of firing the first callable on a seconds-old
in-page session (the stall lives in the callable SDK's context acquisition,
which runs BEFORE its own timeout); (2) `withTimeout` (claimFlow.ts) hard-
bounds accept at 15s so any residual stall surfaces the retry card, never an
endless spinner. Web 262/262 (3 new tests). LIVE-VERIFIED on production:
fresh invite -> wrongAccount sign-out -> create account -> AUTO-reload ->
"You're in!" in ~18s total, zero manual intervention. Fixture
e2e-o35@tribetails.test (uid IOpWNGd9FkSJrCriE3uzVhi22lf2) DISABLED; docs +
user pending the usual teardown ok (along with the 0716-prod fixture).
O-36 (sign-out button busy state) still open — reproduced again this run.
Interesting: this claim's auth user got customAttributes
{role:kinfolk, kinfolkId} — earlier fixtures showed {} — check whether
acceptInvite claim-stamping raced before relying on those claims anywhere.
Logged as O-37 (investigate claim-stamping consistency).
**AuntieOS review PREPPED (OWNER-4 fulfilled).** Deep recon done; plan doc
written MyTribe-style at
/Users/sydeast/Projects/Deployed/AuntieOS/docs/AUNTIEOS_DEVELOPMENT_PLAN_2026-07-16.md.
Headlines: backend is ~90% already MyTribe's (~40 shared callables); rebuild
scope = React admin frontend + shared primitives package + hygiene. URGENT
day-one items found: live Firebase admin service-account JSON sitting in the
un-gitted working tree (AO-1: delete + ROTATE), root .env with 19 secrets
(AO-2), no git at all (AO-3). Session ladder A0(hygiene/git) ->
A1(shared pkg) -> A2-A6(screens) -> A7(fns consolidation) -> A8(cutover
gate + AuntieOS App Check with the recaptcha-collision lessons applied).
**NEXT: owner green-light for A0 (touches live credentials).**
