# Inbox — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-inbox-2026-05-27.html` (the mock's own header comment, ll.11-33, says it mirrors `InboxScreen.kt`).
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/inbox/InboxScreen.kt`
**Current code (android):** parity target — inbox aggregates the shared `voicemails/calls/sms/emails` streams; a matching Android inbox must reach parity.
**Shared components:** `DenScreenHeading`, `DenPanel`, `AuntieChip`, `AuntieEntityRow`, `AuntieIconTile`, `AuntieEmptyState`, `AuntieBanner`, `BottomBorderField`, `PrimaryButton`, `GhostButton`, `StatusToast` (used `InboxScreen.kt` ll.55-71).
**Backend surface:** `voicemailsStream/callsStream/smsStream/emailsStream`, `markVoicemailRead`, `markVoicemailReplied`, `N8nClient.sendMessage` (used `InboxScreen.kt` ll.107-110, 242, 281, 290).
**Nav:** `Destination.Inbox` and `Destination.Notifications` are **both** top-level in the "More" group (`web/.../ui/shell/NavDestinations.kt` ll.48-49).

> ⚠️ Code correction vs. the assignment complaint: the complaint is "Inbox vs Notifications duplication / terminology confusion." This is an **information-architecture + naming** issue, not a data-binding gap — both screens already read real, *different* data sources. The honest distinction in code is: **Inbox** = inbound/outbound communications *from kinfolk* across four channels (voicemail/call/SMS/email), aggregated from the comms streams (`InboxScreen.kt` ll.107-110, 208-213). **Notifications** = system/catalog-dispatched events *to the operator* from the recipient-scoped `notifications/` collection (`NotificationsScreen.kt` ll.60-68, 93). The confusion is real because the Notifications mock titles itself "Inbox" with a "3 new" badge (`auntieos-notifications-2026-05-27.html` l.83) — two screens, overlapping "inbox" language. This spec scopes the terminology/IA fix and notes the screens are otherwise correctly wired.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (kinfolk names, voicemail transcripts, "Missed call", phone numbers, "Mon D · HH:MM" timestamps, unread counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the strings. Every displayed value must be bound to a real data source. If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web list looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Inbox vs Notifications — terminology + IA (the headline delta)
- **Current:** two sibling top-level destinations both living in "More" (`NavDestinations.kt` ll.48-49), both reachable, both using "inbox" language. `InboxScreen` is titled "Inbox" with subtitle "Voicemails, calls, SMS, and emails…" (`InboxScreen.kt` ll.127-132). `NotificationsScreen` is titled "Notifications" (`NotificationsScreen.kt` ll.245-248) — but the **Notifications mock calls itself "Inbox"** with a "3 new" badge. So the product has two "inboxes": a comms inbox (kinfolk reaching out) and a system-notification inbox (events for the operator).
- **Desired:** disambiguate so an operator knows which surface is which. The two real data sources are legitimately distinct (kinfolk comms vs operator system events) — the fix is **naming + placement**, not merging the data.
- **Fix (deliberate IA/naming decision — do not guess):**
  1. **Vocabulary (LOCKED — Decision 1): SEPARATE roles.** **Inbox = two-way conversations** (voicemail/call/SMS/email + MyTribe "Message Auntie" threads, 16.4). **Notifications = one-way system/business alerts**, surfaced via the shell bell + badge (Decision 10) — never a second "Inbox". Rename the Notifications mock's "Inbox / 3 new" header (`auntieos-notifications-2026-05-27.html` l.83) to "Notifications". Keep old routes resolvable.
  2. **Settle placement.** Decide whether Inbox stays in "More" or is promoted (it's a daily-use comms surface, currently buried beside admin tools). Make the choice deliberately; mirror it in the Android/desktop nav.
  - **Dependency:** nav/label changes in `NavDestinations.kt` (and `Route.kt` slugs if a destination is renamed/removed) across web/desktop/Android — routing/wiring only, no backend. Coordinate with spec 21 (Notifications → home badge) so the two decisions are consistent. Tests: route resolution unit tests (old slugs still resolve), nav integration on all three platforms.

## 2. Section header
- **Current:** `DenScreenHeading` kicker "The Den · Inbox", title "Inbox", subtitle "Voicemails, calls, SMS, and emails, everywhere kinfolk reach out." (`InboxScreen.kt` ll.127-132). Operator-facing chrome, no kinfolk copy. Real.
- **Desired:** mock SectionHeader title "Inbox" + verbatim subtitle + Inbox icon (mock comment ll.14-15). Verbatim match.
- **Fix:** none (other than the item-1 vocabulary lock if the surface is renamed).

## 3. Channel filter row
- **Current:** `ChannelFilterRow` (`InboxScreen.kt` ll.325-344): pills All / Voicemails / Calls / SMS / Emails with Lucide glyphs (enum ll.76-82). Selection narrows the already-aggregated list (l.215). Real.
- **Desired:** mock `ChannelFilterRow` in source order with the same icons + labels (mock comment ll.16-17). Verbatim.
- **Fix:** none. The mock's per-pill unread-count chips are self-flagged SUGGESTION (mock ll.28-31) — leave off unless a real unread-count source per channel exists (it does not; do not fake counts).

## 4. Aggregated entry rows
- **Current:** four streams aggregated into `InboxEntry` via real `toEntry()` mappers (`InboxScreen.kt` ll.208-213, 546-623), sorted newest-first, filtered by channel. Each `InboxRow` (ll.358-384): channel icon tile (tone/glyph by channel + unread/missed state, ll.628-642), kinfolk name (→ counterpart → "Unknown"), preview, a `MetaRow` of real pips (sent/received/missed/unread/media), and `shortDateTime`. All bound to real `VoicemailLog/CallLog/SmsMessage/EmailMessage` fields.
- **Desired:** mock `InboxRow` — verbatim per the mock's own comment (ll.18-21).
- **Fix:** none. Fully real.

## 5. Thread actions (reply / call / play voicemail)
- **Current:** selecting a row expands `ThreadActionsCard` (`InboxScreen.kt` ll.386-471): native Call/Text/Email via `tel:`/`sms:`/`mailto:`, "Play voicemail" (when audio URL present), and an SMS reply composer that calls real `N8nClient.sendMessage` and writes `markVoicemailReplied` (ll.267-313). Voicemails auto-mark read on open via `markVoicemailRead` (ll.239-250). Email rows are reply-disabled with the verbatim "phone-based threads only" note (ll.463-468). All real and fail-loud.
- **Desired:** mock's inline thread actions — verbatim per comment (ll.18-22).
- **Fix:** none.

## 6. "Mark all read" (gated SUGGESTION) + empty states
- **Current:** bulk "Mark all read" ships **dark** behind the existing `flags.inboxBulkMarkRead`, and even when on renders a fail-loud "NOT WIRED YET" banner (no `markAllInboxRead` callable) rather than a silent no-op (`InboxScreen.kt` ll.135-154). Per-channel empty states explain the Twilio pipeline isn't live yet (ll.523-542) — honest.
- **Desired:** mock's "Mark all read" header action is self-flagged SUGGESTION (mock ll.28-31).
- **Fix:** keep dark. **Dependency:** a **`markAllInboxRead` callable** (and a real per-entry read model across channels) — does not exist. Until then no bulk-read button.

---

## Out of scope / leave as-is
- Stream aggregation, per-channel error surfacing (a single bad channel must not blank the others), loading shimmer (`InboxScreen.kt` ll.174-204) — fail-loud, correct.
- `toEntry()` mappers and styling helpers (`accentTone`, `channelIcon`, `shortDateTime`) — real, audited.
- Global search / notification bell are shell-level (`web/.../ui/shell/AppShell.kt`), not this screen — and relevant here: the shell **bell** routes to Notifications, reinforcing that the inbox-vs-notifications naming must be settled (item 1).

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Inbox/Notifications vocabulary + placement decision** (coordinated with spec 21) — rename/re-home so the two surfaces don't both read as "Inbox"; keep old routes resolvable. Routing/labels only.
2. **`markAllInboxRead` callable + cross-channel read model** → unblocks the dark "Mark all read" control.
3. **Per-channel unread-count source** → the mock's SUGGESTION unread chips on the filter pills (do not fake counts until it exists).

Every value on this screen already traces to the real comms streams (`voicemailsStream/callsStream/smsStream/emailsStream`) and writes via real callables (`markVoicemailRead`, `markVoicemailReplied`, `sendMessage`). Nothing here is faked; the open work is naming/IA plus the bulk-read backend.
