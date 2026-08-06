# Activity Log — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-activity-log-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/activity/ActivityLogScreen.kt`
**Model:** `ActivityLogEntry` in `…/web/data/FirestoreClient.kt` (ll.1017-1026)
**Audit writer:** `…/web/data/AuditLog.kt` (logs to `activity_log` via `client.logActivity`)
**Shared components:** `DenScreenHeading`, `DenPanel`, `AuntieIconTile`, `AuntieStatusPill`, `AuntieChip`, `AuntieSearchField`, `AuntieBanner`, `GhostButton`, `ShimmerCard`.

> Mock-file confirmation: `ActivityLogScreen.kt` (KDoc ll.57-76) explicitly mirrors `auntieos-activity-log-2026-05-27.html`. No correction needed.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`1,482 entries · seq 1..1482 · 0 anomalies`, `2:14p`, `KinTale draft approved`, `DRAFT_APPROVED`, `Auntie Syd · generated_drafts/dr_8841`, `#1482`, `a3f1e9`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Rows aren't clickable / no detail view (the core complaint, backlog 11.1)
- **Current:** `ActivityRow` (`ActivityLogScreen.kt` ll.432-503) renders a static `Row` (time, `AuntieIconTile`, humanized action + actionType + status pill, context line). It is NOT wrapped in any `clickable`; there is no detail destination. Each row already shows real fields (`humanizeAction(actionType)`, `entry.status`, `rowContext` built from `description`/`actorId`/`targetCollection`/`targetId`), so this is structured, not a raw table dump — but the operator cannot open an entry to see everything the row truncates (`context` is capped at `maxLines = 2`).
- **Desired:** mock `.row` is hover-highlighted (`.row:hover{background:var(--navy-3)}`), implying interactivity. The complaint asks entries be **clickable into a detail view** surfacing the full, usable record.
- **Fix:**
  1. Wrap `ActivityRow` in a `clickable` that opens an activity-detail surface (modal/overlay like `TemplateViewOverlay`, or a routed `Destination.ActivityDetail`). The detail renders the **full** `ActivityLogEntry`: `timestamp` (full ISO, not the `shortTime` `HH:mm` slice), `actionType`, `humanizeAction`, `status`, `actorId`, `description`, `targetCollection` + `targetId` (as a path), and — when present — the chain fields (see item 2). No new copy; reuse existing field labels.
  2. Add a deep-link affordance from `targetCollection/targetId` to the referenced doc where a route exists (e.g. `generated_drafts/...` → draft, `kin_care_sessions/...` → session). Where no route exists, render the path read-only (do not fabricate a link).
  - **Dependency:** none for the read-only detail (all fields already on the model). A clickable target-doc link needs a resolver mapping `targetCollection` → `Destination`; build it once in the nav layer and reuse. Mirror the detail surface on desktop + Android; UI-test the open/close, integration-test the deep-link resolver.

## 2. Per-row seq + entryHash column (right rail) — honestly gated
- **Current:** the mock's `.seq` right rail (`#1482` + linked `a3f1e9` hash) has **no backing data**. The web `ActivityLogEntry` (FirestoreClient ll.1017-1026) carries **no `seq`, `prevHash`, or `entryHash`** fields. The screen handles this honestly: when `flags.activityChainVerify` is on, `ActivityRow` (ll.499-501) renders a `"no hash"` muted pill instead of a fabricated value; when off, the column is hidden. The KDoc (ll.57-76) documents this fail-loud choice.
- **Desired:** mock `.seq` = a real monotonic `#seq` plus a real `entryHash` prefix with a teal "link" dot, signalling the SHA-256 chain.
- **Fix (full-stack — do NOT fabricate hashes):**
  1. **Backend/data:** extend the web `ActivityLogEntry` model (and the `firebase-bridge` deserialize) to carry the real `seq`, `prevHash`, `entryHash` the `writeAuditEntry` server function already seals (the mock and KDoc both reference `writeAuditEntry`). Until those fields are read into the model, keep the honest `"no hash"` pill — never print a placeholder hash.
  2. Once the fields land, render the right-rail `#seq` + `entryHash.take(6)` and flip `activityChainVerify`. Unit-test the deserialize; visual-regression the rail. Parity across web/desktop/Android.

## 3. Chain-integrity badge + Re-verify (already real — keep)
- **Current:** `ChainIntegrityPanel` (ll.306-402) is **fully wired** to the real `client.verifyActivityLogChain()` callable: it shows VERIFYING → VERIFIED (seq range + sealed count) / ANOMALY (first break code + seq + expected/actual hash) / CHECK FAILED, and never fabricates a pass (`verify()` ll.137-146, `LaunchedEffect(Unit)` re-verifies on load). This is ahead of the mock's static "Chain verified" badge and matches the mock's `.chain` + Re-verify button structure.
- **Desired:** mock `.chain` badge with LED, count line, and "Re-verify" button.
- **Fix:** none functionally — keep the live verification. The only delta is cosmetic alignment to the mock's compact badge styling if desired; the data path is correct and must not be downgraded to a static badge.

## 4. Filters + search (already real — keep)
- **Current:** `FilterChipRow` (ll.404-419, six `ActivityFilter` buckets All/Auth/Bookings/KinTales/Notifications/Admin) and `AuntieSearchField` (ll.184-191) both filter the already-streamed entries client-side (`filter.matches`, `matchesQuery` ll.97-111, 543-556). Matches the mock's `.filters` row + `.search` box.
- **Desired:** mock filter chips + "Search actor, action, target…" box.
- **Fix:** none. Already matches. (Search is screen-local, not the shell-level global search in `…/web/ui/shell/AppShell.kt`.)

## 5. Sentry linkage (backlog 11.2) — LOCKED (Decision 4)
- **Finding:** Sentry **is** integrated in this codebase, but **only as the Android crash/error reporter** (build artifacts: `android/app/build/intermediates/sentry/…`, `sentry-debug-meta.properties`, `injectSentryDebugMetaPropertiesIntoAssetsRelease`). There is **no** Sentry reference in `commonMain` source and **no** link between Sentry and the `activity_log` collection. The Activity Log is a **separate, app-level hash-chain audit trail** written by `AuditLog.kt` → `client.logActivity` → `writeAuditEntry`, sealing business events (logins, edits, booking submits, draft approvals). These are two distinct systems: Sentry = engineering crash telemetry; `activity_log` = business audit.
- **Decision (LOCKED — Decision 4):** keep them **separate** — the Activity Log surfaces **business** events from `activity_log`, NOT Sentry exceptions. Add a **failure→Sentry bridge**: an entry with `status != SUCCESS` links out to its Sentry event for debugging (a labelled link, not a merged feed). **NEW infra item:** extend Sentry crash/error coverage to **web (Wasm) + desktop (JVM)** — today it is Android-only. Do not merge Sentry crashes into the audit chain.

## 6. "Showing newest N of M" + timestamp-contract banners (already real — keep)
- **Current:** `LogPanel` (ll.206-291) caps render at `MAX_RENDERED_ENTRIES = 500` with a loud Warning banner (ll.227-242, the bridge has no server orderBy/limit) and raises a second Warning when ≥half of rows have unparseable timestamps (ll.248-265). Both are correct fail-loud behavior.
- **Desired:** mock has no such banners (it is static placeholder data).
- **Fix:** keep both banners. **Dependency (real blocker):** a **server-side ordered + paginated** `activity_log` query (the bridge `listenCollection` currently downloads the whole append-only collection each snapshot). Build a paged/ordered listener so the 500-cap truncation banner can go away; until then the banner stays. Parity across platforms; integration-test the paging.

---

## Out of scope / leave as-is
- Chain verification logic, filter buckets, search, empty/no-match states, the two fail-loud banners — all real and correct; do not regress them.
- The screen is already NOT a raw table (it is grouped-by-day rows with tinted icon tiles), so backlog 11.1's "random table rows" complaint is partly already addressed; the remaining gap is clickability + detail (item 1).

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Activity-detail surface + target-doc resolver** → makes rows clickable (item 1). Resolver maps `targetCollection` → `Destination`.
2. **`seq` / `prevHash` / `entryHash` on the web `ActivityLogEntry` model + bridge deserialize** → unblocks the real chain right-rail (item 2). Never fabricate hashes; keep the `"no hash"` pill until real.
3. **Server-side ordered + paginated `activity_log` listener** → removes the 500-cap truncation banner (item 6).
4. **Sentry linkage (LOCKED — Decision 4):** keep `activity_log` as the source (business audit); add a **failure→Sentry bridge** (entry `status != SUCCESS` links to its Sentry event) and **extend Sentry to web/desktop** (new infra). No merged feed.

Every value rendered on this screen must trace to the real `client.activityStream()` / `client.verifyActivityLogChain()` sources (or a new real source). If it can't, it ships dark with a Not-wired banner — not hardcoded.
