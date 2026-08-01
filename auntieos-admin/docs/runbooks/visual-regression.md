# Visual Regression Runbook: capture, verify, approve (updated 2026-08-01)

## 2026-08-01: the goldens and the mockup renders are gone, the harness is not

Operator ruling: `visual/mockups/` and `visual/baselines/` held designs nobody
ships, and agents kept reading them as current. Both directories are deleted. The
harness that writes them stays, so the rest of this runbook still describes a
working tool.

What that means for a run today:

- **Verify exits 2** ("no goldens exist at all") until someone re-records. That is
  the honest answer: the 60 goldens were captures of the superseded Compose app,
  36 of them were unreviewed drift nobody had approved, and a green run against
  them would have meant nothing.
- **Mockup capture is now the only way to get `visual/mockups/`,** and it renders
  from live `ui-ideas/` at the moment it runs. Nothing under
  `ui-ideas/WrongUIDesigns-UpdateKill/` can be rendered: `capture-mockups.mjs`
  refuses the whole run if the manifest names one.
- **The manifest is 13 screens, not 20.** Seven have no live mockup and sit in
  `manifest.pendingRemock`, each with the rejected filename that used to serve it.
  Five of those are the operator re-mocks F1 to F5 in
  `docs/punchlists/PUNCHLIST_2026-07-31-remaining.md`. A screen leaves
  `pendingRemock` when a replacement mockup lands in `ui-ideas/`, not before.

Design authority is `page-specs/` and `ui-ideas/`. `visual/mockups/` is rendered
output of the second and is never itself a source. See `CLAUDE.md`.

The visual harness has two halves that are easy to confuse. **Capture** re-renders each screen and overwrites the PNGs under `visual/<surface>/`. **Verify** compares those captures against the operator-approved goldens under `visual/baselines/<surface>/` and fails on drift. Capture alone proves nothing: until 2026-07-21 nothing in the repo ever invoked the verify step, so the goldens recorded history instead of guarding it. Design doc: `docs/2026-05-31-visual-testing-design.md`. Verify implementation: `web/visual/baseline.mjs`.

Three surfaces, 13 screens each since 2026-08-01: `web` (Playwright against the Compose wasm canvas), `desktop` (Compose JVM / Skia, `runDesktopComposeUiTest`), `android` (Roborazzi under Robolectric). Screens are declared once in `web/visual/manifest.json`, and the seven withdrawn ones are listed there under `pendingRemock` rather than deleted, so nobody has to reconstruct why a screen left.

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

`VISUAL_BASE_URL` now defaults to `https://auntieos-admin.web.app`, the site `web/firebase.json` deploys the wasm build to. It used to default to `https://auntie.tribetails.com`, which since 2026-07-20 serves the **React** admin, not the Compose wasm app this script drives (it authenticates through `window.__fb.signIn` and screenshots the Skia `<canvas>`). Aimed at that host, the script waited the full 60 seconds for a bridge that will never exist and then failed every screen with a bare Playwright timeout. It now detects the case (`#root` present, no `<canvas>`) and says which app it found and where the wasm build actually lives. Override `VISUAL_BASE_URL` for a local `npm run serve-dist`.

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

## This harness does not cover the React admin

All three surfaces render the **Compose** app. `web` drives the wasm build's Skia canvas through `window.__fb`; `desktop` is Compose JVM; `android` is the Compose Android app under Robolectric. The React admin that `auntie.tribetails.com` has served since 2026-07-20 appears in none of them, so it has **zero** visual coverage and the 20 goldens under `visual/baselines/web/` are pictures of a different application.

Do not read a green verify run as a statement about the React admin. Whatever browser coverage that app has asserts computed style and font metrics, not pixels, and is not a substitute for a screenshot diff. (Task 8.1 adds that coverage under `e2e/`, with its own runbook at `docs/runbooks/e2e.md`.)

Closing the gap means a fourth surface whose capture step drives the React app and whose verify step is this same `baseline.mjs`, so there stays one tolerance policy and one report. It needs a Firebase emulator and a seeded admin, which the e2e harness already provides, and it needs the non-deterministic parts of those screens pinned first: the sign-in orbs drift, and most list screens render relative timestamps. Capturing before that is done produces a golden that fails on the next run for reasons nobody can name, which is how a harness gets ignored.

## Known state as of 2026-07-25 (superseded 2026-08-01)

Kept because it is the evidence behind the deletion at the top of this file, not
because it still describes the tree. The goldens and the report it describes are
gone; the captures under `visual/<surface>/` remain.

A verify run against the committed captures reported **24 ok, 36 regressions, 0 unbaselined** (exit 1): 19 desktop screens and 17 android screens, from 0.69 percent to 19.76 percent changed. Web is clean on all 20. This is accumulated drift from sessions that captured without ever verifying, so it is unreviewed and deliberately **not** approved. Someone has to walk `visual/report/regress/` screen by screen and decide which diffs are intended UI changes before the goldens are promoted. Until that happens the harness is wired but the baselines are stale.

**The tracked report was lying, and the lie was the reassuring direction.** Until 2026-07-25 `visual/report/regression.md` in git listed all 60 screens as `ok | 0`, because it was last written immediately after an approve, when captures and goldens were by definition identical, and never regenerated as the tree moved on. It has been regenerated here so the tracked report describes the tracked PNGs. Anyone who opened that file instead of running the check read a clean bill of health for a harness that was 36 screens red, which is worse than having no report at all. If you run verify and do not commit the result, restore it (`git restore visual/report/`) rather than leaving a half-updated one behind.

**Neither surface can be re-captured casually to clear this.** Desktop and Android both need Gradle, both rewrite 20 tracked PNGs in place, and both produce exactly the unreviewed drift above. Web capture additionally needs a live test-admin credential that only the operator holds. So the 36 rows stay red until someone with those credentials and a reason walks the overlays.

## Suggested order for a routine check

1. Capture the surfaces you touched (web / desktop / android above).
2. `npm run visual:verify`. Exit 0, stop here.
3. Non-zero: open `visual/report/regression.md`, then the overlays for each red row.
4. Every diff explained by a UI change you made: `npm run visual:approve`, commit goldens separately.
5. Any diff you cannot explain: do not approve. Fix the regression or escalate.
</content>
</invoke>
