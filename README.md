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

## Layout notes

Each folder keeps its own toolchain and is built independently:

- `mytribe/functions` — Node, `npm test` (vitest)
- `mytribe/web` — Vite + React, `npm test`
- `auntieos-admin` — Vite + React, `npm test`
- `auntieos-admin/web` — Gradle, `:composeApp:compileKotlinJvm`, `:composeApp:jvmTest`
- `auntieos-admin/web/functions` — Node, `npm test` (`node --test`)
- `auntieos-admin/android` — Gradle, `:app:testDebugUnitTest`

There is no root build. Run gates from the folder you changed.

## Secrets

No real credentials belong in this repo. `.env`, `serviceAccount.json`, and
`local.properties` are gitignored in every folder, and the history was scanned
before the first push. The `AIzaSy...` values that DO appear are Firebase Web
API keys, which are designed to be public: they identify the project, and
access is controlled by Firestore rules and App Check, not by hiding them.
