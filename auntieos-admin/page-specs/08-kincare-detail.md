> STATUS 2026-06-09 (de-stale): most panels shipped + faithful both platforms (lifecycle rail, details, address/access/emergency, GPS RouteMap). GAPS: Kin photo not wired (`Kin.profilePictureUrl` exists but `KinPhotos` still passes null; android `KinCard` has no avatar slot); VET-SLICE FIX: `vetSummary` reads per-kin `Kin411.vetName/vetPhone`, must switch to `HouseholdData.primaryVet*` per the vet decision; web notes are read-only while android shipped WRITABLE notes with a cutoff lock (parity gap); raw `invoiceId`/`sourceBookingId` shown unlinked/unjoined; no rate field on the session; web `KinDetailCard` has an N+1 kin411 listener (android batches). DECISIONS PENDING: hero title (kinfolkName vs joined kin names); web writable-notes parity; whether to add a lifecycle action button here.

# KinCare detail — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kincare-detail-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/sessions/KinCareDetailScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/admin/KinCareDetailScreen.kt`
**Shared components:** `SectionHeader`, `AuntieAvatar`, `AuntieStatusPill`, `AuntieKeyValueRow`, `AuntieNoteCallout`, `GhostButton`, `RouteMap` (`screens/sessions/RouteMap.kt`); data models `KinCareSession`, `Kin411`, `KinCareReport`, `Kinfolk`, `Kin` in `…/web/data/FirestoreClient.kt`.

> No mock-file correction: the screen's KDoc (ll.68-69) explicitly states the layout "mirrors `ui-ideas/auntieos-kincare-detail-2026-05-27.html`." This is one of the most faithful current ports — hero + kin photos + status pill, visit-lifecycle rail, dual note boxes (kinfolk-facing + admin-internal), details key/value list. The deltas below are mostly mock-extras the code intentionally omitted or richer-than-mock fields, not bugs.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Biscuit & Gravy · 30-min walk`, `Wed May 27 · 9:00 to 9:30a`, `82 Creekside Ln`, `8:48a` / `9:01a` lifecycle times, the two note-box paragraphs, `Rate $28`, `#TT-2048`, `Lorna Wren · Mon May 25`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built before the slot can show real data.

---

## 1. Hero — kin photos + title + window + address + status
- **Current:** real and faithful. `HeroPanel` (`KinCareDetailScreen.kt` ll.315-382): overlapping kin avatars (`KinPhotos`, -16dp stacking, ll.384-401), `heroTitle` = "{kinfolkName} · {serviceType}", subtitle = window · kinfolkName · serviceAddress (all real fields), and a real `AuntieStatusPill` with a glow on ARRIVED. Warm radial wash matches the mock `.hero`.
- **Desired:** mock `.hero` (ll.91-101): stacked circular **pet photos**, "Biscuit & Gravy · 30-min walk", "Wed May 27 · 9:00 to 9:30a · the Wrens · 82 Creekside Ln", "● Arrived" pill.
- **Fix:**
  1. **Kin photos:** the mock shows real pet photos; `KinPhotos` passes `imageUrl = null` and falls back to seeded initials/paw glyph (ll.392-398) because **Kin has no `profilePictureUrl`** (model `FirestoreClient.kt` ll.854-880). **Dependency:** Kin photo field + upload (shared with 03/04/06 — once it lands, pass the real `imageUrl` here).
  2. **Title "Biscuit & Gravy":** the mock title is the kin NAMES; current `heroTitle` uses `kinfolkName` (the owner) + serviceType (ll.403-406). If the kin-names title is wanted, build it from the resolved `kinById` names (data already on hand via `kinForKinfolk`, ll.95-101) with a sensible join, falling back to kinfolkName when names are missing. Don't hardcode "Biscuit & Gravy".
  - Otherwise the hero is correct.

## 2. Visit lifecycle rail
- **Current:** real and well-built. `LifecycleRail` + `LifecycleNode` (ll.410-531): ordered SCHEDULED → ON_MY_WAY → ARRIVED → DEPARTED → COMPLETED, computing the current index from `session.status`, drawing done/now/todo nodes with split done/pending connectors, each step showing its real ISO timestamp (`onMyWayAt`, `arrivedAt`, etc.) or "-". Mirrors the mock `.life` rail.
- **Desired:** mock `.life` (ll.103-117): same 5 steps with check/dot/empty nodes and timestamps — PLUS a **"Mark departed →" action button** and a "GPS route is tracking. Departing prompts the KinTale." caption (ll.113-116).
- **Fix:**
  1. The rail itself is correct — keep.
  2. **The lifecycle action button is intentionally absent:** the screen's KDoc (ll.62-64) states "Action buttons live on the *list* row, not here; this screen is read-only context." So the mock's "Mark departed" CTA is a deliberate product divergence. **Decision needed:** either (a) keep this screen read-only and leave the action on the Auntie-Time list row, or (b) add the status-advance action here too. If (b), it's a full-stack write (status transition + GPS/route side effects + the "departing prompts the KinTale" flow) across all platforms — not a decorative button. Pick deliberately; do not add a dead button.
  - The "Editable until 3h before visit" / "Departing prompts the KinTale" copy is operational rules copy — reuse existing strings, don't author new.

## 3. Dual note boxes (kinfolk-facing + admin-internal)
- **Current:** real and faithful. Two `DenPanel`s (ll.150-187): "Kinfolk-facing note" (tag "visible to {kinfolkName}", bound to `session.kinfolkNotes`, with the `CutoffHint` "Editable until 3h before the visit" rule) and "Admin-internal note" (tag "private", bound to `session.notes`, "Only you see this" hint). Empty states fail-loud honestly ("No kinfolk-facing note for this Kin Care.").
- **Desired:** mock `.cols` two panels (ll.119-131): kinfolk-facing note with a "visible to the Wrens" pill + cutoff hint, admin-internal note with a "private" pill.
- **Fix:** essentially done. Two nits:
  1. The mock's cutoff hint shows a **concrete cutoff time** ("Editable until 6:00a (3h before visit)") and a **locked** variant (`.cuthint.locked`, l.70) once past cutoff. Current `CutoffHint` (ll.535-550) prints the static rule sentence without computing the actual cutoff timestamp or a locked state. If the concrete-time + locked treatment is wanted, compute the cutoff from `session.startTime` (minus 3h) and reflect the locked state. Don't fabricate a time — derive it from the real start.
  2. These note boxes are **read-only** here; the mock implies they're authorable ("admin may author, editable until 3h before"). Editing notes from this screen, if desired, is a write path (gated by the cutoff for the kinfolk-facing one) — scope deliberately, all platforms.

## 4. Details key/value list
- **Current:** real. `DenPanel "Details"` (ll.191-225) shows Service, Duration, Window, Status pill, Invoice (raw `invoiceId`), Booked-from (raw `sourceBookingId`), and "KinTales sent" count — all real session fields, blank-hidden.
- **Desired:** mock `.field` rows (ll.133-140): Service ("30-minute walk"), **Rate ("$28")**, **Booked by ("Lorna Wren · Mon May 25")**, **Linked KinTale ("Draft started ›" link)**, **Invoice ("#TT-2048 (this week)" link)**.
- **Fix:**
  1. **Rate:** the mock shows a per-visit rate; `KinCareSession` has **no rate/price field** (model ll.665-692). **Dependency:** a rate source (from the service type's price, or an invoice line) before a Rate row can be real. Do not hardcode "$28".
  2. **"Booked by ... date":** mock shows the booker's name + booking date as a link; current code shows the raw `sourceBookingId` string. **Dependency:** resolve `sourceBookingId` → the booking's booker name + date (join to the booking-requests collection) to render a human row + link. Until then keep the honest raw id or hide it.
  3. **"Linked KinTale (Draft started ›)":** mock links to a tale draft; current code shows only a "KinTales sent" count. **Dependency:** resolve any in-progress/linked draft for this session (`reportIds` exists on the session, ll.687) and render a link into the KinTale composer/report. The screen already streams `reports` and filters `sessionReports` (ll.88-92) — extend to surface a draft-state link.
  4. **Invoice link "#TT-2048 (this week)":** current shows the raw `invoiceId`. **Dependency:** resolve `invoiceId` → the invoice number + a route into the invoice detail, rather than the raw doc id.
  - All four are real-data joins, not styling. Each: backend/query → resolve → render link → all platforms → tests. Where the source doesn't exist (Rate), gate dark; never fabricate.

## 5. Address, household access, emergency, route, kin-411, KinTales panels (richer than mock)
- **Current:** the screen has MORE than the mock: an Address panel with "Open in Maps" (ll.229-236), a Household-access panel (gate code / parking / Wi-Fi / entry notes, ll.239-255), an Emergency-contact panel (ll.258-267), a **live/replay GPS RouteMap** gated on ARRIVED/DEPARTED/COMPLETED with real `breadcrumbsStream` (ll.269-284), a "Kin in this care" panel with per-kin `kin411Stream` 411 snippets (ll.286-296), and a "KinTales sent" list with real report snippets (ll.298-309). All real data, all blank-hidden / fail-loud.
- **Desired:** the mock does not show these (it's a shorter card). They are additive real features.
- **Fix:** keep all of them. Two notes:
  1. The Kin-411 panel reads vet from `Kin411.vetName/vetPhone` (`vetSummary`, ll.630-633) — this is the per-kin vet duplication flagged in 04/06. When vet consolidates onto the household (Kinfolk), this panel should read the household vet, not per-kin `Kin411` vet. Cross-cuts the vet-consolidation dependency.
  2. `KinDetailCard` opens a `kin411Stream` per kin (l.557) — an N+1 listener pattern (same as the profile screen). Consider batching. Perf item, not a visual delta.

---

## Out of scope / leave as-is
- Visit-lifecycle rail rendering — real and faithful, keep (the only open question is the action button, item 2).
- GPS RouteMap live/replay gating on status — real, keep.
- Dual note boxes + cutoff hint copy — keep (refine to concrete-time/locked per item 3 only if wanted).
- Address "Open in Maps", household-access, emergency panels — real additive value, keep.
- ISO formatting helpers (`shortIso`, `sessionWindowFor`) — keep.
- Status label/tone mapping — keep.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Kin `profilePictureUrl` + upload** → real pet photos in the hero (shared with 03/04/06).
2. **Per-visit Rate source** (service-type price or invoice line) → the Details "Rate" row. Gate dark until it exists.
3. **Resolve `sourceBookingId` → booker name + booking date** → human "Booked by" row + link.
4. **Resolve linked/draft KinTale for the session** (`reportIds`/draft state) → "Linked KinTale" link into the composer/report.
5. **Resolve `invoiceId` → invoice number + invoice-detail route** → human "Invoice" link.
6. **(Optional) Lifecycle "Mark departed" action here** (status transition + GPS + KinTale prompt) IF the screen becomes actionable rather than read-only. Deliberate product call.
7. **(Optional) Editable notes from this screen** (cutoff-gated kinfolk-facing write) + concrete cutoff-time/locked CutoffHint.
8. **Vet read from household, not per-kin `Kin411`** in the Kin-411 panel (cross-cuts the vet-consolidation dependency in 04/06).
9. **(Perf) Batch the per-kin `kin411Stream`** in "Kin in this care".

Every value rendered on this screen already traces to a real stream (`sessionsStream`, `kinfolkStream`, `reportsStream`, `kinStream`, `kin411Stream`, `breadcrumbsStream`). New rows (Rate, Booked-by, Linked-tale, Invoice-link) must trace to a real join above or ship dark — never hardcoded.
