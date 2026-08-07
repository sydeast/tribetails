> STATUS 2026-06-09 (de-stale): composer shipped both platforms; all 5 spec dependencies resolved. Send label bound to the real household name (hardcoded "Send to the Wrens" gone); editable cover title wired to `KinCareReport.title`; visibility row removed (no backing field, correct per fail-loud); media upload LIVE (Cloudinary cloud-name + signature fixed 2026-06-09); GPS stats render inside RouteMap; condition chips wired (Step 16). GAPS: cover-image swap (`coverImageId`) has no field/UI; "autosaved Ns ago" relative timestamp deferred (no `lastSavedAt`). STALE: `KinTaleComposeScreen.kt` KDoc ~l.112 still says media upload is deferred (it is live); spec line refs are ~80 lines off.

# KinTale Composer — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kintale-composer-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleComposeScreen.kt`
**Current code (android):** parity target — Android equivalent must match (Rule 2). The KDoc (ll.106-113) notes the Android KinTale template editor already exists and the composer reads its Firestore templates.
**Shared components:** `AuntieBreadcrumbs`, `AuntieStatusPill`, `AuntieAvatar`, `AuntieEntityRow`, `AuntieKeyValueRow`, `AuntieMediaCell`, `AuntieEmailPreviewCard`, `AuntieChip`, `MultilineField`, `GhostButton`, `PrimaryButton`, `ScreenScaffold`, `StatusToast` in `…/web/ui/components/`. `RouteMap` in `…/web/screens/sessions/RouteMap.kt`.

> ⚠️ Mock-file correction: none. `KinTaleComposeScreen.kt` (ll.90-114 KDoc) states it is "Redesigned to the Den 'KinTale composer' mockup," matching the assignment.

> ⚠️ Complaint-vs-code note: there is no complaint attached to this screen in the brief beyond "follow the mock." The shipped composer already implements the mock's two-pane structure (editor left, recipient rail + live preview right) closely. Deltas below are gaps between the mock and code, plus the SUGGESTION items the mock shows that have no backing field.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Biscuit & Gravy hit the trail`, `Tue May 27 · 9:00-9:32 AM`, `dist 1.4 mi / time 32 min / pace steady`, `Photos · 3 attached`, `Lorna Wren`, `#TT-2048`, the moment-chip emoji/labels) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Header bar — breadcrumbs · draft pill · Preview / Send
- **Current:** `ComposerHeaderBar` (ll.489-531): `AuntieBreadcrumbs("KinTales" / "New tale")`, `AuntieStatusPill` "Draft · saving…"/"Draft", a "Close" GhostButton, and a `PrimaryButton` "Send to the Wrens" (label hardcodes "the Wrens" — see below). Bound to `isSaving`/`isSending`/`isDirty`.
- **Desired:** mock `.bar`: crumbs, `● Draft · autosaved 12s ago` pill, "Preview as Kinfolk" ghost, "Send to the Wrens →" CTA.
- **Fix:**
  1. **"Send to the Wrens" is a hardcoded household name** (ll.524, 960). Per Rule 1 the mock's "the Wrens" is placeholder. Bind the send button label to the **real recipient household name** (from `kinfolk`/`session`), e.g. "Send to {household}", or use a generic "Send to kinfolk" — do not ship the literal "the Wrens". **Dependency:** a real household-name field on the session/kinfolk join.
  2. Mock's "autosaved 12s ago" is a relative-time autosave indicator; current pill only shows "saving…"/"Draft". A real "last saved {relative}" needs a **persisted last-saved timestamp**; if absent, keep "Draft"/"saving…" and omit the relative time rather than faking "12s ago".
  3. Mock "Preview as Kinfolk" is realized as the live right-rail preview; the header offers "Close" instead. KDoc (ll.517-518) discloses no separate preview route exists. Acceptable; don't add a dead "Preview" button.

## 2. Cover hero
- **Current:** `CoverHero` (ll.537-584): sunset-glow gradient box, eyebrow = "Visit · {serviceType} · {window}" from real session, big `composerTitle` (ll.987-994, derived from real kin names), and an "Edit template" ghost (top-right) instead of the mock's "Change cover". The title is **editable** in the mock (`<input class="titlein">`); current code renders it as **read-only `Text`** derived from kin names.
- **Desired:** mock `.cover`: "⤢ Change cover" affordance, eyebrow visit window, and an **editable title input**.
- **Fix:**
  1. The mock's editable headline maps to **no `title` field on `KinCareReport`** (same gap flagged in 11-kintale-report). Either: (a) add a real `title`/`headline` field to the report model + write path (all platforms) and make the cover an editable field; or (b) keep the derived read-only title and treat the editable headline as a SUGGESTION gated dark. Do not fake an editable input that writes nowhere.
  2. "Change cover" (cover-image swap) has no backing cover-image field on the report. Gate dark with a Not-wired banner or omit; the current "Edit template" repurpose is reasonable but is a different action than the mock's "change cover" — note the divergence.
  - **Dependency:** `KinCareReport.title` (+ optional `coverImageId`) on the model + write path.

## 3. The tale (narrative)
- **Current:** `ComposerBlock("The tale")` → `MultilineField` bound to `bodyCopy`, persisted via `persistDraft` (ll.343-362). A "Save notes" ghost is present. Real, wired.
- **Desired:** mock `.block` "The tale" with a contenteditable body.
- **Fix:** none functional. The mock has no explicit save button (autosave); current adds an explicit "Save notes" + autosave-on-blur — acceptable, more honest. Mirror on Android.

## 4. Photo strip
- **Current:** `MediaBlock` (ll.618-673): real `AuntieMediaCell` tiles from `attachedMedia` (hydrated via `mediaForSessionStream`), an add tile that calls `pickAndUploadKinTaleMedia`, real cap label (`MAX_FILES_PER_TALE`, `VIDEO_CLIP_SECONDS`). KDoc (l.108) flags Storage upload as partially deferred but the pick/upload path is wired. Real.
- **Desired:** mock `.photos` 4-col grid + add tile, "Photos · 3 attached".
- **Fix:** none functional. The count label binds to real `attached.size` (ll.628-630). Confirm Android upload parity; integration-test the cap and the upload/remove writes.

## 5. Walk route · auto-tracked
- **Current:** `GpsRouteBlock` (ll.679-691): reads `breadcrumbsStream(sessionId)`, renders the shared `RouteMap`, and **hides entirely if there are no crumbs** (l.686) — fail-loud-by-omission, no faked route. Real.
- **Desired:** mock `.route` with an animated polyline + `dist / time / pace` stats.
- **Fix:** the mock shows `dist 1.4 mi / time 32 min / pace steady` stats below the map; current `RouteMap` is rendered without those summary stats here. A real distance/time summary exists on the GPS summary path (see 14-auntie-time `buildGpsSummary`). **Fix:** surface real `GpsSummary` distance/duration under the map (bind to the computed summary, not the mock literals); omit "pace" unless a real pace field exists. **Dependency:** a `GpsSummary` read for this session (the summary is baked on session-end in Auntie Time).

## 6. Moments · per-pet / per-visit checklist chips
- **Current:** `MomentsBlock` (ll.697-763): real template `checklistItems` (PER_PET per kin, PER_VISIT once), rendered as tap-to-toggle `AuntieChip`s with rotating brand tones, each writing a `FieldResponse.boolValue` via `setChecklistChecked`. Per-item notes reachable below. Honest "Unchecked items don't appear…" note (Precise semantics). Real.
- **Desired:** mock `.chips` moment pills.
- **Fix:** none functional. The mock's specific moments (Ate well / Water topped / Potty x2 / Meds…) are placeholder; current binds to the real template items per Rule 1. Mirror on Android.

## 7. Recipient rail
- **Current:** `RecipientRail` (ll.806-886): real kinfolk + kin rows from the live streams, `AuntieKeyValueRow` Service / Booking (`sourceBookingId`) / Visibility. **"Visibility = Kinfolk + shared link" is hardcoded** (ll.880-884) — KDoc (l.880-881) discloses there is no per-report visibility field.
- **Desired:** mock recipient card: kinfolk row, kin row, Service / Booking / Visibility meta.
- **Fix:** the Visibility value is a hardcoded string with no backing field. Per Rule 1, either add a real per-report `visibility` field (model + write, all platforms) or gate the Visibility row as a SUGGESTION with a Not-wired note. Do not ship a hardcoded "Kinfolk + shared link" as if it were real state. **Dependency:** `KinCareReport.visibility` field.

## 8. Live preview
- **Current:** `LivePreviewBlock` (ll.892-918): real `AuntieEmailPreviewCard` driven by the live `bodyCopy` (or `template.defaultEmailMessage`), kin avatars, and a "Live preview · how {kinfolk firstName} sees it" caption. Real.
- **Desired:** mock `.preview` phone mockup.
- **Fix:** none functional. The mock renders the moment tags + route distance as preview chips; if those are wanted in the preview card, bind to the real checked moments + real GPS distance (not the mock's `ATE WELL / 1.4 MI`). Optional polish.

---

## Out of scope / leave as-is
- Send marks the report SENT via `markKinTaleReportSent` (ll.282-290); delivery transport is the existing backend pipeline (KDoc ll.108-111). Correct.
- "Unchecked items omitted" Precise semantics (l.746) — keep.
- Footer Discard / Save Draft / Send (ll.924-981) and the "tick a moment to enable Send" info banner — correct fail-loud gating.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Real recipient/household name** for the Send button label (item 1.1) — stop hardcoding "the Wrens".
2. **Persisted last-saved timestamp** for the "autosaved {relative}" pill (item 1.2) — else omit the relative time.
3. **`KinCareReport.title` (+ optional `coverImageId`)** for the editable cover headline / change-cover (item 2) — else gate the editable headline dark.
4. **`GpsSummary` read for this session** to show real route distance/time under the map (item 5).
5. **`KinCareReport.visibility` field** for the Visibility row (item 7) — else gate it as SUGGESTION.

Every value rendered on this screen must trace to the real `sessionsStream` / `kinfolkStream` / `kinStream` / `mediaForSessionStream` / `breadcrumbsStream` / template streams, or a new real source. The two hardcoded strings ("the Wrens" send label, "Kinfolk + shared link" visibility) are the live Rule-1 violations to fix.
