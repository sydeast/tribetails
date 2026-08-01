# Design: UI Visual Comparison Harness (app vs ui-ideas mockups)

> **RETIRED 2026-07-31. History only.** Everything this document describes was
> built, then removed by owner ruling: the goldens photographed the superseded
> Compose app and `visual/mockups/` carried a design round that had since been
> overruled. Nothing here exists in the tree. Do not implement from it, and do
> not treat any `visual/` path below as a live location.
> See `docs/runbooks/visual-regression.md` for what was deleted and why.

**Date:** 2026-05-31
**Status:** Implemented 2026-06, retired 2026-07-31
**Surfaces:** Web (Compose Wasm/Skia), Desktop (Compose Desktop JVM/Skia), Android (native Compose)
**Tools:** Playwright (web) + Roborazzi (desktop + android)

---

## Goal

Compare the running AuntieOS apps against the `ui-ideas/` Den mockups to (1) surface
current UI divergences ("a few issues") now, then (2) lock regression baselines so
drift is caught going forward. Three surfaces, one mockup source of truth.

## Hard constraints (why the tooling is what it is)

- **Web + Desktop render via Skia.** Web is a single `<canvas>`; desktop is a Skia
  JVM window. They share `commonMain` composables, so they look near-identical.
- **A Skia render NEVER pixel-matches an HTML/CSS mockup** (font hinting, antialiasing,
  subpixel). Therefore app-vs-mockup is a **tolerant perceptual diff for triage**, never
  a strict pixel gate. Strict diffing is reserved for Phase 2 app-vs-golden (same renderer).
- **DOM-snapshot tools (Percy, Chromatic) capture a Skia canvas as one opaque box** → useless
  for layout conformance. Playwright screenshots real pixels, so it is the only web fit.
- **Roborazzi** captures Compose composables headlessly on the JVM (desktop) and under
  Robolectric SDK 35 / Java 21 (android, infra already in place). It cannot render HTML,
  so it consumes the Playwright-rendered mockup PNGs for pairing.
- **No git repo** in this project → no CI gate. Harness runs as local `npm` / `gradle`
  scripts that emit a browsable report folder.
- **Fail loud, never fake** (project CLAUDE.md): a screen that fails to load, a missing
  route, an absent demo doc, or a missing credential produces a LOUD red report entry or a
  hard STOP — never a blank-pass or fabricated data.

## Phasing

- **Phase 1 — triage contact sheets.** Pilot 3 screens (Directory, Home, Invoice Detail)
  across all 3 surfaces end-to-end, then expand to the 27 converted screens.
- **Phase 2 — baseline lock.** Operator-approved app screenshots become goldens; re-runs
  diff app-vs-golden (tighter threshold) for regression.

## Architecture

```
ui-ideas/*.html ──(Playwright render @1440x900)──► visual/mockups/<name>.png  ┐
                                                                              │ pair + tolerant diff
web app  ──(Playwright: login→hash-route→canvas shot)──► visual/web/<screen>.png ─┤──► visual/report/index.html
desktop  ──(Roborazzi JVM, demo fixtures)───────────► visual/desktop/<screen>.png┤    (side-by-side + diff overlay)
android  ──(Roborazzi Robolectric)──────────────────► visual/android/<screen>.png┘
```

### Components

1. **Mockup capturer** (`web/visual/capture-mockups.ts`, Playwright)
   Renders each `ui-ideas/*.html` at **1440×900** (mockup wrap is `max-width:1240px`)
   → `visual/mockups/<name>.png`. Single source of mockup truth for all surfaces.

2. **Web capturer** (`web/visual/capture-web.spec.ts`, Playwright)
   - One-time `global-setup` logs in as the sole admin and saves `storageState.json`
     (Firebase auth persists in localStorage/IndexedDB). Reused by all specs.
   - Per screen: navigate to its hash route (`#/directory`, `#/invoices/{demoId}`, …),
     wait for the canvas-ready signal (`window.__fbReady` + a render-settled wait),
     screenshot the `<canvas>` → `visual/web/<screen>.png`.
   - Scoped to `_demo:true` kinfolk/kin (demo-family-001/002) for stable content.

3. **Desktop capturer** (`web/composeApp/src/jvmTest/.../visual/*ScreenshotTest.kt`, Roborazzi)
   Renders each `commonMain` screen composable with injected demo fixtures (same fixture
   objects the demo seed produces) → `visual/desktop/<screen>.png`.

4. **Android capturer** (`android/app/src/test/.../visual/*ScreenshotTest.kt`, Roborazzi)
   Renders each native screen composable under Robolectric → `visual/android/<screen>.png`.
   **Coverage:** only screens with a matching mockup. Android screens **without** a mockup
   are NOT silently dropped — they are emitted to `visual/report/mockup-gaps.md` as
   "mockup-needed?" candidates for later review.

5. **Manifest** (`web/visual/manifest.json`)
   The single mapping table. One entry per screen:
   ```json
   {
     "screen": "directory",
     "mockup": "auntieos-directory-2026-05-27.html",
     "webRoute": "#/directory",
     "desktopEntry": "DirectoryScreen",
     "androidEntry": "DirectoryScreen",
     "demoScope": "demo-family-001"
   }
   ```
   39 mockups vs 27 converted screens: unmapped mockups + unmapped android screens are
   listed in `mockup-gaps.md`, never silently dropped.

6. **Pair + report** (`web/visual/build-report.ts`)
   For each manifest entry × surface: stitch app PNG + mockup PNG side-by-side, run
   **tolerant pixelmatch** (high threshold, cross-renderer) to produce a diff-overlay
   highlighting only large layout/color/missing-element divergences. Emit one browsable
   `visual/report/index.html` (screen rows, per-surface columns, diff %, red rows for
   load failures).

## Data flow

Demo Firestore docs (`_demo:true`, already seeded, sanctioned — not fabrication) → app
renders real code paths → screenshot. Mockup HTML → Playwright → mockup PNG. Pair → tolerant
diff → report. Phase 2: approved app PNG → `visual/baselines/<surface>/<screen>.png` golden;
re-run diffs app-vs-golden.

## Error handling (fail loud)

| Condition | Behavior |
|---|---|
| `VISUAL_ADMIN_EMAIL`/`VISUAL_ADMIN_PASSWORD` unset | Hard STOP before any capture, clear message. No fabricated creds. |
| Web login fails / auth expired | Red report entry for every web screen + surfaced error; no blank-pass. |
| Hash route renders nothing / `__fbReady` never true | Red entry with timeout reason. |
| Demo doc absent for a screen | Red entry naming the missing demo id. |
| Diff over threshold | Flagged amber/red in report, never hidden. |
| Roborazzi composable throws | Test fails loud with the composable + fixture in the trace. |

## Pilot screens (Phase 1)

| Screen | Mockup | Pattern exercised |
|---|---|---|
| Directory | `auntieos-directory-2026-05-27.html` | list + tabs (HANDOFF-confirmed good anchor) |
| Home | `auntieos-home-2026-05-27.html` | dashboard + stat tiles |
| Invoice Detail | `auntieos-invoice-detail-2026-05-27.html` | detail + key-value rows + deep-link route |

These cover list / dashboard / detail and all exist on web + desktop + android.

## Out of scope (this design)

- Maestro on-device e2e (optional later for real-device booking flows).
- Percy/Chromatic SaaS review UI (revisit only if hosted team-approval workflow is wanted).
- CI gating (no git repo).
- The 19 booking-flow PNGs (kinfolk/MyTribe oriented, not AuntieOS admin).

## Deliverables

- `web/visual/` Playwright project (config, global-setup login, capture-mockups,
  capture-web, manifest, build-report) + `npm run visual:*` scripts.
- Roborazzi screenshot tests under web `jvmTest` (desktop) and android `test` (android),
  with `recordRoborazziDebug` / verify gradle tasks.
- `visual/report/index.html` contact-sheet report + `visual/report/mockup-gaps.md`.
- Phase 2: `visual/baselines/` goldens + a verify mode.
