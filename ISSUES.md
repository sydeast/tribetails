# MyTribe — Open Issues / E2E Test Backlog

Each entry is an open issue AND a future end-to-end test. Status legend:
`OPEN` = not started · `WIP` = in flight · `BLOCKED` = needs decision/info · `FIXED` = code merged · `VERIFIED` = manually confirmed across all 3 platforms (web, desktop, android).

**Platform parity is non-negotiable**: every fix must be confirmed on web + desktop + android before VERIFIED.

---

## Critical / Blocking

### #1 Web target won't load after Phase 1 redesign
- **Status**: OPEN
- **Platforms affected**: js (web)
- **Symptom**: Page does not render. Last known good state had `[MyTribe] Firebase initialized` + `ComposeViewport mounted` console lines.
- **Suspects**:
  - Material3 `NavigationBar` / `ModalNavigationDrawer` not yet wired for Kotlin/JS Compose Multiplatform
  - Webpack bundle picking up stale module after dir deletes
  - `kotlin-js-store/yarn.lock` cached against deleted modules
- **Repro**: `./gradlew jsBrowserDevelopmentRun` → open localhost:8080
- **E2E test**: launch web → expect TabShell + bottom nav visible
- **Fix actions**:
  - [ ] Capture console output (`Cmd+Opt+J`) and add to this issue
  - [ ] `./gradlew clean kotlinNpmInstall jsBrowserDevelopmentRun`
  - [ ] If still blank, swap Material3 NavigationBar for Material 1 BottomNavigation as fallback for JS

### #2 Desktop NoTribes copy needs onboarding language
- **Status**: FIXED (this commit) — pending VERIFIED
- **Platforms affected**: all
- **Old copy**: "You're not part of a Tribe yet. Ask your Auntie for an invite."
- **New copy**: see `KinfolkPortalAppGuarded.kt`
- **E2E test**: signed-in user with empty `clients/{uid}.kinfolkIds` → see welcome onboarding card with "Message Auntie" CTA

### #3 Owner account missing `clients/{uid}` doc — locked out on web/desktop
- **Status**: FIXED (this commit) — pending VERIFIED
- **Symptom**: After removing operators path, `tribetails@tribetails.com` (uid `nppJNdMNYJfUigibGKUQj3n4obt2`) has no kinfolkIds → routed to NoTribes everywhere
- **Fix**: seed `clients/nppJNdMNYJfUigibGKUQj3n4obt2` with `kinfolkIds: ["demo-family-001", "demo-family-002"]`
- **E2E test**: sign in → see TribePicker with 2 tribes → pick → land in TabShell

---

## Phase 2A scope (Functions translation layer)

### #4 Functions translation layer — `getMyHome`
- **Status**: OPEN
- **Goal**: kinfolk app calls `getMyHome` → returns `{ kinfolkId, displayName, currentVisit?, upcomingBookings, recentBookings }`
- **E2E test**: real kinfolkId resolves real displayName from AuntieOS schema (currently dummy)

### #5 Functions translation layer — `getMyKin`
- **Status**: FIXED — pending deploy + VERIFIED
- **Function**: `functions/src/portal/getMyKin.ts`
- **Source**: `families/{kinfolkId}/kin/{kinId}` structured docs. `legacyKinId` field links to AuntieOS `411/{kinId}` for AI blurb.
- **DTO**: `Kin` with status `active|noLongerWithUs`, AI blurb merged from `411`
- **Screens**: `KinScreen.kt` rewrite + new `KinDetailScreen.kt`
- **Add Kin button**: disabled — needs `addKin` Function + form
- **Schema gap**: structured `families/{fid}/kin/*` is empty in production. Owner must seed or AuntieOS must write.
- **Deploy**: `firebase deploy --only functions:getMyKin --project auntieos-ttpc`
- **E2E test**: 0 kin → empty state ✓, active grouped above NoLongerWithUs ✓, tap → detail ✓

### #6 Functions translation layer — `getMyKinTales`
- **Status**: FIXED — pending deploy + VERIFIED
- **Function**: `functions/src/portal/getMyKinTales.ts`
- **Source**: `families/{kinfolkId}/kinTales/*` (AuntieOS writes via `ingestKinTale`). Read-only.
- **Pagination**: `before` cursor = sentAt epoch millis, max 50/page
- **DTO**: `KinTale` with `body, authorDisplayName, mediaIds, sentAtMs, shared`
- **Screen**: `KinTalesScreen.kt` rewrite — All/Lore/Gallery filter chips, share icon if `shared`, photo-count badge, Load More button
- **Media URLs**: not resolved yet — only `mediaIds` shown as count badge. Phase 2C: `getMyKinTaleMedia(taleId)` returns signed Storage URLs.
- **Deploy**: `firebase deploy --only functions:getMyKinTales --project auntieos-ttpc`
- **E2E test**: filter chips switch view ✓, recent first ✓, Load More extends list ✓ wired

### #7 Functions translation layer — `getMyInvoices`
- **Status**: FIXED — pending deploy + VERIFIED
- **Function**: `functions/src/portal/getMyInvoices.ts`
- **Client wrapper**: `PortalApi.getMyInvoices(kinfolkId)`
- **Screen**: `InvoicesScreen.kt` rewrite + new `InvoiceDetailScreen.kt`
- **Heuristic**: `amountDue == 0` → paid (production data uses string `status: "Yes"/"No"` for "viewed", not paid-state)
- **Date sort**: lexical on long-form English dates — bug, fix when AuntieOS writes ISO timestamps
- **Pay button**: disabled — phase 2C `payInvoice`
- **Deploy**: `firebase deploy --only functions:getMyInvoices --project auntieos-ttpc`
- **E2E test**: open shown above paid; tap invoice → detail view loads ✓ wired

### #8 Functions translation layer — `getMyBookings` (replaces getMySchedule)
- **Status**: FIXED — pending deploy + VERIFIED
- **Function**: `functions/src/portal/getMyBookings.ts`
- **Source**: `families/{kinfolkId}/bookings/*` (greenfield, MyTribe-owned schema)
- **Returns**: `{liveVisit, upcoming[], recent[]}` — already split server-side
- **Schema (greenfield)**: `{status: requested|confirmed|enRoute|active|completed|cancelled, serviceType, title, startTime, endTime, kinIds, kinNames, auntieDisplayName, auntieAvatarUrl, notes, requestedByUid, createdAt, updatedAt, visitProgress: confirmed|enRoute|active|ended}`
- **Deploy**: `firebase deploy --only functions:getMyBookings --project auntieos-ttpc`
- **Wired**: `HomeScreen` (live + upcoming + recent), `ScheduleScreen` (upcoming + past)

### #9 Functions translation layer — write paths
- **Status**: FIXED — pending deploy + VERIFIED
- **Done**:
  - `requestBooking` — kinfolk-initiated booking request, status='requested'
  - `saveTribeProfile` — `families/{kid}.{displayName, customFields}` merge
  - `saveHomeAccess` — `families/{kid}/homeAccess/current` merge with `updatedByUid`
  - `getMyNotificationPrefs` + `saveMyNotificationPrefs` — `clients/{uid}.notificationPrefs` map
  - `getMyAccount` + `saveMyAccount` — Firestore profile + Firebase Auth `displayName` mirror
  - `getMyTribeProfile` — read for the editable Tribe screen
  - `payInvoice` — Stripe **Checkout Session** (cross-platform URL); `successUrl`/`cancelUrl` from caller; webhook updates `paymentStatus` via metadata
  - `addKin` / `updateKin` / `archiveKin` — full CRUD on `families/{kid}/kin/*` with Active ↔ NoLongerWithUs toggle
  - `addSecondaryContact` — MyTribe-flavored wrapper, creates `inviteRequests` doc that AuntieOS' `acceptInvite` resolves
  - `getMyKinTaleMedia` — signed Storage URLs per `mediaIds[]`, 60min TTL
- **Still deferred** (truly out-of-scope for Phase 2):
  - `updateBillingDetails` — full Stripe customer/payment-method management; Checkout Session covers the immediate pay flow
  - Photo upload for Add Kin (`Storage.upload` from client) — uses `photoUrl` field for now
- **Deploy**: `firebase deploy --only functions --project auntieos-ttpc`
- **E2E test**: each mutation reflects on next read; firestore docs visible in console; Stripe Checkout opens in browser

---

## Phase 2B scope (UI -> data)

### #10 Header family name resolution
- **Status**: FIXED — pending VERIFIED
- **Wired**: `KinfolkPortalAppGuarded` calls `getMyHome` after kinfolkId resolves; passes `displayName` to TabShell. Falls back to `"The {id} Tribe"` only when Function throws.

### #11 Live Visit card on Home
- **Status**: FIXED — pending real-data verify
- **Wired**: `HomeScreen.kt` shows auntie + service type + LIVE pill + 4-step progress timeline (Confirmed → En Route → Active → Ended)
- **Source**: `getMyBookings.liveVisit` when status in {enRoute, active}
- **Visual gap**: no auntie avatar yet (needs `auntieAvatarUrl` populated by AuntieOS or Storage signed-URL resolver)

### #12 Glass card visual fidelity
- **Status**: OPEN — visual polish pass after data wiring
- **Notes**: Mockups show subtle real blur. Current uses translucent fill only. Acceptable for v1.

---

## Cross-cutting infra

### #13 App Check
- **Status**: OPEN
- **Why**: Firebase project hardening + abuse prevention before public release
- **Tasks**: register App Check provider per platform (Play Integrity, reCAPTCHA, DeviceCheck-via-web), client init, enforce on rules + functions

### #14 Crashlytics + Analytics + Sentry
- **Status**: OPEN
- **Notes**: Sentry stub exists for js; nothing wired on android/jvm. Crashlytics gradle plugin not on classpath.

### #15 Deep linking + claim invite flow
- **Status**: FIXED — pending VERIFIED
- **Wired**:
  - commonMain `ClaimInviteScreen` calls existing `acceptInvite` Function
  - `expect fun readInitialClaimInviteId()` with platform actuals:
    - js: parses `#/claim/<id>` or `/claim/<id>`
    - jvm: `--claim=<id>` arg parsed in Main
    - android: `MainActivity.onCreate` + `onNewIntent` extract from `intent.data`
  - `KinfolkPortalAppGuarded` checks invite first, routes to ClaimInviteScreen, calls `acceptInvite`, then resumes auth flow
  - AndroidManifest filters: `https://kinfolk.tribetails.com/claim/*` (autoVerify) + custom scheme `mytribe://claim/...`
- **Production setup**: assetlinks.json on `kinfolk.tribetails.com/.well-known/assetlinks.json` for autoVerify Android App Links

### #16 PWA / install prompt
- **Status**: FIXED — pending VERIFIED
- **Files**:
  - `src/jsMain/resources/manifest.webmanifest` — name, theme_color #DF8431, background #FBFBF9, icons 192/512
  - `src/jsMain/resources/service-worker.js` — stale-while-revalidate for app shell, network-only for Functions/Firestore
  - `src/jsMain/resources/index.html` — registers worker + theme-color meta + manifest link
- **Missing assets**: drop `icon-192.png` + `icon-512.png` into `src/jsMain/resources/`
- **Install prompt**: browsers will offer "Add to Home Screen" once worker + manifest serve over HTTPS

### #17 Storage rules + KinTale media uploads
- **Status**: FIXED (rules) — uploads still TODO
- **Rules paths**:
  - `families/{kinfolkId}/kinTales/{taleId}/{mediaId}` — read by family/Auntie, write Auntie-only
  - `families/{kinfolkId}/kin/{kinId}/{filename}` — read+write family + Auntie
  - `families/{kinfolkId}/profile/{filename}` — same
  - everything else denied
- **Auth model**: requires custom claim `request.auth.token.role == 'kinfolk'` + `kinfolkId` claim; AuntieOS sets these via `setKinfolkClaim` (need to verify Function exists or write it)
- **TODO**: client-side photo picker + upload helper (commonMain expect/actual)

### #18 Firestore composite indexes for new screens
- **Status**: FIXED — pending deploy + VERIFIED
- **Added to `firestore.indexes.json`**:
  - `invoices(kinfolkId asc, amountDue desc)` — open-first sort
  - `invoices(kinfolkId asc, dueDate asc)` — overdue sort
  - `bookings(status asc, startTime asc)` — collection-group across all family bookings
  - `bookings(requestedByUid asc, createdAt desc)` — "my requested bookings" lookup
  - `kinTales(sentAt desc)` — collection-group recent feed
- **Deploy**: `firebase deploy --only firestore:indexes --project auntieos-ttpc`

### #19 FCM client wiring
- **Status**: PARTIAL FIXED — server-side complete, client-side platform code TODO
- **Server**: `functions/src/portal/registerFcmToken.ts` + `unregisterFcmToken` — `fcm_tokens/{token}` doc with uid + platform + appVersion + lastSeenAt
- **PortalApi**: `registerFcmToken(token, platform, appVersion)` / `unregisterFcmToken(token)` ready
- **Client TODO**:
  - Android: `FirebaseMessagingService` subclass, register manifest `<service>`, override `onNewToken` calling `PortalApi.registerFcmToken(it, "android")`
  - Web: `getMessaging(app).getToken()` via gitlive, register service worker handler
  - JVM desktop: no FCM (Firebase doesn't support JVM client) — skip

### #20 No JDK 17 toolchain auto-download
- **Status**: FIXED
- **Fix**: added `id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"` to `settings.gradle.kts`. Gradle auto-resolves JDK17 from foojay disco when not installed.

---

## TDD test harness (separate from above issues)

Goal: each issue above gets a corresponding e2e test in `src/commonTest/` (logic) + a manual platform check until UI test runner exists.

### Suite #1 — Routing
- signed-out → SignIn screen
- signed-in + 0 kinfolkIds → NoTribes onboarding
- signed-in + 1 kinfolkId → TabShell
- signed-in + 2+ kinfolkIds → TribePicker → TabShell on pick

### Suite #2 — Tab nav
- bottom nav 5 entries Home/Schedule/KinTales/Kin/Invoices
- drawer 3 entries Tribe Profile/Account Settings/Notification Settings + Sign Out
- selected state visual matches brand orange

### Suite #3 — Auth
- email/password sign-in succeeds
- sign-out clears state on every platform
- desktop refresh-token survives app restart (Preferences-backed)

### Suite #4 — Data (post-Phase-2)
- one E2E per `getMy*` Function
- one E2E per write Function

### Suite #5 — commonTest harness landed (PASSING)
- **Files**: `src/commonTest/.../firebase/FakeFunctionsClient.kt`, `portal/PortalApiTest.kt`, `util/FormatTest.kt`, `util/RelativeTimeTest.kt`
- **Coverage**:
  - `PortalApi` — `getMyHome`, `getMyHome` missing field, `getMyInvoices` open/paid split, `getMyKin` active vs noLongerWithUs, `getMyBookings` liveVisit + visitProgress, `payInvoice` URL forwarding, `getMyKinTales` empty, `getMyAccount` missing optionals (8 tests)
  - `formatUsd` — zero, decimals, thousands, large, negative, rounding (6 tests)
  - `relativeTime` — null, just now, mins, hours, days, month-day fallback (6 tests)
- **Run**: `./gradlew jvmTest`
- **Result**: 21/21 passing

### Suite #6 — Functions unit tests (PASSING)
- **Helper**: `functions/test/_helpers/mockDb.ts` — fake Firestore with chainable where/orderBy/limit, doc tree, recorded writes/adds/deletes
- **Files** (one per portal Function): `getMyHome.test.ts`, `getMyInvoices.test.ts`, `getMyKin.test.ts`, `getMyBookings.test.ts`, `requestBooking.test.ts`, `getMyKinTales.test.ts`, `getMyTribeProfile.test.ts`, `saveTribeProfile.test.ts`, `saveHomeAccess.test.ts`, `notificationPrefs.test.ts`, `account.test.ts`, `payInvoice.test.ts`, `kinWrites.test.ts`, `addSecondaryContact.test.ts`, `registerFcmToken.test.ts`, `getMyKinTaleMedia.test.ts`, `onClientsWrite.test.ts`
- **Coverage**: every portal Function — auth check, kinfolkId scoping, response shape, edge cases (missing docs, fully-paid invoices, ownership of FCM tokens, custom-field arrays, server-timestamp mocking, Stripe Checkout payload assertions)
- **Run**: `cd functions && npm test`
- **Result**: 130/130 passing (57 new + 73 pre-existing)

### Combined suite total: 222+ tests, 0 failures

---

### #21 Booking workflow must mirror AuntieOS 5-step wizard
- **Status**: WIP — TDD red phase
- **Current**: `ScheduleScreen` opens a single dialog with free-text service + notes. Shipped, parity gap.
- **Target** (per AuntieOS mockups): wizard with 5 steps
  1. Select Client & Pets — kinfolk picks Kin (multi-select) from their own roster
  2. Choose Service — pulled live from Firestore `base_services` collection
  3. Schedule Dates — Individual Dates (multi-pick calendar) OR Repeating Schedule (weekly pattern); per-visit time + service override
  4. Invoice Options — new invoice / attach to existing
  5. Review & Confirm — full breakdown, "Create Booking" submit
- **Server work**:
  - New `getServiceCatalog` Function (read `base_services`, scope-public)
  - Extend `requestBooking` to accept `visits: Array<{startTimeMs, endTimeMs?, serviceId, serviceName, priceCents}>` + `kinIds[]` + `pattern: individual|weekly`
  - One Firestore doc per visit OR one parent with `visits` subcollection
- **Client work**:
  - `Service` DTO + `getServiceCatalog` wrapper
  - `BookingVisit` DTO
  - 5-step Composable wizard with state holder
  - Replace `RequestBookingDialog` with launch into wizard
- **Tests** (must fail before implementation):
  - Function: `getServiceCatalog` auth/scope/decode
  - Function: extended `requestBooking` accepts visits[] + creates N docs
  - Kotlin: `PortalApi.getServiceCatalog()` + `requestBookingMultiVisit`
  - UI: each wizard step renders + advances

---

Updated: continuously.
