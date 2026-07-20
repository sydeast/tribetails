# Android Parity Map — A8 web fixes → Android (recon 2026-06-24)

Android app: `android/app/src/main/java/com/tribetails/auntieos/`.
Callable invocation: `functions.getHttpsCallable("name").call(payload).await()` (Firebase SDK, in `AuntieRepository`, returns `Result<T>`).
`BusinessSettings` model: `data/model/LocationModels.kt` (lines ~136–222). Writes merge (`SetOptions.merge()`).

## ALREADY DONE on Android (no work)
- **B2 booking cards** — `ui/admin/KinCareSessionsScreen.kt:374-377` `KinCareCard` `.clickable(onClick=onOpenDetail)`. ✅
- **Notifications MATRIX** — `ui/admin/AdminSettingsScreen.kt:840-938` `NotificationMatrixPanel()` (tabs, On/Off + channels, SMS "—"). ✅ (only the global pause toggle missing — see below)
- **B6 block-time UI** — `ui/admin/SchedulingOptionsScreen.kt:39-140` already has Block-Dates/Times form → `schedulingViewModel.blockTimeSlot(...)` (Firestore write). ✅-ish; verify there's a "New Visit" button to remove + optionally repoint to the `createBlockedTimeSlot` callable.

## QUICK WINS (small)
- **K2 remove Preferred Contact** — `ui/directory/KinfolkProfileScreen.kt:400` delete `ProfileField("Preferred Contact", preferredContactSummary(...))` (keep model field; line 108 `ContactOverrideBanner` is separate).
- **D1 strip dossier citations** — `ui/directory/KinfolkProfileScreen.kt:462-478` `DossierCard`: `rawSummary` renders `[[source:…]]` verbatim → add a regex strip helper (`\[\[source:[^\]]*]]`) at line 478. "Last enriched" already date-only (`.take(10)`).
- **B5 breed bank on open** — `ui/directory/BreedDropdownField.kt:24-69`: dropdown only shows after typing (`if (matches.isNotEmpty() && !exact)`) → show catalog head on focus/blank.
- **B7 schedule legend** — `ui/admin/ScheduleViewScreen.kt`: NO legend → add a DenPanel listing `businessSettings.serviceRates` keys (sorted by duration, reuse B9 sort).
- **B9 KinCare type order** — sort service types by duration ascending wherever the chips render (booking create / `KinCareDetailScreen.kt:113`).

## MEDIUM
- **A1 gallery viewer** — `ui/media/GalleryScreen.kt:154-172`: tile click opens `TagKinDialog`, not a full-size viewer → add a `MediaViewerDialog` (full image/video).
- **B4 kin VIEW screen** — `ui/directory/KinfolkProfileScreen.kt:524-574` `KinDetailsCard`: Edit btn → `EditKinScreen`; no read-only view → build `KinViewScreen`, route card tap to view + Edit button.
- **K1 recent-tale clickable** — `ui/directory/KinfolkProfileScreen.kt:254-289` `ProfileFeedSection`: rows not clickable → add `onOpenTale(taleId)` param + `.clickable` → `KinTaleReportScreen`.
- **K3 household-notes to EDIT** — `ui/directory/KinfolkProfileScreen.kt:166-175` `HouseholdNotesMigrationCard` on profile → move to `EditKinfolkScreen`.
- **KT1 KinTales sort** — `ui/admin/KinTaleLogsScreen.kt:90-152`: search only → add a sort chip row (Newest/Oldest/Kinfolk/Service) + apply before bucketing.

## LARGE (model + UI + maybe backend)
- **Payments** — `LocationModels.kt` add `venmoHandle/paypalHandle/cashappHandle` to `BusinessSettings`; `AdminSettingsScreen.kt` add a "Payment Options" panel; `ui/invoices/InvoiceDetailScreen.kt` add a "How to pay" section.
- **Notifications global pause** — `LocationModels.kt` add `notificationsPaused: Boolean=false`; `AdminSettingsScreen.kt` add a master "Pause all" toggle (backend dispatcher already honors the flag — deployed). Matrix already exists.

## Build/verify
Android: `cd android && ./gradlew :app:testDebugUnitTest` (+ `assembleDebug` for the APK). Operator sideloads the APK.
