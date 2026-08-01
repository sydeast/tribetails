# Visual regression: RETIRED 2026-07-31

There is no visual harness in this repo any more. This file is the record of
what was removed and why, so the next person who finds a `visual/` path in an
older doc knows the line is stale rather than the tree broken.

## The ruling

Owner, 2026-07-31, on `auntieos-admin/visual/`:

> deliberately deleted. i want it gone. it holds old ui mocks and i think claude
> code keeps using them instead of the correct mocks.

That is the whole reason. The harness was not failing. It was teaching agents
the wrong designs.

## Why the goldens were worse than no goldens

Three problems, each on its own enough.

**They photographed an application nobody ships.** All three surfaces rendered
the **Compose** app: `web` drove the wasm build's Skia canvas through
`window.__fb`, `desktop` was Compose JVM, `android` was Compose under
Robolectric. The React admin that `auntie.tribetails.com` has served since
2026-07-20 appeared in none of them. The 20 files under `visual/baselines/web/`
were pictures of a different program than the one under test.

**`visual/mockups/` predated the current design rulings.** They were rendered
from `ui-ideas/*.html` in the 2026-05-27 concept round, before the operator
sorted those concepts and moved the rejected ones under
`ui-ideas/WrongUIDesigns-UpdateKill/`. An agent reading `visual/mockups/` got
the rejected round with no signal it had been overruled, which is exactly the
failure the ruling names.

**The tracked report lied in the reassuring direction.** Until 2026-07-25
`visual/report/regression.md` listed all 60 screens as `ok | 0`, because it was
written immediately after an approve, when captures and goldens are identical by
definition, and never regenerated as the tree moved. A verify run against the
committed captures actually reported 24 ok and 36 regressed. Anyone who opened
the file instead of running the check read a clean bill of health for a harness
that was 36 screens red.

## What was deleted

| Path | What it was |
|---|---|
| `visual/` | 297 tracked files: 60 captures, 60 goldens, 20 mockups, the HTML report and its diff overlays. |
| `web/visual/` | The Playwright harness: capture-mockups, capture-web, build-report, baseline (verify and approve), the emulator seed, the `functions-emu` shim, and the CDP probes. |
| `web/firebase.dev.json` | Dev-only hosting-emulator config whose only purpose was serving the wasm dist to the harness with a widened CSP. Its `functions.source` pointed into `web/visual/`. |
| `web/composeApp/src/jvmTest/.../visual/` | `DesktopScreenshotTest` and its `DemoFixtures`. |
| `android/.../visual/AndroidScreenshotTest.kt` | The Roborazzi captures. |
| roborazzi | Dependency, version-catalog entries, and the `roborazzi.test.record` gradle wiring. Nothing else on either side used it. |

`AndroidDemoFixtures` survived the sweep. Three KinTale report suites build
their world from it, so it moved to
`android/app/src/test/java/com/tribetails/auntieos/testfixtures/`. It is
ordinary test data now, not harness scaffolding.

## What this fixes beyond the mocks

`:composeApp:jvmTest` used to rewrite tracked PNGs under `visual/desktop/`
unconditionally, as an ordinary member of the suite. Running the routine web
gate dragged 20 unexplained image changes into any `git add -A`, and the README
and the CI workflow both carried warnings about it. That side effect left with
the test.

## If visual regression comes back

Do not restore this. Build it against `src/`, the React admin, which is the app
that actually ships, and point the comparison target at `page-specs/` and
`ui-ideas/`. `auntieos-admin/e2e/` already drives the real React admin under
Playwright with a Firebase emulator and a seeded admin, so that is where a
screenshot assertion belongs. Pin the non-deterministic parts first: the sign-in
orbs drift and most list screens render relative timestamps. Capturing before
that is done produces a golden that fails on the next run for reasons nobody can
name, which is how the last one got ignored.

Design authority is `page-specs/*.md`, then `ui-ideas/` honoring the
`WrongUIDesigns-UpdateKill/` rulings. There is no third source, and `visual/` is
not coming back as one.

The original design record is preserved at
`docs/2026-05-31-visual-testing-design.md` and the last triage before retirement
at `docs/reviews/2026-07-21-golden-screenshot-triage.md`. Both are history.
Neither describes anything currently in the tree.
