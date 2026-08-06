> STATUS 2026-06-09 (de-stale pass): SHIPPED: segmented-pill height fix (item 1), surname sort + tests (item 3), last-visit footer (items 6.3/7, flags removed), New badge (item 7), and bulk + per-kinfolk portal invite (new, not in the original delta). GENUINE GAPS: the kin chip still passes `imageUrl=null` though `Kin.profilePictureUrl` + upload now exist; `Kin` has no `createdAt`/`updatedAt` so the Kin-tab recency sort silently falls back to alpha; optional Kinfolk `neighborhood`/`serviceArea` subtitle. DECISIONS PENDING: wire the kin-chip photo now or hold the paw glyph; sort labels use arrow glyphs vs the mock's "A to Z".

# Directory — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-directory-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/DirectoryScreen.kt` (+ `DirectoryViewModel.kt`)
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/directory/DirectoryScreen.kt` (+ `DirectoryViewModel.kt`)
**Shared components:** `SegmentedPicker`, `AuntieSearchField`, `SortMenu` (`…/web/ui/components/`), `SortOption` + `sortedByOption` (`…/web/util/SortOption.kt`), `KinfolkCard` / `KinCard` (in `DirectoryScreen.kt`).

> No mock-file correction needed: `DirectoryScreen.kt` (ll.81, 339) explicitly cites `repeat(auto-fill, minmax(290px, 1fr))` from this directory mock. The screen's KDoc references match `auntieos-directory-2026-05-27.html`.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren`, `the Wrens · Riverside`, `Biscuit`, `Gravy`, the `8` / `16` tab counts, `Today, 9:00a`, the `New` badge) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Kinfolk / Kin segmented control — the off-center "pill-in-pill" (Auntie complaint)
- **Current:** `SegmentedPicker` (`SegmentedPicker.kt` ll.20-53). Outer `Row` is `height(34.dp)` + `clip(RoundedCornerShape(999.dp))` + `padding(2.dp)`. Each option `Box` (ll.41-48) has **only** `padding(horizontal = 14.dp)` and `contentAlignment = Center` — it has **no height/`fillMaxHeight`**, so the active pill (the `c.primary` fill) sizes to its text + vertical default, not to the 34dp track. Result: the inner selected pill is shorter than the track and floats, reading as an off-center "pill inside a pill." The outer `padding(2.dp)` is applied on all four sides but the inner boxes don't stretch to consume it symmetrically.
- **Desired:** mock `.tabs` (ll.54-60): outer rail `padding:5px`; each `.tabs button` `padding:8px 18px` and the active `.on` pill fills the rail height so the cream fill is flush top/bottom inside the rail with even 5px inset. The selected pill is a clean inset, vertically centered, same height as the inactive segment.
- **Fix:**
  1. In `SegmentedPicker`, give each option `Box` `Modifier.fillMaxHeight()` (and matching vertical padding) so the active fill spans the full inner track height; keep the 2dp outer inset even on all sides. Verify the `c.primary` fill is flush inside the rail with equal top/bottom gap.
  2. Confirm both segments share the same height whether selected or not (currently the unselected `c.surface2` box also doesn't fill height, so the baseline can shift).
  3. Mirror on Android's segmented control (`ui/directory/DirectoryScreen.kt`); component-test the selected/unselected geometry (snapshot/visual-regression on the pill bounds).
  - Pure layout fix, no data dependency. Tab counts themselves are already real (see item 2).

## 2. Tab counts ("Kinfolk 8 / Kin 16")
- **Current:** real. `kinfolkCount` = size of the live Kinfolk stream; `kinCount` = count of non-archived Kin from `allKinStream()` (`DirectoryScreen.kt` ll.184-185, label lambda ll.222-225). Rendered as `"$tab  $count"` — keep this binding.
- **Desired:** mock `.ct` micro-count is a small mono number appended to each tab label (`Kinfolk 8`, `Kin 16`). Mock's `8`/`16` are PLACEHOLDER.
- **Fix:** styling only — the `.ct` in the mock is a smaller, dimmed mono span. If desired, render the count in `AuntieTheme.typography.mono` / `textDim` rather than the same weight as the label. Keep the real binding. No data dependency.

## 3. Sort "A to Z" sorts by FIRST name, must sort by LAST name (Auntie complaint)
- **Current:** broken. `DirectoryUiState.filteredSorted` (`DirectoryViewModel.kt` ll.33-48) calls `sortedByOption(name = { it.displayName }, …)`. `Kinfolk.displayName` (`FirestoreClient.kt` l.642-643) = `"$firstName $lastName"`. `sortedByOption` (`SortOption.kt` ll.34-39) for `AlphaAsc` does `sortedBy { name(it).lowercase() }` — so "A to Z" orders by the **first name**, exactly the complaint. (The Kin tab passes `name = { k -> k.name }`, which is correct for pets.)
- **Desired:** mock sort pill exposes `A to Z` / `Z to A` (mock script ll.235). For Kinfolk, alphabetical must order by **surname** (last name), the directory convention.
- **Fix (full-stack-ish — touches the shared sort helper + both platforms):**
  1. Add a last-name-aware sort key for Kinfolk. Cleanest: pass `name = { it.lastName.ifBlank { it.displayName } }` for the Kinfolk tab so `sortedByOption` orders on surname, with a stable tiebreak on first name. (Do not change Kin, which sorts on `name`.) Alternatively add a dedicated comparator that sorts `(lastName, firstName)`.
  2. Decide ties + blank last names deliberately (a Kinfolk with no `lastName` should fall back to `displayName`, not vanish to the top).
  3. Mirror the same surname comparator in Android's `DirectoryViewModel` so web/desktop/Android agree.
  4. Unit-test the comparator: surnames order correctly, blank-lastName fallback, `Z to A` reverses on surname. (Android has `DirectoryViewModelExtTest.kt` / sort tests already — extend them.)
  - **Dependency:** none new; uses existing `firstName`/`lastName` fields. This is a logic bug, fix it directly.

## 4. Sort options labels + "Recently active / Recently created"
- **Current:** `SortOption` enum (`SortOption.kt` ll.8-12) = `A → Z`, `Z → A`, `Recently Created`, `Recently Updated`. Uses real arrow glyphs `→` in labels. Recency sorts use `joinDate` for Kinfolk (ll.43-46) and **blank** for Kin (`createdAt = { _ -> "" }`, `DirectoryScreen.kt` ll.311-313) → Kin recency falls back to alpha.
- **Desired:** mock sort pill cycles `Recently active`, `A to Z`, `Z to A`, `Recently created` (mock script l.235). Note mock uses plain `to`, not the `→` arrow.
- **Fix:**
  1. Copy guardrail: the enum labels use `→`. The mock uses "A to Z". Em dashes are banned; the arrow is not an em dash, but to match the mock copy reuse "A to Z" / "Z to A" verbatim (no new copy authored). Leave a TODO if a label change needs sign-off.
  2. **Dependency (Kin recency):** Kin has **no `createdAt`/`updatedAt`** (`FirestoreClient.kt` Kin model ll.854-880 — none present). "Recently created/active" on the Kin tab silently falls back to alpha today (honest fallback, but undisclosed). Either add `createdAt`/`updatedAt` to the Kin schema + write path (all platforms) so recency is real, or disclose the fallback with a small note on the sort pill when Kin is active. Do not fake a Kin timestamp.
  3. **Dependency ("Recently active"):** the mock's default sort is "Recently active," implying a **last-activity** signal (last visit / last comms). Neither Kinfolk nor Kin carries a `lastVisitAt`/`lastActiveAt`. Until a last-activity aggregation exists (see item 7), "Recently active" must map to an honest proxy (`joinDate`/`updatedAt`) or be omitted — never a fabricated recency.

## 5. Search field
- **Current:** real and wired. `AuntieSearchField` bound to `vm.search()` (`DirectoryScreen.kt` ll.227-234). Kinfolk match runs over `displayName`, `email`, and **digit-normalized** phone (`DirectoryViewModel.kt` ll.64-73 — strips formatting so a bare-digit query matches `(512) 555-1234`). Kin match runs over name/species/breed (`matchKin`, ll.388-394). Placeholder copy switches per tab.
- **Desired:** mock `.search` (ll.61-63) single input, placeholder "Search by name, pet, or phone…". Search box sits between the tabs and the sort pill in the controls row.
- **Fix:** no functional change needed — search is genuinely wired. Copy nit: mock says "name, pet, or phone"; current Kinfolk placeholder is "Search by name, phone, or email" and does **not** search by pet name. If "search by pet" is desired on the Kinfolk tab, extend `Kinfolk.matches` to also scan that kinfolk's kin names (needs the kin-by-kinfolk map already built at `DirectoryScreen.kt` ll.179-181 to be threaded into the matcher) — otherwise keep the current honest placeholder. Do not promise "pet" search the matcher can't do.

## 6. Card layout + frame
- **Current:** `CardGrid` (`DirectoryScreen.kt` ll.349-378) computes a real column count from width and lays out fixed-height (`CARD_HEIGHT = 196.dp`) cards in equal-weight rows, padding the last row — a faithful port of `repeat(auto-fill, minmax(290px, 1fr))`. `KinfolkCard` (ll.404-548): gradient `AuntieAvatar`, name + household subtitle (`householdLabel(lastName)` → "the {lastName}s"), kin chips with paw-glyph leading avatars (capped at 3 + overflow), a contact rail (phone/mail icons), and a status pill in the footer.
- **Desired:** mock `.kcard` (ll.72-107): gradient avatar + name + `the {household} · {area}` subtitle; kin chips with a **circular pet photo** thumbnail leading; footer = contact icons (phone/mail) left, a right-aligned `last visit / {time}` block. A `New` badge top-right for onboarding kinfolk.
- **Fix:**
  1. **Subtitle "· {area}":** the mock subtitle is "the Wrens · Riverside" (household + neighborhood). `Kinfolk` has no neighborhood/serviceArea field; current code honestly shows only "the {lastName}s" (ll.448-463, with an inline SUGGESTION). **Dependency:** add a `neighborhood`/`serviceArea` field to the Kinfolk model + edit form + write path (all platforms) if the "· area" segment is wanted, else leave the household-only subtitle. Do not invent a locality string.
  2. **Kin chip thumbnail:** mock uses a circular **photo**; current chips use a paw-glyph `AuntieAvatar` because Kin has no `profilePictureUrl` field (Kin model `FirestoreClient.kt` ll.854-880 has none). **Dependency:** add a Kin photo field + upload (see 06-kin-detail) to show real pet photos; until then the paw glyph is the honest fallback.
  3. **Footer "last visit / {time}":** the mock's footer right-block is a last-visit timestamp. Current footer shows a `StatusPill` instead, and the screen already gates a "last-visit footer" extra behind `flags.directoryLastVisit` with a visible "not wired" banner (`DirectoryScreen.kt` ll.243-262) — correct fail-loud. **Dependency:** a last-visit-per-kinfolk source (item 7) before this footer can be real.
  4. **Contact icons** (phone/mail) currently `onClick = onClick` → open the profile, because there's no verified `tel:`/`mailto:` launcher (ll.523-543, audit-low note). Honest. If a platform launcher is added, wire the icons to it on all three platforms; else leave opening the profile.

## 7. "New" badge + last-visit footer (gated, fail-loud) — Auntie's card extras
- **Current:** both already disclosed-and-gated. `flags.directoryLastVisit` / `flags.directoryNewBadge` drive a single dashed "Card extras not wired yet" `AuntieBanner` above the grid (`DirectoryScreen.kt` ll.243-262) that explicitly names the missing data paths ("no lastVisit field, no isNew flag, no visit_logs query here"). This is the correct pattern — keep it.
- **Desired:** mock `.badge.new` top-right "New" pill on onboarding kinfolk; `.last` footer "last visit / {time}" or "onboarding / 0 KinTales".
- **Fix:** do **not** un-gate these by hardcoding. Build the real sources first:
  - **Dependency — last visit per kinfolk:** a per-kinfolk last-visit timestamp (max `completedAt`/`departedAt` across that kinfolk's `kin_care_sessions`, or a denormalized `lastVisitAt` on Kinfolk). Backend aggregation → data layer → all platforms → tests. Unblocks the footer AND the "Recently active" sort (item 4).
  - **Dependency — onboarding / "New" flag:** an `isNew` / onboarding-status signal (e.g. joinDate within N days, or an explicit onboarding state) + a KinTale-count per kinfolk for the "0 KinTales" variant. Until both exist, the gated banner stays.

---

## Out of scope / leave as-is
- Editorial head (mono kicker + serif "Your **kinfolk**" + Add CTA) already matches the mock `.head` (`DirectoryScreen.kt` ll.189-209).
- The responsive grid math (`CardGrid`) is a faithful, real port of the mock CSS grid — leave it.
- Empty states / loading shimmer already fail-loud correctly (ll.276-322).
- N+1 fix (single `allKinStream()` feeding both the Kin tab and per-card chips) is a real improvement — leave it.
- Phone-search digit normalization is correct — leave it.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Surname sort comparator for Kinfolk** (logic fix, no new data): order Kinfolk alphabetically by `lastName` (tiebreak `firstName`, blank-lastName → `displayName`). Mirror in Android, extend sort unit tests.
2. **Last-visit-per-kinfolk source** (max session `completedAt`, or denormalized `lastVisitAt` on Kinfolk): unblocks the card footer AND the "Recently active" default sort.
3. **Onboarding / "New" flag + KinTale-count per kinfolk:** unblocks the `New` badge and "0 KinTales" footer variant.
4. **Kin `createdAt`/`updatedAt` timestamps:** so the Kin tab's recency sorts are real, not an undisclosed alpha fallback.
5. **(Optional) Kinfolk `neighborhood`/`serviceArea` field:** to render the "· {area}" subtitle segment verbatim.
6. **(Optional) Kin `profilePictureUrl` + upload:** real circular pet thumbnails in the kin chips (shared with 06-kin-detail's photo-upload dependency).
7. **(Optional) Pet-name search on the Kinfolk tab:** thread the kin-by-kinfolk map into `Kinfolk.matches` to honor the mock's "search by pet" placeholder.

Every value rendered on this screen must trace to a real stream (`kinfolkStream`, `allKinStream`) or a new real source above. If it can't, it ships dark with a "Not wired" banner — not hardcoded.
