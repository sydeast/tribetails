# AuntieOS

The operator side of Tribe Tails Pet Care. Auntie runs the business from here:
the Den dashboard, the Directory of Kinfolk and their Kin, Auntie Time (the
sitter workflow), KinTales, invoices, and the comms surfaces.

Merged 2026-07-21 from two repositories that had to be edited together anyway.
The React admin and the Kotlin tree share a Firestore project, a rules file, and
a callable contract, and a large share of the functions this app depends on live
in MyTribe next door. Keeping them in separate directories meant a change to one
could not see the other.

## What is in here

| Path | What it is |
|---|---|
| `src/` | **The React admin.** The live web surface at auntie.tribetails.com. |
| `android/` | The Android app. A permanent surface, not a port target. |
| `web/composeApp/` | Kotlin Multiplatform: shared logic plus the desktop (jvm) app. The wasm admin it also builds is superseded by `src/`. |
| `web/functions/` | AuntieOS-owned Cloud Functions (Node). Firebase codebase `default`. |
| `web/functions-python/` | The dossier and 411 reconcile pipeline. Firebase codebase `reconcile`. |
| `visual/` | Golden screenshots for web, desktop and android, plus the comparison harness. |
| `docs/` | Specs, runbooks, reviews, punch lists, and the backlog. |
| `scripts/` | Build and ops helpers. `loud-build.sh` is the one to use for anything slow. |
| `twilio-service/`, `twilio-functions/` | Telephony. |
| `sotu-hosting/` | SOTU hosting and Firebase ops scripts. Not the product web app. |

MyTribe, the Kinfolk portal, is a separate repository beside this one. It owns
`firestore.rules` (this tree carries a mirror the pre-commit hook checks) and
most of the callables this admin invokes.

## Running it

```
npm install
npm run dev            # the React admin, port 5174
npm test               # vitest
npx tsc --noEmit       # typecheck
npm run build          # production bundle
```

```
cd web/functions && npm test                # the Node functions
cd web && ./gradlew :composeApp:jvmTest     # shared + desktop Kotlin
cd android && ./gradlew :app:testDebugUnitTest
```

Two traps worth knowing before running those.

`:composeApp:jvmTest` rewrites tracked golden PNGs under `visual/desktop/`, so
they follow you into a `git add -A`. The android suite no longer does this: its
record mode reads a gradle property and defaults to off. Pass
`-Proborazzi.record` when you actually mean to capture.

Do not pipe gradle to `tail`. It masks the exit code, and a failing build then
reports success. `scripts/loud-build.sh` preserves the code and prints a
heartbeat.

## Deploying, and why the site names read backwards

Deploy by TARGET, never by site id:

```
firebase deploy --only hosting:app          # the React admin (auntie.tribetails.com)
firebase deploy --only hosting:sotu         # the SOTU status page
firebase deploy --only hosting:legacy-wasm  # the superseded wasm build
firebase deploy --only functions:default:<name>
```

The targets exist because the Firebase site ids do not mean what they say. All
four sites live on one project, `auntieos-ttpc`:

| Site id | Actually serves |
|---|---|
| `auntieos` | the SOTU status page, NOT this app |
| `auntieos-ttpc` | the AuntieOS admin, this app |
| `auntieos-admin` | the superseded wasm build, NOT this app |
| `kinfolk-portal` | MyTribe |

So `auntieos` is not AuntieOS and `auntieos-admin` is not the admin. Firebase
Hosting site ids cannot be renamed: fixing the names for real means creating new
sites, deleting the old ones (deleted ids are reserved for a while, so it can
simply be refused), and re-pointing `auntie.tribetails.com`, which is DNS plus
SSL re-provisioning with a downtime window. Targets buy the readable names for
none of that risk.

Deploy commands and CI both use targets, so nobody has to hold the mapping in
their head. If you find yourself typing a raw site id, that is the bug.

## Visual regression

```
cd web/visual
node baseline.mjs            # verify, exits non-zero on regression
node baseline.mjs update     # approve current captures as the new goldens
```

`update` has no per-screen mode; it promotes a whole surface at once. Read
`docs/runbooks/visual-regression.md` before approving anything.

## Conventions that are not obvious

Kin is a pet. Kinfolk is a client or household. Tribe means the client, never
the household. Auntie is the caregiver. These are not stylistic preferences; the
voice depends on them and review enforces them.

No em dashes in user-facing copy.

Errors belong on a persistent surface (`Banner`, `AsyncRegion`), never a toast.
`ToastTone` has no error member, so the type enforces it rather than reviewer
memory.

Firestore drops documents missing an `orderBy` field. That has silently hidden
live data three times here. Order by something every writer stamps, and record
in a comment why you picked it.

Never write a document with a bare `.set()` on an update path. Use
`SetOptions.merge()` or a field-level update, or you delete every field the
backend writes that the local model does not declare.

The pre-commit hook scans staged content for credentials, checks the
`firestore.rules` mirror against MyTribe, and runs the functions tests when that
code is touched. Enable it once per clone:

```
git config core.hooksPath .githooks
```
