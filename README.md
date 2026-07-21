# Tribe Tails

Monorepo for the Tribe Tails pet-care system. Three codebases that ship as one
product, kept in one repo so a change that spans them lands as one commit.

| Folder | What it is |
|---|---|
| `mytribe/` | Cloud Functions (the real backend, all callables) + the kinfolk portal React app at `kinfolk.tribetails.com` |
| `auntieos/` | The operator app: Compose Multiplatform web (Wasm) + desktop (JVM) in `web/`, native Android in `android/` |
| `auntieos-admin/` | React admin surface at `auntieos-admin.web.app` |

All three deploy into a single Firebase project, `auntieos-ttpc`.

## Why one repo

Features here are vertical slices. A single change routinely touches a callable
in `mytribe/`, a model in `auntieos-admin/web/`, and a screen in
`auntieos-admin/src/`, and those pieces are only correct together. Separate
repos made that several commits that could drift out of sync; one repo makes it
one commit that either lands whole or not at all.
The two also share `firestore.rules` on one Firebase project, so a deploy from
either could overwrite the other's. `mytribe/firestore.rules` is the source of
truth and `auntieos-admin/web/firestore.rules` is a mirror, with a test and a
pre-commit hook guarding the drift.

History from all three original repos is preserved, grafted in via
`git subtree`, so `git log` reaches back through the full history of each.

## Deploying

Both trees deploy into the one project `auntieos-ttpc`, so a careless deploy
from the wrong tree can clobber the other's live config. Production deploys go
through `scripts/safe-deploy.sh`. It pins `--project auntieos-ttpc`, refuses a
bare `firebase deploy` (which would ship hosting, every functions codebase,
rules and indexes at once), and refuses to push `firestore.rules` from anywhere
but `mytribe`, and only when its mirror in `auntieos-admin/web/firestore.rules`
is byte-identical. Every refusal says, in red, what it stopped and why.

    scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets>

The three you actually run:

    # live React admin at auntie.tribetails.com
    scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:app

    # the callables
    scripts/safe-deploy.sh mytribe -- firebase deploy --only functions:mytribe

    # firestore indexes (rules change the same way, from mytribe only)
    scripts/safe-deploy.sh mytribe -- firebase deploy --only firestore:indexes

Set `DRY_RUN=1` to print the firebase command the wrapper would run instead of
running it.

## Layout notes

Each folder keeps its own toolchain and is built independently:

- `mytribe/functions`: Node, `npm test` (vitest)
- `mytribe/web`: Vite + React, `npm test`
- `auntieos-admin`: Vite + React, `npm test`
- `auntieos-admin/web`: Gradle, `:composeApp:compileKotlinJvm`, `:composeApp:jvmTest`
- `auntieos-admin/web/functions`: Node, `npm test` (`node --test`)
- `auntieos-admin/android`: Gradle, `:app:testDebugUnitTest`

There is no root build. Run gates from the folder you changed.

## Secrets

No real credentials belong in this repo. `.env`, `serviceAccount.json`, and
`local.properties` are gitignored in every folder, and the history was scanned
before the first push. The `AIzaSy...` values that DO appear are Firebase Web
API keys, which are designed to be public: they identify the project, and
access is controlled by Firestore rules and App Check, not by hiding them.
