# Media Gallery — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-media-gallery-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/media/MediaGalleryScreen.kt` (+ `MediaGalleryViewModel.kt`)
**Shared components:** `AuntieMediaGrid`, `AuntieMediaCell`, `MediaCellGlyphs` (`…/web/ui/components/AuntieMediaCell.kt`), `AuntieBanner`, `AuntieEmptyState`, `AuntieProgressBar`, `AuntieChip`, `AuntieDialog`, `ScreenScaffold`, `ShimmerCard`, `PrimaryButton`, `GhostButton`, `AuntieIconButton` (`…/web/ui/components/`).
**Model:** `MediaFile` (`…/web/data/MediaModels.kt` ll.12-32), `KinTaleMediaConfig` (Cloudinary URL builders, same file).
**Data path:** `AuntieDataSource.{mediaStream,uploadMedia,deleteMedia}` (`…/web/data/AuntieDataSource.kt` ll.20-22) → `FirestoreClient` (`…/web/data/FirestoreClient.kt` ll.283-290) → wasmJs actual `platformUploadMedia` (`…/wasmJsMain/…/data/FirestoreInterop.wasmJs.kt` ll.589-633).

> ⚠️ Mock-file correction: none. `MediaGalleryScreen.kt` KDoc (ll.59-71) names this mock as truth and the mock header (ll.7-9) names this screen + `MediaModels.kt#MediaFile`. They agree. **One important reality correction below:** the mock tags the type-filter pills and count chip as un-shipped "SUGGESTION" items, but the code has since **shipped both** (`MediaTypeFilters` ll.251-285, `MediaCountChip` ll.220-243). So those are DONE, not deltas. The mock is slightly behind the code there.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren`, `10 files`, `Biscuit on the porch`, `Auntie Jo`, `May 27`, `0:12`, `vet-summary-biscuit.pdf`, the `g1`…`g6` gradient thumbnails) is **illustrative sample data**, not a value to type into the UI. The mock itself says so (header ll.40-42, inline ll.230-231, 266). The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (`mediaStream` → `MediaFile`). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). The mock's gradient thumbnails are stand-ins for real Cloudinary `thumbnailUrl`s; never ship gradient placeholders as if they were photos.

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Upload action — file picker / upload pipeline (verify the seam)
- **Current:** the Upload button calls `vm.upload(byteArrayOf(), "image/jpeg")` (`MediaGalleryScreen.kt` l.98) — an **empty** byte array and a hardcoded mime. That looks broken at the call site, BUT on the **wasmJs target** `platformUploadMedia` (`FirestoreInterop.wasmJs.kt` ll.589-633) ignores the passed `bytes`/`mimeType` and instead calls `jsPickAndUpload(...)` (l.599), which opens a real browser file picker and does a real Cloudinary **signed** upload (`fetchSignedUpload` l.596), then writes a real `MediaFile` doc (`jsAddDoc("media_files", …)` l.629). So on web the empty array is vestigial and uploads do work. The seam is fragile: the common-code signature implies bytes flow through, but only the wasmJs actual short-circuits to a picker.
- **Desired:** the mock's `+ Upload Media` action with the indeterminate progress bar (mock ll.94-99, 239) — one obvious upload affordance.
- **Fix (full-stack seam cleanup + parity — the real risk):**
  1. **Decide the contract.** Either (a) make the picker the explicit responsibility of the data layer on every platform (drop the `bytes`/`mimeType` params from the screen call, document that `uploadMedia` self-picks), or (b) actually read bytes in common code and pass them down. Today web does (a) implicitly while the desktop/JVM and Android actuals may expect (b) — **a real cross-platform parity hazard.** Pick one deliberately; do not leave the empty-`byteArrayOf()` call masking a platform divergence.
  2. **Desktop (JVM) `platformUploadMedia`:** confirm it exists and picks/reads a real file. If it does not, the desktop Upload button silently uploads nothing — gate it dark with a "Upload not wired on desktop" banner rather than shipping a button that no-ops (fail loud).
  3. **Android parity:** Android has its own `MediaFile` round-trip (model KDoc l.6-9). Confirm the Android gallery uses the same signed-upload + Cloudinary path.
  4. **`uploadedBy` is hardcoded** to the literal `"auntie"` (wasmJs l.626) — per Rule 1 this should be the real signed-in admin's identity, not a constant. **Dependency:** thread the real uploader (uid/display name from `AuthClient`) into the write. The mock surfaces `uploadedBy` ("Auntie Jo") in its caption suggestion, so this field is meant to be real.
  - **Tests:** integration test of the signed-upload → Firestore write; e2e (Playwright) that the picker opens and a successful upload streams a new cell in; parity tests on desktop/Android.

## 2. Profile-photo badge — in the model, not rendered
- **Current:** `MediaFile.isProfilePhoto` exists (`MediaModels.kt` l.27) but `AuntieMediaCell` **never renders a profile marker** (read of `AuntieMediaCell.kt` ll.117-187 shows preview/glyph/play/duration/delete badges only — no `isProfilePhoto` branch). The mock shows a teal "Profile" pill top-left (mock `.pf` ll.171-174, applied l.274).
- **Desired:** a top-left "Profile" badge on the cell whose `isProfilePhoto == true`.
- **Fix:** add a top-start badge in `AuntieMediaCell` gated on `media.isProfilePhoto` (mirror the existing `DeleteBadge` top-end pattern, ll.164-171). Bind to the **real** boolean — never hardcode which cell is "Profile." Mirror on Android cell. Component/visual test for the badge. No new backend (field already streams).

## 3. Hover caption strip — description + uploadedAt + uploadedBy (data exists, not shown)
- **Current:** `AuntieMediaCell` supports only a single-line caption (`showCaption` param, default false) showing `description.ifBlank { originalFileName }` **below** the tile (`AuntieMediaCell.kt` ll.174-186). The screen calls the cell **without** `showCaption` (ll.327-333) so even that single line is off. There is **no** hover overlay surfacing `uploadedAt` / `uploadedBy` / a two-line description, which the mock proposes (mock `.cap` ll.176-186, 277-280). The model carries `description`, `uploadedAt`, `uploadedBy` (`MediaModels.kt` ll.23-26) — all real, all currently invisible on this screen.
- **Desired:** mock's gradient-to-dark hover strip: 2-line `description` + a mono meta row `{uploadedAt} · {uploadedBy}`.
- **Fix:**
  1. Add an on-hover caption overlay variant to `AuntieMediaCell` (absolute-positioned bottom gradient, distinct from the existing below-tile `showCaption`). Bind `description`, format `uploadedAt` (it is a String ISO/Firestore value, l.23 — needs a real relative/short-date format, do not invent a date), and `uploadedBy` (real value once item 1.4 stops hardcoding it).
  2. If `uploadedBy` is still the constant `"auntie"`, **do not** render a fake author name — omit the author segment until item 1.4 lands (fail loud over fake).
  - Mirror Android. Component test for overlay; verify empty `description`/`uploadedAt` degrade gracefully (no orphan separators).

## 4. Count chip + type-filter pills — already shipped (mock SUGGESTION resolved)
- **Current:** `MediaCountChip` (ll.220-243) renders the **real** `state.items.size`; `MediaTypeFilters` (ll.251-285) renders All/Images/Videos/Documents/Audio pills with **real** per-type counts derived from `items.groupingBy { fileType }` and slices the grid live. Both bound to real data, neither hardcoded.
- **Desired:** mock tags both as un-shipped "SUGGESTION" (mock ll.82-86, 110-121, 253-263).
- **Fix:** none — these exceed the mock. Note only: the filter is a pure **view-layer** slice (no backend), which is correct and fail-loud-safe. Leave as-is.

## 5. Empty / loading / error states + delete dialog — already match
- **Current:** Empty state copy "No media files found" / "Upload photos and videos to see them here" (ll.298-305) is verbatim. Error banner surfaces `FirestoreResult.Error` message verbatim with dismiss (`clearError`, ll.109-122) — fail-loud, never swallowed. Loading uses `ShimmerCard` (ll.287-295). Delete dialog copy "Delete Media" / "Are you sure you want to delete this {fileType lowercased}?" / "Delete" / "Cancel" (ll.353-377) is verbatim. Upload progress is a real indeterminate `AuntieProgressBar` gated on `state.isUploading` (ll.102-105).
- **Desired:** all of the above appear in the mock identically.
- **Fix:** none. These are correct and fail loud. Do not touch.

---

## Out of scope / leave as-is
- Header: back affordance, "THE DEN · MEDIA" kick, "$entityName Media" Fraunces title with "Media" in the pink secondary — all match the mock (ll.149-217). `entityName` is bound to the screen param (real), correctly not hardcoded.
- Image/video rendering: `AuntieMediaCell` loads real `thumbnailUrl`/`storageUrl` via `AsyncImage` with a broken-image glyph fallback (ll.135-162); video play badge + `durationSeconds` badge are real (ll.145-154). Cloudinary URL building is real (`KinTaleMediaConfig`). Matches the mock's IMAGE/VIDEO/DOCUMENT/AUDIO branches.
- Grid is `GridCells.Adaptive`-style square tiles via `AuntieMediaGrid` (mock `.grid` minmax(150px)).
- Global search/bell live at the shell level (`web/.../ui/shell/AppShell.kt`); this screen's top bar is correctly screen-local (back + upload only) and should not grow a search box.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Upload contract / parity** — resolve the empty-`byteArrayOf()` seam so the picker-vs-bytes responsibility is identical and real on web, desktop, and Android (desktop/Android `platformUploadMedia` must be confirmed real or gated dark with a Not-wired banner; never a no-op button).
2. **Real `uploadedBy`** — replace the hardcoded `"auntie"` string (wasmJs l.626) with the signed-in admin identity from `AuthClient`, so the caption author is real. Until then, omit the author segment rather than printing the constant.
3. **`uploadedAt` formatting** — a real short-date/relative formatter for the caption meta (the field is a raw String; do not fabricate dates).
4. **Profile-photo badge** render path in `AuntieMediaCell` (model field already streams; UI-only + Android parity + visual test).
5. **Hover caption overlay** variant in `AuntieMediaCell` binding real `description` + meta (UI-only + Android parity + tests).

Every value on this screen already traces to the real `mediaStream`/`MediaFile`; the only fabricated value in shipped code is the hardcoded `uploadedBy = "auntie"`, which must be made real or omitted. No gradient placeholder, sample name, or sample date from the mock may ship.
