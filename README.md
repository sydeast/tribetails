# Tribe Tails

Monorepo for the Tribe Tails pet-care system. Two products, the operator admin
and the kinfolk portal, over one backend, kept in one repo so a change that
spans them lands as one commit.

| Folder | What it is |
|---|---|
| `mytribe/functions` | Cloud Functions. The real backend: about 230 callables plus triggers and scheduled jobs |
| `mytribe/web` | The kinfolk portal React app at `kinfolk.tribetails.com` |
| `mytribe/src` | The kinfolk portal Android app (Compose, `com.kinfolk.portal`). Live, not a leftover |
| `auntieos-admin/src` | The live operator admin at `auntie.tribetails.com` |
| `auntieos-admin/android` | The operator Android app (`com.tribetails.auntieos`) |
| `auntieos-admin/web` | AuntieOS-owned functions (`default` and `reconcile` codebases), plus the Compose desktop (JVM) console. Desktop gets no new features, but it is kept working as the fallback if the web admin breaks. The wasm build was deleted in #481 |

Two Android apps ship from here, so "the Android app" is never specific enough
to act on. Name the package.

All of it deploys into a single Firebase project, `auntieos-ttpc`. There is no
staging project. Click-testing happens on the local emulators.

`docs/RUNBOOK.md` is the standing operational doc: setup, scripts, builds,
deploys, secrets and troubleshooting.

## Why one repo

Features here are vertical slices. A single change routinely touches a callable
in `mytribe/functions/`, a generated contract on both web clients, and a screen
in `auntieos-admin/src/` and `auntieos-admin/android/`, and those pieces are
only correct together. Separate repos made that several commits that could
drift out of sync; one repo makes it one commit that either lands whole or not
at all.
The two also share `firestore.rules` on one Firebase project, so a deploy from
either could overwrite the other's. `mytribe/firestore.rules` is the source of
truth and `auntieos-admin/web/firestore.rules` is a mirror, with a test and a
pre-commit hook guarding the drift.

History from all three original repos is grafted in via `git subtree`, but
each of those repos starts at an initial commit dated 2026-07-16. Most of the
code predates that, so `git log` does not show when older code was written or
prove that something never existed.

## Deploying

The production release is one command:

    npm run deploy:bg     # detached, logged, survives the terminal closing
    npm run deploy        # foreground, when you want to answer the prompts

A full release, the normal case, also ships the AuntieOS function codebases
and skips the pre-deploy revision prune:

    RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 RELEASE_PREDEPLOY_KEEP=0 npm run deploy:bg

Run it from the repo root, and never pipe it through `tail` or anything else.

`scripts/release.sh` runs the whole ordered procedure: preconditions, CI
verdict, dependency drift, secret and client-config checks, `npm run check`,
the Android build, indexes, index wait, rules, functions, both hosting targets,
the APK upload, a verify step that fetches the live bundles and proves they
changed, the Cloud Run revision prune, the release tag and the merged-branch
prune. Order is the point. Indexes go before the code that queries them and
functions before the clients that call them, because both failures land at
runtime rather than at build.

Merging to `main` does not release anything. `.github/workflows/main-channel.yml`
publishes main's HEAD to one fixed Firebase Hosting preview channel per web
app, so main's UI can be walked before a release. Functions, Firestore and Auth
behind those URLs are production, so do not submit forms there.

Do not rebuild that sequence by hand. A menu of deploy commands is what this
repo had before, and on 2026-07-26 the live admin sat 33 hours and ~19 merged
PRs behind `main` because a green `npm run build` was read as a shipped one.
Build writes `dist/` on your disk and uploads nothing.

`docs/RUNBOOK.md` has the step table, the environment overrides
(`RELEASE_SKIP_ANDROID`, `RELEASE_ANDROID_GROUPS`, and the rest), and what to do
when a step fails.

Two things a release needs that `npm run setup` does not provide. Run
`bash scripts/preflight.sh` first; it reports both, with the command that fixes
each.

- **`RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` also ships the `reconcile` Python
  codebase**, which needs `python3.13` and a venv at
  `auntieos-admin/web/functions-python/venv`. Nothing creates that venv. The
  Firebase CLI runs the code to discover its endpoints, so without it a deploy
  cannot even list what it would ship.
- **An install can drift from its lockfile**, and nothing about a clean tree or
  green CI says otherwise: CI installs from scratch every run, so only a
  long-lived checkout drifts.

Underneath, every deploy goes through `scripts/safe-deploy.sh`. It pins
`--project auntieos-ttpc`, refuses a bare `firebase deploy` (which would ship
hosting, every functions codebase, rules and indexes at once), and refuses to
push `firestore.rules` from anywhere but `mytribe`, and only when its mirror in
`auntieos-admin/web/firestore.rules` is byte-identical. Every refusal says, in
red, what it stopped and why. Call it directly only when you genuinely want one
target and not a release:

    scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets>

Set `DRY_RUN=1` to print the firebase command the wrapper would run instead of
running it.

## Layout notes

`mytribe/web`, `auntieos-admin`, and `packages/*` are real npm workspaces: one
install, one root `package-lock.json`. That's how `packages/geo` (route
geometry) reaches both web apps' module graphs.

`mytribe/functions` and `auntieos-admin/web/functions` are deliberately NOT
workspace members. Cloud Functions deploy as self-contained artifacts with
their own `package.json` and lockfile; hoisting their deps into the root tree
would ship a broken deploy. Each keeps its own toolchain, lockfile and
install, built independently of everything else here.

    npm run setup       one-time: hooks, Android SDK path, all installs
    npm test            every JS suite
    npm run check       typecheck, lint, contracts, seeds, test, build

Suffix `test`, `typecheck` or `build` with `:functions`, `:admin` or `:portal`
to run one project (`packages/geo` has `test:geo` and `typecheck:geo` only). `docs/RUNBOOK.md` has the full table.

## Secrets

No real credentials belong in this repo. `.env`, `serviceAccount.json`, and
`local.properties` are gitignored in every folder, and the history was scanned
before the first push. The `AIzaSy...` values that DO appear are Firebase Web
API keys, which are designed to be public: they identify the project, and
access is controlled by Firestore rules and App Check, not by hiding them.
