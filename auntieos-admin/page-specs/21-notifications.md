# Notifications — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-notifications-2026-05-27.html` (the screen's KDoc, `NotificationsScreen.kt` ll.73-77, names this mock).
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/notifications/NotificationsScreen.kt`
**Current code (android):** parity target — reads the recipient-scoped `notifications/` collection; a matching Android surface must reach parity.
**Shared components:** `DenScreenHeading`, `DenPanel`, `StatCard`, `AuntieChip`, `AuntieIconTile`, `AuntieStatusPill`, `AuntieBanner`, `EmptyHint`, `ShimmerCard` (used `NotificationsScreen.kt` ll.46-58).
**Backend surface:** `notificationsStream()` (`NotificationsScreen.kt` l.93), `NotificationEntry` model (recipient-scoped read, `firestore.rules:403`, see KDoc ll.62-68).
**Nav:** `Destination.Notifications` is a top-level destination in "More" (`web/.../ui/shell/NavDestinations.kt` l.49); the shell **bell** (`web/.../ui/shell/AppShell.kt`) is the global entry point.

> ⚠️ Code correction vs. the assignment complaint. The complaint is two parts: (a) "should be a small badge/icon entry from home, not a big screen" and (b) "organize by notification type."
> - Part (b) is **already done**: the screen filters by category via a chip row derived from the *real* categories present in the data, plus a day-separated feed (`NotificationsScreen.kt` ll.199-223, 269-338, 306-324). It does not invent a taxonomy.
> - Part (a) is the real delta: there is currently **no home badge / icon entry-point** at all — Notifications is reachable only as a full destination and via the shell bell (a grep of `screens/home/` and `AppShell.kt` finds no notification badge or unread indicator). So "make it a small badge from home" is genuinely missing. Note also: the screen has **no real per-recipient read flag** — it uses a `status == "pending"` proxy for "unread" (ll.444-450), so any badge/count built on it must use that same honest proxy or wait for a real read model.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`3 new`, `2m` / `18m` / `1h`, "Ada Devlin requested a drop-in for Marigold on May 31", "The Wrens paid invoice #TT-2048 ($280)", `booking.requested`, `security.new_device`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the strings. Every displayed value must be bound to a real data source. If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web feed looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Make Notifications a small badge/icon entry from home (the headline delta)
- **Current:** Notifications is a **full destination** (`NavDestinations.kt` l.49) with a heavy screen: editorial heading + a three-`StatCard` summary row + category chips + a day-separated feed (`NotificationsScreen.kt` ll.99-228). There is **no compact home entry-point** — no badge on home, no unread indicator wired into the shell bell (confirmed: no notification badge in `screens/home/` or `AppShell.kt`).
- **Desired:** the operator wants a **small badge/icon** (a bell with an unread "ping") as the entry point — glanceable from home — rather than a big standing page. (This is the same shell-bell intent flagged in spec 01 item 4.)
- **Fix (full-stack — decide the entry-point home, don't guess):**
  1. **Add a bell + unread ping** as the primary entry point. The natural home is the **shell-level bell** (`web/.../ui/shell/AppShell.kt`) so it's consistent across screens and gives Android/desktop parity for free; the alternative is a badge in the home `DenScreenHeading` trailing slot. Pick deliberately (this overlaps spec 01's bell decision — make one consistent call).
  2. **Drive the ping from a real unread count.** Reuse the screen's honest proxy: count `notificationsStream()` entries where `isUnread()` (status == "pending", `NotificationsScreen.kt` ll.135, 444-450). Do **not** hardcode the mock's "3 new" (Rule 1).
  3. **Optionally slim the full screen** to a popover/feed reachable from the bell rather than a top-level nav item, if the team agrees the standing page is overkill. Keep the feed reachable somewhere; don't orphan it.
  - **Dependency:** an **unread-count source** for the shell (the `status == "pending"` proxy works today; a real per-recipient read flag is the better long-term source, item 4). Routing/wiring + a shell badge component, parity across web/desktop/Android. Tests: unit on the unread-count derivation, component test on the bell ping (zero vs nonzero), nav integration to the feed.

## 2. Organize by notification type — already real (keep)
- **Current:** category filter chips built from the **real** categories present in the feed (`NotificationsScreen.kt` ll.199-217, 269-298) plus per-row icon/tone keyed off category family (`toneFor`/`iconFor`, ll.459-501). Day-separated into "Recent"/"Earlier" off the real `createdAt` (ll.306-324). No invented taxonomy.
- **Desired:** mock filter chips All / Unread / Bookings / KinTales / Payments / System (mock ll.89-91) + a day-separated feed with type-colored tiles.
- **Fix:** the type organization is already done from real data. One gap vs. the mock: the mock has an explicit **"Unread"** chip; the code's chip row is category-only. If wanted, add an "Unread" filter using the same `isUnread()` proxy (status == "pending") — not a faked read flag. The mock's fixed category names (Bookings/KinTales/Payments/System) are placeholders; the code's data-derived categories are the correct approach — do not hardcode the mock's list.
  - **Dependency:** none for category chips (data-derived). An "Unread" chip uses the existing proxy; a *true* unread filter needs item 4's read model.

## 3. Summary stat row + heading badge
- **Current:** three `StatCard`s (All / Pending dispatch / Dispatched) from real counts (`NotificationsScreen.kt` ll.142-168), and a coral "{n} new" heading badge driven by the real unread proxy (ll.240-267). Real.
- **Desired:** mock heading "Inbox / 3 new" badge (mock l.83). The "3 new" is placeholder per Rule 1; the badge structure matches.
- **Fix (LOCKED — Decisions 1 + 10):** Notifications = **one-way system/business alerts**, surfaced via the **shell bell + badge** (the small home entry, 2.7/10.1); slim this screen to a bell-triggered feed. The comms **Inbox is a separate surface for two-way conversations** (spec 20). Rename this surface's mock "Inbox" header to "Notifications" so the two never collide.

## 4. Per-row quick actions + read state — keep dark, honest
- **Current:** per-row quick actions (Accept / Open / Send reminder) and a real read/unread model ship **dark** behind `flags.notificationsQuickActions` (default off). When on, the screen renders a fail-loud dashed "not wired yet" banner + a disabled "Quick actions not wired yet" pill (`NotificationsScreen.kt` ll.79-85, 171-190, 407-417), because `NotificationEntry` has **no body text, no action target, no read flag**, and no `markRead`/per-action callable exists.
- **Desired:** mock rows carry human-readable body copy ("Ada Devlin requested a drop-in…") and per-row buttons (Accept / Open / Send reminder), mock ll.96-130. Those are self-flagged in code as mockup-only.
- **Fix:** keep dark. Do **not** fabricate body copy (the model has none) or wire dead action buttons.
  - **Dependency (real blocker):** the server must (a) write **body text + an action target** onto `NotificationEntry`, (b) add a **per-recipient read flag** (+ `markRead` / `markAllRead` callable), and (c) provide **per-action callables** (accept booking / open target / send reminder). All full-stack; until they land, the quick-action affordances and a true read model stay gated.

## 5. Relative time
- **Current:** `relativeTime()` shows the real timestamp ("05-27 14:02"), explicitly **not** a fabricated "2m / 1h" delta — the screen has no current-time source (`NotificationsScreen.kt` ll.511-529).
- **Desired:** mock shows relative ages "2m" / "18m" / "1h" (mock ll.101-135). Self-flagged as needing a clock the screen lacks.
- **Fix:** keep the honest absolute timestamp. **Dependency:** a current-time source to compute deltas (the same gap noted on the home tale rows in spec 01). Until then, no invented "2m ago".

---

## Out of scope / leave as-is
- Loading shimmer + the fail-loud Firestore error banner (which surfaces a likely missing `recipientUid` where-filter on the platform stream, fixed in `FirestoreInterop` not this screen) — correct (`NotificationsScreen.kt` ll.100-129).
- Category icon/tone derivation (`toneFor`/`iconFor`) and day-grouping (`Feed`/`datePrefix`) — real, audited.
- Global search / notification bell are shell-level (`web/.../ui/shell/AppShell.kt`) — directly relevant here (item 1 puts the unread ping on that bell).

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Shell-bell unread ping + home entry-point** — drive the badge from a real unread count (the `status == "pending"` proxy works today) and decide bell-vs-home-trailing placement (coordinated with spec 01 and spec 20). Routing/wiring + shell badge; the headline delta of this complaint.
2. **Real per-recipient read flag + `markRead`/`markAllRead` callable** — replaces the pending proxy, unblocks a true "Unread" filter and "Mark all read".
3. **Body text + action target on `NotificationEntry`** — unblocks human-readable rows and per-row quick actions (currently dark behind `notificationsQuickActions`).
4. **Per-action callables** (accept booking / open / send reminder) — unblocks the mock's quick-action buttons.
5. **Current-time source** — relative "2m / 1h" timestamps (shared gap with spec 01).

Every value on this screen already traces to `notificationsStream()`; the unread signal is an honest `status == "pending"` proxy. Nothing here is faked; the open work is the home/bell entry-point plus a real read/action model from the server.
