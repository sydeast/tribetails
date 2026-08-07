# Bookings — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-manage-bookings-2026-05-27.html` (list) AND `ui-ideas/auntieos-create-booking-2026-05-27.html` (create)
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/booking/BookingScreen.kt`
**Current code (web, VM):** `…/screens/booking/BookingViewModel.kt`
**Current tests (web):** `…/commonTest/.../screens/booking/BookingViewModelTest.kt`, `BookingViewModelExtTest.kt`
**Current code (android):** parity target — Android equivalent must match (Rule 2).
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `StatCard`, `AuntieBanner`, `AuntieStatusPill`, `AuntieAvatar`, `AuntieChipGroup`, `AuntieFieldLabel`, `BottomBorderField`, `MultilineField`, `GhostButton`, `PrimaryButton`, `EmptyHint`, `ShimmerCard` in `…/web/ui/components/`.

> ⚠️ Mock-file correction: none. `BookingScreen.kt` is the list + create flow (`BookingRoute.List` / `BookingRoute.Create`, ll.66-100); the two mocks map to those two routes. Agree.

> ⚠️ Complaint reconciliation (read first): Auntie's complaint — *"booking management only (not overlapping Schedule); history is raw rows, needs organization."*
> - **"Booking management only, not overlapping Schedule"** — ALREADY ADDRESSED: Bookings owns create (single source of truth; Schedule's create is gated dark per 13). Bookings does NOT show a calendar.
> - **"History is raw rows, needs organization"** — PARTLY OPEN: history is already in a `DenPanel("History")` of `BookingCard`s (ll.270-291), not a flat table, BUT it is a single undifferentiated, unsorted, uncapped list of every non-scheduled session (`history = sessions.filter status !in {SCHEDULED,DRAFT,PENDING}`, l.183) — Completed and Cancelled mixed, no date grouping, no sort, no limit. That is the "raw rows" Auntie means. See item 4.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mocks (`Ada Devlin`, `Drop-in · 2026-05-31 · Midday block`, `Odette Mallory · Meet & greet`, the `2`/`2`/`recent` counts; create-side `30 min $28`/`45 min $38`, `Morning 8:00 to 11:00`, `May 28/30`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Heading + stat row
- **Current:** `DenScreenHeading(kicker="The Den · Bookings", title="Bookings", subtitle="Pending requests and scheduled visits.", trailing=Select + New booking)` (ll.127-145). A 3-card stat row (`StatRowCard`, ll.185-211): Pending approval (feature card, real `pending.size`), Scheduled (`scheduled.size`), History (`history.size`) — all from the real streams, with "…" while loading. Real.
- **Desired:** mock `.head` Bookings + "☑ Select" + "＋ New booking".
- **Fix:** none functional. The stat row is an app addition over the mock; values are bound to real counts. Mirror on Android.

## 2. Pending approval — REAL requested-bookings source (the important wiring)
- **Current:** Pending reads `client.bookingRequestsStream()` — the **server-side `status=="DRAFT"` query** — NOT the full `sessions` collection (ll.119-122, comment ll.116-118 explains this avoids the legacy COMPLETED-import noise that dominates the full collection). Each `BookingCard` offers Approve/Reject calling `vm.approveBooking`/`rejectBooking` (single-id callables, ll.232-235). Real, wired, audited (`BookingViewModel` ll.21-39).
- **Desired:** mock "Pending approval" section with Approve/Reject per card.
- **Fix:** none functional. This is correctly wired to the real request source, not the noisy full collection. Mirror on Android; integration-test approve/reject; the VM tests already exist.

## 3. Scheduled section
- **Current:** `scheduled = sessions.filter status=="SCHEDULED"` (l.182), each card offers Cancel (→ `vm.rejectBooking`, ll.256-265). Real.
- **Desired:** mock "Scheduled" section with Cancel per card.
- **Fix:** none functional. Note: Cancel reuses `rejectBooking` — confirm that callable is the correct cancel semantics for a SCHEDULED session vs. rejecting a request (they may need distinct callables/audit reasons). **Dependency (verify):** a `cancelBooking` callable distinct from `rejectBooking` if the audit/semantics differ.

## 4. History — "raw rows, needs organization" (Auntie's explicit complaint)
- **Current:** `history = sessions.filter status !in {SCHEDULED,DRAFT,PENDING}` (l.183) → one `DenPanel("History")` listing every such `BookingCard` with no sort, no date grouping, no Completed/Cancelled split, no limit (ll.270-291). The trailing count is a literal "recent" string (l.274) that does not reflect the real size. This is the unorganized list Auntie flagged.
- **Desired:** mock History section (the mock itself is also a flat list, but Auntie wants it organized).
- **Fix:**
  1. **Sort** history by a real date descending (most-recent first) using `bookingDateLabel`'s source timestamps (`startTime`→`completedAt`→`departedAt`→`createdAt`, ll.401-407).
  2. **Group or split** Completed vs. Cancelled (sub-sections or status filter chips), and/or **group by month**, so it reads as organized history not raw rows.
  3. **Cap + paginate** (e.g. recent N with a "show more") so the list does not render the entire legacy import at once.
  4. Replace the literal "recent" trailing count (l.274) with the **real history size** (or the visible/total).
  - Pure client-side organization over the existing real stream (no new backend), EXCEPT pagination may want a **paged history query** if the collection is large. **Dependency:** optional paged/limited history query for scale. Mirror on Android; component-test the sort + split.

## 5. Booking cards
- **Current:** `BookingCard` (ll.324-393): status-accent bar, `AuntieAvatar` (initials), kinfolk name (italic "Unnamed Kinfolk" when blank), "{serviceType} · {bookingDateLabel}", status pill, note preview (`kinfolkNotes`/`notes`). `bookingDateLabel` (ll.401-407) falls back through real timestamps so legacy rows with blank `startTime` show a real date instead of "No date". Real.
- **Desired:** mock `.bk` row: accent, avatar, name, "{type} · {date} · {block}", pill, note.
- **Fix:** the mock shows a **time-block** segment ("Midday block") in the service line; current shows only "{type} · {date}". Binding a real block needs the **time-block field/resolver** (same dependency as Auntie-Time 14 item 4 and create item 8 below). Until it exists, omit the block segment rather than faking one. **Dependency:** time-block field/resolver.

## 6. Multi-select / bulk actions (mock affordance, gated dark)
- **Current:** the "Select" toggle exists (ll.133-136) but `FF_BOOKINGS_BULK_SELECT=false` (l.64); turning Select on shows a fail-loud "Bulk select is not wired yet … needs a batch callable and a reschedule callable that do not exist" banner (ll.161-177). Per-card actions stay live. No bulk action is faked.
- **Desired:** mock multi-select checkboxes + a floating bulk bar (Approve / Reject / Cancel / Reschedule).
- **Fix (full-stack):** build a **batch approve/reject/cancel callable** + a **reschedule callable** (the reschedule one is shared with Schedule-13 item 6), then wire the checkboxes + bulk bar + flip the flag. Until both exist, keep the gate. **Dependency:** batch booking-action callable + reschedule callable, all platforms.

## 7. Create — kinfolk select, KinCare type, notes (REAL)
- **Current:** `BookingCreateScreen` (ll.413-647): real kinfolk search/select from `kinfolkStream` (no per-kin select — KinCare covers the household), **KinCare type chips sourced from Business Settings `serviceRates`** (NOT hardcoded; falls back to `SERVICE_TYPES` only when settings have none, ll.444-447, 533-543) with real price suffixes, a kinfolk-facing "Additional Information" note + an admin-internal note, and Cancel / Save draft (DRAFT) / Submit request (PENDING) via `vm.createBooking` → `createBookingRequest` (ll.604-647). Real, wired, audited; notes persist via `addBookingNote`/`addInternalBookingNote` (VM ll.58-70).
- **Desired:** create mock: kinfolk select, type chips from settings, notes, actions.
- **Fix:** none functional for these. The KinCare-type-from-settings wiring is exactly right per Rule 1. Mirror on Android; the VM `createBooking` path is already unit-tested.

## 8. Create — multi-date calendar / time-block / recurring / specific-time (SUGGESTION)
- **Current:** date+time are **single-date** `BottomBorderField`s ("Date YYYY-MM-DD", "Time HH:MM", ll.552-569). The comment (ll.546-551) discloses the mock's non-consecutive multi-date calendar + Time-Block chips + recurring options + specific-start-time-with-disclaimer are NOT built here: `requestBooking` supports `visits[]`+`pattern` server-side, but `createBooking`/`buildSession` is single-date (ll.649-663). Nothing multi-date is faked — it's honestly single-date.
- **Desired:** create mock: a non-consecutive multi-date calendar, Time-Block chips, recurring segment + weekday picker, optional specific-start-time with the kinfolk-facing disclaimer.
- **Fix (full-stack — the big create gap):**
  1. **Multi-date + recurring:** wire the UI (calendar multi-select + recurring segment) to the **`requestBooking` `visits[]`+`pattern`** path that the server already supports, replacing the single-date `buildSession`. This is the headline create dependency.
  2. **Time-block chips:** bind to the real **Business-Settings time blocks** (same time-block source as Auntie-Time 14 and item 5 here).
  3. **Specific-start-time + disclaimer:** the disclaimer copy is author-owned; the specific-time field needs a real field on the request. Gate dark until wired.
  - **Dependency:** wire `requestBooking` `visits[]`+`pattern` into create; Business-Settings time-block source; a specific-start-time field. All platforms.

---

## Out of scope / leave as-is
- Pending reads `bookingRequestsStream` (DRAFT query), not the noisy full collection (ll.116-122) — correct and load-bearing; do not regress to filtering `sessions`.
- KinCare-type chips from `serviceRates` (ll.444-447) — correct; never hardcode service types/prices.
- `bookingDateLabel` timestamp fallback (ll.401-407) — keep; it fixes legacy blank-startTime rows.
- Fail-loud error banners on approve/reject/create (ll.149-157, 458-466) — correct.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **History organization** (item 4): sort-desc, Completed/Cancelled split or month grouping, cap+paginate, real count instead of literal "recent". Optional paged history query for scale.
2. **Time-block field/resolver** (items 5, 8.2): real block descriptors on cards + create chips. Shared with Auntie-Time 14.
3. **Batch booking-action callable + reschedule callable** (item 6): bulk Approve/Reject/Cancel/Reschedule. The reschedule callable is shared with Schedule-13.
4. **Wire `requestBooking` `visits[]`+`pattern` into create** (item 8.1): multi-date + recurring bookings, replacing single-date `buildSession`.
5. **Specific-start-time field** (item 8.3) for the create-side optional time + disclaimer.
6. **Verify cancel semantics** (item 3): a `cancelBooking` callable distinct from `rejectBooking` if audit/semantics differ.

Every value rendered already traces to the real `bookingRequestsStream` / `sessionsStream` / `kinfolkStream` / `businessSettingsStream`. The not-yet-real surfaces (bulk select, multi-date/recurring/time-block/specific-time create) are gated dark or honestly single-date with disclosing comments — none are hardcoded. The open work is organizing History and wiring the multi-date/recurring create plus the batch/reschedule callables.
