# Development

Day-to-day commands, the repo map, and the rules for making a change. None of this is needed to run a release.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Everything you run

From the repo root. Each fans out to the project that owns it.

| Command | Does |
|---|---|
| `npm run dev:admin` | Operator admin, `:5174` |
| `npm run dev:portal` | Kinfolk portal, `:5173` |
| `npm test` | Every JS suite (functions, geo, admin, portal) |
| `npm run test:android` | Gradle unit tests for the operator app (`auntieos-admin/android`) only. The portal Android and desktop tests have no root script; run `./gradlew` in `mytribe/` or `auntieos-admin/web/` |
| `npm run test:rules` | Firestore rules, against the emulator |
| `npm run test:scripts:emulator` | Every backfill's `*.emulator.test.ts`, against the emulator. **Run it before any backfill's prod write.** |
| `npm run typecheck` | All four projects |
| `npm run build` | Functions, admin, portal. `packages/geo` has no build step: both apps consume its TypeScript source directly. |
| `npm run build:android` | `compileDebugKotlin` |
| `npm run lint` | Functions eslint |
| `npm run contracts:generate` | Rewrite the generated Contracts module from the server zod schemas |
| `npm run contracts:check` | Regenerate into memory and fail on any diff. Part of `check`. |
| `npm run seeds:generate` | Bundle `mytribe/seeds/notificationTemplates/` into the module the deployed functions read |
| `npm run seeds:check` | Regenerate that bundle into memory and fail on any diff. Part of `check`. |
| `npm run e2e` | Playwright against the emulator. **Not part of `check`** |
| `npm run e2e:cy` | Both Cypress suites against the emulators (`e2e:cy:admin`, `e2e:cy:portal` for one). See `auntieos-admin/docs/runbooks/e2e.md` |
| `npm run check` | typecheck, lint, contracts, seeds, test, build. Not e2e; release step 0b covers that by asking CI. |
| `npm run setup` | One-time machine setup: hooks, Android SDK path, every install (`scripts/bootstrap.sh`) |
| `npm run preflight` | Reports what a release needs that setup does not provide, with the fix for each |
| `npm run dev:record:admin` / `dev:record:portal` | Dev server with the issue recorder on. See `packages/issue-recorder/README.md` |
| `npm run deploy` | The production run. See [Deploying](#deploying). |
| `npm run deploy:bg` | The same run, detached, logged, one command. Use this one. |

Suffix any of `test`, `typecheck`, `build` with `:functions`, `:admin` or
`:portal` to run one project.

**Before a backfill writes to prod, run `npm run test:scripts:emulator` and
read the pass count.** A dry run only reads, so it cannot catch a write that
Firestore rejects. The emulator test runs the real write path.

All suites pass on `main`. The counts move every day, so `npm test` is the
authority rather than a number written here; as of 2026-08-04 the functions
suite was 229 files / 2937 tests. (This paragraph read "196 files / 2053 tests"
until then, which is the failure mode of writing a moving number down once.)
A red test is a real regression, not something you inherited.

**Known debt:** functions eslint reports ~750 warnings and 0 errors. The warnings
are almost entirely `no-explicit-any` in older files. They should be burned down
rather than lived with.

## The map

| Path | What | Ships to |
|---|---|---|
| `mytribe/functions` | The backend. Every callable. | Firebase codebase `mytribe` |
| `mytribe/web` | Kinfolk portal web app | `kinfolk.tribetails.com` |
| `mytribe/src` (android target) | Kinfolk portal Android app, `com.kinfolk.portal` | App Distribution |
| `auntieos-admin/src` | Operator admin | `auntie.tribetails.com` |
| `auntieos-admin/android` | Operator Android app, `com.tribetails.auntieos` | App Distribution |
| `auntieos-admin/web/functions` | AuntieOS-owned functions | Firebase codebase `default` |
| `auntieos-admin/web/functions-python` | Dossier and 411 reconcile pipeline | Firebase codebase `reconcile` |

Two Android apps ship from this repo, both registered in Firebase, so "the
Android app" is never specific enough to act on. Name the package. The release
runbook, `docs/RUNBOOK.md`, is the authority on which of them a run actually builds and
distributes; `scripts/distribute-apks.sh` carries both app ids.

**Two web apps and two Android apps**, one pair per operating system, and
`npm run deploy` ships all four in one run. `mytribe/src` is easy to misread as
dead: it is a Compose Multiplatform tree whose `jvm` target is the desktop
build, and whose `android` target is a live delivery surface.

The desktop consoles, `auntieos-admin/web/composeApp` and the `jvm` target of
`mytribe/src`, get no new features: desktop parity is paused by owner ruling.
They are still kept working, because the desktop console is the fallback if a
web app breaks, so fix what breaks there and do not delete it. Run
`./gradlew :composeApp:jvmTest` in `auntieos-admin/web` locally; its CI job
(`kotlin` in `ci.yml`) runs only on a manual dispatch. The wasm admin that used
to live in `composeApp` was deleted in #481. `auntieos-admin/sotu-hosting` is
ops hosting with no Cloud Functions of its own.

All of it deploys into ONE Firebase project, `auntieos-ttpc`, which is why
deploys go through a wrapper. There is no staging project. Click-testing
happens on the local emulators (`npm run e2e:cy:open` in either app).

## Making a change

Features here are **full vertical slices**: callable + zod validation + wiring +
routes + component + error handling + tests, on the React admin (`auntieos-admin/src`)
AND the operator Android app (`auntieos-admin/android`). A missing callable means
build the callable. `auntieos-admin/CLAUDE.md` is the authority and overrides habit.

The only legitimate defer is something needing an EXTERNAL SECRET the operator
must physically provide. Stop and name the exact secret.

Branch per task, never commit on `main`, one concern per PR. A stacked PR merges
into ITS OWN BASE. Watch the failure that has already happened here: the base
branch merges to main first, your PR then merges into an already-merged branch,
GitHub says MERGED, and your code is not on main. Check it:

```bash
git merge-base --is-ancestor <sha> origin/main
```

### The contract freeze

Two regimes run side by side, and which one applies depends on the callable.

**Generated (ADR-0001).** The invoice family (20 callables) and the booking
family (9) each export a zod `Result` beside their `Args`, validate outbound,
and are code-generated into the clients: TypeScript for both web apps, Kotlin
for the admin Android app. `npm run contracts:generate` writes them,
`npm run contracts:check` fails on any diff, and CI runs that check
(`.github/workflows/ci.yml`). For these, review discipline is not what keeps
the clients in sync; the generator is.

**Hand-mirrored (everything else).** The remaining callables are still
transcribed per client, with nothing but review discipline holding them
together. `mytribe/functions/test/callableContract.test.ts` freezes their
request field set and `mytribe/functions/CALLABLE_CONTRACT.md` is the human
source the mirrors are built from. Changing one of those shapes means doing it
in one change: the doc, the frozen set, every client mirror. A red test there is
the guard working. Closing this gap is the rest of ADR-0001.
