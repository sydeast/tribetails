> STATUS 2026-06-09 (de-stale): nearly all shipped tri-platform. Heading reframed; the `scheduleNewVisit` / `scheduleDragReschedule` / `scheduleGoogleCalBusy` gates are all REMOVED and live (new-visit -> createKinCareSession; drag -> rescheduleBooking with snapRescheduleTo15Min + optimistic update + fail-loud revert; busy blocks stream real `booking_time_slots`, error banner gated on `calendarSyncId` configured); fill-width weight(1f) week grid; day-card above the calendar (#12); busy legend swatch. Android at parity (ScheduleViewScreen.kt). GAP (named external secret): the Google Calendar busy-SYNC write source (`syncGoogleCalendarBusyEvents`) needs a Google Calendar OAuth client ID from the operator; the read path is fully wired. DECISIONS: 6-Week view kept as an extension beyond the mock's Day/Week/Month; final heading subtitle copy is operator-owned (currently the data-derived range label).

# Schedule — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-schedule-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/schedule/ScheduleScreen.kt`
**Current code (web, modal):** `…/screens/schedule/BookingDetailModal.kt` (opened on event/agenda tap, ScheduleScreen ll.271-277)
**Current code (android):** parity target — Android equivalent must match (Rule 2).
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `SegmentedPicker`, `AuntieIconButton`, `AuntieBanner`, `AuntieStatusPill`, `ServicePill`, `PrimaryButton`, `EmptyHint`, `ShimmerCard`, `serviceTone`/`statusLabel` in `…/web/ui/components/`.

> ⚠️ Mock-file correction: none. The assignment names `auntieos-schedule-2026-05-27.html` and `ScheduleScreen.kt`; the screen builds the mock's week grid. Agree.

> ⚠️ Big-complaint reconciliation (read first): Auntie's complaints are mostly ALREADY addressed in code, with two still open.
> - **"Schedule and Bookings duplicate add-visit / add-booking with no single source of truth"** — ADDRESSED: ScheduleScreen's "New visit" CTA is shipped **dark** behind `flags.scheduleNewVisit` with a fail-loud banner that says *"Creating a visit from the Schedule has no backing write yet. Create bookings from the Bookings screen for now."* (ll.165-180). So booking creation has a single source of truth (Bookings), and Schedule does not duplicate it. The remaining decision is whether to **remove the New-visit button from Schedule entirely** vs. keep it gated.
> - **"Schedule should become a full CALENDAR of events"** — PARTIALLY ADDRESSED: Day/Week/Month/6-Week views exist (`ScheduleView`, ll.77-82), Week renders a real time-grid calendar. STILL OPEN: it plots only `kin_care_sessions`; it is not yet a full multi-source event calendar (no Google-busy, no non-session events).
> - **"Calendar should be centered + fill width + level pills"** — PARTLY OPEN: the week grid uses fixed `DAY_COLUMN_MIN_WIDTH=132.dp` columns inside a horizontal scroll (ll.93, 450), so it does NOT fill width responsively; and the view picker is a `SegmentedPicker`, which is the "level pills" intent — confirm styling matches.
> - **"This week's runs" is mislabeled** — STILL OPEN: the heading is literally `title="This week's" accentTail="runs."` (ll.113-118). Auntie flagged this label as wrong for a full calendar.
> - **"Today's route / active visits / upcoming care windows belong under Auntie Time, not Schedule"** — STILL OPEN: the Schedule **subtitle** literally reads *"Today's route, active visits, and upcoming care windows."* (l.117) — exactly the content Auntie says belongs on Auntie Time (14). The subtitle copy must move/change.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`This week's runs`, `May 25 to 31`, `Biscuit & Gravy 9:00`, `Marigold 10:30`, `Busy · Google Calendar`, `now 11:18`, the day numbers) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Heading + subtitle — the mislabel (Auntie's explicit complaint)
- **Current:** `DenScreenHeading(kicker="The Den · Schedule", title="This week's", accentTail="runs.", subtitle="Today's route, active visits, and upcoming care windows.")` (ll.113-118). Both the title and subtitle are exactly what Auntie flagged: "this week's runs" is wrong for a full calendar, and the subtitle describes Auntie-Time content (today's route / active visits / care windows).
- **Desired:** mock `.head` shows "This week's runs" as a *week-view* label, but Auntie wants Schedule reframed as a full event calendar.
- **Fix (copy + framing decision — author-owned, do not invent new copy here):**
  1. Retitle the screen to read as a **calendar** (e.g. "Schedule" / "Calendar"), not "this week's runs" — Auntie authors the final words. Make the dynamic label follow the **active view + range** (Day/Week/Month) rather than a fixed "this week's".
  2. **Move the "today's route / active visits / upcoming care windows" subtitle to Auntie Time (14)** and give Schedule a calendar-appropriate subtitle. The current subtitle is the single clearest mislabel. No data dependency — pure copy/framing — but coordinate with 14 so the moved content actually lands there.

## 2. Single source of truth for creating visits/bookings (Auntie's explicit complaint)
- **Current:** "New visit" `PrimaryButton` exists in `ScheduleControls`/`FlowRowControls` (ll.356-369) but is **disabled unless `flags.scheduleNewVisit`** (off), with a fail-loud "New visit not wired here … Create bookings from the Bookings screen for now" banner (ll.165-180). So there is no duplicate create path today.
- **Desired:** mock `.add` "＋ New visit" button.
- **Fix (decision, full-stack):**
  1. **Pick one:** (a) remove the New-visit affordance from Schedule entirely so Bookings is the sole create surface (cleanest single-source-of-truth, matches Auntie's complaint), or (b) keep it but have it **route to the Bookings create flow** instead of a separate Schedule create. Do NOT build a second create-session/booking write on Schedule.
  2. If kept, the banner must stay until the chosen path is wired; never enable a dead CTA. Parity on Android; integration-test the route/gate.
  - **Dependency:** none new if it routes to Bookings; a create-session callable only if you deliberately add a Schedule-native create (discouraged).

## 3. Week calendar grid — centered + fill-width (Auntie's complaint)
- **Current:** `WeekCalendar` (ll.421-623) is a real time-grid: day-header row, time gutter (8a-6p, `GRID_START_HOUR`/`GRID_END_HOUR`, ll.88-90), real session `EventBlock`s positioned by **local** start time (ll.626-689), a coral "now" line (ll.564-591), and an honest off-window note for visits outside 8a-6p (ll.597-621, no edge-clamping). Columns are fixed `DAY_COLUMN_MIN_WIDTH=132.dp` inside a `horizontalScroll` (ll.93, 450).
- **Desired:** mock `.cal` uses `grid-template-columns:56px repeat(7,1fr)` — i.e. the 7 day columns **flex to fill the container width**, centered in a `max-width:1280px` wrap.
- **Fix:**
  1. Make the 7 day columns **weight-based (`weight(1f)`) to fill width** instead of fixed 132.dp + horizontal scroll, so the calendar fills and centers like the mock (drop the horizontal scroll on wide viewports; keep a min-width fallback only on narrow screens per the mock's `@media(max-width:900px)`).
  2. Ensure the grid sits in a centered max-width container (the `ScreenScaffold` likely already centers; confirm). Pure layout; mirror on Android. No data dependency.

## 4. View picker "level pills"
- **Current:** `SegmentedPicker` over Day/Week/Month/6-Week (ll.347-352). 6-Week is an extra view not in the mock (mock has Day/Week/Month).
- **Desired:** mock `.seg` Day / Week / Month pills.
- **Fix:** confirm `SegmentedPicker` styling reads as the mock's pill segment. Decide whether to keep the extra "6 Wk" view (not in mock) — if kept, it is a reasonable addition; if Auntie's "level pills" means exactly three, trim to Day/Week/Month. Pure UI; mirror on Android.

## 5. Google Calendar busy blocks (mock affordance, gated dark)
- **Current:** gated behind `flags.scheduleGoogleCalBusy` (off) with a fail-loud "Google Calendar busy sync not wired … none are drawn on the grid" banner (ll.184-198). The legend's busy swatch is correspondingly not implemented (the legend uses real service tones + an honest "Other / unmapped", ll.379-393). No busy data is faked.
- **Desired:** mock shows read-only striped "Busy · Google Calendar" blocks + a legend swatch.
- **Fix (full-stack — this is the real "full calendar of events" backend):** build a **Google Calendar busy-sync source** (OAuth + a synced-busy stream) so external busy time appears as read-only blocks. Until it exists, keep the gate + banner. This is the core dependency to make Schedule a true multi-source event calendar. **Dependency:** Google Calendar busy-block sync source + stream, all platforms.

## 6. Drag-to-reschedule (mock affordance, gated dark)
- **Current:** the mock's drag-snap-15-min reschedule is gated behind `flags.scheduleDragReschedule` (off) with a fail-loud "Drag-to-reschedule not wired … Tap a visit to open and review it instead" banner (ll.239-253). Grid is read-only. Comment (ll.85-87) confirms no reschedule callable exists.
- **Desired:** mock drag-to-reschedule (snaps to 15 min, cross-day).
- **Fix (full-stack):** build a **reschedule callable** (move a session's start, snap to 15 min, cross-day), then wire drag gestures + flip the flag. Until then keep the gate + banner; never let a drag silently do nothing. **Dependency:** reschedule-session callable, all platforms; this same callable also unblocks bulk Reschedule on Bookings (15).

## 7. Day agenda + booking detail modal
- **Current:** below the grid, `DenPanel` "Day agenda" with `DayAgenda` (ll.255-266, 767-855): real session rows (time, service, status pill, subtitle) tappable → `BookingDetailModal`. Tapping a grid event also opens the modal (ll.553-558, 271-277). Real, wired.
- **Desired:** mock has no separate agenda; this is an app-correct addition that surfaces off-window visits and detail.
- **Fix:** none functional. Keep; mirror on Android. Confirm `BookingDetailModal` shows real session/booking detail (not faked). Integration-test the tap→modal path.

---

## Out of scope / leave as-is
- Local-timezone day-bucketing + positioning (`localDateKey` / `localMinutesOfDay` / `displayTime`, ll.943-1012) — correct and important; do not regress.
- Honest off-window note instead of edge-clamping (ll.597-621) — keep.
- Month / 6-Week `MonthGrid` count dots (ll.691-765) bound to real per-day session counts — correct.
- Loading/Error fail-loud states (ll.122-141) — correct.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Reframe copy + move the "today's route / active visits / care windows" content to Auntie Time (14)** (item 1) — the explicit mislabel. Coordinate with 14 so it lands there, not nowhere.
2. **Single-create-path decision** (item 2): remove Schedule's New-visit CTA or route it to Bookings create. No second create write.
3. **Fill-width / centered week grid** (item 3): weight-based columns instead of fixed 132.dp + horizontal scroll.
4. **Google Calendar busy-sync source + stream** (item 5) → the core "full event calendar" backend. Largest item.
5. **Reschedule-session callable** (item 6) → drag-to-reschedule (and bulk Reschedule on Bookings).

Every value drawn on the grid already traces to the real `sessionsStream`. The not-yet-real surfaces (New visit, Google busy, drag-reschedule) are all gated dark with fail-loud banners — none are hardcoded. The open work is the copy/framing reframe, the fill-width layout, and the two real backends (busy sync, reschedule callable).
