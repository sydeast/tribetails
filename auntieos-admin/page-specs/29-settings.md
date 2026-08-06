# Settings — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-settings-2026-05-27.html` (primary) plus six sub-view mocks folded in below.
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/settings/SettingsScreen.kt` (1280+ ll.) + `SettingsViewModel.kt` + `DynamicFieldsCard.kt` (same folder).
**Models:** `BusinessSettings` (`…/web/data/FirestoreClient.kt` ll.1076-1095), `UserProfile` (same file ll.1268-1298, stored at `users/{uid}`), `VetClinic` (ll.1254-1262), `DynamicField` (ll.1160-1185). `serviceRates: Map<String,String>` lives on `BusinessSettings` (l.1082).
**Data path:** `SettingsViewModel` streams `businessSettingsStream()` and writes `saveBusinessSettings()` (the WHOLE doc); `client.userProfileStream(uid)` for the personal profile; `auth.sendPasswordReset` / `auth.signOut` for Security.

> ⚠️ Mock-file correction / reality note: the SHIPPED `SettingsScreen.kt` is already **far ahead** of the single primary mock. Its KDoc (ll.87-105) and `SettingsSection` enum (ll.289-300) define a real section-nav switch with ten sections: Profile, BusinessProfile, BusinessHours, Notifications, Integrations, Scheduling, Appearance, Security, TimeOff, DynamicFields. So several complaints are **partly addressed already** and several sub-mocks are **not built at all**. This spec reconciles all of that against the code, panel by panel. Where the primary mock disagrees with the code, trust the code.

### Where each folded-in sub-mock belongs under Settings
- `auntieos-user-profile-2026-05-27.html` → the **Profile** section (personal operator identity) + bleeds into **Notifications** + **Security**. The operator avatar/hero, personal fields, and "Sign out all devices" suggestion live here.
- `auntieos-business-hours-2026-05-27.html` → the **Business hours** + **Scheduling** + **Time off** sections combined (weekly hours, Google Calendar sync, observed holidays, company holidays, special hours, suggested "Time blocks").
- `auntieos-kincare-types-2026-05-27.html` → a **NEW "KinCare types" section** editing `BusinessSettings.serviceRates` (today there is NO editor for it; booking reads it read-only). Belongs in the section nav between Business profile and Business hours.
- `auntieos-vet-clinics-2026-05-27.html` → a **NEW "Vet clinics" section** (the `VetClinic` model + CRUD callables already exist; no settings UI does).
- `auntieos-members-2026-05-27.html` → **RE-HOMED out of Settings (LOCKED — Decision 8).** Household members/permissions are kinfolk/household, not staff: primary→secondary kinfolk invites + permissions live in **MyTribe**; the mock breadcrumb already reads "Directory / Households / the Wrens / Members". Do NOT build under Settings.
- `auntieos-invites-2026-05-27.html` → **RE-HOMED out of Settings (LOCKED — Decision 8).** Auntie "Invite to app" = a **Kinfolk action in the Directory**; KinTale external share = on the **KinTale** (spec 11). Net-new callables `inviteKinfolk` / `inviteSecondaryKinfolk` (+permissions) / `shareKinTaleExternal`. Do NOT build under Settings.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mocks (`Auntie B`, `auntie@example.com`, `TribeTails Pet Care`, `100 Creekside Ln`, `08:00`/`17:00`, `2026-07-03 | Long weekend`, `$28`/`$48`, `Google Calendar / Stripe / Twilio / Mapbox / Cloudinary / n8n`, `fam_7Qk2`, `rq_8fk29a`, `Morning 08:00 to 11:00`) is **illustrative sample data**, not a value to type into the UI. The mocks say so repeatedly (e.g. settings mock l.10, business-hours l.13, members l.205, invites l.164). The mocks define **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (`BusinessSettings`, `UserProfile`, `VetClinic`, the invite/member callables). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). The shipped screen already does this correctly for `FF_PROFILE_PIC_UPLOAD`, `FF_SCHEDULING_SYNC`, `FF_INTEGRATION_MANAGE` (ll.78-85) — keep that discipline everywhere.

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Personal vs Business split — the "My Profile mixed into Business" complaint (LARGELY DONE, verify)
- **Current:** the screen **already** splits **Profile** (personal: firstName/lastName/displayName/phone/title/bio/photo from `UserProfile` at `users/{uid}`, `ProfilePanel` ll.444-630) from **Business profile** (businessName/businessEmail/businessPhone/businessAddress from `BusinessSettings`, `BusinessProfilePanel` ll.636-711). They are distinct nav sections and save to distinct docs (`saveUserProfile` vs `saveBusinessSettings`). The `user-profile` mock's "Profile" + "Business Profile" two-card layout maps cleanly to these two sections.
- **Desired:** user-profile mock — a personal hero (avatar + name + role + email + uid tags) and a personal "Profile" card, with "Business Profile" as a separate card.
- **Fix:** mostly parity already. Remaining gaps to verify/close:
  1. The mock's **hero block** (gradient avatar, "Admin · Operator" role, Active/Sole-admin/uid tags) is richer than the current inline header (`ProfilePanel` ll.464-501). Build the hero from **real** `UserProfile` + `authUser` values (uid take(12) already real, l.496). The "Sole admin" tag must reflect a **real** admin-count check, not a hardcoded star — **Dependency:** an admin-count source; gate the tag dark if absent rather than always showing "Sole admin."
  2. Confirm no business-only field leaked into the personal Profile panel and vice-versa (read shows they are clean: personal panel uses `UserProfile`, business panel uses `BusinessSettings`). If any business field is still surfaced under Profile, move it. Tri-platform parity on Android settings.

## 2. Notifications must become a per-TYPE matrix — currently 3 global toggles (CORE complaint)
- **Current:** `NotificationsPanel` (ll.769-804) renders exactly **three** rows — Email / SMS / Push — bound to three booleans `notificationEmail` / `notificationSms` / `notificationPush` on `BusinessSettings` (model ll.1086-1088; state ll.136-138). There is **no notification-type dimension**. The user-profile mock (ll.200-218) also shows only these three, so the mock is behind the requirement too.
- **Desired (per the complaint, not the mock):** a **matrix** — every notification TYPE is a row (e.g. new booking request, booking approved/rejected, visit started, visit completed, KinTale sent, payment received, daily summary, breach/alert …), with **Email / SMS / Push checkboxes per type**. Admin enables which channels are *available* for each type; the client side then chooses among the enabled ones. So this is a two-layer model: admin availability matrix here, plus a downstream client preference surface.
- **Fix (full-stack — large):**
  1. **Backend / model:** replace the three scalar booleans with a real per-type channel matrix on `BusinessSettings` (e.g. `notificationMatrix: Map<String, Set<String>>` of `typeKey → {EMAIL,SMS,PUSH}`, or a typed structure). Define the canonical **notification type list** in one shared place (it must be the same list the notification *senders* in `functions/` actually emit — do not invent types the backend never fires; **Dependency:** enumerate real notification types from the Cloud Functions / FCM / Twilio senders).
  2. **Migration:** map the legacy three booleans onto the matrix on read so existing docs are not lost (fail-loud if a value can't be migrated, don't silently drop).
  3. **Frontend:** a matrix grid (type rows × channel columns of checkboxes) replacing the three toggles, bound to the real matrix. No hardcoded type labels — render from the shared type list.
  4. **Client-choice layer:** the kinfolk/client app must read the admin-enabled availability and let clients pick within it. That is a separate (kinfolk-side) surface; note the contract here so admin and client agree on the same matrix shape.
  - Parity: web + desktop + Android admin matrices identical. Tests: model migration unit test; matrix component test; integration test that a disabled channel actually suppresses the corresponding send.

## 3. Saves don't persist on refresh — Business hours / Time off / Appearance lost (CORE complaint)
- **Current — this is real and confirmed:**
  - **Business hours** (`BusinessHoursPanel` ll.717-761) has **no Save button of its own**; it tells the user "Hours save with the Business Profile panel." (l.755). So edited hours live only in hoisted state until the user navigates to Business Profile (or Time Off) and presses Save. A **browser refresh before saving loses them** because nothing was written.
  - **Notifications** (item 2) likewise has no save — "Changes save with the Business Profile panel." (l.776).
  - **Appearance / theme** (`AppearancePanel` ll.908-948) is hoisted to the caller via `onThemeModeChange` and **never written to any backend** (no `BusinessSettings`/`UserProfile` theme field exists). On refresh the theme reverts to whatever the app default is. This is silent loss.
  - **Time off** (`TimeOffPanel`) DOES have its own Save (ll.1095-1116) writing the full `BusinessSettings`, so it persists — but it bundles hours+notifications into that save, which is why the cross-panel coupling is confusing.
- **Desired:** each editable panel persists its own edits reliably; a refresh never silently discards a change.
- **Fix (full-stack):**
  1. **Give Business hours and Notifications their own Save** (or a single sticky global Save bar with a dirty indicator, like the kincare-types mock's "Unsaved changes" pill, ll.198-202). Either way, **edits must reach `saveBusinessSettings` before they can be lost**, or the UI must warn-on-navigate-away (fail loud: an unsaved-changes guard, never silent loss).
  2. **Persist the theme.** Add a real `theme`/appearance field to `UserProfile` (per-operator) or `BusinessSettings`, write it on change, and hydrate `themeMode` from it at load. Until that field exists, the Appearance control is effectively a session-only toggle — if it cannot persist, surface that honestly ("theme is not saved yet") rather than implying it sticks.
  3. **Dependency:** the theme-persistence field + write path is net-new backend. The hours/notifications save is wiring of existing fields, but the unsaved-changes guard is new UX plumbing on all three platforms.
  - Tests: integration test that edit→refresh→value-survives for hours, notifications, and theme; component test for the dirty/guard UX.

## 4. Appearance → full Customization system (LOCKED — Decision 6; see Plan Phase 17)
- **Current:** `AppearancePanel` (ll.908-948) offers a `SegmentedPicker` of exactly `LIGHT / DARK / SYSTEM` (`ThemeMode`), nothing else.
- **Desired (LOCKED — Decision 6):** build the **Customization system (Plan Phase 17)**: accent color, density (roomy/compact), larger-text/scaling, **dashboard drag-and-drop + resizable cards** (Home), **editable logo + home-screen title**, and a **nav editor** (rename sections, reorder, move screen links). All **persisted** (item 3.2 prefs field) and **really applied** — never a dead control. This is its own phase, sequenced after core screens.
- **Fix:** extend `ThemeMode`/the theme system with the chosen axes; each new option needs a real `AuntieTheme` effect + a persisted field + tri-platform support. Gate any option whose theming wiring isn't done behind a Not-wired note rather than shipping a no-op picker.
- **Dependency:** theme-token plumbing for each new axis + the same persistence field as item 3.

## 5. Security — login email shown is the business email; no edit-email, no in-place password change (CORE complaint)
- **Current — confirmed:** `SecurityPanel` (ll.954-995) shows only `authUser.email` and a single "Send Reset Email" `GhostButton` calling `auth.sendPasswordReset(authUser.email)` (ll.976-989). There is **no field to edit the login email** and **no change-password-in-place** — only the reset-link flow ("reset to original"). Because `authUser.email` is the Firebase Auth email and the business email is also surfaced elsewhere, they read as the same address, which is the source of the "shows the business email as the login email" confusion.
- **Desired (user-profile mock Security card, ll.220-233, plus the complaint):** editable login credentials (change login email, change password in place) and account recovery — clearly separated from the business contact email.
- **Fix (full-stack auth — sensitive):**
  1. **Distinguish the two emails in the UI.** Label the Security email explicitly as the **login/account email** (Firebase Auth identity), visually separate from `BusinessSettings.businessEmail` (the contact email on invoices). They may coincide but are different fields.
  2. **Edit login email:** add a real change-email flow. **Dependency:** `AuthClient` has no `updateEmail` (facade is `signIn`/`signOut`/`sendPasswordReset`/`idToken`/`isCurrentUserAdmin`, `AuthClient.kt` ll.11-27). Add a `platformUpdateEmail` expect/actual (Firebase `updateEmail`/`verifyBeforeUpdateEmail`) with re-auth handling. Until it exists, ship the email field read-only with a Not-wired note — never a dead input.
  3. **Change password in place:** add a `platformUpdatePassword` (with current-password re-auth) so the user can set a new password without the email round-trip; keep "Send Reset Email" as the recovery fallback.
  4. **Recovery:** keep reset-link; consider the "Sign out all devices" suggestion from the mock (ll.235-242) — that needs a real refresh-token-revoke callable (**Dependency**), gate dark until built.
  - Re-auth, error surfacing (fail loud on `auth/requires-recent-login`), tri-platform, and security tests are mandatory here.

## 6. Time Off conflates personal time-off with business closures/holiday hours (CORE complaint)
- **Current — confirmed:** `TimeOffPanel` (ll.1001-1119) holds **US Holidays Observed** toggles (`observedUsHolidays`) + **Company Holidays** (`companyHolidays`, "YYYY-MM-DD|Name" closures). Both are **business closures**. There is **NO personal time-off** concept, and the model's `specialHours` field (ll.1093-1094, "YYYY-MM-DD|HH:MM-HH:MM|Name") is **not edited anywhere** in this panel — the business-hours mock's "Special hours" editor (ll.258-266) is unbuilt.
- **Desired:** separate **business closures / holiday hours** (observed holidays, company holidays, special partial-day hours — all in the Business hours area per the business-hours mock) from **personal time-off** (the operator's own days away). The business-hours mock (ll.226-267) groups holidays + special hours under "Time off · holidays" as a business concept; personal time-off would be a distinct concept.
- **Fix:**
  1. **Move the holiday/closure editors** (observed US holidays, company holidays, and a NEW special-hours editor binding the unused `specialHours` field) under the **Business hours** section per the business-hours mock, framed as business closures.
  2. **Define personal time-off** as its own thing (the operator's PTO/away days) with its own storage — **Dependency:** there is no personal-time-off field today; decide whether it lives on `UserProfile` or a new collection, and how it affects availability. Do not repurpose `companyHolidays` (business) for personal PTO.
  3. **Build the `specialHours` editor** the model already supports (the business-hours mock's date|range|name rows). It currently has a field but no UI — wire it.
  - Tri-platform + tests for each list editor (add/remove/persist).

## 7. KinCare types editor — NEW section, model field has no UI (kincare-types mock)
- **Current:** `BusinessSettings.serviceRates: Map<String,String>` (name→rate, l.1082) is **read** by Booking (`BookingScreen.kt`) but has **no editor** — there is no Settings section for it, and no `SettingsSection` entry.
- **Desired:** kincare-types mock — an editable rows list (type name + rate, add/remove/reorder) plus a live booking-chip preview, with a Save and a dirty indicator.
- **Fix (full-stack):**
  1. Add a **KinCare types** `SettingsSection` + panel editing `serviceRates`. Bind to the **real** map; the mock's `30 min/$28` etc. are placeholder.
  2. Save via `saveBusinessSettings` (field already on the doc) with the same unsaved-changes discipline as item 3.
  3. The mock's "duration + color per type" is explicitly tagged **suggestion, not in `serviceRates`** (ll.182-194) — ship dark/omit; a future `serviceRates` schema change would be a separate dependency. Do not invent duration/color fields.
  - Reorder needs a stable ordering (a `Map` is unordered — **Dependency:** if order must persist, the storage may need to become an ordered list, not a `Map<String,String>`). Note this; don't silently lose order. Tri-platform + tests.

## 8. Vet clinics manager — NEW section, model + CRUD exist, no UI (vet-clinics mock)
- **Current:** `VetClinic` model (name/phone/address/notes, ll.1254-1262) + `vetClinicsStream`/`createVetClinic`/`updateVetClinic` callables (`FirestoreClient.kt` ll.331-333, expect/actual ll.533-535) **exist**, but **no Settings UI** consumes them.
- **Desired:** vet-clinics mock — a clinics list with add/edit (name, phone, address, notes).
- **Fix:** add a **Vet clinics** `SettingsSection` + panel bound to `vetClinicsStream`, with add/edit forms calling the existing create/update callables. (Note: no `deleteVetClinic` in the facade — if the mock offers delete, that callable must be added; **Dependency**, gate delete dark if absent.) Bind to real data; mock clinic names are placeholder. Tri-platform + tests.

## 9. Integrations + Scheduling — already correctly gated dark (verify, keep honest)
- **Current:** `IntegrationsPanel` (ll.810-847) shows **static-config** rows (Firestore/n8n/FCM/Twilio) with an explicit "Static config" pill and a Not-wired banner for Manage/Connect (`FF_INTEGRATION_MANAGE=false`). `SchedulingPanel` (ll.853-902) shows placeholder toggles all gated behind a Not-wired banner (`FF_SCHEDULING_SYNC=false`). Both **fail loud** and do not fake "Connected."
- **Desired:** settings mock Integrations card shows colorful "Connected" / "Manage" / "Connect" cards (Google Calendar, Stripe, Twilio Voice, Mapbox, Cloudinary, n8n). The business-hours mock shows a Google Calendar Sync card with "Last sync 7:42a, 4 bookings ready, Run sync."
- **Fix:** do **not** ship the mock's green "Connected" glow or live "Last sync" line until there is a **real connection/health source** — that would be fabricated status (Rule 1). Keep the current honest static-config + Not-wired treatment. When OAuth/connect and a real sync backend land (flip `FF_INTEGRATION_MANAGE` / `FF_SCHEDULING_SYNC`), bind the connected state and last-sync to **real** values. These are the right behavior already; the work is the **backend** (OAuth/connect flows, Google Calendar sync callables), not the UI.
- **Dependency:** OAuth/connect flow per integration; Google Calendar sync backend (a `BusinessSettings` field/callable that does not exist, per KDoc ll.82-83). Until then, dark.

## 10. Profile-picture upload — correctly dark (FF_PROFILE_PIC_UPLOAD), surface honestly
- **Current:** `ProfilePanel` gates the photo control behind `FF_PROFILE_PIC_UPLOAD=false` with a Not-wired banner (ll.505-521); the old path "uploaded an empty ByteArray and falsely toasted success" (comment ll.79-80) and was correctly disabled.
- **Desired:** user-profile mock shows an "Edit photo" action on the hero (l.162).
- **Fix:** keep dark until a real file picker + image upload pipeline exists (the same missing bytes/picker seam as the Media Gallery upload, screen 28 item 1). When built, write `UserProfile.photoUrl` from a real upload. Do not re-enable until the bytes pipeline is real on web (and parity on Android, which has native pickers). **Dependency:** image upload pipeline for `users/{uid}` avatars.

## 11. Household Members + Invites — RE-HOMED out of Settings (LOCKED — Decision 8)
- **Current:** **no UI exists** for either (both mocks state this explicitly: members l.205, invites l.164). The mocks are built from backend callable contracts (`families/{familyId}/members/{targetUid}`, `mintInvite`/`mintInviteFromPrimary`/`revokeInvite`/`expireStaleInvites`/`acceptInvite`, `inviteRequests` doc). **Verification note:** I searched this repo's TS sources and did **not** find `mintInvite`/`revokeInvite`/`setMemberPermissions` files — they may live in a separate functions repo/branch not present here, or may be planned. **Do not assume the callables exist; verify before building UI against them.**
- **Desired:** members mock — primary/secondary roles, per-member permission toggles (`kintales_only` server-locked-on, `billing_full` admin-only logged with severity warn). invites mock — send-invite form (mintInvite args) + pending/accepted/expired/revoked lists with status pills and a 14-day TTL note.
- **Fix (full-stack, backend-first):**
  1. **Confirm the callables exist and their exact signatures** before any UI. If they are not in the deployed functions, this is backend work first (Rule 2 backend→api→wiring→frontend).
  2. **Placement (LOCKED — Decision 8): NOT under Settings.** Re-home: Auntie "Invite to app" → a Kinfolk action in the **Directory**; primary→secondary kinfolk invites + permission model → **MyTribe** (household members); KinTale external share → the **KinTale** (spec 11). The mock breadcrumbs already point here (Members under "Directory / Households / the Wrens / Members" l.199). Remove from Settings entirely.
  3. Bind every field/permission/status to the **real** callable responses — all sample emails, familyIds, inviteIds, dates are placeholder. Respect server-locked permissions (don't render `kintales_only` as toggleable-off) and admin-only gating (`billing_full`).
  - Tri-platform + integration tests against the real callables; this is the heaviest backend dependency in the Settings family.

## 12. Dynamic fields — already a real section (leave as-is)
- **Current:** `DynamicFieldsCard` (`DynamicFieldsCard.kt`) is a real CRUD over the `dynamic_fields` collection (`DynamicField` model ll.1160-1185), rendered as the **DynamicFields** section (`SectionPanel` l.436).
- **Fix:** none for this redesign pass. Not depicted in any of the six folded-in mocks. Verify Android parity exists; otherwise out of scope.

---

## Out of scope / leave as-is
- The section-nav switch pattern (`SectionNav` ll.302-341, active item gets `c.textPrimary` background) already matches the settings/business-hours/kincare-types mocks' left rail.
- Heading "How the Den runs." (`DenScreenHeading`, ll.162-167) matches the mock's "How the Den runs".
- `DenPanel` glass cards match the mocks' `.panel` styling.
- The three already-dark feature flags (`FF_PROFILE_PIC_UPLOAD`, `FF_SCHEDULING_SYNC`, `FF_INTEGRATION_MANAGE`) and their Not-wired banners are the correct fail-loud pattern — extend, don't remove.
- Business Profile save writes the full `BusinessSettings` doc with an `AuditLog.fire` (ll.682-703) — keep the audit trail.
- Global search/bell live at the shell level (`web/.../ui/shell/AppShell.kt`); Settings should not add its own.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Notification-type matrix** on `BusinessSettings` (replace 3 booleans), driven by the **real notification-type list emitted by the Cloud Functions senders**, with legacy-boolean migration, plus the downstream kinfolk-side client-choice surface.
2. **Theme/appearance persistence field** (on `UserProfile` or `BusinessSettings`) + write/hydrate path — without it Appearance silently resets on refresh.
3. **Per-panel save / unsaved-changes guard** for Business hours, Notifications (and a global dirty indicator) so edits cannot be silently lost on refresh.
4. **Additional appearance axes** (accent color / density / font-size / reduced-motion) — each needs real theme-token wiring + persistence; design sign-off on which axes.
5. **`AuthClient.updateEmail` + `updatePassword`** expect/actual (with re-auth) so login credentials are editable; plus an optional **revoke-all-sessions** callable for "Sign out all devices."
6. **Personal time-off storage** (distinct from business `companyHolidays`/`observedUsHolidays`) + its effect on availability.
7. **`specialHours` editor** wiring (model field exists, no UI) under Business hours.
8. **KinCare-types editor** over `serviceRates` (and a decision on ordered storage if reorder must persist; a `Map` cannot preserve order).
9. **Vet-clinics section** over the existing `VetClinic` CRUD (and a `deleteVetClinic` callable if delete is offered — not in the facade today).
10. **Integrations OAuth/connect flows** + **Google Calendar sync backend** (no `BusinessSettings` field/callable today) before any "Connected"/"Last sync" status can be real.
11. **Profile-picture / avatar image-upload pipeline** (`users/{uid}.photoUrl`) — same missing bytes/picker seam as Media Gallery.
12. **Build the invite/share callables (net-new; LOCKED — Decision 8 placement):** `inviteKinfolk` (Auntie→kinfolk), `inviteSecondaryKinfolk` + permission model (primary→secondary, MyTribe), `shareKinTaleExternal` (KinTale link, spec 11). Not in repo's TS today. Surfaces route under **Directory/Household + MyTribe + KinTale**, NOT Settings.

Every value on every Settings panel must trace to `BusinessSettings`, `UserProfile`, `VetClinic`, `DynamicField`, or a real callable. Where it can't (theme today, notification matrix, personal time-off, special hours, integration health, members/invites), it ships dark with a Not-wired banner — never hardcoded sample data, never a no-op control that implies success.
