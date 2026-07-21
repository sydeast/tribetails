# Visual Regression Runbook: capture, verify, approve (2026-07-21)

The visual harness has two halves that are easy to confuse. **Capture** re-renders each screen and overwrites the PNGs under `visual/<surface>/`. **Verify** compares those captures against the operator-approved goldens under `visual/baselines/<surface>/` and fails on drift. Capture alone proves nothing: until 2026-07-21 nothing in the repo ever invoked the verify step, so the goldens recorded history instead of guarding it. Design doc: `docs/2026-05-31-visual-testing-design.md`. Verify implementation: `web/visual/baseline.mjs`.

Three surfaces, 20 screens each: `web` (Playwright against the Compose wasm canvas), `desktop` (Compose JVM / Skia, `runDesktopComposeUiTest`), `android` (Roborazzi under Robolectric). Screens are declared once in `web/visual/manifest.json`.

## The sharp edge: capture mutates tracked files

Everything under `visual/` is git-tracked, including all 60 current captures and all 60 goldens. The capture steps below rewrite `visual/<surface>/*.png` in place. Anti-aliasing and font timing make those PNGs differ byte-for-byte on almost every run, so a capture you did not mean to run will follow you into a `git add -A` as 20 unexplained image changes.

Two specific traps:

- **Desktop has no opt-out.** `DesktopScreenshotTest` writes to `../../visual/desktop/` unconditionally (`web/composeApp/.../visual/DesktopScreenshotTest.kt`). It is an ordinary member of the `jvmTest` suite, so the routine web gate `./gradlew -p web :composeApp:jvmTest` re-captures all 20 desktop PNGs as a side effect. Check `git status visual/` after any jvmTest run and restore what you did not intend to change: `git restore visual/desktop/`.
- **Android used to have no opt-out.** `android/app/build.gradle.kts` hardcoded `roborazzi.test.record = "true"` on every unit test task, so `:app:testDebugUnitTest` re-captured all 20 android PNGs. That is now behind a Gradle property that defaults to **off** (see below). With recording off, `captureRoboImage` early-returns and writes nothing, so the screenshot tests still execute but leave the tree alone.

Verify itself also writes: it regenerates `visual/report/regression.md` and, for each regressed screen, a diff overlay at `visual/report/regress/<surface>-<screen>.png`. Those are tracked too. They are triage artifacts, not goldens, so commit them deliberately or restore them with `git restore visual/report/`.

## Capture

### Web

Needs a real test-admin login and a running wasm build. Credentials go in `web/visual/.env` (gitignored) or the environment; the script hard-stops rather than fabricating them.

```bash
cd web/visual
# VISUAL_ADMIN_EMAIL / VISUAL_ADMIN_PASSWORD required.
npm run visual:web
```

`VISUAL_BASE_URL` defaults to `https://auntie.tribetails.com`, which since 2026-07-20 serves the **React** admin, not the Compose wasm app the script drives (it authenticates through `window.__fb.signIn` and screenshots the Skia `<canvas>`). Per `web/firebase.json` the wasm build deploys to the `auntieos-admin` site, so point `VISUAL_BASE_URL` at that host (or a local `npm run serve-dist`) before capturing, or the run will fail loud on every screen.

### Desktop

```bash
./gradlew -p web :composeApp:jvmTest --tests "com.tribetails.auntieos.web.visual.DesktopScreenshotTest"
```

Deterministic by construction: demo fixtures, dark theme, fixed 1440x900, and a 4s font-load window so Fraunces/Hanken resolve before the capture. Running the whole `:composeApp:jvmTest` suite captures too, whether or not you wanted it.

### Android

Recording is opt-in. Without the property the tests run and capture nothing.

```bash
cd android
./gradlew :app:testDebugUnitTest -Proborazzi.record=true \
  --tests "com.tribetails.auntieos.visual.AndroidScreenshotTest"
```

A bare `-Proborazzi.record` (no value) also records. The Roborazzi **Gradle plugin** is deliberately absent: 1.46.1 needs AGP's removed `TestedExtension`, so the usual `recordRoborazziDebug` / `verifyRoborazziDebug` tasks **do not exist**. Do not add the plugin and do not reach for those task names. Only the Roborazzi library is on the classpath, driven by the `roborazzi.test.record` system property that `android/app/build.gradle.kts` now derives from the Gradle property.

## Verify

Compares the current captures against the goldens for the same surface. Same renderer on both sides, so a strict pixel diff is valid.

```bash
cd web/visual
npm run visual:verify              # all surfaces
node baseline.mjs verify web       # one surface, if you need it
```

Exit code 0 means clean, 1 means at least one screen regressed, 2 means no goldens exist at all. A screen regresses when more than `REGRESSION_PCT` (default 0.5) percent of its pixels differ, using a per-pixel tolerance of `PIXEL_THRESHOLD` (default 0.1). Both are env knobs; raise `REGRESSION_PCT` only with a reason, never to make a red run go green.

Read the results in `visual/report/regression.md` and the per-screen overlays in `visual/report/regress/`. `missing-capture` means a golden has no matching current capture (you did not run the capture step for that surface). `dim-mismatch` means the viewport changed. `unbaselined` means a new screen exists with no golden yet, and it does **not** fail the run.

Verify only ever compares what is on disk. It does not capture. Run the capture step for a surface first, or you are diffing stale PNGs against the goldens and learning nothing.

## Approve a legitimate change

Only after you have looked at the overlays and can name the UI change that caused every regression.

```bash
cd web/visual
npm run visual:approve             # promotes ALL current captures on ALL surfaces
node baseline.mjs update android   # or promote one surface
```

This copies `visual/<surface>/*.png` over `visual/baselines/<surface>/*.png`. Commit the goldens in their own commit, with the UI change that justifies them named in the message. Approving a regression you cannot explain is how the goldens stopped meaning anything the first time.

Do not approve to clear a red run. If you cannot account for a diff, leave it red and escalate to the operator.

## Why the JVM screenshot test does not assert

`DesktopScreenshotTest` records and never compares, and that is intentional, not an oversight to fix. Making it assert would need a Compose-side compare harness (golden loading, tolerance policy, diff-artifact emission) that this repo does not have and that Roborazzi cannot supply here, since its Gradle plugin is incompatible with AGP 9.2.1. `baseline.mjs` already fills that role for all three surfaces with one tolerance policy and one report. Keep the Kotlin tests as pure capture; keep the assertion in `baseline.mjs`.

## Known state as of 2026-07-21

A verify run against the committed captures reports **23 ok, 37 regressions, 0 unbaselined** (exit 1): 19 desktop screens and 18 android screens, ranging from 0.69 percent to 78.9 percent changed. Web is clean on all 20. This is accumulated drift from sessions that captured without ever verifying, so it is unreviewed and deliberately **not** approved. Someone has to walk `visual/report/regress/` screen by screen and decide which diffs are intended UI changes before the goldens are promoted. Until that happens the harness is wired but the baselines are stale.

## Suggested order for a routine check

1. Capture the surfaces you touched (web / desktop / android above).
2. `npm run visual:verify`. Exit 0, stop here.
3. Non-zero: open `visual/report/regression.md`, then the overlays for each red row.
4. Every diff explained by a UI change you made: `npm run visual:approve`, commit goldens separately.
5. Any diff you cannot explain: do not approve. Fix the regression or escalate.
</content>
</invoke>
