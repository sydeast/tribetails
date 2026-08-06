# Template Assignment — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-template-assignment-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/admin/TemplateAssignmentScreen.kt`
**Service:** `TemplateService` in `…/web/data/TemplateService.kt` — `listBindings` (callable `listTemplateBindings`), `listTemplates`, `assignTemplate` (MyTribe `assignTemplate`); `TemplateBinding(catalogKey, templateId, audience?, triggerKey?, active)` (ll.39+)
**Related screen:** Template Bank (`TemplateBankScreen.kt`) — see 24-template-bank.md; backlog 13.1 asks to merge/relate the two.
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `AuntieDialog`, `AuntieChip`, `AuntieStatusPill`, `AuntieToggle`, `AuntieSearchField`, `AuntieBanner`, `AuntieEmptyState`, `AuntieIconTile`, `BottomBorderField`, `GhostButton`, `PrimaryButton`.

> Mock-file confirmation: the mock mirrors `TemplateAssignmentScreen.kt`. No correction needed. The shipped screen is **substantially ahead of the complaint**: "New binding does nothing" describes an older build — the current Add Binding + editor are fully wired to `assignTemplate` (see item 1).

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (catalog keys, template ids, audience names, ACTIVE/PAUSED counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. "New binding does nothing" — already wired (backlog 13.9, complaint describes an older build)
- **Current:** **already works.** "Add Binding" (`TemplateAssignmentScreen.kt` ll.269-282) opens `BindingEditorOverlay` (ll.286-316, 372-523) seeded with a blank `catalogKey` and the first template's id. Save calls the real `templateService.assignTemplate(catalogKey, templateId, audience, triggerKey, active)` (ll.297-313) and reloads on success; errors surface in a loud dismissable `saveError` banner (ll.152-162). Existing binding rows ARE clickable — `BindingCard` (ll.319-370) has an Edit button (l.366) that opens the same editor. So the "does nothing / dead page" complaint is stale; the page is live.
- **Desired (LOCKED — Decision 2; binding = template ↔ trigger event):** a **binding** maps one **notification catalog key / trigger event** (e.g. `kincare.booking.confirm`) → one **email template** (`templateId`), with an optional **audience** (kinfolk/auntie/admin/guest) and an optional **trigger-key override**. The dispatcher resolves the right template per trigger at send time — exactly what `assignTemplate` persists. Document this on-screen (item 3); it lives on the **"Assignment" tab** of the merged Templates screen.
- **Fix:** functionally none — keep the wired flow. Verify `assignTemplate` parity on desktop + Android; integration-test create→reload and edit→persist; the catalogKey-immutable-on-edit guard (ll.291-293, 433-449) is correct (no delete/unassign callable exists, so renaming would orphan a doc — keep it locked).

## 2. Relate / merge with Template Bank (backlog 13.1)
- **Current:** Template Bank and Template Assignment are **separate** admin nav entries sharing the same `TemplateService`. The binding editor's template picker (ll.467-480) already lists the bank's `EmailTemplate`s, so they are data-linked but UI-separate. There is no cross-navigation between them.
- **Desired (LOCKED — Decision 2):** MERGE into one Templates screen, two tabs — "Bank" (author) + "Assignment" (this surface). A **binding = template ↔ trigger event** (onboarding, booking confirmed, etc.) so the right template auto-fires.
- **Fix:** decision needed. Options: (a) merge into one "Templates" screen with a bank tab + an assignments tab; or (b) keep separate but add cross-links (a template card → "where is this bound?", a binding → "open this template"). Either way, surface the relationship. No new backend; reuses `listTemplates` + `listBindings`. Cross-reference 24-template-bank.md item 5. Parity + nav tests.

## 3. Surface the binding model + directions on-screen
- **Current:** the panel subtitle (l.199) and editor hint (l.401) explain bindings tersely, but the screen has no top-level directions on what bindings are for (parallels Template Bank backlog 13.7).
- **Desired:** clear guidance.
- **Fix:** add a short directions block defining a binding (catalog key → template, optional audience/override) and how defaults work when unbound (the empty state already says "Defaults from the catalog apply until you assign one", ll.222-227). Author copy with Auntie; no backend dependency.

## 4. Trigger-override echo on cards — honestly gated
- **Current:** the per-card "override: {triggerKey}" line is gated behind `FF_TRIGGER_OVERRIDE_ECHO = false` (ll.58-64, 356-364). Even when on, it only renders for a **genuine** override (`triggerKey` present AND different from `catalogKey`), because the server (`assignTemplate`) defaults a blank `triggerKey` to the `catalogKey` — so an unguarded echo would fire on every binding. Correct fail-loud caution.
- **Desired:** mock shows trigger-override info per binding.
- **Fix:** keep gated until the server stops defaulting blank `triggerKey` to `catalogKey`. **Dependency:** server-side change so a blank override stays null; then the echo reflects a real override. Do not flip the flag before that or it will echo the catalogKey on every row.

## 5. "Unbound catalog keys" hint panel — honestly gated
- **Current:** gated behind `FF_UNBOUND_CATALOG_HINT = false` (ll.66-70, 180-195). There is **no `list-catalog-keys` callable**, so the set of catalog keys that exist-but-are-unbound cannot be computed. When flipped on it shows a fail-loud "NOT WIRED YET" Suggestion banner rather than a fabricated list.
- **Desired:** mock hints at unbound catalog keys (so the operator knows which triggers still use defaults).
- **Fix (full-stack):** **Dependency:** a `listCatalogKeys` callable returning the full notification-catalog key set. Then diff against `listBindings` to show unbound keys. Until that callable exists, keep the panel dark. Parity + integration-test the diff.

## 6. Status pills, search, dual error channels (already real — keep)
- **Current:** Active/Paused count pills (ll.200-217), client-side search over loaded bindings (ll.231-261, marked SUGGESTION, touches no callable), separate `bindingsError` / `templatesError` / `saveError` channels (ll.83-88, 126-178) so failures aren't conflated, and a Warning when templates load empty (ll.165-178, since the picker would be a dead end). All correct fail-loud behavior.
- **Desired:** mock filters/counts.
- **Fix:** none. Keep. (Search is screen-local, not shell-level.)

---

## Out of scope / leave as-is
- The wired Add Binding / edit / `assignTemplate` flow, catalogKey-immutable-on-edit guard, dual error channels, empty/loading states, status pills — all real; do not regress.
- Audience single-select-clear-on-reselect behavior (ll.491-499) is intentional (nullable audience); keep.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`listCatalogKeys` callable** → unblocks the "unbound catalog keys" hint (item 5). No callable exists today.
2. **Server `assignTemplate` change: stop defaulting blank `triggerKey` to `catalogKey`** → unblocks the genuine trigger-override echo (item 4).
3. **Delete/unassign-binding callable** (currently none) → would let catalogKey be editable without orphaning a doc; until then the lock (item 1) is correct.
4. **Merge with Template Bank (LOCKED — Decision 2):** one screen, two tabs (Bank + Assignment).
5. **Binding definition (LOCKED — Decision 2):** a binding = template ↔ trigger event; add on-screen directions explaining that.

Every value rendered on this screen must trace to `TemplateService.listBindings()` / `listTemplates()` / `assignTemplate()` (or the new `listCatalogKeys`). If it can't, it ships dark with a Not-wired banner — not hardcoded.
