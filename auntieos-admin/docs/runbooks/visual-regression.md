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

Four surfaces. Three render the **Compose** app: `web` (Playwright against the Compose wasm canvas), `desktop` (Compose JVM / Skia, `runDesktopComposeUiTest`), `android` (Roborazzi under Robolectric). The fourth, `react`, renders the **React admin that `auntie.tribetails.com` actually serves**, and is the only one photographing an application anybody ships.

Screens are declared once in `web/visual/manifest.json`. Since 2026-08-01 that is 13 live screens plus 7 under `pendingRemock`, the ones whose mockup the operator withdrew, listed rather than deleted so nobody has to reconstruct why a screen left. The two lists give the surfaces different counts, on purpose. The three Compose capture scripts read `screens` only, so 13 each. The react runner captures both lists, because `pendingRemock` means a screen has no approved MOCKUP, and a regression golden needs a shipped screen rather than a design to compare against. That comes to 19, not 20, because `#/payments` has no React screen at all.

The react surface maps the manifest's Compose hash routes onto the React router rather than keeping a second list.

## The sharp edge: capture mutates tracked files

Everything under `visual/` is git-tracked, including every current capture and every golden (60 Compose plus 19 react). The capture steps below rewrite `visual/<surface>/*.png` in place. Anti-aliasing and font timing make those PNGs differ byte-for-byte on almost every run, so a capture you did not mean to run will follow you into a `git add -A` as 20 unexplained image changes.

Two specific traps:

- **Desktop has no opt-out, and no longer needs one.** `DesktopScreenshotTest` still writes to `../../visual/desktop/` unconditionally (`web/composeApp/.../visual/DesktopScreenshotTest.kt`), as an ordinary member of the `jvmTest` suite, so the routine web gate re-captures all 20 PNGs as a side effect. **Those files are gitignored as of 2026-08-07 and the 20 tracked copies were deleted**, so the capture no longer dirties the tree and there is nothing to `git restore`. They were never goldens: that test calls `ImageIO.write` and never compares, and the desktop baselines had already been deleted after the verify run below. The capture still lands on disk if you want to look at it.
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

### React

Needs no credential and no deployed build. It borrows the whole e2e harness: the Firebase emulators, the seeded admin, the vite dev server and the real sign-in form.

```bash
cd auntieos-admin
npm ci
npm run e2e:install     # once per machine: downloads Chromium
npm run visual:react
```

That runs `tsc -p e2e`, starts the auth and Firestore emulators on the e2e ports, seeds them with `e2e/seed.visual.ts`, signs the operator in through `auth.setup.ts`, and writes `visual/react/<screen>.png`. Roughly a minute for 19 screens. Verify with `npm run visual:react:verify`, or with the all-surface `npm run visual:verify` from `web/visual`.

**Capture is opt-in and `npm run e2e` cannot trigger it.** The project only exists when `VISUAL_CAPTURE=1`, which is what the npm script sets, so the routine e2e suite cannot rewrite 19 tracked PNGs the way `:composeApp:jvmTest` rewrites the desktop ones.

**Everything non-deterministic is pinned, and the pins are the point.** In `e2e/visual.capture.spec.ts` and `e2e/visual/fixtures.ts`:

| Pinned | How |
|---|---|
| The three Den orbs drifting on a 29s keyframe, and every screen's `rise` entrance | `page.emulateMedia({ reducedMotion: 'reduce' })`. `styles/base.css` already answers that preference with a global `animation: none !important`, so the app needs no harness-only branch. `page.screenshot({ animations: 'disabled' })` on top. |
| Relative timestamps, day headings, countdowns, and the rolling windows Invoices / KinTales / Sessions filter on | `page.clock.setFixedTime(VISUAL_NOW)` freezes what the page READS without pausing timers, and `E2E_SEED_NOW` dates the seed against the same instant, so the rows and the window move together. |
| Local-time formatting (`lib/time.ts` reads the browser's zone on purpose) | `timezoneId: 'UTC'`, `locale: 'en-US'`. |
| Callables reaching **production** `us-central1`, failing fast on one run and after a 20s `CallableTimeoutError` on the next | two things, and the second does not replace the first. `src/lib/firebase.ts` pins the Functions SDK at the unserved `127.0.0.1:5399`, so a deployed URL cannot be produced at all; the capture spec additionally aborts every non-localhost request, so a golden cannot depend on any external service being up. |
| Callables having **no answer at all**, which photographs a red error panel where the screen should be | `e2e/visual/callableStubs.ts` answers the fifteen callables the captured screens invoke, with fixed, server-shaped data. Registered AFTER the abort above: Playwright checks route handlers in reverse order, so the stub owns the callable port and the abort still owns everything else. A callable it does not name still fails loud. |
| Shooting a screen mid-load | waits until nothing matching `div[role=status][aria-live=polite], .async-loading, .den-stat-value--pending` is left, then `document.fonts.ready`, then two frames. A load that never clears fails the screen instead of photographing a spinner. |
| Shooting a screen whose data never arrived | after the wait above, the capture searches the page for `lib/fns.ts`'s "was called in e2e emulator mode" and FAILS the screen if it finds it, naming the callable. Nine goldens were photographs of that sentence before this existed. |
| The text caret | `caret: 'hide'`. |

Four consecutive runs, one of them under `TZ=Asia/Tokyo`, produced byte-identical PNGs for all 19 screens.

**What it does not photograph.** `payments` is skipped: `#/payments` names a slug the React nav table does not know (`lib/nav.ts`'s `routeWarning` says so), because Payments became a tab inside Settings.

**Callable-backed screens are stubbed, and this paragraph used to say the opposite.** Until 2026-08-04 it read that screens whose data arrives through a callable "photograph their error state, correctly and stably, because the functions emulator is not running", and named Templates, Form Schemas, five of Home's seven widgets, the Inbox thread panel, ActivityLog's chain-integrity banner and KinTaleDetail's comment and reaction panels. That was accurate and it should never have been acceptable. A golden of `Couldn't load templates` is not a photograph of the Templates screen. Nine of the nineteen captures were pictures of an error panel and seven of the approved goldens already were, all seven recorded on 2026-08-01 with `…failed: internal` where the content belongs. `invoice-detail` and `kintale-logs` were the other two, and worse: their panels landed after the recording, so the drift looked like design work and was one approve away from being frozen. `invoice-detail`'s Payment History was the sentence `Couldn't load this invoice's payments or visits`, and a regression in that table could not have appeared in a picture that had no table in it.

`e2e/visual/callableStubs.ts` answers them instead: fifteen callables, fixed data derived from `VISUAL_NOW`, shaped against the callable's own contract, and agreeing with what the seed writes wherever both describe the same thing. It is not the functions emulator and does not pretend to be one, which is still not started and still for the reasons in `docs/runbooks/e2e.md`. What it fixes is narrower and was the whole problem: the screens now have data, so the goldens are of the screens.

Adding a callable to a captured screen without adding it there FAILS the capture, by name. That is deliberate, and it is the guard whose absence let nine broken goldens be recorded and approved.

**The goldens are machine-specific.** They were recorded on macOS 26.5 / arm64, Playwright 1.62.0's bundled Chromium, headless. Font rasterization differs between machines and between Chromium builds, so a first verify on different hardware can be red on all 19 for a reason that is not a UI change. That is a re-record (`node web/visual/baseline.mjs update react`), not a review.

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

`DesktopScreenshotTest` records and never compares, and that is intentional, not an oversight to fix. Making it assert would need a Compose-side compare harness (golden loading, tolerance policy, diff-artifact emission) that this repo does not have and that Roborazzi cannot supply here, since its Gradle plugin is incompatible with AGP 9.2.1. `baseline.mjs` already fills that role for all four surfaces with one tolerance policy and one report. Keep the Kotlin tests as pure capture; keep the assertion in `baseline.mjs`. The react surface follows the same rule and for the same reason: `visual.capture.spec.ts` never calls `toHaveScreenshot()`, which would have grown a second golden store under `.artifacts/` with a second threshold.

## The three Compose surfaces are still pictures of a different application

`web` drives the wasm build's Skia canvas through `window.__fb`; `desktop` is Compose JVM; `android` is the Compose Android app under Robolectric. None of them renders the React admin that `auntie.tribetails.com` has served since 2026-07-20, so the goldens under `visual/baselines/web|desktop|android/` picture a superseded app. The `react` surface above is where the shipped admin lives. A green run on the other three says nothing about it, and a red one says nothing about it either.

Nothing here retires those three. The images are wrong; the machinery is not, and the split between capture and one shared `baseline.mjs` verify is exactly what let a fourth surface be added without a second tolerance policy or a second report.

### How the react surface reaches the manifest's screens

`manifest.json` was written for the Compose hash router and the React admin runs TanStack Router on real paths, so the two disagree in three ways. `e2e/visual/routes.ts` resolves each one and prints the whole map at the top of every capture run:

- **Renamed.** `#/training-docs` is `/tribal-intel`; `#/template-bank` and `#/template-assignment` are both the merged `/templates`. The mapping is DERIVED from `src/lib/nav.ts`'s own slug table, including its back-compat entries, so a rename that lands there reaches this surface with no second list to update.
- **Reshaped.** `#/invoices/{id}` and `#/kintales/{id}` are path params in Compose and search params (`/invoices?invoiceId=`, `/kintales?kinTaleId=`) in React. Their ids are seeded constants, not the `VISUAL_DEMO_*_ID` environment variables the Compose `web` surface needs.
- **Not addressable.** `template-assignment` and `formschema-editor` are component state in React with no URL, so they are opened by clicking a named control (`Manage assignments`, `New schema`). Without that, `template-assignment` would resolve to `/templates` and ship a second copy of the `template-bank` picture under another name. The run fails if two screens ever resolve to one URL.

The runner tolerates both manifest shapes, the older flat 20-entry `screens` array and the `screens` + `pendingRemock` split that PR #188 landed. **Both lists are captured.** `pendingRemock` marks a screen with no approved mockup, which matters to `build-report.mjs` (app vs mockup) and not at all here: a regression golden needs a shipped screen, not a design to compare it against.

## Known state as of 2026-07-25 (superseded 2026-08-01)

Kept because it is the evidence behind the deletion at the top of this file, not
because it still describes the tree. The Compose goldens and the report it
describes are gone; the captures under `visual/<surface>/` remain.

A verify run against the committed captures reported **24 ok, 36 regressions, 0 unbaselined** (exit 1): 19 desktop screens and 17 android screens, from 0.69 percent to 19.76 percent changed. Web was clean on all 20. That was accumulated drift from sessions that captured without ever verifying, and it was never reviewed or approved. It is the evidence behind the deletion, and it is why nobody should re-record a Compose surface casually.

**`react` is the only surface with goldens today.** 19 ok, 0 regressions. Re-recorded 2026-08-04, three days after the first set, for two reasons in one run: the callable stubs above replaced nine error panels with the screens they were hiding, and three days of design work had landed on the screens themselves (`a5254f1` Invoices and Notifications to the design system, `f2a70bc` the seeded rows and today's visit, `9f0806c` the Activity Log filter bar and the notification's delivery state, `5e87128` the invoice's payments and linked visits). Every one of the nineteen diffs was walked against a named commit before the record. The three Compose surfaces have captures and no goldens, so verifying them reports exit 2 until somebody records deliberately.

**The tracked report was lying, and the lie was the reassuring direction.** Until 2026-07-25 `visual/report/regression.md` in git listed all 60 screens as `ok | 0`, because it was last written immediately after an approve, when captures and goldens were by definition identical, and never regenerated as the tree moved on. Anyone who opened that file instead of running the check read a clean bill of health for a harness that was 36 screens red, which is worse than having no report at all. PR #188 deleted `visual/report/` for that reason; `build-report.mjs` still regenerates it, so if you run verify and do not commit the result, restore it (`git restore visual/report/`) rather than leaving a half-updated one behind.

**Neither surface can be re-captured casually to clear this.** Desktop and Android both need Gradle, both rewrite 20 tracked PNGs in place, and both produce exactly the unreviewed drift above. Web capture additionally needs a live test-admin credential that only the operator holds. So the 36 rows stay red until someone with those credentials and a reason walks the overlays.

## Suggested order for a routine check

1. Capture the surfaces you touched (react / web / desktop / android above). If you changed the React admin, that is `npm run visual:react`.
2. `npm run visual:verify`. Exit 0, stop here.
3. Non-zero: open `visual/report/regression.md`, then the overlays for each red row.
4. Every diff explained by a UI change you made: `npm run visual:approve`, commit goldens separately.
5. Any diff you cannot explain: do not approve. Fix the regression or escalate.
</content>
</invoke>
