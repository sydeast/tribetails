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
| `android/` | The operator Android app (`com.tribetails.auntieos`). A permanent surface, not a port target. Not the only Android app in the repo; see below. |
| `web/composeApp/` | Kotlin Multiplatform: shared logic plus the desktop (jvm) app. Its wasm admin was superseded by `src/` and deleted in #481. |
| `web/functions/` | AuntieOS-owned Cloud Functions (Node). Firebase codebase `default`. |
| `web/functions-python/` | The dossier and 411 reconcile pipeline. Firebase codebase `reconcile`. |
| `docs/` | Specs, runbooks, reviews, punch lists, and the backlog. |
| `scripts/` | Build and ops helpers. `loud-build.sh` is the one to use for anything slow. |
| `twilio-service/` | Telephony (canonical — see [`docs/twilio/README.md`](../docs/twilio/README.md) at repo root for setup/env vars/known issues). `twilio-functions/` was the pre-migration copy; archived under `archive/twilio-functions-deprecated/`. |
| `sotu-hosting/` | SOTU hosting and Firebase ops scripts. Not the product web app. |

MyTribe, the Kinfolk portal, is a sibling prefix in this monorepo under
`mytribe/`, not a separate repository. It owns `firestore.rules` (this tree
carries a mirror, guarded by a functions test and the root pre-commit hook) and
most of the callables this admin invokes. It also ships its own Android app,
`com.kinfolk.portal`, built from the Compose `mytribe/src/` tree. So the repo
has two Android apps, and `android/` here is only the operator one.

## Running it

Install from the repo root (`npm run setup` once, or `npm ci` at the root).
Running `npm install` or `npm ci` in this directory is refused by its
`preinstall` guard, because this is a workspace member with no lockfile of its
own.

```
npm run dev            # the React admin, port 5174
npm test               # vitest
npm run typecheck      # app and service-worker tsconfigs
npm run build          # production bundle
```

```
cd web/functions && npm test                # the Node functions
cd web && ./gradlew :composeApp:jvmTest     # shared + desktop Kotlin
cd android && ./gradlew :app:testDebugUnitTest
```

One trap worth knowing before running those.

Do not pipe gradle to `tail`. It masks the exit code, and a failing build then
reports success. `scripts/loud-build.sh` preserves the code and prints a
heartbeat.

## The brand-voice corpus, and the copy nobody sees

`generateAuntieCopy` reads the voice corpus from `web/functions/voice/`, which is
a COPY. The source of truth is `voice/` at the admin root. Both are gitignored
(anchored `/voice/` and `web/functions/voice/`), so the corpus lives on the
operator's machine and never ships in a pull request.

Edit `voice/`, then push the copy the function actually reads:

```
cd web/functions && npm run sync:voice
```

Nothing enforces this. The two trees drifted for four days once, and the
deployed function kept generating against the older rules with no warning: the
Voice Bible pairing note, the no-formula-openers guidance and the
gracious-formal demotion were all live in `voice/` and absent from what the
model saw. Run the sync after every corpus edit, and again before deploying the
function.

Channel and length rules belong in `voice/02_Channel_Playbook.md` §2. The
per-type lines in `SYSTEM_FRAMING` (`web/functions/generate.js`) must agree with
that table; when they disagree, the table is right and the prompt is the bug.

## Deploying, and why the site names read backwards

The admin ships as step 6 of the production release (`npm run deploy:bg` from
the repo root, see `docs/RUNBOOK.md`). For a single target, deploy by TARGET,
never by site id, and always through the wrapper (run from the repo root):

```
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:app    # the React admin (auntie.tribetails.com)
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:sotu   # the SOTU status page
```

The targets exist because the Firebase site ids do not mean what they say. All
five sites live on one project, `auntieos-ttpc`:

| Site id | Target | Actually serves |
|---|---|---|
| `auntieos` | `sotu` | the SOTU status page, NOT this app |
| `auntieos-ttpc` | `app` | the AuntieOS admin, this app |
| `auntieos-admin` | `legacy-wasm` | nothing current. It served the wasm build deleted in #481; nothing builds it, so do not deploy it |
| `kinfolk-portal` | `kinfolk_portal` | MyTribe |
| `mytribe-kinfolk-beta` | `mytribe_beta` | a second MyTribe site for beta builds. Same project and same production backend, so not a staging environment |

So `auntieos` is not AuntieOS and `auntieos-admin` is not the admin. Firebase
Hosting site ids cannot be renamed: fixing the names for real means creating new
sites, deleting the old ones (deleted ids are reserved for a while, so it can
simply be refused), and re-pointing `auntie.tribetails.com`, which is DNS plus
SSL re-provisioning with a downtime window. Targets buy the readable names for
none of that risk.

Deploy commands and CI both use targets, so nobody has to hold the mapping in
their head. If you find yourself typing a raw site id, that is the bug.

### Deploying the AuntieOS functions

Every production deploy goes through `scripts/safe-deploy.sh`, functions
included. It pins the project, refuses a bare deploy, and refuses a rules push
from this tree, so going around it is how live security rules get overwritten
by a stale copy.

```
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only functions:default:generateAuntieCopy
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only functions:reconcile:nightly_reconcile
```

`default` is `web/functions` (Node), `reconcile` is `web/functions-python`.
Name the function; `--only functions:default` alone pushes all nine, and a bare
`--only functions` is refused because it would ship both codebases at once.

`DRY_RUN=1` in front prints the command instead of running it. Use it whenever
you are unsure.

Worth knowing, because it caused a real bypass: `auntieos-admin` is TWO
`firebase.json` files. This directory's declares hosting; `web/firebase.json`
declares the functions codebases. The wrapper handles that split for you and
runs a functions deploy from `web/`. For the same reason it refuses one command
that mixes functions with hosting: those are two trees, so run two deploys.

Two things that will stop a functions deploy on a fresh checkout:

- The Firebase CLI analyzes the codebase locally before uploading, so
  `web/functions/node_modules` must exist. `npm run setup` at the repo root
  installs it and checks it against its lockfile; `npm ci` in `web/functions`
  does it by hand.
- If npm fails with `EACCES` renaming inside `~/.npm/_cacache`, the cache has
  root-owned entries from an earlier `sudo npm`. Pass `--cache` a writable
  directory rather than fixing it destructively. Some transitive postinstall
  scripts also hang here; `--ignore-scripts` is safe for a deploy-analysis
  install.

`generateAuntieCopy` in particular must be deployed before the Communicate
composer's Push format works. An un-deployed function returns 400 for `push`
while the other six formats keep working, so it fails loud rather than quietly.

## Visual regression

There is none, by operator ruling of 2026-08-18. The screenshot goldens, the
harness that captured them and the CI gate that compared them were all removed:
the comparisons were not trustworthy enough to block a pull request on. What
checks appearance now is the real-browser e2e suite (`npm run e2e`) and review.
Nothing in this repo records or compares screenshots.

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
