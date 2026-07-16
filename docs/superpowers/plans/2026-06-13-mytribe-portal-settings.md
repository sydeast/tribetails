# MyTribe Portal Settings Implementation Plan

> **For agentic workers:** execute phase by phase. Each phase compiles + (at the end) deploys on its own. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Operator-controlled MyTribe portal customization (logo, color theme, banner, Home layout, chat settings) from a new "MyTribe" section in AuntieOS Settings, plus removal of the 11 spurious MyTribe feature flags.

**Architecture:** AuntieOS writes a typed `mytribePortal` map on `business_settings/business_settings` (gitlive merge, `isAuntie`); MyTribe `getMyHome` returns it; MyTribe consumes it (theme/shell/Home/chat). 8 brand-derived themes shared by both apps.

**Tech stack:** Kotlin Compose Multiplatform (both apps), Firebase callables/Firestore (functions in `MyTribe/functions`, deployed to `auntieos-ttpc`), gitlive Firebase SDK.

**Repos:** MyTribe `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe`; AuntieOS `/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web/composeApp`.

**Verify per phase:** MyTribe `./gradlew compileKotlinJvm compileKotlinJs`; functions `npx tsc --noEmit`; AuntieOS `./gradlew :composeApp:compileKotlinJvm` (or wasm). Deploy at phase end: `firebase deploy --only "functions:mytribe:<names>"`, MyTribe web (`jsBrowserDistribution` + `hosting:kinfolk_portal`), AuntieOS web.

---

## Phase 0: MyTribe de-flag cleanup (MyTribe repo)

Remove all 11 `mytribe.*` flags. 10 become always-on; delete the legacy custom-fields editor. Each task: edit, then `compileKotlinJvm` green.

### Task 0.1: Remove cosmetic/always-on flag branches in screens
**Files (modify):**
- `auth/SignInScreen.kt:71,158` — delete `val showPasswordToggle = ...current.authShowPasswordToggle`; always render the password eye (inline `true`).
- `screens/claim/ClaimInviteScreen.kt:160` — `Text(if (flags.claimEnterCtaCopy) "Enter MyTribe" else "Continue")` → `Text("Enter MyTribe")`.
- `ui/LaunchErrorScreen.kt:64` — drop the `if (flags.launchErrorReassuranceCopy)` guard; always show the "Nothing is lost, your pack is safe..." line.
- `screens/kin/KinDetailScreen.kt:64` — delete `memorialEnabled` flag read; gate the "In our hearts" pill on `memorial` (status) alone.
- `screens/notifications/NotificationSettingsScreen.kt:174` — `flags.notificationsScheduleReminders && cat.id=="schedule"` → `cat.id=="schedule"`.
- `screens/schedule/ScheduleScreen.kt:189,200,143` — remove `scheduleMessageAuntie`/`scheduleRecurringVisit`/`bookingEnvelope` guards; recurring CTA + message-auntie entry always present (message-auntie later gated by chat.enabled in Phase 6); envelope grouping always on.
- [ ] Remove each flag reference; replace with the on-branch. Drop now-unused `LocalFeatureFlags`/`flags` locals where they become unused.
- [ ] `./gradlew compileKotlinJvm` → BUILD SUCCESSFUL.

### Task 0.2: After-hours vet always-on (TribeScreen)
**Files:** `screens/tribe/TribeScreen.kt:332,430,454,462`
- [ ] Replace `flags.tribeAfterHoursVet` usages with `true` (always show the after-hours block + persist its fields). Remove the `showAfterHours` flag plumbing if it collapses to constant.
- [ ] Compile green.

### Task 0.3: Delete the legacy custom-fields editor (TribeScreen)
**Files:** `screens/tribe/TribeScreen.kt:247,257,308,318` + `CustomFieldList` composable.
- [ ] Remove the `allowEditing` (legacy) branch of `CustomFieldList` and its add-field button; keep only the read-only display of existing admin-defined fields. Delete `flags.tribeLegacyCustomFields` reads and the `hasProfileExtras`/`hasHomeExtras` flag terms.
- [ ] Compile green.

### Task 0.4: invoice.downloadPdf always-on
**Files:** grep `invoiceDownloadPdf` (InvoicesScreen/InvoiceDetailScreen).
- [ ] Remove the guard; PDF download always available.
- [ ] Compile green.

### Task 0.5: Strip the flags from `FeatureFlags.kt` + fix tests
**Files:** `config/FeatureFlags.kt`; `commonTest/.../config/FeatureFlagsTest.kt`, `PortalApiFeatureFlagsTest.kt`, and per-screen tests asserting flag behavior (`SignInScreenTest`, `ClaimInviteScreenTest`, `LaunchErrorScreenTest`, `KinDetailScreenTest`, `NotificationSettingsScreenTest`, `ScheduleScreenTest`, `TribeScreenTest`).
- [ ] Reduce `FeatureFlags` to an empty (or near-empty) data class; keep `getFeatureFlags` plumbing in `PortalApi` (harmless) so future flags can re-use it. Keep `LocalFeatureFlags` provider with the empty default so existing `CompositionLocalProvider` call sites still compile, OR remove it and its references.
- [ ] Update/remove the flag tests (delete assertions on removed fields; keep screen tests that now assert the always-on behavior).
- [ ] `./gradlew compileKotlinJvm compileKotlinJs` + run the affected tests green.

### Task 0.6: Deploy MyTribe web (Phase 0)
- [ ] `jsBrowserDistribution` + `firebase deploy --only hosting:kinfolk_portal`. (No function changes in Phase 0.)

---

## Phase 1: Data model + read path

### Task 1.1: `MyTribePortalConfig` on AuntieOS `BusinessSettings`
**Files:** AuntieOS `data/FirestoreClient.kt` (BusinessSettings @Serializable, ~line 2119-2214).
- [ ] Add nested `@Serializable data class MyTribePortalConfig(...)` per spec §2.1 (logoUrl, themeId, banner{}, home{sections}, chat{}) + `val mytribePortal: MyTribePortalConfig = MyTribePortalConfig()` field. Default-construct = back-compat. Merge write already preserves it.
- [ ] AuntieOS compile green.

### Task 1.2: `getMyHome` returns `portal`
**Files:** `MyTribe/functions/src/portal/getMyHome.ts`.
- [ ] Read `settings.mytribePortal` (already loading `business_settings` in Phase-? — it loads it now for logoUrl/businessName). Map into a `portal` object (logoUrl, themeId, banner, home, chat) with safe defaults. Repoint `businessLogoUrl` to `mytribePortal.logoUrl` (fallback "" ).
- [ ] `tsc --noEmit` green.

### Task 1.3: MyTribe DTO parse
**Files:** `MyTribe/.../portal/PortalApi.kt` (MyHomeResult + getMyHome parse), new `portal/PortalConfigDtos.kt`.
- [ ] Add `PortalConfig` + `PortalBanner` + `PortalHomeSection` + `PortalChat` data classes; add `portal: PortalConfig` to `MyHomeResult`; parse the `portal` JSON in `getMyHome()`.
- [ ] `compileKotlinJvm compileKotlinJs` green.

### Task 1.4: Deploy getMyHome.

---

## Phase 2: AuntieOS MyTribe section shell + Logo

### Task 2.1: Nav + section
**Files:** AuntieOS `screens/settings/SettingsScreen.kt` (`SettingsSection` enum + `SectionPanel` when), new `MyTribePanel` (in-file or `MyTribeSettingsPanel.kt`). Reuse `DenPanel`, `AuntieSettingRow`, `AuntieToggle`, text fields.
- [ ] Add `SettingsSection.MyTribe`; render `MyTribePanel(vm)`; ViewModel loads/saves `businessSettings.mytribePortal`.

### Task 2.2: Logo upload
**Files:** `MyTribePanel` + reuse AuntieOS `signCloudinaryUpload` (folder `tribetails/portal/`).
- [ ] Image picker → Cloudinary signed upload → set `mytribePortal.logoUrl`; preview + clear; Save via `saveBusinessSettings`.
- [ ] AuntieOS compile + deploy AuntieOS web. (MyTribe consumer already live; logo appears once saved.)

---

## Phase 3: Banner

### Task 3.1: Admin editor (AuntieOS) — message, tone, dismissMode (none|perDevice|perUser), enabled, id.
### Task 3.2: MyTribe `TopBannerBar` in `TabShell` (wide+narrow), tone colors, dismiss handling (localStorage for perDevice; `dismissBanner(id)` callable for perUser writing `clients/{uid}.dismissedBanners`).
### Task 3.3: `dismissBanner` callable in functions. Deploy functions + both webs.

---

## Phase 4: Color themes (8 brand-derived) + AuntieOS Appearance presets

### Task 4.1: Shared theme catalog
**Files:** MyTribe new `theme/PortalThemeCatalog.kt` (`themeId` -> `KinfolkColors`); AuntieOS mirror `AuntieThemeCatalog.kt` from its tokens.

Each theme = `KinfolkColors()` with these overrides (brand-derived; every theme keeps a dominant hue + one sharp accent; `isDark` flips the Material scheme):

- `default`: no overrides. `isDark=false`.
- `midnight` (dark + vibrant): `cream=#11131F`, `navy=#FBFBF9`, `surface=#1A1D2B`, `surfaceCard=white@0.06`, `navySoft=white@0.80`, `navyMuted=white@0.55`, `navyHairline=white@0.12`, `glassSurface=white@0.06`, `glassSurfaceDim=white@0.04`, `glassBorder=white@0.14`, `primary=#DF8431`, `accent=#D55C87`. `isDark=true`.
- `clear` (high-contrast): `cream=#FFFFFF`, `surface=#FFFFFF`, `surfaceCard=white@0.85`, `navySoft=navy@0.92`, `navyMuted=navy@0.74`, `primary=#C26A1E`, `accent=#B23B6A` (darkened for AA on white).
- `sunset` (gradient): `surface=#FBEFE6`, `surfaceCard=white@0.70`, `primary=#DF8431`, `accent=#D55C87` (leans on the existing tribe gradient for heroes).
- `duo` (duotone): `accent=#DF8431`, `teal=#11131F`, `purple=#11131F`, `coral=#DF8431` (navy + orange only).
- `calm` (minimalist): `primary=#0A8595`, `accent=#0A8595`, `coral=#0A8595`, `purple=#74538A`, `surface=#F3F1EC` (one teal accent, heavy neutral).
- `hearth` (warm/nature): `surface=#F0E7D8`, `primary=#DF8431`, `accent=#0A8595`, `coral=#D5535A` (earthy warm + teal).
- `jewel` (jewel tones): `primary=#74538A`, `accent=#0A8595`, `coral=#D55C87`, `surface=#ECE7DF` (purple + sapphire teal, rich).
- `soft` (pastels): `primary=#D55C87`, `accent=#74538A`, `surface=#FBF3F6`, `navySoft=navy@0.72`, `success=#0A8595` (washed pink + lavender, gentle).

Catalog signature: `fun portalColors(themeId: String): Pair<KinfolkColors, Boolean>` (colors + isDark); unknown id -> default. AuntieOS mirrors the same 9 ids against its own color model.
### Task 4.2: MyTribe `KinfolkPortalTheme(themeId)` param; `KinfolkPortalAppGuarded` passes `home.portal.themeId`; midnight flips Material to dark.
### Task 4.3: AuntieOS portal theme picker (swatch cards) in `MyTribePanel` + the same 8 presets in AuntieOS Appearance section.
- [ ] Compile both; deploy both webs.

---

## Phase 5: Home editor

### Task 5.1: Admin reorderable section list (AuntieOS) — show/hide + order + per-section limit (upNext/tales/roster).
### Task 5.2: MyTribe `HomeScreen` config-driven: render `portal.home.sections` in order, skip disabled, apply limits to `.take(n)`; absent config = current layout.
- [ ] Compile MyTribe; deploy MyTribe web.

---

## Phase 6: Chat settings

### Task 6.1: Admin (AuntieOS) — enabled, awayMessage, hours, maxMessageLength, rateLimitPerHour.
### Task 6.2: MyTribe `MessageAuntieScreen` — disabled state + away message + outside-hours note + length enforcement; entry points gated by `chat.enabled` (replaces the old messageAuntie flag).
### Task 6.3: `sendKinfolkMessage` server validation (enabled/length/rate-limit). Deploy functions + MyTribe web.

---

## Self-review notes
- Spec coverage: logo (P2), flags-removed (P0), banner (P3), themes incl. AuntieOS (P4), home editor (P5), chat (P6), data model/read path (P1). All covered.
- Back-compat: every consumer falls back to today's behavior when `mytribePortal` is absent/blank.
- Risk: theme dark-mode contrast (verify at runtime); per-user banner dismiss is best-effort.
