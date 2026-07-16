# O-3 App Check Ruling, 2026-07-13 [SEC]

Design ruling per docs/DEVELOPMENT_PLAN_2026-07-10.md S6: "O-3 App Check
(design ruling: providers per platform, enforcement order, grace mode),
Fable 5 designs, Opus implements." This document is the design. The
implementing session should follow the rollout sequence at the bottom
literally; every deviation from it should be treated as a new ruling request.

Threat-model framing that shapes everything below: App Check raises the cost
of scripted abuse (token replay from non-app clients, scraping, credential-
stuffing amplification). It is NOT an authorization boundary. Firestore rules
plus `req.auth` custom claims (`kinfolkId`, `admin`, `role`) remain the tenant
boundary, and nothing in this ruling weakens or substitutes for them. That is
why this rollout can afford to be patient, and why the one unforgivable
failure mode is breaking real kinfolk traffic, not a slow enforcement date.

Load-bearing facts this ruling rests on (verified in-repo 2026-07-13):

- Zero App Check code exists today anywhere (functions, web, KMP app).
- The Firebase project `auntieos-ttpc` is SHARED: the AuntieOS admin web app
  (auntie.tribetails.com) calls the same Functions service and Firestore
  database (see `functions/src/lib/cors.ts` allowlist, `wrapAdminCallable.ts`).
  Any service-wide App Check enforcement hits AuntieOS clients too.
- Callable enforcement is per-function (`enforceAppCheck` in the `onCall`
  options object, `firebase-functions@7.2.5`); Firestore/Storage enforcement
  is per-SERVICE, project-wide, toggled in the console.
- `req.app` is populated on any request carrying a valid App Check token even
  when enforcement is off: free monitoring signal, no behavior change.
- All 116 `onCall` sites pass an inline options object; 58+ route through
  `wrapCallable`/`wrapAdminCallable` in `functions/src/lib/`. The wrappers are
  the single choke point for telemetry and runtime soft-enforcement.
- The web portal reads Firestore directly (breadcrumbs map, messages
  listener in `web/src/lib/firebase.ts` / `messagesListener.ts`), so Firestore
  service enforcement is not hypothetical for us.
- The legacy Compose-for-Web app (`src/jsMain`) is live production traffic at
  kinfolk.tribetails.com until the S7 cutover and calls the same callables.

Legend: D-numbers are decisions (final unless the owner overrides), OWNER
items need the owner and are listed at the end.

---

## D1. Providers per platform

**Web portal (`web/`): reCAPTCHA Enterprise provider, with a NEW dedicated
site key.** Not reCAPTCHA v3, not a WAF option.

- Why Enterprise over v3: the project already runs reCAPTCHA Enterprise
  (guest-comment assessment in `functions/src/public/addGuestKinTaleComment.ts`),
  so the org/billing/API relationship exists; Enterprise is the provider
  Firebase recommends for new web App Check installs and gives score-based
  signal rather than v3's coarser model. A WAF (e.g. Cloud Armor) solves a
  different problem (L7 flood) and does nothing for the "stolen ID token
  replayed from a script" case App Check exists for.
- Why a NEW key rather than reusing `6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg`:
  App Check performs and manages its own assessments against its key. Mixing
  App Check traffic with the manual guest-comment assessments on one key
  pollutes both metric streams and couples two unrelated tuning knobs. Keys
  are free; create one scoped to App Check with domains
  `mytribe-kinfolk-beta.web.app` and `kinfolk.tribetails.com`, with
  `localhost` left off (localhost dev uses debug tokens, D3).
- The PWA/service-worker angle is a non-issue: App Check tokens are fetched
  by the page, not the SW, and callables go through the page context. No SW
  changes needed.

**Android (`src/androidMain`): Play Integrity provider.** SafetyNet is
deprecated and decommissioned. Do not implement it, do not add a fallback to
it. Debug builds use `DebugAppCheckProviderFactory` (D3). Hard prerequisite:
Play Integrity requires the app registered in the Play Console (an internal
testing track upload is sufficient, a public listing is not required).
Whether the app goes onto a Play track is OWNER-1 below; Android App Check is
blocked until that is answered yes.

**Legacy Compose-for-Web (`src/jsMain`): explicitly NOT retrofitted.** It
retires at S7. Adding App Check through the Kotlin JS interop is real work
with zero lasting value, and during the grace period (monitor-only, D3) its
tokenless traffic breaks nothing. The consequence is structural and accepted:
**platform-level enforcement on any callable the legacy app calls is gated on
the S7 cutover.** The enforcement order in D2 is built around this.

**Desktop (JVM Compose): out of scope for this ruling**, per the plan's
standing exemption. Two things worth recording anyway: (a) no first-party
App Check provider exists for JVM desktop; the only path is a custom
provider fed by an Admin-SDK token-minting endpoint, which is a small but
real piece of infrastructure; (b) the desktop app talks to the same callables
and Firestore, so the moment cohort-2 enforcement flips (D2), desktop breaks.
That fork (mint custom tokens for one owner-personal app, vs the owner using
the portal after cutover) is OWNER-3, decided no later than cutover week.

**AuntieOS clients: not this repo's code, but this ruling binds them.**
Admin callables (`wrapAdminCallable` surface) and any service-wide Firestore
enforcement must wait until AuntieOS ships its own App Check integration
(natural slot: the S8+ AuntieOS-on-the-new-stack rebuild). OWNER-4.

---

## D2. Enforcement order: three layers, four cohorts, two permanent exemptions

**Architecture: enforce in the wrapper first, in the platform last.**
Platform `enforceAppCheck: true` is a deploy-time option. Reverting it means
redeploying functions, which for this project (no CI, ~120 functions, direct
`firebase deploy`) is a 10-plus-minute kill switch. That is too slow for the
first enforcement flip on live traffic. So enforcement arrives in three
layers:

- **L1, telemetry (ships first, changes no behavior).**
  `wrapCallable.ts` and `wrapAdminCallable.ts` add to every `logEvent`:
  `appCheck: req.app ? 'valid' : 'absent'` and
  `origin: req.rawRequest?.headers?.origin`. The origin field is what lets us
  separate portal traffic (should have tokens) from legacy jsMain traffic
  (never will, until cutover) in the same per-function log stream. Invalid
  and missing tokens both surface as `req.app === undefined` when enforcement
  is off; that granularity is enough, since the Firebase console App Check
  metrics page gives the valid/invalid/outdated breakdown per service for
  free.

- **L2, runtime soft-enforcement (the actual first enforcement, instantly
  revertible).** The wrappers gain a mode read from Firestore
  `business_settings/security` field `appCheckMode`: `off` | `log` | `enforce`,
  cached in-process with a 60-second TTL (same pattern class as the existing
  feature-flag system; one cheap read per instance per minute). In `enforce`,
  a request without `req.app` on an enforced-cohort function is rejected with
  `HttpsError('unauthenticated', ...)`, which `wrapCallable` already
  classifies as user-fault (no Sentry noise) while still logging the failure.
  Cohort membership lives in code (a `const APP_CHECK_COHORT_1 = [...]` list
  or a per-function boolean passed to the wrapper); the MODE is runtime. Kill
  switch = flip one Firestore field, effective within 60 seconds, no deploy.

- **L3, platform `enforceAppCheck: true` (the backstop, last).** Only after
  L2 has run clean on a cohort for 7+ days. Add it via a shared spread
  constant in `functions/src/lib/` (e.g. `...APP_CHECK_ENFORCED` merged into
  the options object) so the flip is one constant, not 116 edits. Optional
  nicety: bind it to a `defineBoolean` param (`Expression<boolean>` is
  accepted) so reverting is a redeploy with an env change rather than a code
  edit. Still a deploy either way, which is exactly why L3 comes after L2
  proved quiet.

**Cohort order (which functions, in what sequence):**

1. **Cohort 1: portal-only callables.** Functions that ONLY the React portal
   calls: the S4/S5 additions (KinTale reactions, signed-upload minting,
   receipts, web-push registration, and peers). The legacy app has never
   called these, so enforcing them breaks nothing regardless of cutover
   status. This is the proving ground.
2. **Cohort 2: all kinfolk-facing callables** (the `wrapCallable` surface).
   Gated on the S7 cutover retiring `src/jsMain`, plus one quiet week.
3. **Cohort 3: admin callables** (`wrapAdminCallable` surface). Gated on
   AuntieOS clients shipping App Check (S8+, OWNER-4). Last.
4. **Never: the public unauthenticated surface.** Permanent exemption, not
   deferral: `getShareLink`, `getSharedKinTalePage` (hosting rewrite
   `/share/**`), `addGuestKinTaleComment`, and the `confirmSecureReset`
   onRequest endpoint. These serve people who may have never installed
   anything: a grandmother clicking a shared KinTale link, a link-preview
   bot fetching OG tags. A device-attestation gate on them is a category
   error. Their defenses remain what they already are: the server-side
   reCAPTCHA Enterprise assessment on guest comments, `lib/rateLimit.ts`,
   unguessable share tokens, and the S4 sanitization pass. If abuse shows up
   here, the fix is tighter rate limits and assessment thresholds, never
   App Check.

**Services (Firestore, Storage, Auth): register and monitor, do NOT enforce
for the foreseeable future.** Firestore enforcement is one console toggle for
the whole `auntieos-ttpc` database; it would simultaneously break AuntieOS
admin clients, the legacy web app, and desktop on the day it flips. Firestore
rules are already the tenant boundary and are strong (that was their job
before App Check existed). Storage same reasoning. Firebase Auth App Check
enforcement is likewise deferred; the Identity Toolkit reCAPTCHA interceptor
in `web/src/lib/auth.ts` already covers the auth surface's abuse case.
Revisit service-level enforcement only when every live client of the project
attests (earliest: after the S8 AuntieOS rebuild ships with App Check), and
treat that as a fresh go/no-go, not a scheduled follow-through.

**Do not enable replay protection** (`consumeAppCheckToken` /
limited-use tokens) on any function. It adds a billed server round-trip per
call and defends against a threat (single-token replay inside its TTL) that
`req.auth` already bounds for this surface. Off the table until an actual
incident argues otherwise.

---

## D3. Grace mode: length, flip signal, kill switch

**Monitor-only period: minimum 14 days, AND-gated with a traffic signal.**
Fourteen days covers two full weekly usage cycles (Auntie visits and kinfolk
check-ins are weekly-patterned). The flip from `log` to `enforce` for a
cohort requires ALL of:

1. **≥ 14 days** since both the web provider and the Android provider shipped
   to production clients (clock starts at whichever shipped later).
2. **≥ 99.5% of requests from portal/Android origins carry valid tokens**,
   per-function across the cohort, over the trailing 7 days, measured from
   the L1 wrapper logs filtered by origin (this is why L1 logs origin:
   legacy-app traffic must be excluded from the denominator or the metric is
   meaningless until cutover). Sample Logs Explorer filter:
   `jsonPayload.origin="https://mytribe-kinfolk-beta.web.app" AND jsonPayload.appCheck="absent"`.
   The goal is that this query returns near-nothing.
3. **Zero unresolved user-facing incidents** attributable to App Check in the
   monitoring window (Sentry + the wrapper failure logs).

The 0.5% allowance exists because reCAPTCHA Enterprise legitimately fails for
a small tail (aggressive privacy extensions, corporate proxies stripping
scripts). If the observed absent-rate from portal origins sits above 0.5%
after 14 days, do not lower the bar. Investigate the tail first; those are
real kinfolk.

**Kill switch, post-flip:**
- L2 enforcement: flip `business_settings/security.appCheckMode` back to
  `log`. Takes effect within the 60s cache TTL. No deploy, no console, doable
  from the Firestore console on a phone. This is the incident-response path
  and the reason L2 exists at all.
- L3 platform enforcement: requires a functions deploy to revert
  (~10+ minutes, no CI). Acceptable only because L3 is never flipped until
  L2 has already run clean for 7+ days on the same cohort. L3 reverts should
  never be an emergency.
- Service-level (Firestore/Storage): console toggle, instant. Per D2 we are
  not enforcing these anyway.

**Debug tokens (local dev + future CI):**
- Web: in `web/src/lib/firebase.ts`, before `initializeAppCheck`, set
  `self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN`
  guarded by `import.meta.env.DEV` so it is dead code in production bundles.
  Each developer registers their token in the App Check console; tokens are
  per-browser secrets. Never commit one.
- Android: `DebugAppCheckProviderFactory` in debug builds only (source-set or
  `BuildConfig.DEBUG` gate), token registered in console.
- CI (arrives S7 per plan): mint a dedicated debug token stored as a CI
  secret. Note for the S7 session; nothing to do now.
- Token TTLs: keep the 1-hour defaults on both providers. Shorter buys
  nothing at this threat level and multiplies assessment volume.

---

## Rollout sequence (for the implementing session)

Each phase ends with an explicit gate. Do not start a phase before the prior
gate passes.

**Phase 0: console prep (no deploy, no code).**
Create the dedicated reCAPTCHA Enterprise key (D1 domains). In Firebase
console → App Check: register the web app with that key and the Android app
with Play Integrity; leave every service and function UNENFORCED. Confirm the
App Check metrics page starts rendering.
*Gate: both apps show as registered; nothing enforced anywhere.*

**Phase 1: telemetry + web client.**
- `functions/src/lib/wrapCallable.ts`, `wrapAdminCallable.ts`: add
  `appCheck` + `origin` fields to both success and failure `logEvent` calls
  (L1). No behavior change.
- `web/src/lib/firebase.ts`: `initializeAppCheck` with
  `ReCaptchaEnterpriseProvider` and `isTokenAutoRefreshEnabled: true`,
  immediately after `initializeApp`, before anything grabs
  functions/firestore handles. Dev-only debug-token block per D3.
- Verify CSP/connect-src on the hosting headers allows
  `https://www.google.com/recaptcha/` and `https://www.gstatic.com/recaptcha/`
  plus the App Check exchange endpoint
  (`https://content-firebaseappcheck.googleapis.com`). The claim-flow work
  already opened recaptcha origins; verify rather than assume, and test on
  the DEPLOYED origin, since localhost alone was misleading before (S2
  stale-CORS gotcha).
- Deploy functions + hosting. Remember the standing deploy rules: gen2
  functions keep their `secrets:` arrays intact, and watch for the
  empty-IAM-policy gotcha.
*Gate: portal traffic on the beta origin shows `appCheck:"valid"` in wrapper
logs; App Check console shows verified web requests; legacy-app and AuntieOS
traffic unaffected (their requests log `absent` and still succeed).*

**Phase 2: Android client.**
`src/androidMain`: add the `firebase-appcheck-playintegrity` dependency,
install `PlayIntegrityAppCheckProviderFactory` in the Application class
(debug factory in debug builds). Blocked on OWNER-1 (Play Console
registration). If OWNER-1 stalls, Phases 3 and 4 may proceed for web-only
cohort-1 functions, but the D3 clock rule still applies: the 14-day clock for
any cohort an Android client calls starts only when Phase 2 ships.
*Gate: a release-build device shows `appCheck:"valid"` on its callable logs.*

**Phase 3: grace period (monitor only).**
Run the D3 window. Weekly: check the Logs Explorer absent-from-portal-origin
query and the App Check console metrics. Build the cohort-1 function list
into `functions/src/lib/` while waiting (code-reviewed, mode still `off`).
*Gate: all three D3 flip conditions met for cohort 1.*

**Phase 4: L2 soft-enforce, cohort 1.**
Implement the `appCheckMode` read (60s cached) + rejection path in
`wrapCallable`; seed `business_settings/security { appCheckMode: 'log' }`;
deploy; confirm `log` mode logs would-have-rejected counts of ~zero for 48h;
then flip the field to `enforce`. Watch Sentry + failure logs for 7 days.
*Gate: 7 clean days enforced. Rollback drill: flip the field back to `log`
once, confirm sub-60s effect, flip forward again. Do this ON PURPOSE before
declaring the phase done, so the kill switch is a tested path, not a theory.*

**Phase 5: cohort 2 (post-cutover).**
After S7 retires `src/jsMain` plus one quiet week (OWNER-2 sets the exact
date): extend cohort membership to the full `wrapCallable` surface, repeat
Phase 4's log→enforce ladder. After 7 clean days, apply L3
(`...APP_CHECK_ENFORCED` shared constant) to cohorts 1+2 and deploy.
*Gate: L3 deployed, zero regression week.*

**Phase 6: cohort 3 and services (S8+, not this ruling's execution).**
Admin callables after AuntieOS attests (OWNER-4). Firestore/Storage
service enforcement gets its own go/no-go review then, and is explicitly NOT
pre-approved by this document.

---

## OWNER input needed (not mine to rule)

- **OWNER-1 [BUILD]:** Will the Android app be registered in the Play Console
  (internal testing track is enough)? Play Integrity, and therefore all of
  Android App Check, is blocked until yes. If the answer is a permanent no,
  say so and I will rule on the ugly alternatives (custom provider vs
  web-only App Check) separately.
- **OWNER-2 [PROD]:** The calendar. My recommended defaults are baked into
  the phases (14-day grace, cutover + 1 quiet week for cohort 2, +7 days for
  L3), but real families are on this backend and the owner owns the risk
  appetite on dates. Confirm or adjust the two anchors: cohort-1 flip date,
  and cohort-2-after-cutover offset.
- **OWNER-3 [PROD]:** Desktop Compose fate at cohort-2 time: mint custom
  App Check tokens for it (small Admin-SDK endpoint, owner-only), or accept
  that the owner-personal desktop app loses callable access after cohort-2
  L3 and the owner uses the portal. Decide by cutover week.
- **OWNER-4 [BUILD]:** Schedule the AuntieOS App Check workstream into S8.
  It is the prerequisite for cohort 3 and for ever enforcing Firestore.
- **OWNER-5 [VALUE]:** Billing acknowledgment: reCAPTCHA Enterprise bills per
  assessment past the monthly free tier on `auntieos-ttpc`. At current beta
  scale with 1-hour token TTLs this rounds to zero, but it is a new billable
  SKU on the project and the owner should see it appear.
