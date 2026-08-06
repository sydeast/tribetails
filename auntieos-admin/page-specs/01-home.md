> STATUS 2026-06-09 (de-stale pass): SHIPPED: asymmetric stat row (item 1), feature-card radial wash + paw watermark (item 2), live weekly-revenue card via `weeklyRevenue()` with the flag removed (item 3), shell-level global search + notification bell on web/desktop (item 4), KinTale-row duplicate-name fix (item 6), dashboard widget customization 17.3/17.4. GENUINE GAPS: prior-week delta + `StatCard.trendTone` (item 3); breed/species join on `KinCareSession` for the visit-row subtitle (item 5); relative-time formatter for tale rows (item 6). DECISIONS PENDING: `GeneratedDraft` has no title field, the row uses `communicationType` (keep or add a real title?); Android shell search/bell parity (intended on mobile, or add?).

# Home — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-redesign-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/home/HomeScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/home/HomeScreen.kt` (+ `HomeViewModel.kt`)
**Shared components:** `StatCard`, `DenScreenHeading`, `DenPanel` in `…/web/ui/components/DenScreenKit.kt`

> ⚠️ Mock-file correction: `HomeScreen.kt` (line 59) mirrors **`auntieos-redesign-2026-05-27.html`**, not `auntieos-home-2026-05-27.html`. The `-home-` file is an older/different concept (quick-action grid + "Today's Tribe"). Use the `-redesign-` file as truth for this screen.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`$1.9k`, `+12% vs last`, `6`, `Marigold's lazy afternoon`, `Labradors · the Wrens`, `DRAFT · DUTTON · 4 MIN AGO`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Stat row — overall layout
- **Current:** four `StatCard`s each `Modifier.weight(1f)` → equal widths (`HomeScreen.kt` ll.108-156).
- **Desired:** asymmetric row, first card wider. Mock `.stats{grid-template-columns:1.5fr 1fr 1fr 1fr}`.
- **Fix:** feature card `Modifier.weight(1.5f)`, other three `weight(1f)`. Pure layout; mirror on Android. No data dependency.

## 2. Card 1 "Today's pack" — the feature card
- **Current:** `StatCard(feature = true)` renders a **flat** wash: `fill = toneColor.copy(alpha = 0.10f)`, hairline border, value in `headlineLarge` (same size as others), no watermark. (`DenScreenKit.kt` ll.120-148). Value/trend are already bound to the real `todaySessions` count + done/on-the-way counts — keep that binding.
- **Desired:** mock `.stat.feature` =
  - background: **radial orange wash top-right** `radial-gradient(120% 140% at 100% 0%, rgba(223,132,49,.32), transparent 55%)` over base `linear-gradient(160deg, navy-2, navy-3)`;
  - value enlarged to ~58px in orange;
  - **paw-print watermark** bottom-right, ~78px, opacity ~.16, clipped to the card.
- **Fix (styling only — data already real):**
  1. In `StatCard`, replace the flat 10% feature fill with a `Brush.radialGradient` top-right orange wash over the base.
  2. Feature value → ~58sp, color `c.primary`.
  3. Add bottom-right `Lucide.PawPrint` (or brand paw) at ~16% alpha, ~78dp, inside `clip(shape)`.
  - Keep the mock's faint `var(--line)` hairline (Auntie's "remove the solid border" = lose the flat fill, not the hairline). Mirror on Android; visual-regression test the feature variant.

## 3. Card 4 (rightmost) — revenue card vs Kinfolk count
- **Current:** gated. `flags.homeWeeklyRevenueStat` defaults **off** → card 4 shows the **real** "Kinfolk / {kinfolkCount} / active households" (bound to `kinfolkStream`). Flag-on path currently shows `"-"` / "revenue (coming soon)" — correctly NOT faked. (`HomeScreen.kt` ll.137-155)
- **Desired:** mock card 4 = a **weekly-revenue** stat: label "This week", a **currency value**, and a **percent-change trend** with the positive delta tinted teal. (The mock's "$1.9k" and "+12%" are PLACEHOLDER per Rule 1 — do not hardcode either.)
- **Fix (full-stack — this is the important one):**
  1. **Backend:** build a weekly-revenue aggregation (sum of paid invoices for the current week, plus prior week to compute the % delta). Expose it as a real stream/callable across web + desktop + Android data layers. Until it exists, **leave the card on the real Kinfolk-count fallback** — never print a hardcoded "$1.9k/+12%".
  2. **Component:** add **conditional trend coloring** to `StatCard` (today `trend` is one flat `c.textDim` string). New param e.g. `trendTone` so a positive delta renders teal/green and negative coral — driven by the *computed* delta sign, not a literal.
  3. **Wire + flip:** once the aggregation lands, bind value (compact-currency format of the real sum) and trend (real % delta), then enable `homeWeeklyRevenueStat`. Unit-test the aggregation; integration-test the wired card; parity on all three platforms.

## 4. Top bar — search + notification bell (MISSING)
- **Current:** Home shows only `DenScreenHeading` (kicker + greeting). No search, no bell. (real screenshot confirms)
- **Desired:** mock `.topbar` adds, right of the greeting: a **search input** (placeholder copy "Find a kinfolk, kin, or KinTale…") and a **bell icon button** with an unread "ping" dot.
- **Fix (full-stack):**
  1. **Placement (LOCKED — Decision 10):** shell-level top bar in `…/web/ui/shell/AppShell.kt` (consistent across all screens; Android/desktop parity for free). NOT the per-screen `DenScreenHeading` trailing slot.
  2. **Search** must run a real query across kinfolk/kin/KinTale data and route to results — not a decorative box. If there's no search backend yet, gate the field dark with a Not-wired banner rather than shipping a dead input.
  3. **Bell** routes to `Destination.Notifications`; the ping reflects a **real unread count** (needs an unread-count source — gate dark if absent). Tests: search query/unit + nav/integration; parity across platforms.

## 5. "Today's Pack" panel — visit rows
- **Current:** `VisitRow` (`HomeScreen.kt` ll.214-245): paw `AuntieIconTile`, `kinfolkName` + `serviceType` subtitle, `ServicePill`, time + `statusLabel`. All bound to the real `KinCareSession`.
- **Desired:** mock `.visit` (grid `58px 1fr auto`): **species-tinted pet tile**, name + **"{breed/species} · the {household}"** subtitle, then service pill + right-aligned "**big time** / status word" column. (Mock's "Labradors · the Wrens" = placeholder; bind to real fields.)
- **Fix:** subtitle = real breed/species + household name (serviceType already shows in the pill); tint the avatar by `serviceTone`.
  - **Dependency:** needs breed/species + household-name **joined onto the session**. If that join doesn't exist, build it in the data layer (all platforms) or keep the current subtitle and flag the missing join — do not invent a breed/household string.

## 6. "KinTales pending" panel — tale rows
- **Current:** `TaleRow` (`HomeScreen.kt` ll.248-279): title = `communicationType` ("visit report"), subtitle = `kinfolkName`, meta = `"{STATUS} · {kinfolkName}"` — name **repeats** (real screenshot: "visit report / Sana / GENERATED · Sana"). All real data, but the wrong fields in the wrong slots.
- **Desired:** mock `.tale`: a real **tale title**, a **one-line blurb**, and meta "**STATUS · HOUSEHOLD · {relative time}**". (Mock's "Marigold's lazy afternoon" / "4 MIN AGO" = placeholder.)
- **Fix:**
  1. Title = the draft's real subject/title. **Dependency:** if `GeneratedDraft` has no title field, add one to the model + write path (all platforms) or derive a short title from copy — flag which; don't hardcode.
  2. Blurb = first ~line of the real `generatedCopy`.
  3. Meta = `STATUS · {real household} · {relative time}` — **stop repeating kinfolkName** (the Sana · Sana bug). Relative time needs a **real draft timestamp**; if the field is absent, omit the time segment rather than faking it.

---

## Out of scope / leave as-is
- Greeting + kicker (`DenScreenHeading`) already match the time-aware greeting + "{n} visits on the books" kicker, bound to real data.
- Two-column split (Today's Pack `weight(3f)` / KinTales `weight(2f)`) ≈ mock's `1.6fr / 1fr`. Fine.
- Empty states already fail-loud correctly ("Nothing on the books today. Enjoy the quiet.").

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Weekly-revenue aggregation** (paid-invoice sum, current + prior week for % delta) → unblocks card 4. Never hardcode a fallback number.
2. **`StatCard` `trendTone` param** → positive delta tinted teal, driven by computed sign.
3. **Unread-count source** → bell ping (and the bell/search top-bar placement decision).
4. **Breed/species + household join on sessions** → richer visit-row subtitle.
5. **Draft title + timestamp on `GeneratedDraft`** → real tale titles + relative time.

Every value rendered on this screen must trace to one of the real streams above (`sessionsStream`, `generatedDraftsStream`, `kinfolkStream`, `bookingRequestsStream`) or a new real source. If it can't, it ships dark with a Not-wired banner — not hardcoded.
