# Apps runbook

`README.md` says what the repo is. This says what you do with it.

Every command here was run against the repo on 2026-07-26.

---

## Setup

### What the machine needs first

```bash
bash scripts/preflight.sh
```

Changes nothing. Reports every tool, and for each missing one prints the install
command for your platform. Run it before anything else; `npm run setup` runs it
too and refuses to start if anything required is absent.

| Tool | Needed for | Install (macOS) |
|---|---|---|
| **git** | everything | `xcode-select --install` |
| **Node 22** | every JS project. 22 is the deployed functions runtime, pinned in `.nvmrc` | `nvm install 22 && nvm use` |
| **npm** | dependencies | ships with Node |
| **JDK 17+** | Firebase emulators (`test:rules`, `e2e`) and Gradle | `brew install --cask temurin@21` |
| **firebase-tools** | emulators and every deploy | `npm install -g firebase-tools` |
| Android SDK | Android builds only | Android Studio, or set `ANDROID_HOME` |
| gh | PRs from the terminal | `brew install gh` |

Two of these fail in ways that do not name themselves, which is why preflight
checks them by RUNNING them rather than by looking for the binary:

- **No JDK** produces `Could not start Firestore Emulator`, which mentions
  neither Java nor the fix. macOS makes this worse by shipping a `/usr/bin/java`
  stub that exists on a machine with no JDK and only fails when executed.
- **firebase-tools missing** fails inside an npm script, so the error names the
  script rather than the missing tool.

### Then

```bash
npm run setup
```

Idempotent, safe to re-run. Runs preflight, points git at `.githooks`, writes
`auntieos-admin/android/local.properties` if absent (never overwriting an
existing one, which also holds signing keys), installs all three JS projects one
at a time, and then **proves it worked** by typechecking. If any step fails it
says which step, rather than exiting quietly.

Optional, for Sentry and an App Check debug token. Both apps run fine without
them:

```bash
cp auntieos-admin/.env.example auntieos-admin/.env
cp mytribe/web/.env.example mytribe/web/.env.local
```

Playwright needs its browser once, before `npm run e2e`:

```bash
npm --prefix auntieos-admin run e2e:install
```

---

## Everything you run

From the repo root. Each fans out to the project that owns it.

| Command | Does |
|---|---|
| `npm run dev:admin` | Operator admin, `:5174` |
| `npm run dev:portal` | Kinfolk portal, `:5173` |
| `npm test` | Every JS suite (functions, admin, portal) |
| `npm run test:android` | Gradle unit tests |
| `npm run test:rules` | Firestore rules, against the emulator |
| `npm run typecheck` | All three projects |
| `npm run build` | All three projects |
| `npm run build:android` | `compileDebugKotlin` |
| `npm run lint` | Functions eslint |
| `npm run contracts:generate` | Rewrite the generated Contracts module from the server zod schemas |
| `npm run contracts:check` | Regenerate into memory and fail on any diff. Part of `check`. |
| `npm run e2e` | Playwright against the emulator. **Not part of `check`** |
| `npm run check` | typecheck, lint, contracts, test, build. Not e2e; release step 0b covers that by asking CI. |
| `npm run deploy` | The production run. See [Deploying](#deploying). |

Suffix any of `test`, `typecheck`, `build` with `:functions`, `:admin` or
`:portal` to run one project.

All suites pass on `main`: 196 files / 2053 tests (functions), 210 / 3542
(admin), 29 / 348 (portal), 1739 Android. A red test is a real regression, not
something you inherited.

**Known debt:** functions eslint reports ~750 warnings and 0 errors. The warnings
are almost entirely `no-explicit-any` in older files. They should be burned down
rather than lived with.

---

## The map

| Path | What | Ships to |
|---|---|---|
| `mytribe/functions` | The backend. Every callable. | Firebase codebase `mytribe` |
| `mytribe/web` | Kinfolk portal | `kinfolk.tribetails.com` |
| `auntieos-admin/src` | Operator admin | `auntie.tribetails.com` |
| `auntieos-admin/android` | Operator Android app | APK |
| `auntieos-admin/web/functions` | AuntieOS-owned functions | Firebase codebase `default` |

Not delivery targets, do not add features: `auntieos-admin/web/composeApp` (wasm
admin superseded by `auntieos-admin/src`, desktop build paused by owner ruling)
and `auntieos-admin/sotu-hosting` (ops hosting).

All of it deploys into ONE Firebase project, `auntieos-ttpc`, which is why
deploys go through a wrapper.

---

## Making a change

Features here are **full vertical slices**: callable + zod validation + wiring +
routes + component + error handling + tests, on the admin AND Android. A missing
callable means build the callable. `auntieos-admin/CLAUDE.md` is the authority
and overrides habit.

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

Three surfaces hand-mirror the callable request shapes: admin, Android, and
sometimes the portal. Nothing but review discipline keeps them in sync, so
`mytribe/functions/test/callableContract.test.ts` freezes the field set of every
cross-app callable, and `mytribe/functions/CALLABLE_CONTRACT.md` is the human
source the mirrors are built from.

Changing a shape means doing all three in one change: the doc, the frozen set,
every client mirror. A red test there is the guard working.

---

## Deploying

**`npm run build` does not deploy.** It writes `dist/` on your disk and uploads
nothing. This is the mistake that has actually been made here: on 2026-07-26 the
live admin was 33 hours and ~19 merged PRs behind `main` because a green build
was read as a shipped one.

### The production run

```bash
npm run deploy
```

That is the whole release. `scripts/release.sh` runs the steps below **in this
order**, stops at the first failure, and names the step it died in.

| # | Step | Why here |
|---|---|---|
| 0 | Preconditions | Clean tree, on `main`, synced with origin. Shipping uncommitted or stale code is the classic incident. Falls back to `gh` if the SSH agent is down, since it must verify the fact, not one transport. |
| 0b | CI verdict for HEAD | Asks GitHub whether every check is green for this exact commit, **e2e included**. `npm run check` does not run e2e, so until this existed a red e2e could not stop a release. See below. |
| 1 | `npm run check` | Typecheck, lint, test, build. Not optional theatre: this is what produces the `dist/` that step 6 uploads. |
| 1b | Secret preflight | Every secret the code DECLARES must exist. Firebase validates these before uploading, and one missing name fails the whole codebase. Refuses here, before any deploy. |
| 1c | Android build | Assembles the signed release APK. Runs before the first deploy so a build failure costs nothing; the upload is step 6b. |
| 2 | Firestore indexes | Before the code that queries them. A query with no index fails at RUNTIME, not at build. |
| 3 | Wait for indexes | The CLI returns when Firestore ACCEPTS an index, not when it is Enabled. The run blocks; the CLI will not. |
| 4 | Firestore rules | From `mytribe` only. Refused outright if the admin mirror has drifted. |
| 5 | Functions | Before the clients that call them. **Skipped when `mytribe/functions` is unchanged since the last release AND no declared secret is newer than it**. Otherwise deployed **by name, in batches of 25, with retries**, because the whole fleet does not fit the regional CPU quota. See below. |
| 6 | Hosting | Admin, then portal. |
| 6b | Android | Uploads the APK from step 1c to App Distribution, in the same run as the web. |
| 7 | Verify | Fetches both live sites and compares the hashed bundle they reference against the one just built. |
| 8 | Prune revisions | Deletes old Cloud Run revisions, keeping the newest 3 per service and every serving one. Runs after verification, because those revisions are rollback targets. Was 10, which floored the sweep above every inventory level that has ever caused trouble; see below. |
| 9 | Tag the release | Annotates `release/YYYY.MM.DD-<sha>`, naming what actually shipped, and pushes just that tag to origin. Runs after step 7, so nothing gets tagged unless it was verified live. |

**Why step 5 is conditional.** Redeploying the codebase mints a new Cloud Run
revision for every one of its ~200 functions even when nothing changed, and a
bulk functions deploy is the step most likely to fail: it is where the CPU
quota bites, and a failure there blocks the release before it ever reaches
hosting. That happened on 2026-07-27. Skipping the step when the code is
identical removes that risk for free rather than re-rolling the dice. The
last released commit is recorded in `.release-state` (gitignored, per machine);
if nothing under `mytribe/functions` changed since then, the step is skipped and
says so. Anything unknown deploys, because the safe default when you cannot
prove code is current is to ship it.

**And why it is not conditional on the code alone.** A changed secret is a
changed deploy that changes no file, so the git diff above cannot see it. Setting
a secret mints a Secret Manager version and binds it to nothing; a gcfv2 function
keeps the version it was deployed with. Left there, the skip turned "set the
secret, then release" into a loop that never binds anything and reports success
every time. That is the Google Calendar report: both OAuth secrets set several
times, the feature still rejecting with `google_oauth_not_configured`. So when
the code is unchanged, step 5 asks whether any declared secret has an enabled
version created after the last released commit, and deploys if one does, naming
the secrets. If it cannot ask (functions not built, gcloud not signed in) it says
so and still skips, because an unknown must not turn every run into a
~200-function deploy; `RELEASE_FORCE_FUNCTIONS=1` is the override, and the
warning names it.

**Why step 5 deploys by name in batches.** `--only functions:mytribe` hands the
CLI all ~227 functions at once. Each is its own Cloud Run service at 1 vCPU, a
deploy starts a new revision beside the serving one, and
`CpuAllocPerProjectRegion` in `us-central1` is 200 vCPU. The fleet does not fit
and cannot be made to fit. On 2026-08-01 five full deploys each died partway:

| attempt | succeeded | failed |
|---|---|---|
| forced (`RELEASE_FORCE_FUNCTIONS=1`) | 197 | 26 |
| stray (wrong cwd, functions package script) | 131 | 95 |
| release retry | 197 | 30 |
| release with `RELEASE_PREDEPLOY_KEEP=2` | 201 | 26 |
| targeted redeploy of just those 26 | 0 | 26 |

Look at where the successes stop: 197, 201, 197, against a quota of 200. That is
the ceiling printing itself. Revisions went 702 → 926 → 1250 across the day
because every attempt mints ~227 more, and pruning back to 487 did **not** make
the next full deploy fit, which is what proves this is a ceiling and not a
timing problem.

Every recovery that day worked the same way: name the casualties, redeploy them
as a small batch through `safe-deploy.sh`. The release now does that by design.

- **Batches of 25.** Set from what has landed, not from a model: hand recoveries
  used 20 and 26 and they worked, and the wall is at ~200. 25 leaves roughly 8x
  headroom, so two or three batches can still be settling and fit.
- **30 seconds between batches.** The one batch that failed outright (26 by
  name, 0 landed) went out immediately after a full deploy abandoned ~200
  starting revisions. Cloud Run releases the allocation as revisions settle.
- **Retries, not a dead release.** A quota refusal is expected, not fatal. The
  run reads firebase's own per-function result lines, retries only the names it
  did **not** see confirmed, halves the batch size each round (floor 5) and
  prunes in between. Three rounds by default. If the format of those lines ever
  changes, nothing is parsed, the whole batch counts as failed, and it retries
  too much rather than too little.
- **Then it gives up loudly.** After the last round the release **refuses**,
  names every stale function and prints the exact retry command. It refuses
  rather than continuing because step 5 sits before hosting precisely so the
  clients never ship ahead of the backend.

**Only what changed.** A one-function change has no business redeploying 227
services. `.release-state` names the last released commit, so `git diff
--name-status` names the changed files and `scripts/function-targets.js` maps
those to functions:

```bash
node scripts/function-targets.js                    # every deployable name
node scripts/function-targets.js --changed-from F --base SHA
node scripts/function-targets.js --from-services F  # lowercase service -> export
```

The names come from `mytribe/functions/lib/index.js`, the artifact the Firebase
CLI itself loads, taking every export that carries an `__endpoint`, the same
reason `declared-secrets.js` reads the build rather than the source. It resolved
227 of 227 the first time it ran and it prints that count every run, so the claim
stays checkable. Mapping a changed file to functions walks the `require()` graph
of the built `lib/`, read **statically** so lazy requires inside handler bodies
are in it. Shared code widens correctly rather than being mapped per file:
`src/lib/logger.ts` is in all 227 closures and `src/lib/auditEvents.ts` in 196.

It refuses to narrow, and falls back to the full (still batched) fleet, whenever
it cannot attribute a change: a `src/index.ts` edit (the barrel can repoint an
export at a different module while touching neither), a delete or a rename, a
`package.json` change outside its `scripts` block, a `require()` it cannot read
statically, or a source file with no built counterpart. It says which, every
time. A correct slow deploy beats a clever wrong one, and every uncertain case
resolves towards deploying *more* functions, never fewer.

Two consequences worth knowing. A secrets-only rebind now deploys just the
functions that **declare** those secrets, not the fleet. And deploying by
explicit name never **deletes** anything, where the whole-codebase deploy would
have offered to; so the run records the fleet it shipped in `.release-functions`
(gitignored, per machine, written under the same guard as `.release-state`) and
the next release names anything that has since left the code, with the
`firebase functions:delete` command. It reports; it does not delete.

`scripts/function-targets.js --from-services` is the recovery direction: Cloud
Run service names are the lowercased export names, and mapping them back by eye
against `src/index.ts` resolved 79 of 95 on 2026-08-01. Reading the same artifact
resolves all of them or refuses, because a recovery that silently drops names
leaves exactly the functions nobody redeployed.

Step 7 is the one whose absence hid the stale admin. Hosting can report a
successful release while browsers still get the old bundle. A release that
cannot prove it landed has told you nothing.

**Why step 0b asks CI instead of running e2e.** `npm run check` is typecheck,
lint, `contracts:check`, test and build. It does not run `npm run e2e` and never
did, so the Playwright suite could not block a release. That suite is the only
thing here that drives the admin in a real browser, against the real
`firestore.rules`, through the real sign-in form. On 2026-08-01 a release went
out from a commit whose `React admin e2e` job was red on `main`, and the run
said nothing.

Three ways to close that, and the other two are worse:

- **Put e2e inside `npm run check`.** `check` is also what CI runs and what
  everyone runs before pushing. e2e needs the auth and Firestore emulators on
  9399 and 8385, a downloaded Chromium and a JDK, so this makes a busy port fail
  everybody's `check`, and makes a release that cannot *start* because a dev
  emulator is holding a port. A new failure mode for the one being fixed.
- **A dedicated release step running e2e locally.** Same port exposure, narrower,
  plus 42-49s of wall clock (measured, `auntieos-admin/docs/runbooks/e2e.md`).
  The minute is affordable; the problem is that it answers a different question.
  A local pass says this machine agrees today. "CI red, local green" below says
  these disagree in practice, and CI is the authority for what is red on main.
- **Ask CI.** One HTTPS request, no emulator, no port, no browser, and it covers
  every other job for free: a red Android, portal or functions job now stops the
  release too. `gh` uses an HTTPS token, so it answers when the SSH agent is
  down, the same reason step 0 already falls back to it.

The gate refuses on any check that failed, and on any still running: shipping
against a run in flight is shipping against an unknown.

**The path filter is the subtle part.** `React admin e2e` only runs when the
paths it watches change, so on a functions-only commit GitHub reports it
`skipped`. Skipped is not a verdict, and it must not be rounded up to green.
That is the hole a red e2e survives through, needing only one more commit on top
that touches nothing the filter watches. So when HEAD has no e2e *result*, the
gate walks back up to 15 commits of first-parent history for the most recent
commit that has one, uses it, and names which commit it came from. If there is
no verdict at all within that window it says so loudly and continues, because a
repo can legitimately go that long without touching the admin.

**When the gate cannot answer** (no `gh`, not authenticated, GitHub unreachable)
it refuses, and the refusal names `RELEASE_SKIP_CI_GATE=1`, which releases
without it. An unreachable GitHub must not become an inability to ship a fix.
That override is for an unavailable gate, not for a gate that said no.

**A dry run is inert, and says so.** `DRY_RUN=1` deploys nothing, writes
nothing, and claims nothing. It does not write `.release-state`, does not delete
the built APK, does not tag, and ends under a "Dry run finished" banner listing
what it actually established rather than a "Released" one. Until 2026-08-01 it
wrote `.release-state` and signed off with "Commit `<sha>` is live and verified".
That made the *next* real release compare `mytribe/functions` against
code that had never shipped, find no diff, and skip the functions deploy. The
new admin bundle went live calling `getInvoiceLedger`, `listInvites`,
`transitionBookingStatus` and `getBusinessClosures` against a backend that had
none of them. `.release-state` is not a log; it is step 5's input.

`bash scripts/release.test.sh` covers both of those, the CI gate, and the
batching: the `firebase` stub takes a `FIREBASE_QUOTA_MAX`, refuses everything
past it exactly as the quota did, and the suite proves the release retries the
right names, survives, and refuses honestly when the quota never lifts. It runs
the real script against a throwaway repo with `gh`, `gcloud`, `firebase`, `curl`
and `npm` stubbed. 38 cases. Run it after touching `scripts/release.sh`.

Knobs, all off by default:

| Variable | Effect |
|---|---|
| `DRY_RUN=1` | Rehearse: print every firebase command, run none, write nothing, claim nothing |
| `RELEASE_SKIP_CHECK=1` | Skip step 1. Then `dist/` is whatever was last built, which may not match HEAD |
| `RELEASE_SKIP_CI_GATE=1` | Release without CI's verdict for HEAD. For when the gate is unavailable, not for when it says no |
| `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` | Also ship the AuntieOS `default` and `reconcile` codebases |
| `RELEASE_YES=1` | Do not prompt (CI). Preconditions still apply |
| `RELEASE_FORCE_FUNCTIONS=1` | Deploy functions even when unchanged |
| `RELEASE_SKIP_ANDROID=1` | Ship the web without the Android client. Off by default; shipping them together is the point of steps 1c and 6b |
| `RELEASE_ANDROID_APP_ID=…` | Override the App Distribution app id (defaults to the `com.tribetails.auntieos` app) |
| `RELEASE_ANDROID_GROUPS=a,b` | App Distribution group aliases to distribute to |
| `RELEASE_ANDROID_TESTERS=a@b,c@d` | Tester emails to distribute to. Neither this nor groups set means every tester on the project |
| `RELEASE_SKIP_SECRET_CHECK=1` | Skip step 1b |
| `RELEASE_SKIP_PRUNE=1` | Skip the step 8 retention prune. Revisions then accumulate until someone prunes by hand |
| `RELEASE_PREDEPLOY_KEEP=N` | Prune to N per service before a **large** functions deploy (default 3, `0` disables). See the quota entry below |
| `RELEASE_PREDEPLOY_MIN_TARGETS=N` | How many functions count as large (default 50). Below it the pre-deploy prune does not run |
| `RELEASE_KEEP_REVISIONS=N` | Revisions kept per service in step 8 (default 3) |
| `RELEASE_FUNCTIONS_ALL=1` | Deploy every function, not only the ones this release can reach |
| `RELEASE_FUNCTIONS_BATCH=N` | Functions per `firebase deploy` (default 25) |
| `RELEASE_FUNCTIONS_ROUNDS=N` | Retry rounds for functions that did not land (default 3) |
| `RELEASE_FUNCTIONS_SETTLE=S` | Seconds between batches (default 30) |
| `RELEASE_RETRY_KEEP=N` | Prune depth between retry rounds (default 2, `0` disables) |

### Every release is tagged

Step 9 names what just went live: an annotated tag `release/YYYY.MM.DD-<sha>`,
pushed to `origin` and nothing else. Its message lists what actually shipped
that run (hosting, functions or the reason it was skipped, Android distributed
or not), so `git show <tag>` answers "what was live" without reconstructing it
from the deploy log.

`DRY_RUN=1` skips this step too: a dry run tags and pushes nothing. A tagging
or push failure does not fail the release: by step 9 the web is already live
and verified, so the run reports the problem and leaves it for you to tag by
hand rather than call a good deploy broken.

List releases oldest-first with `git tag -l 'release/*' | sort`. To revert:
hosting rolls back instantly from the Firebase console, as above. Functions
and rules do not, and `release.sh` itself only runs from `main`, so it cannot
redeploy a tag directly. Either check the tag out somewhere other than your
`main` worktree and run `scripts/safe-deploy.sh` against it target by target
(see below), or `git revert` forward to that state on `main` and release
normally.

### The Android client ships with the web

Steps 1c and 6b exist because it did not, for a long time, and nothing said so.
The three clients were built to parity, the same callables and contracts and
invoice state table, held honest by tests in all three trees. The release script
shipped functions and two hosting targets and never touched Android. Parity was
real in the source tree and fiction in production: by 2026-07-28 the newest APK
was versionCode 318 against a web build of 518, which is 47 commits and ~13,400
added lines nobody could run.

Staleness was not the whole cost. The deployed rules revoked client-direct
invoice writes on 2026-07-28 (`invoices allow create/update/delete: if false`,
ADR-0002) and Android's writer moved to callables in PR #105, so any APK from
before #105 gets `PERMISSION_DENIED` on every invoice create, edit and delete.
A client that cannot ship rots against a server that keeps moving.

The build runs at 1c, before the first deploy, so a failure costs nothing. The
upload runs at 6b, beside hosting. **CI cannot do either**: release signing needs
the keystore, and the Mapbox SDK needs a downloads token, and both are per
machine and gitignored. That is why this lives in the release you run locally
and not in Actions. What it needs:

| Needs | Where |
|---|---|
| `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | `auntieos-admin/android/local.properties` |
| `MAPBOX_DOWNLOADS_TOKEN` | `~/.gradle/gradle.properties`, or the environment |
| An App Distribution tester list | Firebase console, per project |

A missing keystore or token **refuses the release** at 1c rather than shipping a
web half, because a partial release is how the clients diverged to begin with.
Override with `RELEASE_SKIP_ANDROID=1` when you mean it.

A distribution failure at 6b is loud but not fatal: the web has already landed
by then, the signed APK is on disk, and the run prints the retry command with
its audience flags. Failing the release there would report a good deploy as
broken.

**Uploading is not distributing.** `appdistribution:distribute` needs
`--testers` or `--groups`. Given neither it uploads the binary, attaches the
release notes, prints `no testers or groups specified, skipping`, and **exits
0**. That is a release that looks shipped and reaches nobody, and it is worse
than the old silence because a green Android line now claims otherwise. It
happened on the first real run of this step, on 2026-07-28.

So step 1c resolves the audience before anything deploys: `RELEASE_ANDROID_GROUPS`,
else `RELEASE_ANDROID_TESTERS`, else every tester on the project, read from
`appdistribution:testers:list --json`. The roster stays in the Firebase console
rather than in this repo, where a checked-in list of people would rot. If it
resolves to nobody the release is **refused** while nothing has shipped, and the
refusal prints the command that adds a tester.

`versionName` embeds the short SHA (`build.gradle.kts` builds it from
`gitShortSha`), so a tester's screenshot names the commit it came from without
anyone checking the console.

The AuntieOS functions codebases are **skipped by default** and the run says so
rather than omitting them quietly. They live in the second tree
(`auntieos-admin/web`) with their own deploy semantics.

Rolling back: the previous hosting release restores from the Firebase console
(Hosting → release history). Functions and indexes do **not** roll back with it;
they need their own revert and redeploy.

### Deploying one thing by hand

When you genuinely want a single target and not a release:

```bash
scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets>
```

`<prefix>` is `auntieos-admin` or `mytribe`. Both trees declare a
`firestore.rules` and both deploy into one project, so `--only firestore` from
the wrong tree overwrites live rules with a stale mirror. The wrapper pins
`--project`, refuses a bare `firebase deploy`, allows rules only from `mytribe`
and only when the mirror is byte-identical, and prints every refusal in red.
`DRY_RUN=1` prints the command it would run and does nothing.

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only functions:mytribe
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:app
scripts/safe-deploy.sh mytribe -- firebase deploy --only hosting:kinfolk_portal
scripts/safe-deploy.sh mytribe -- firebase deploy --only firestore:indexes
```

Doing it this way puts the ordering above back in your head. Prefer the run.

**Hosting target names lie.** `hosting:app` is the live admin. The target called
`legacy-wasm`, whose site is literally named `auntieos-admin`, is the superseded
build. Full list in `.firebaserc`.

---

## Secrets

Server secrets live in Google Secret Manager, never in the repo, never in
`.env`. Run from `mytribe/`, which prompts so the value stays out of your shell
history:

```bash
firebase functions:secrets:set SECRET_NAME --project auntieos-ttpc
```

**Setting a secret does nothing until a function declares it** in its
`secrets: [...]` array and is redeployed. This has already gone wrong: a setup
doc told the operator to set a `GOOGLE_CALENDAR_ID` no function ever read, so
the setup looked complete and did nothing. Add a test that reads the function's
`__endpoint` and asserts the name is declared.

**And setting a secret does nothing until the next deploy, every time, not just
the first.** These are gcfv2 functions, which pin the secret VERSION resolved at
deploy time. `functions:secrets:set` mints version N+1 and binds it to nothing;
the running function keeps reading version N until a deploy resolves the name
again. Rotating a value without redeploying leaves the old one live, and setting
a value for the first time leaves the runtime reading nothing at all. Release
step 5 checks for this now (see the deploy section); by hand it is
`firebase deploy --only functions:mytribe`, with the codebase prefix, because a
bare name matches nothing.

Two ways to read the declarations out of the built artifact rather than guessing
from source, which cannot see arrays built from spreads:

```bash
node scripts/declared-secrets.js                             # every declared name
node scripts/declared-secrets.js --by-function GOOGLE_OAUTH  # which function gets what
```

The first answers "will the deploy validate". The second answers the question an
operator actually arrives with, which is "I set it and the feature still fails,
so which function was supposed to receive it": a secret is mounted per function,
so the binding is a pair, and a name in the flat list can still be absent from
the one function that reads it. Neither can tell you whether the secret has a
VALUE or whether the DEPLOYED function carries the declaration; both live in the
project. For those: `gcloud secrets list` and
`gcloud functions describe <name> --gen2 --region us-central1`.

`VITE_*` is different by mechanism, not by policy: Vite inlines
`import.meta.env.VITE_*` into the bundle at build time, so it ships to every
browser. Public client keys only. A Sentry DSN qualifies (write-only ingestion).

The `AIzaSy...` values in the repo are Firebase Web API keys, public by design.
Access is controlled by Firestore rules and App Check.

---

## Firestore query traps

All of these fail SILENTLY. No error, just wrong or empty results.

- **Equality skips documents that lack the field.** `where('invoiceId','==','')`
  misses every document that never wrote it.
- **`where('x','==',null)` matches only documents that HAVE the field.** On a
  collection where nothing is archived yet, `where('archivedAt','==',null)`
  returns zero rows.
- **Every Timestamp sorts after every string.** A Timestamp bound against an
  ISO-string field matches nothing and does not error. `kin_care_sessions.startTime`
  and the four channel collections' `timestamp` are ISO strings; range-query them
  lexically. Invoices page on `date`, not `createdAt`, for this reason.
- **`orderBy` skips documents missing the field**, so a writer that forgets
  `timestamp` makes its rows invisible rather than raising.
- **Status casing is unenforced.** `where('status','==','completed')` drops a row
  stored as `Completed`. Normalize in memory.
- **Money is integer cents.** Float dollar fields are a server-derived
  projection, never an input. Read `paidCents`, never `amountDue`, to decide
  whether an invoice is settled: a pre-2026-07-25 write set `amountDue` to 0 even
  for a partial payment.

---

## When something breaks

**A query returns nothing, with no error.** Almost always the section above.
Check the field type first.

**A callable works locally and 500s in production.** The secret is set but not
DECLARED in that function's `secrets: [...]`. See above.

**A secret is set, set again, and the feature still says it is unset.** The
declaration is not the problem; the deploy is. `functions:secrets:set` mints a
version and binds nothing, and a gcfv2 function reads the version it was deployed
with, so a value set after the last deploy is invisible to the running code.
Confirm the declaration is there, then redeploy:

```bash
node scripts/declared-secrets.js --by-function GOOGLE_OAUTH   # the pairs
firebase deploy --only functions:mytribe                       # from mytribe/
```

Release step 5 now refuses to skip the functions deploy when a declared secret is
newer than the last release, so `npm run deploy` covers this. The AuntieOS
Settings, Calendar section names which of the three setup steps is outstanding
rather than reporting one generic failure.

**A functions deploy fails with `Failed to validate secret versions ... not
found or has no versions`.** The inverse trap: a secret the code DECLARES that
nobody ever SET. Firebase validates every declared secret before uploading, so
one missing name fails the ENTIRE codebase, not just the function declaring it.
Release step 1b now catches this before anything deploys and prints the exact
`firebase functions:secrets:set` command per missing name. To check by hand:

```bash
node scripts/declared-secrets.js
```

That reads the built `__endpoint`s — the same structure the CLI validates —
rather than grepping source, which cannot see arrays built from spreads.

**A functions deploy fails with `Quota exceeded for total allowable CPU per
project per region`.** It fails the tail of the deploy (18 functions on
2026-07-26, 20 on 2026-07-28, 26 to 95 across five attempts on 2026-08-01), and
the casualties are crons, triggers and sweeps, the batch firebase-tools deploys
last.

**The release itself no longer does this to you.** Step 5 deploys by name in
batches of 25 and retries the casualties; see "Why step 5 deploys by name in
batches" above. If you are reading this entry it is because you ran a
whole-codebase deploy by hand: `firebase deploy --only functions:mytribe`, or
`npm run deploy` from inside `mytribe/functions/`, which is the package script
and is not the release. That second one is the "stray" row in the table above:
131 of 226. Recover through the release, or batch it yourself:

```bash
gcloud run services list --region us-central1 --project auntieos-ttpc \
  --format='value(metadata.name,status.conditions[0].status)' \
  | awk -F'\t' '$2!="True"{print $1}' > /tmp/stale-services
node scripts/function-targets.js --from-services /tmp/stale-services > /tmp/stale-names
```

That second command resolves lowercase service names back to export names or
refuses; doing it by eye against `src/index.ts` resolved 79 of 95 that day, and
the 16 it missed are 16 functions nobody would have redeployed.

**Do not prune to fix this.** Pruning was the documented fix here until
2026-07-28, on the theory that Cloud Run revisions each hold CPU forever. That
theory is wrong, and it was disproved the expensive way: the pre-deploy prune
ran, hit its predicted floor within one revision (676 against a predicted 677),
and the deploy failed anyway with the same 20 functions. Three measurements say
why:

- `run.googleapis.com/active_revisions` reported usage **230 against 230
  services**, one apiece, while 676 revisions existed. Idle revisions are not
  counted, so deleting them frees nothing that was being counted.
- 36 revisions pin `min-instances=1`; the other 640 scale to zero. At rest the
  project holds ~36 CPU, nowhere near a ceiling.
- redeploying the failed names as a batch of 20 succeeds minutes later with no
  quota change in between.

2026-08-01 settled it. A run with `RELEASE_PREDEPLOY_KEEP=2` took the inventory
from 1,250 revisions to 487, a bigger reclaim than any prune before it, and
the deploy behind it still lost 26 functions. Pruning is proven to reclaim
inventory and proven **not** to make a whole-fleet deploy fit.

Read that as: the prune reclaims something other than what is being counted. The
remaining inference, that the real limit is on concurrent container starts during
a bulk deploy, fits every observation but has not been proven directly. Nobody
has found the enforced ceiling; `CpuAllocPerProjectRegion` reports 200,000 and
publishes no usage series, while the successes stop dead at 197, 201, 197 against
a stated 200 vCPU.

So the fix is batching, which is now step 5's normal behaviour, and the durable
fix is a quota increase: Cloud Run Admin API, "Total CPU allocation, per project
per region", `us-central1`.

**`RELEASE_PREDEPLOY_KEEP` now defaults to 3, and that is retention, not
headroom.** It runs only when the deploy is large (50 functions or more,
`RELEASE_PREDEPLOY_MIN_TARGETS`), which keeps a narrowed four-function release
from sweeping the whole project's revision history first. At depth 3 it is a
near no-op in steady state, because step 8 already left the inventory at that
floor after the last successful release; it only bites when something went wrong
in between, which is exactly when it is worth doing, and it spends no rollback
depth step 8 was not going to spend an hour later anyway. It is **not** claimed
to buy quota headroom: 1,250 to 487 and the deploy still failed. Set it to `0`
to turn it off.

Pruning is still worth doing as retention, which is what step 8 is for:

```bash
scripts/prune-run-revisions.sh 3   # retention, what step 8 does
```

It never touches a serving revision, keeps the newest N per service, and retries
the 429s the Cloud Run API returns under load.

**The retention default was 10 and could never fire.** A keep of N sets a floor
of N x services below which the sweep is arithmetically incapable of deleting
anything. At 238 services, keep-10 floors at 2,380 revisions, above every level
this project has ever been in trouble at (676 on 2026-07-28, 926 on
2026-08-01). Confirmed the expensive way: on 2026-08-01 step 8 ran against 926
revisions across 238 services, a mean of 3.9 apiece, and deleted **zero**. Not a
bug in the prune; a retention default set above the pressure it exists to
relieve.

The depth bought nothing usable either. The documented rollback path for
functions is revert-and-redeploy, and hosting rolls back from the console
separately; revision-level rollback would be `gcloud run services update-traffic`,
which is written down nowhere here and has never been run. Keep-10 was holding
~8 revisions per service of theoretical depth nobody has used, at the price of
reclaiming none of it.

So the default is **3**: a floor of 714 across 238 services, which would have
removed ~212 at the 926 that mattered, while still leaving the two previous
deploys plus the serving revision per service. It stops at 3 rather than 2 even
though recovery on 2026-08-01 took the inventory to 468 (~2 per service) before
the last 26 functions would land, because the measurements above say the prune is
not what fixed that. Picking 2 would be quietly re-adopting the theory that was
tested and failed.

Step 8 still runs after step 7, so it cannot help the deploy in its own run.
That is answered across runs rather than within one: a sweep whose keep actually
fires leaves the inventory at its floor every release, so the next release starts
from ~714 instead of from 926 and climbing. `RELEASE_PREDEPLOY_KEEP=N` defaults
to 3 and runs before a large functions deploy, as retention only; it is not
claimed to buy headroom, for the reasons above.

**Do not trust the "removed" and "remaining" counts in any prune output logged
before 2026-08-03.** They were computed by listing the region again after the
deletions and subtracting, and that listing fails silently: `gcloud run
revisions list` can print nothing and still exit 0. The 2026-08-03 release
printed `before: 903 after: 0 removed: 903` and signed off "903 revisions
removed, 0 remaining" for a run whose own plan deleted 197, over a region that
still held 240 serving revisions the prune cannot touch. The plan line above it
(`plan: N revisions, ... delete M`) was correct in those runs; the numbers after
it were not. The script now counts the deletions its workers completed and does
not re-list at all, so `deleted:` is a real count and `remaining (derived):` is
labelled as the arithmetic it is. `scripts/prune-run-revisions.test.sh` holds
that line.

**A deploy failed partway and left named functions undeployed.** The failed
functions are still serving their previous revision, so production is
mixed-version rather than down, so check before assuming an outage:

```bash
gcloud run services list --region us-central1 --project auntieos-ttpc \
  --format='value(metadata.name,status.conditions[0].status)' | awk -F'\t' '$2!="True"{print $1}'
```

Service names are the lowercased export names. Redeploy exactly those, then
record the release:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only "functions:mytribe:NAME1,functions:mytribe:NAME2"
git rev-parse HEAD > .release-state   # only once every function is live
npm run deploy                        # functions now skip; hosting and verify finish
```

Confirm every retried service is serving its **new** revision before writing
`.release-state`. `Ready=True` alone can mean it rolled back to the old one:

```bash
gcloud run services describe NAME --region us-central1 --project auntieos-ttpc \
  --format='value(status.latestCreatedRevisionName,status.latestReadyRevisionName)'
```

Those two must match. Write `.release-state` to a path outside the repo if you
back it up first; a stray `.release-state.bak-*` is untracked and step 0 refuses
the release for a dirty tree.

Write `.release-state` by hand only when the functions really are all live.
The next release reads it to decide whether to deploy functions at all, so a
premature write makes that release skip work it needed to do.

**A client mirror test goes red after a backend change.** The contract freeze
doing its job. Update the doc, the frozen set and every mirror together.

**`git fetch` or `push`: `communication with agent failed`.** The 1Password SSH
agent dropped out. Usually transient; retry, unlock 1Password if it persists.
Dangerous because a failed fetch leaves stale refs and every later local answer
is confidently wrong. `gh` uses an HTTPS token and is unaffected, so cross-check
with `gh pr view` before believing local git.

**Typecheck or build errors in code you did not touch, right after pulling
main.** Example: `'rolldownOptions' does not exist in type
'BuildEnvironmentOptions'` from `vite.config.ts`. A dependency-upgrade PR moved
the lockfile past your installed `node_modules`, so tsc is checking new code
against old types.

```bash
npm run setup
```

`setup` detects this now: it compares each `package-lock.json` against
`node_modules/.package-lock.json` and reinstalls any project whose lockfile is
newer, announcing it as STALE rather than skipping. (It used to check only that
the directory existed, which is exactly how this hid for an hour.)

**Gradle: "SDK location not found".** Run `npm run setup`.

**Release build complains about signing.** `local.properties` needs
`KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`. Debug builds
and unit tests do not. The build names whichever is missing.

**CI red, local green.** The e2e job is the usual difference: a real browser
against the emulator catches font, cascade and auth problems jsdom cannot see.
Run `npm run e2e`.

**A release refuses with "CI is not green for `<sha>`".** Working as intended,
and it is release step 0b. Fix the named job on main and release the commit that
fixes it. `RELEASE_SKIP_CI_GATE=1` is for a gate that cannot answer, not for one
that answered no; using it that way reproduces 2026-08-01 exactly.

---

## Where else to look

| File | For |
|---|---|
| `README.md` | What the repo is, why one repo |
| `auntieos-admin/CLAUDE.md` | Vertical-slice rule, error-handling philosophy |
| `mytribe/functions/CALLABLE_CONTRACT.md` | Canonical request and response shapes |
| `scripts/safe-deploy.sh` | Deploy guards, with the reasoning in the header |
| `scripts/release.sh` | The production run, step by step, with why each step is where it is |
| `scripts/release.test.sh` | Runs the release script against a throwaway repo and stubbed CLIs |
| `scripts/prune-run-revisions.test.sh` | Holds the prune's counts to what it deleted; run it by hand, CI does not |
| `auntieos-admin/docs/runbooks/e2e.md` | The Playwright harness |
| `auntieos-admin/docs/runbooks/visual-regression.md` | Visual harness, escalate-never-approve |
| `auntieos-admin/docs/handoffs/` | What a given week found |
