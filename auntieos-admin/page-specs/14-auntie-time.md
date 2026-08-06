> STATUS 2026-06-09 (de-stale): shipped tri-platform. RouteMap renders live on ARRIVED/DEPARTED cards (not just the composer); time-block labels + multi-pet avatars are wired ALWAYS-ON (the `FF_TIME_BLOCK_LABELS` / `FF_MULTI_PET_AVATARS` gates the spec cites no longer exist); full lifecycle (SCHEDULED..COMPLETED) + GPS start/stop + live indicator; empty/loading/error all fail-loud. Android at parity plus 3 android-only affordances (OMW confirm dialog, Note-to-Office, quick-contact row). Empty `startTime` handled gracefully ("Time TBD"). GAP: the multi-stop geocoded route OVERVIEW (item 1.2) has no lat/lng/ordering source; the sorted stop list exists, only the map polyline is missing. DECISIONS: android-only "Live Map" full-screen view (add to web?); split item 1.2 so the done stop-list is separated from the pending map overlay?

# Auntie Time — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-auntie-time-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/sessions/KinCareSessionsScreen.kt`
**Current code (web, route render):** `…/screens/sessions/RouteMap.kt`
**Current code (web, detail):** `…/screens/sessions/KinCareDetailScreen.kt` (drill-in from a card)
**Current code (android):** parity target — Android equivalent must match (Rule 2).
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `AuntieStatusPill`, `AuntieIconTile`, `AuntieAvatarStack`, `AuntieBanner`, `AuntieEmptyState`, `StatCard`, `GhostButton`, `PrimaryButton`, `StatusToast`, `ShimmerCard` in `…/web/ui/components/`.

> ⚠️ Mock/identity verification (the assignment asked to confirm this is the Auntie Time / route view): CONFIRMED. `KinCareSessionsScreen` (ll.112-129) routes to `AuntieTimeListScreen` (the List route); that composable's `DenScreenHeading` is `kicker="The Den · Auntie Time", title="Auntie", accentTail="Time."` (ll.226-231) and its header comment names the Auntie Time mockup. The screen status lifecycle SCHEDULED→ON_MY_WAY→ARRIVED→DEPARTED→COMPLETED with per-session GPS trackers matches the mock's documented behavior. This is the right file.

> ⚠️ Complaint reconciliation (read first): Auntie's complaint — *"today's route + active visits + upcoming care windows live HERE; currently underbuilt."*
> - **Active visits + upcoming care windows** — ALREADY HERE: phases `Active` / `Upcoming` / `Recent` (`Phase`, ll.131-135) with the full lifecycle action buttons and a stat row. This is built.
> - **"Today's route"** — UNDERBUILT / MISSING: the screen tracks GPS per ARRIVED session (`startGpsFor` / `GpsTracker`, ll.164-184) and shows a live "GPS tracking · live route" indicator (`GpsLiveRow`, ll.698-718), and `buildGpsSummary` bakes the route on session-end (ll.853-870) — BUT the screen does **not render an actual route map** (`RouteMap.kt` is imported by the KinTale composer, not by `AuntieTimeListScreen`). There is no "today's route" overview map. This is the core underbuilt gap.
> - **Content moving from Schedule (13):** the Schedule subtitle currently claims "today's route, active visits, and upcoming care windows" — per 13's complaint, that framing belongs HERE. This screen is where those land.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren`, `30 min · Biscuit & Gravy · 9:00 to 9:30a`, `82 Creekside Ln`, `today, Evening block`, `Bess Sparrow 10:30a`, the `3`/`2`/`2` counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. "Today's route" overview map — the underbuilt gap (Auntie's complaint)
- **Current:** there is **no route map** on this screen. GPS is tracked per ARRIVED session and summarized on end (`buildGpsSummary`, ll.853-870; `saveSessionGpsSummary`, l.208), and a pulsing "GPS tracking · live route" text row shows on ARRIVED cards (`GpsLiveRow`, ll.698-718) — but the shared `RouteMap` composable (`RouteMap.kt`) is **not rendered here** (it is imported only by the KinTale composer). The complaint "today's route … currently underbuilt" is accurate.
- **Desired:** the Auntie Time mock itself does not draw a map, but Auntie's stated intent (and the Schedule-13 content that should move here) is a **today's-route view**: the live polyline of the in-flight visit and/or the ordered route across today's stops.
- **Fix (full-stack — the headline item):**
  1. **Live single-visit route:** render the shared `RouteMap` on the ARRIVED card (or in `KinCareDetailScreen`) bound to the real `breadcrumbsStream(sessionId)` with `live=true`, so the in-flight polyline is actually visible, not just a text indicator.
  2. **Today's multi-stop route overview** (the bigger ask): a map/ordered list of today's stops in run order. This needs a **route-ordering source** (the ordered list of today's sessions + their service addresses/coords). Addresses exist on `Kinfolk.serviceAddress` (joined in via `kinfolkById`, ll.217-221); geocoding/ordering does not. Until a real ordering/coords source exists, render the ordered **stop list** from real data and gate the map overlay dark with a Not-wired banner — do not fake a route line.
  - **Dependency:** for (1) none new (breadcrumbs exist). For (2) a today's-stops ordering + per-stop coordinates source (geocode of `serviceAddress` or stored coords), all platforms.

## 2. Header + stat row
- **Current:** `DenScreenHeading` Auntie Time (ll.226-231) + `StatRow` (ll.356-385): "In flight" (feature card, real active count), "Up next today", "Wrapped today" — all computed from the live `sessionsStream` (ll.298-303). Real.
- **Desired:** mock `.head` paw + "Auntie Time" + "Day-of view…" sub.
- **Fix:** none functional. If the Schedule-13 "today's route / active visits / upcoming care windows" framing moves here, fold it into this subtitle (author-owned copy). Mirror on Android.

## 3. Active phase cards + lifecycle actions
- **Current:** `PhaseGroup`/`KinCareCard` (ll.408-563): live ARRIVED cards lift to a teal radial wash (mockup `.card.live`), show real status pill, address chip (→ maps), notes preview, "Invoice linked" chip (real `invoiceId`), and **state-aware action rows** (`ActionRow`, ll.565-647): SCHEDULED→[OMW][Arrived][Complete], ON_MY_WAY→[Arrived][Complete], ARRIVED→[Departed][Undo Arrived], DEPARTED→[Complete KinTale], COMPLETED→[View KinTale]. Each writes via `patchKinCare` + starts/stops GPS (ll.325-343). A kebab offers Mark Completed / Cancel. Real, wired, audited.
- **Desired:** mock Active cards with the same lifecycle buttons + GPS row.
- **Fix:** none functional — this matches the mock closely and is fully wired. Integration-test each status transition + the GPS start/stop side effects; parity on Android.

## 4. Upcoming phase + time-block labels (SUGGESTION, gated dark)
- **Current:** Upcoming cards render from real SCHEDULED sessions (today..+14, ll.278-287). The mock's "today, Evening block" descriptor is gated by `FF_TIME_BLOCK_LABELS=false` (ll.95-97) because `KinCareSession` has **no block field** and no Business-Settings block resolver is wired. When flipped on, a fail-loud `SuggestedNotWiredBanner` shows (ll.389-406) instead of faking a block.
- **Desired:** mock shows "today, Evening block" / "tomorrow, Midday block" descriptors.
- **Fix (full-stack):** resolve a real **time-block descriptor** for a session (a block field on the session, or a Business-Settings block resolver mapping start time → named block). Until it exists, keep the gate. **Dependency:** time-block field/resolver, all platforms (shared with the Bookings/Create "Time block" chips in 15).

## 5. Multi-pet avatar cluster (SUGGESTION, gated dark)
- **Current:** cards show the single kinfolk profile photo via `AuntieAvatarStack` (ll.489-499) or a status glyph tile. The mock's overlapping per-kin pet circles are gated by `FF_MULTI_PET_AVATARS=false` (ll.99-102) because per-kin pet avatars are not fetched. Fail-loud banner when on.
- **Desired:** mock `.photos` overlapping pet circles per card.
- **Fix (full-stack):** join real **per-kin avatars** onto the session (a kin-photos read by the session's `kinIds`), then render the cluster. Until then, gate stays. **Dependency:** per-kin avatar join by `kinIds`, all platforms.

## 6. Recent phase
- **Current:** COMPLETED/CANCELLED today-or-yesterday (ll.283-287). COMPLETED → "View KinTale" ghost (ll.638-642); CANCELLED → no actions. Real.
- **Desired:** mock Recent cards with Completed/Cancelled pills + "View KinTale".
- **Fix:** none. Mirror on Android.

## 7. Empty / loading / error
- **Current:** Loading → shimmer; Error → persistent fail-loud `AuntieBanner` (ll.255-266, fixed from a prior auto-dismiss-toast bug per the comment); Empty → `AuntieEmptyState` explaining where Kin Cares come from (ll.747-762). Correct.
- **Desired:** n/a.
- **Fix:** none.

---

## Out of scope / leave as-is
- The full lifecycle state machine + per-session GPS trackers + audit logging (ll.156-215, 565-647) — correct and load-bearing; do not regress.
- `buildGpsSummary` down-sampling + distance/duration math (ll.853-907) — correct; this is the real source for any route distance/time shown here or on the KinTale composer/report.
- DRAFT/PENDING bookings intentionally excluded (they live on Bookings, 15) — correct single-source-of-truth boundary.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Render `RouteMap` on the live ARRIVED card / detail** bound to real `breadcrumbsStream` (item 1.1) — no new backend; the underbuilt "today's route" is largely a wiring gap for the single-visit case.
2. **Today's-stops ordering + per-stop coordinates source** (item 1.2) → the multi-stop "today's route" overview. Geocode/ordering of `serviceAddress`, all platforms.
3. **Time-block field/resolver** (item 4) → Upcoming "Evening block" descriptors. Shared with 15's Time-block chips.
4. **Per-kin avatar join by `kinIds`** (item 5) → the multi-pet avatar cluster.
5. **Move the Schedule-13 "today's route / active visits / care windows" framing here** (item 2) so the content lands on the screen that owns it.

Every value already drawn here traces to the live `sessionsStream` / `kinfolkStream` / `breadcrumbsStream`. The two mock SUGGESTIONs (time-block labels, multi-pet avatars) are gated dark with fail-loud banners. The headline work is wiring the real route map (single-visit now; multi-stop once a coords/ordering source exists).
