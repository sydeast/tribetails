> ARCHIVED SNAPSHOT (pre-2026-06-18). Superseded by the current /SESSION_RECAP.md. Kept for history.

# MyTribe — Session Recap (resume cold)

Last worked: 2026-05-07. Pair this file with [ISSUES.md](ISSUES.md) (open issues + e2e tracker).

---

## Project state

**MyTribe** = Kotlin Multiplatform Compose app (jvm desktop, android, js web). Kinfolk-facing pet-care client portal.

**AuntieOS** = separate codebase (`~/Documents/TribeTails_Docs/.../AuntieOS/...`). Operator/admin only. **Never gets MyTribe screens. Never accepts kinfolk login.**

**Project ID**: `auntieos-ttpc`. Single Firebase project shared by both apps via different auth tiers + Functions translation.

**No iOS. No wasm.** Both deleted. Don't reintroduce.

---

## Architecture (locked decisions)

- **Path C** — Cloud Functions translation layer. Client never reads AuntieOS-shaped Firestore directly. Every read = a `getMy*` callable that scopes by `clients/{auth.uid}.kinfolkIds`.
- **Auth uid → kinfolkId mapping**: lives in `clients/{authUid} = { kinfolkIds: List<String>, email, createdAt }`. NOT devices (`fcm_tokens` covers that).
- **Three Firebase clients**:
  - **android + js**: gitlive-firebase Kotlin SDK
  - **jvm desktop**: Ktor + Firebase REST (gitlive on JVM is the Admin SDK — wrong tier)
- **Source set hierarchy**: `commonMain` ← `firebaseMain` (gitlive deps) ← {androidMain, jsMain}. `jvmMain` depends on commonMain only + own REST impls.
- **Theme**: locked Tribe Tails brand. Cream `#FBFBF9`, Navy `#11131F`, Kinfolk Orange `#DF8431` PRIMARY, Pack Pink `#D55C87`, Kin Teal `#0A8595`, Family Purple `#74538A`, Snuggle Coral `#D5535A`. Glass = white@62% + white@55% border (no native blur).
- **Naming canon**: collection `kinTales` (camelCase), `homeAccess` (not `access`). UI labels "KinTales", "Home Access".
- **Two AI summary collections** (read-only, AuntieOS owns writes): `411/{kinId}` = AI personality blurb per pet, `dossiers/{kinfolkId}` = AI relationship blurb per household.

---

## What ships in code today

### Phase 0 (foundation, done)
- KMP project compiles for jvm + android + js. JVM uses Ktor REST against Firebase.
- Sign-in via Firebase Auth email/password works on all 3 platforms. JVM persists refresh token via `java.util.prefs`.
- `KinfolkPortalAppGuarded` is the entry composable on every platform.

### Phase 1 (UI redesign, done)
- Theme v2 with locked palette + glass tokens (`theme/Theme.kt`)
- Reusable components: `GlassCard`, `ScreenHeader`, `EmptyState`
- Bottom-nav 5-tab shell (`nav/TabShell.kt`): Home / Schedule / KinTales / Kin / Invoices
- Drawer (`nav/TabRoute.kt`): Tribe Profile / Account Settings / Notification Settings + Sign Out
- 8 empty-state screens with brand styling:
  - `screens/home/HomeScreen.kt`
  - `screens/schedule/ScheduleScreen.kt`
  - `screens/kintales/KinTalesScreen.kt` (Lore/Gallery tabs)
  - `screens/kin/KinScreen.kt`
  - `screens/invoices/InvoicesScreen.kt`
  - `screens/tribe/TribeScreen.kt`
  - `screens/account/AccountSettingsScreen.kt`
  - `screens/notifications/NotificationSettingsScreen.kt` (per-channel matrix: email/sms/push)
- Branded `NoTribesOnboarding.kt` replaces old "you're not part of a Tribe" text
- LaunchRouter simplified — kinfolk-only, drops Admin/operators path
- Mass purge: KinfolkDashboard, KinfolkPortalApp, KinfolkShaderBackdrop, all `transaction/*` demo modules, AdminHomeScreen (admin-only — belongs in AuntieOS), wasmJsMain/, iOS allowlist entries, orphan ClaimInviteScreen + AccountSettingsAuthPane.

### Phase 3 — Hardening batch landed

- **Deep linking + claim invite flow**: commonMain `ClaimInviteScreen` calls `acceptInvite`. `expect fun readInitialClaimInviteId()` with platform actuals (js URL parsing, jvm `--claim=` arg, android `intent.data`). AndroidManifest gains `https://kinfolk.tribetails.com/claim/*` autoVerify filter + `mytribe://claim/*` custom scheme.
- **PWA**: `manifest.webmanifest`, `service-worker.js` (stale-while-revalidate app shell, network-only Functions/Firestore), `index.html` registers worker + theme-color. Drop `icon-192.png` + `icon-512.png` into `src/jsMain/resources/` to complete.
- **Composite indexes**: invoices (×2), bookings (collection-group ×2), kinTales (collection-group). Deploy with `firebase deploy --only firestore:indexes`.
- **Storage rules**: read+write scoped to `families/{kinfolkId}/...` paths with kinfolk custom claim. KinTale media write Auntie-only.
- **FCM Functions**: `registerFcmToken` / `unregisterFcmToken`. `PortalApi.registerFcmToken(token, platform, appVersion)`. Client-side Android service + Web `getMessaging` token still TODO.
- **Custom claim sync**: `onClientsWrite` trigger mirrors `clients/{uid}.kinfolkIds[0]` into Firebase Auth `role: 'kinfolk'` + `kinfolkId` claim — required so AuntieOS rules + Storage rules see this user as a kinfolk.
- **commonTest harness**: `FakeFunctionsClient` + 20 unit tests across PortalApi (8), formatUsd (6), relativeTime (6).

### Phase 2 — COMPLETE (read + write + payments + media)

All Cloud Functions added, all 8 screens wired, payments live via Stripe Checkout, Kin CRUD live, Secondary Contact invite live, KinTale media signed URLs live, Firestore rules updated. Truly deferred: full Stripe customer / saved-card management (`updateBillingDetails`) and direct client-side photo upload to Storage (`photoUrl` field accepted today).

**Portal Functions (all read-scoped by `clients/{auth.uid}.kinfolkIds`)**:
- `getMyHome` — kinfolkId + displayName
- `getMyBookings` — `{liveVisit, upcoming[], recent[]}` from `families/{kid}/bookings/*`
- `requestBooking` — creates booking with status='requested'
- `getMyKin` — `families/{kid}/kin/*` + `411/{legacyKinId}` AI blurb merge
- `getMyKinTales` — paged `families/{kid}/kinTales/*` (read-only; AuntieOS writes)
- `getMyInvoices` — flat `invoices` filtered by kinfolkId; open/paid split
- `getMyTribeProfile` — `families/{kid}` + `families/{kid}/homeAccess/current`
- `saveTribeProfile` — merges into `families/{kid}`
- `saveHomeAccess` — merges `families/{kid}/homeAccess/current`
- `getMyNotificationPrefs` / `saveMyNotificationPrefs` — `clients/{uid}.notificationPrefs` map
- `getMyAccount` / `saveMyAccount` — Firestore + Firebase Auth profile mirror
- `payInvoice` — Stripe Checkout Session, opens via `openExternalUrl` cross-platform
- `addKin` / `updateKin` / `archiveKin` — kin CRUD with active/noLongerWithUs status
- `addSecondaryContact` — creates `inviteRequests` doc (AuntieOS' `acceptInvite` finishes the flow)
- `getMyKinTaleMedia` — signed Storage URLs (60min TTL) for `families/{kid}/kinTales/{tid}/{mediaId}`

**Bookings schema (greenfield, MyTribe-owned)**: at `families/{kinfolkId}/bookings/{id}`:
```
status: requested|confirmed|enRoute|active|completed|cancelled
serviceType, title
startTime, endTime (Timestamps)
kinIds, kinNames
auntieDisplayName, auntieAvatarUrl
notes
requestedByUid, createdAt, updatedAt
visitProgress: confirmed|enRoute|active|ended  (only meaningful when status=active)
```
AuntieOS will write status transitions + auntieDisplayName. Rules + indexes still need to be authored (issue #18).

**Kotlin DTOs added**: `Booking, BookingStatus, VisitProgress, BookingsResult`, `TribeProfile, HomeAccess, CustomField, TribeProfileResult`, `Account, NotificationPrefs`, `Kin, KinStatus`, `KinTale, KinTalesResult`, `Invoice, InvoicesResult`.

**Screen wires**:
- HomeScreen — Live Visit + Up Next + Recent (real bookings) + 4-step progress timeline
- ScheduleScreen — upcoming + past + Request Booking dialog (creates booking via `requestBooking`)
- KinTalesScreen — All/Lore/Gallery filter, share icon, photo-count badge, Load More
- KinScreen — active + No Longer With Us groups, tap → KinDetailScreen with AI blurb + care details
- InvoicesScreen — open/paid split, tap → InvoiceDetailScreen (Pay button disabled until 2C)
- TribeScreen — Tribe Profile (displayName + customFields) + Home Information (gateCode/keyLocation/wifi + customFields) + Save
- AccountSettingsScreen — Profile (display name, phone) + Recovery (backup email/phone) + Billing placeholder + Save + Sign Out
- NotificationSettingsScreen — 6 categories × 3 channels (email/sms/push) checkbox matrix + Save

### Phase 2A (Functions translation scaffold, done)
- Common interface `firebase/FunctionsClient.kt`
- Gitlive impl `firebaseMain/firebase/GitliveFunctionsClient.kt`
- JVM REST impl `jvmMain/firebase/RestFunctionsClient.kt` (Bearer token + JSON ↔ Map conversion both directions)
- Typed wrapper `portal/PortalApi.kt` with `getMyHome(kinfolkId)`
- Cloud Function `functions/src/portal/getMyHome.ts` — registered in `functions/src/index.ts`, callable, returns `{kinfolkId, displayName, currentVisit:null, upcomingBookings:[], recentBookings:[]}`. Auth-scoped by `clients/{uid}.kinfolkIds`. Falls back: `families/{id}.displayName` → `dossiers/{id}.kinfolkName` → `"Tribe {id}"`.
- `KinfolkPortalAppGuarded` now calls `getMyHome` after kinfolkId resolves → real header name everywhere.
- Seeded `clients/nppJNdMNYJfUigibGKUQj3n4obt2` (owner uid `tribetails@tribetails.com`) with `kinfolkIds: [demo-family-001, demo-family-002]` so login on web/desktop hits TribePicker instead of NoTribes.

---

## Production data shape (read-only intel)

Top-level Firestore collections used by AuntieOS (do not modify schema):

| Collection | Key | Owner | Purpose |
|---|---|---|---|
| `411` | `kinId` (int string) | AuntieOS | AI summary per pet |
| `dossiers` | `kinfolkId` (int string) | AuntieOS | AI summary per household |
| `invoices` | invoiceNumber | AuntieOS | flat invoices, `kinfolkId` field |
| `business_hours` | auto | AuntieOS | service catalog |
| `booking_time_slots` | auto | AuntieOS | available slots |
| `base_services` | auto | AuntieOS | service definitions |
| `discounts` | auto | AuntieOS | promo codes |
| `generated_drafts` | auto | AuntieOS | AI-drafted comms |
| `fcm_tokens` | auto | shared | push targeting |
| `fcm_messages` | auto | shared | push log |
| `emailTemplates` | name | shared | sendgrid templates |
| `journal_import_staging` | auto | AuntieOS | import staging |
| `admins` | auth uid | shared | admin grants |
| `families` | fid | MyTribe | display name only (mostly empty) |
| `clients` | auth uid | MyTribe | uid → kinfolkIds (1 doc seeded) |
| `operators` | auth uid | (deprecated for MyTribe) | operator grants |

**No `bookings` collection exists in either schema** — Schedule/Home Live Visit screens are blocked on greenfield design.

---

## Pick up here

### Right-now action items (do these next session BEFORE writing code)

1. **Deploy `getMyHome`** — has not been deployed yet:
   ```bash
   firebase deploy --only functions:getMyHome --project auntieos-ttpc
   ```
2. **Verify all 3 platforms** display real family name on every tab:
   ```bash
   ./gradlew jvmRun -DmainClass=com.kinfolk.portal.MainKt
   ./gradlew jsBrowserDevelopmentRun
   ./gradlew assembleDebug && adb install -r build/outputs/apk/debug/kinfolk-portal-debug.apk
   ```
3. **Web is blank — debug console required** (issue #1 in ISSUES.md). If still blank after `clean kotlinNpmInstall`:
   ```bash
   rm -rf build/js build/dist kotlin-js-store/yarn.lock
   ./gradlew clean kotlinNpmInstall jsBrowserDevelopmentRun
   ```
   Open `Cmd+Opt+J`, paste error into ISSUES.md.

### Next code phase (Phase 2B-Invoices recommended)

Smallest screen with real data. Reads `invoices` flat collection filtered by `kinfolkId`.

**Files to create**:
- `functions/src/portal/getMyInvoices.ts` — callable. Auth-scope by clients map. Query `invoices where kinfolkId == requested`. Sort by `date` desc. Return `{open: [...], paid: [...]}` based on `status`/`amountDue` heuristic.
- `src/commonMain/.../portal/PortalApi.kt` — add `getMyInvoices(kinfolkId)` wrapper.
- `src/commonMain/.../portal/InvoiceDtos.kt` — `Invoice(id, title, amountCents, dueDate, status, isPaid, ...)`.
- `src/commonMain/.../screens/invoices/InvoicesScreen.kt` — replace empty-state with real cards. Tap → detail screen. Pay button on open.
- `src/commonMain/.../screens/invoices/InvoiceDetailScreen.kt` — new.

**Outstanding decisions before coding 2B-Invoices**:
- Invoice `status` field is `"Yes"`/`"No"` in production data (string!). What semantic? Probably "viewed" or "sent". Need to map `amountDue == 0` → paid? Confirm with owner.
- Stripe payment flow — `payInvoice` Function not written. PaymentIntent path TBD.

### After 2B-Invoices

In order: Kin (`getMyKin` against `411`), KinTales (greenfield collection), Tribe Profile + Home Access (writes — `saveTribeProfile`, `saveHomeAccess` Functions), Account Settings (write paths), Notification Settings (`saveNotificationPrefs`), then Schedule + Home (blocked on bookings schema).

---

## Open issues / blockers

See [ISSUES.md](ISSUES.md). Top priority:
- **#1** Web target blank — needs console output to diagnose
- **#2** NoTribes onboarding copy — fixed, pending visual verify
- **#3** Owner `clients/{uid}` seed — fixed, pending verify
- **#4–#9** Phase 2 Functions to build
- **#20** JDK 17 toolchain not auto-installable — bump to 21 or document

---

## File map (where things live)

```
src/commonMain/kotlin/com/kinfolk/portal/
├── auth/        AuthBackend, AuthRepository, AuthState, AuthProviderId, SignInScreen
├── biometric/   (platform expect/actual)
├── components/  GlassCard, ScreenHeader, EmptyState
├── error/       ErrorEnvelope, OpaqueErrorBanner
├── firebase/    FirestoreClient, FunctionsClient, FirebasePlatform (expect)
├── launch/      LaunchDestination, rememberLaunchDestination, TribePickerScreen
├── nav/         TabRoute, ShellRoute, TabShell
├── portal/      PortalApi, MyHomeResult
├── screens/     home/, schedule/, kintales/, kin/, invoices/, tribe/, account/, notifications/
├── theme/       Theme.kt (KinfolkBrand, KinfolkGradients, KinfolkShapes, KinfolkSpacing, KinfolkTypography, KinfolkPortalTheme)
├── ui/          KinfolkPortalAppGuarded, NoTribesOnboarding
└── util/        Now (expect/actual)

src/firebaseMain/kotlin/com/kinfolk/portal/
├── auth/        FirebaseAuthBackend (gitlive)
└── firebase/    GitliveFirestoreClient, GitliveFunctionsClient, FirebasePlatform.firebase.kt (actuals)

src/jvmMain/kotlin/com/kinfolk/portal/
├── Main.kt
└── firebase/    FirebaseRestConfig, RestHttp, RestAuthClient, RestAuthBackend,
                 RestFirestoreClient, RestFunctionsClient, JvmTokenStore,
                 FirebasePlatform.jvm.kt (actuals)

src/androidMain/kotlin/com/kinfolk/portal/  MainActivity, KinfolkPortalApplication
src/jsMain/kotlin/com/kinfolk/portal/       Main.kt (Firebase.initialize(context=null, options=...))

functions/src/
├── portal/getMyHome.ts        (Phase 2A — needs deploy)
├── admin/                     AuntieOS-side callables (provisionTribe, mintInvite, etc.)
├── auth/                      signOutAllDevices
├── billing/                   stripeWebhook
├── membership/                acceptInvite, etc.
├── recovery/                  swapPrimaryContact, requestPrimaryRecovery
├── share/                     createShareLink, revokeShareLink, getShareLink
├── theme/                     setKinfolkOverrides
├── triggers/                  onAuthUserCreate, onMembersWrite, onKinTaleCreate, onInviteRequestCreate
├── scheduled/                 cleanupExpiredShareLinks, rotateOldFcmTokens, errorDailyDigest, expireStaleInvites
├── migration/                 migrateFoundationV1{,Rollback}
├── lib/                       sentry, logger, helpers
└── index.ts                   all exports
```

---

## Brand reference

`/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android/Scratch Folder/brandColors copy.md` — palette, gradients, mascots (TiTi, Kiko, Nala, Zuri, Taj). Use Tribe Gradient (orange→pink→teal) for hero/CTAs only, never full-screen.

---

## Things owner has corrected — DO NOT REPEAT

- **No iOS / Apple anything.** Stated 3+ times. Removed for good.
- **No wasmJs.** Stated. Compile OOMs. Removed.
- **AuntieOS is not in this repo** — different directory. Don't try to edit AuntieOS files from here.
- **Live Firestore data exists** — owner emphasized it's there. The 411/dossiers/invoices flat schema is the source of truth. Don't re-question whether data exists; build the translation Functions instead.
- **Translucent glass + tint, not native blur** — cross-platform legibility wins.
- **Caveman mode** is the prevailing tone. Stay terse outside code/commits/security.

---

## Data safety — AuntieOS shares this Firebase project

AuntieOS reads + writes the same Firestore. Treat shared collections like a production DB. Hard rules:

### Collection ownership

| Collection | Owner / writer | MyTribe access |
|---|---|---|
| `411` | AuntieOS | **read only** |
| `dossiers` | AuntieOS | **read only** |
| `invoices` | AuntieOS | **read only** until `payInvoice` Function lands (which only sets `paymentsHistory` + `amountDue` — never deletes) |
| `business_hours`, `booking_time_slots`, `base_services`, `discounts`, `generated_drafts`, `journal_import_staging`, `emailTemplates`, `admins` | AuntieOS | **read only** |
| `families` | MyTribe | read+write |
| `families/{fid}/{members,kin,kinTales,homeAccess,...}` subcollections | MyTribe | read+write |
| `clients` | MyTribe | read+write |
| `fcm_tokens`, `fcm_messages` | shared | read+write |
| `operators` | AuntieOS | **don't touch** (not used by MyTribe anymore) |

### Hard "don't" list
- **Never** mass-delete or mass-update any AuntieOS-owned collection.
- **Never** add required fields to a shared collection schema (breaks AuntieOS readers/writers).
- **Never** rename fields on shared collections.
- **Never** rewrite a Cloud Function whose name AuntieOS depends on (e.g. existing `acceptInvite`, `mintInvite*`, `provisionTribe`, `setBrandTokens`, `ingestKinTale`, `postInvoiceEvent`, etc.). Add new portal Functions; leave existing ones alone.
- **Never** run a migration script (`migrateFoundationV1*`) without owner explicit confirmation.
- **Never** tighten `firestore.rules` on a shared collection in a way that could deny AuntieOS — if rules need changes, propose the diff first.
- **Never** seed/edit data that already exists in production via MCP `firestore_*_document` without confirming.

### Soft "extra-careful" list
- New write Functions that touch shared collections need explicit owner approval AND should be additive (set new fields, not overwrite).
- Index changes (`firestore.indexes.json`) — propose first, deploy after confirmation, since index builds can briefly slow queries.
- Storage rules changes — same.

When in doubt, **read-only** + new Functions + new collections owned by MyTribe.

Resume from "Right-now action items" above.
