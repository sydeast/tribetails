# AuntieOS — Page Spec Scaffold (fill-in for Claude Code)

**Purpose:** one section per screen where Auntie writes what each page should be. CC follows this document together with the mockups. Pair this with `AuntieOS_Fix_Backlog_2026-06-02.md` (the bug list) — this file is the *intent*, that file is the *defects*.

---

## ⛔ DESIGN AUTHORITY — read before touching any screen

Precedence order. Higher wins. CC does not get to skip down the list.

1. **The approved mockup** for the screen (`ui-ideas/auntieos-<screen>-2026-05-27.html`). This is the source of truth for layout, spacing, hierarchy, and component choice. "CC is refusing to follow the mocks" is the #1 problem this document exists to stop. If a mockup exists, **build to it**. If you believe the mock is wrong, flag it — do not silently substitute your own layout.
2. **Auntie's written description / override** in this file (the "Auntie says" block per screen). This refines or overrides the mock where Auntie has spoken. If it conflicts with the mock, Auntie wins.
3. **CC's smart default**, allowed ONLY for details neither the mock nor the description covers — and it must conform to the Global UI Rules below. When you make a judgment call, note it in your delivery summary so Auntie can correct it.

If a mockup and a description disagree and it's not obvious which is current, **stop and ask** — do not pick one silently.

---

## 🎨 GLOBAL UI RULES (the "smart defaults" CC must conform to)

Anchored to the real system in `docs/2026-05-31-den-redesign-design.md`. The `tribe-tails-engineer` skill's React/Tailwind + grape-purple (#6B4FA0) palette is **STALE** — do not use it for AuntieOS web.

**Stack & design system**
- AuntieOS web is **Compose Multiplatform / Wasm**. Use the **Den / `Auntie*` primitives only**. No Material 3 visual components.
- Available Den primitives (use these before inventing anything): `GlassSurface`, `AuntieGlass`, `MeshGradient`, `AppShell`, `SectionHeader`, `AuntieTable`, `AuntieButtons`, `PrimaryButton`, `GhostButton`, `BottomBorderField`, `MultilineField`, `SegmentedPicker`, `SortMenu`, `StatusToast`, `ShimmerSkeleton`, `StubBadge`, `AuntieSlider`, `AuntieHoverRow`, `AuntieMotion`, `AuntieSpinner`. If a needed pattern (modal/dialog, chips/tags, tabs, empty-state, avatar, card variants) isn't there, **build it as a shared Den component first**, then compose the screen from it.
- Fonts: **Fraunces / Hanken / Spline**. Palette: **warm-dark Den palette** (per the mockups), not the skill's cream/grape.

**Hard guardrails (already established, non-negotiable)**
- **No em dashes** anywhere in code or copy.
- **Do not author user-facing copy.** Reuse the mockup's text or leave a clearly-marked placeholder TODO. (Exception: where Auntie explicitly supplies copy in this file.)
- **Fail loud, never fake.** No silent error-swallowing, no fabricated/sample data. Anything not backed by a real callable ships **dark behind a visible "Not wired" banner** — never faked. (This is why several screens are gated; see the backlog.)
- **Preserve every real data binding, ViewModel, callable, and functional field.** Mirror real contracts; mark any addition as a suggestion.
- **Verify the live deployed artifact, not the build exit code.** Deploy via `wasmJsBrowserDistribution`.

**Default UX patterns CC should apply where a screen leaves it unspecified**
- Lists: search/filter + loading skeleton (`ShimmerSkeleton`) + a meaningful empty state. Rows are clickable → detail. **Avoid raw table-row dumps** where the mock shows cards or richer layout (recurring Auntie complaint).
- Forms: validate **on field-blur**, inline errors that **name the specific field and the actual problem**, success toast on save. No "fix the highlighted fields" generic messages.
- Detail views: Edit + Delete (delete confirms and names the item) + breadcrumb back.
- Destructive actions: confirmation dialog that names the target.
- Sensitive fields (alarm codes, WiFi, lockbox): masked with show/hide toggle.
- All async ops: loading + error states. All routes auth-guarded.
- Mobile-first responsive. Clicking the **logo** → home/refresh.
- Segmented controls (`SegmentedPicker`) must be centered with clearly-separated segments (fix the Kin/Kinfolk pill-in-pill).
- Brand language everywhere: **Kin, Kinfolk, Tribe, Auntie, KinTale**.

---

## HOW TO USE THIS FILE (Auntie)

Under each screen, fill the **"Auntie says"** block. Anything you leave blank → CC follows the mockup, then the Global UI Rules. Tag each screen's state so CC knows the authority level:

- `[MOCK]` follow the mockup as-is (default if you write nothing)
- `[MOCK + NOTES]` follow the mockup but apply my notes/overrides
- `[IGNORE MOCK]` the mock is wrong; build to my description instead
- `[CC DECIDES]` no strong opinion; make a smart Den-consistent choice

---

# SCREENS

> Each block lists the real mockup path (source of truth) and the related fix-backlog phase. Fill in "Auntie says."

---

## 1. Sign In
- **Mockup:** `ui-ideas/auntieos-sign-in-2026-05-27.html`
- **Backlog:** Phase 1 (password-manager support, single-tab field order)
- **Auntie says:** `[ ]`
  - _State tag:_
  - _What the page should be / mock overrides:_
  - _CC-decides zones:_

## 2. Home
- **Mockup:** `ui-ideas/auntieos-home-2026-05-27.html`
- **Backlog:** Phase 2 (clickable cards, "Review & send drafts"→KinTales, "KinTales to review"→KinTales, notifications as badge)
- **Auntie says:** `[ ]`

## 3. Directory (Kinfolk / Kin)
- **Mockup:** `ui-ideas/auntieos-directory-2026-05-27.html`
- **Backlog:** Phase 3 (centered segmented control, sort by last name)
- **Auntie says:** `[ ]`

## 4. Kinfolk Profile
- **Mockup:** `ui-ideas/auntieos-kinfolk-profile-2026-05-27.html`
- **Backlog:** Phase 4 (tabs not long-scroll, required service address + emergency contact, vet on Kinfolk)
- **Auntie says:** `[ ]`

## 5. Kinfolk Edit / Add
- **Mockup:** `ui-ideas/auntieos-kinfolk-edit-2026-05-27.html`
- **Backlog:** Phase 4 (field visibility/a11y, remove preferred-contact + best-time, address required & selectable, on-blur validation)
- **Auntie says:** `[ ]`

## 6. Kin Detail (pet)
- **Mockup:** `ui-ideas/auntieos-kin-detail-2026-05-27.html`
- **Backlog:** Phase 5 (species/breed dropdowns, no vet box on Kin, gender required, profile-pic upload, drop free-text precare)
- **Auntie says:** `[ ]`

## 7. Household Data
- **Mockup:** `ui-ideas/auntieos-household-data-2026-05-27.html`
- **Backlog:** Phase 4 (service address + access info live here / under Identity)
- **Auntie says:** `[ ]`

## 8. KinCare Detail (a visit/session)
- **Mockup:** `ui-ideas/auntieos-kincare-detail-2026-05-27.html`
- **Backlog:** (relates to Schedule/Antie-Time split, Phase 6)
- **Auntie says:** `[ ]`

## 9. KinTale Logs (list)
- **Mockup:** `ui-ideas/auntieos-kintale-logs-2026-05-27.html`
- **Backlog:** Phase 8 (stop the long table/row list; follow the mock)
- **Auntie says:** `[ ]`

## 10. KinTale Composer
- **Mockup:** `ui-ideas/auntieos-kintale-composer-2026-05-27.html`
- **Auntie says:** `[ ]`

## 11. KinTale Report
- **Mockup:** `ui-ideas/auntieos-kintale-report-2026-05-27.html`
- **Auntie says:** `[ ]`

## 12. KinTale Template Editor
- **Mockup:** `ui-ideas/auntieos-kintale-template-editor-2026-05-27.html`
- **Auntie says:** `[ ]`

## 13. Schedule  →  (rebuild as a Calendar)
- **Mockup:** `ui-ideas/auntieos-schedule-2026-05-27.html`
- **Backlog:** Phase 6 (Schedule becomes a full calendar of events; stop duplicating "add visit" vs Bookings; calendar centered/fills space, pills level)
- **Auntie says:** `[ ]`

## 14. Antie-Time
- **Mockup:** `ui-ideas/auntieos-auntie-time-2026-05-27.html`
- **Backlog:** Phase 6 (today's route + active visits + upcoming care windows live HERE, not Schedule; build it out)
- **Auntie says:** `[ ]`

## 15. Bookings (Manage + Create)
- **Mockups:** `ui-ideas/auntieos-manage-bookings-2026-05-27.html`, `ui-ideas/auntieos-create-booking-2026-05-27.html`
- **Backlog:** Phase 6 (booking management only; organized, not raw rows; single source of truth vs Schedule)
- **Auntie says:** `[ ]`

## 16. Invoices (list)
- **Mockup:** `ui-ideas/auntieos-invoices-2026-05-27.html`
- **Backlog:** Phase 7 (migrate real Kinfolk first/last + info onto rows, add filtering by Kinfolk name)
- **Auntie says:** `[ ]`

## 17. Invoice Detail
- **Mockup:** `ui-ideas/auntieos-invoice-detail-2026-05-27.html`
- **Backlog:** Phase 7 (payment linked to invoice here; Record Payment action)
- **Auntie says:** `[ ]`

## 18. Payments  →  (fold into Invoices as a sub)
- **Mockup:** `ui-ideas/auntieos-payments-2026-05-27.html`
- **Backlog:** Phase 7 (payments are a sub of invoices; link via Payment.invoiceId; standalone page likely removed)
- **Auntie says:** `[ ]`

## 19. Communicate
- **Mockup:** `ui-ideas/auntieos-communicate-2026-05-27.html`
- **Sub-views:** `auntieos-email-creation-2026-05-27.html`, `auntieos-marketing-blasts-2026-05-27.html`
- **Backlog:** Phase 9 (message-type selector visit/text/email/blog; blog needs no recipient; "about" selector; Broadcast = company-wide; wire it)
- **Auntie says:** `[ ]`

## 20. Inbox
- **Mockup:** `ui-ideas/auntieos-inbox-2026-05-27.html`
- **Backlog:** Phase 10 (resolve Inbox vs Notifications duplication)
- **Auntie says:** `[ ]`

## 21. Notifications
- **Mockup:** `ui-ideas/auntieos-notifications-2026-05-27.html`
- **Backlog:** Phase 10 (shrink to badge+icon entry from home; organize by notification type)
- **Auntie says:** `[ ]`

## 22. Activity Log
- **Mockup:** `ui-ideas/auntieos-activity-log-2026-05-27.html`
- **Backlog:** Phase 11 (clickable entries with detail; confirm Sentry linkage; usable info not junk rows)
- **Auntie says:** `[ ]`

## 23. Training Documents  →  (AI-generator upload tool)
- **Mockup:** `ui-ideas/auntieos-training-documents-2026-05-27.html`
- **Backlog:** Phase 12 (repurpose: type/screenshot/attach → attach to Kinfolk/Kin → propagates to 411 + dossiers + AI blurbs)
- **Auntie says:** `[ ]`

## 24. Template Bank
- **Mockup:** `ui-ideas/auntieos-template-bank-2026-05-27.html`
- **Backlog:** Phase 13 (category pulls from real list, real editor widget w/ HTML+images+links, live preview, directions, category assignment + drag-drop)
- **Auntie says:** `[ ]`

## 25. Template Assignment
- **Mockup:** `ui-ideas/auntieos-template-assignment-2026-05-27.html`
- **Backlog:** Phase 13 (merge/relate with Template Bank; "New binding" must actually do something — define it)
- **Auntie says:** `[ ]`

## 26. Form Schema List  (Dynamic Fields)
- **Mockup:** `ui-ideas/auntieos-formschema-list-2026-05-27.html`
- **Backlog:** Phase 14 (consolidate with Dynamic Fields Manager duplicate; this powers the precare checklist)
- **Auntie says:** `[ ]`

## 27. Form Schema Editor
- **Mockup:** `ui-ideas/auntieos-formschema-editor-2026-05-27.html`
- **Backlog:** Phase 14 (backend auto-generates snake_case; "applies to" needs a real placement target; live preview; real config tools)
- **Auntie says:** `[ ]`

## 28. Media Gallery
- **Mockup:** `ui-ideas/auntieos-media-gallery-2026-05-27.html`
- **Auntie says:** `[ ]`

## 29. Settings (parent)
- **Mockup:** `ui-ideas/auntieos-settings-2026-05-27.html`
- **Backlog:** Phase 15 (split Personal "My Profile" from Business; notifications = type-rows × email/SMS/push checkboxes; appearance customization; editable login email + password + recovery; persistence)
- **Sub-views (fold into Settings):**
  - Business Hours — `ui-ideas/auntieos-business-hours-2026-05-27.html`
  - User Profile (personal) — `ui-ideas/auntieos-user-profile-2026-05-27.html`
  - KinCare Types — `ui-ideas/auntieos-kincare-types-2026-05-27.html`
  - Vet Clinics — `ui-ideas/auntieos-vet-clinics-2026-05-27.html`
  - Members — `ui-ideas/auntieos-members-2026-05-27.html`
  - Invites — `ui-ideas/auntieos-invites-2026-05-27.html`
- **Auntie says (settings overall):** `[ ]`
- **Auntie says (notifications matrix specifically):** `[ ]`
- **Auntie says (Time Off vs Business Closures naming):** `[ ]`

---

## Screens with no mockup (CC must use smart Den-consistent defaults — flag every choice)
_List any screen/feature Auntie wants that has no `ui-ideas/` mockup. CC builds these from the Global UI Rules and flags each decision for review._

- `[ ]` (e.g. "Dynamic Fields Manager" if it stays separate from Form Schemas — TBD whether it's deleted)
- `[ ]`

---

## Open questions for Auntie (carried from the backlog)
- Merge Template Bank + Template Assignment into one screen, or keep linked? (Phase 13)
- What exactly should a template "binding" do? (Phase 13)
- Keep the name "Training Documents," or rename the AI-upload tool? (Phase 12)
- Activity Log: is it meant to read from Sentry, and what detail per entry? (Phase 11)
- Record Payment: on the invoice itself, or elsewhere? (Phase 7)
- Appearance: which customization controls do you want beyond light/dark/system? (Phase 15)
