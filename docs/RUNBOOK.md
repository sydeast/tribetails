# Apps runbook

`README.md` says what the repo is. This says what you do with it.

Every command here was run against the repo on 2026-07-26. The release,
quota and Cloud Run sections were re-verified 2026-08-03, and the map, test
counts and contract-freeze sections on 2026-08-04.

---

## Setup

### What the machine needs first

```bash
bash scripts/preflight.sh
```

Changes nothing. Reports every tool, and for each missing one prints the install
command for your platform. Run it before anything else; `npm run setup` runs it
too and refuses to start if anything required is absent, **except** when the
only thing wrong is dependency drift (node_modules out of sync with a
lockfile, exit code 2 rather than 1): installing is exactly the fix for that,
so setup proceeds to install and re-checks preflight afterward rather than
refusing to start the one thing that would fix it. See below.

| Tool | Needed for | Install (macOS) |
|---|---|---|
| **git** | everything | `xcode-select --install` |
| **Node 22** | every JS project. 22 is the deployed functions runtime, pinned in `.nvmrc` | `nvm install 22 && nvm use` |
| **npm** | dependencies | ships with Node |
| **JDK 17+** | Firebase emulators (`test:rules`, `e2e`) and Gradle | `brew install --cask temurin@21` |
| **firebase-tools** | emulators and every deploy | `npm install -g firebase-tools` |
| Android SDK | Android builds only | Android Studio, or set `ANDROID_HOME` |
| gh | PRs from the terminal | `brew install gh` |
| Python 3.13 | the `reconcile` functions codebase only | `brew install python@3.13` |

### The Python codebase has a setup step nothing performs

`auntieos-admin/web/firebase.json` declares a second functions codebase,
`reconcile`, on a pinned Python runtime. The Firebase CLI discovers its
endpoints by RUNNING that code out of a venv beside its source, so without the
venv a deploy cannot even list what it would ship:

```
Error: Failed to find location of Firebase Functions SDK: Missing virtual
environment at venv directory. Did you forget to run 'python3.13 -m venv venv'?
```

`npm run setup` does not create it and never has. It was built by hand once and
nothing recorded that, so on 2026-08-05 a release ran 25 minutes of successful
function deploys and then stopped here, on a machine holding Python 3.14 and no
3.13.

```bash
brew install python@3.13
cd auntieos-admin/web/functions-python
python3.13 -m venv venv && venv/bin/pip install -r requirements.txt
```

Preflight reports all four ways this is wrong (no interpreter, no venv, a venv
built by a different interpreter, requirements never installed) and reads the
required version from `firebase.json` rather than hardcoding it, so a runtime
bump cannot leave it validating the old one. It WARNS rather than fails: this
codebase only ships under `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1`, and a machine
that never deploys it is not broken for lacking a venv.

### An install either matches its lockfile or it does not, and only one of those looks wrong

Preflight also checks, per project, that what is in `node_modules` is what the
lockfile pins. The release that forced this had a clean tree, a present
lockfile and green CI, and died 90 seconds into `npm run check` with nine TS2307
errors naming `@googleapis/calendar`: PR #250 swapped that dependency and the
checkout never installed it. CI cannot catch this, because CI installs from
scratch every run. Only a long-lived checkout drifts.

A missing `node_modules` entirely is a note rather than a failure, since that is
a fresh clone and `npm run setup` is the fix, and `bootstrap.sh` calls preflight
BEFORE installing. A PARTIAL or STALE install fails, because that is the state
that looks installed and is not. The first run of this check found two more
instances nobody knew about, including a Fraunces font version that had been
producing an unexplained e2e failure.

**The comparison lives in one place** (`scripts/lib/dep-drift.sh`), sourced by
both `preflight.sh` (report only) and `release.sh` step 0a (refuse), so they
cannot silently disagree about what counts as drift. It checks the workspace
root (every npm workspace member, read from the root `package.json`'s
`workspaces` field and expanded rather than hardcoded, so a new member is
never missed), `mytribe/functions`, and `auntieos-admin/web/functions`.
`release.sh` only refuses on the last one when `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1`
is actually going to build and deploy it; `preflight.sh` and `bootstrap.sh`
check and install it unconditionally, since setup asks "is this machine
ready", not "is this run shipping it".

**A drift-only failure does not stop `npm run setup`.** On 2026-09-13 the
release Mac's `node_modules` was installed 2026-09-10, before Dependabot moved
vitest 4.1.11 → 5.0.0 and about twenty other packages, `stripe` in
`mytribe/functions` included. `scripts/release.sh` had nothing checking this
before its test step, so the third release attempt that day died three minutes
into `npm run check` on a portal test CI had already passed on the same
commit. Fixing it needed `npm ci` and `npm ci --prefix mytribe/functions`,
but `npm run setup`'s OWN preflight check refused to even start over the exact
drift installing would fix, so the operator ran both by hand.

`preflight.sh` now exits **2**, not 1, when the ONLY thing wrong is dependency
drift (1 still means something installing will not fix: a missing tool, a
missing lockfile, an old JDK). `bootstrap.sh` reads that: on exit 2 it prints
why, forces a reinstall of ONLY the units preflight found drifted (never every
unit: drift in `mytribe/functions` alone must not force a root reinstall too),
and re-runs preflight afterward to prove the drift is actually gone rather
than assuming it. Any other preflight failure still refuses to start,
unchanged. See `scripts/bootstrap.test.sh` and `scripts/preflight.test.sh` for
the cases.

`scripts/release.sh` runs the same comparison as its own precondition (step
0a, placed BEFORE the "release this commit?" confirm so an operator who says
yes is not then told no, and before step 1 builds or tests anything) and
refuses outright: a release is not a machine you want fixing itself mid-run.
It names every drifted directory and the exact `npm ci` command for each:

```
REFUSED: installed dependencies do not match their lockfile(s):
  - mytribe/functions: stripe (17.0.0, lockfile says 18.5.0)

  This is exactly what stopped the 2026-09-13 release 3 minutes into
  step 1, on a commit CI had already passed: ...

    npm ci --prefix mytribe/functions
```

See `scripts/release.test.sh` for the cases: drift refuses and names the
directory and fix, a clean install proceeds silently, and
`auntieos-admin/web/functions` drift is checked only when
`RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` is actually shipping it.

**Never run `npm ci` INSIDE a workspace member** (`mytribe/web`,
`auntieos-admin`, `packages/geo`, `packages/issue-recorder`). They share the
ROOT's `package-lock.json`/`node_modules` and carry no lockfile of their own,
and that absence is normal, not a defect. Another agent working in parallel
on this same issue saw `npm ci` run inside `mytribe/web` exit 0 and SILENTLY
DROP `@tiptap/*` and `@vitejs/plugin-react` from its `node_modules`: npm
walks up, finds the workspace root, and runs the equivalent of `npm ci -w
mytribe/web` from there. That empties the root `node_modules` and reinstalls
only that member's dependencies, then exits 0. The fix, every time, is `npm
ci` at the **root**. The drift check follows this: a workspace member's
drift is always reported as "workspace root: ..." with the fix `npm ci`,
never `npm ci --prefix mytribe/web`, and `scripts/release.test.sh` and
`scripts/preflight.test.sh` each assert that no per-member `--prefix`
command is ever suggested.

`npm ci` inside a member still empties the root `node_modules` before any
guard can run, and npm has no earlier hook to stop it (tested on both npm
10.9.8 and 11.9.0). Since #862 a guard turns that silent exit 0 into a loud
refusal: every lockfile-less member carries a `preinstall` script
(`scripts/lib/refuse-member-install.js`) that refuses `npm ci`, `npm
install`, and `npm uninstall` run from inside that member, and stays silent
for a root install, a `-w` filter run from the root, CI, or `bootstrap.sh` --
see `scripts/refuse-member-install.test.sh` for the cases. The fix is `npm
ci` at the repo root either way; to add or remove a single dependency in one
member, run `npm install <pkg> -w mytribe/web` (or `npm uninstall <pkg> -w
mytribe/web`) from the repo root instead of from inside the member.

`npm ci -w <member>` run FROM THE ROOT is a legitimate command, not something
this guard refuses, but it also empties most of the root tree down to just
that member's subtree (477 entries down to 456 in one measurement here) --
restore the full tree afterward with a plain root `npm ci`.

Two of the tool checks above fail in ways that do not name themselves, which is
why preflight checks them by RUNNING them rather than by looking for the binary:

- **No JDK** produces `Could not start Firestore Emulator`, which mentions
  neither Java nor the fix. macOS makes this worse by shipping a `/usr/bin/java`
  stub that exists on a machine with no JDK and only fails when executed.
- **firebase-tools missing** fails inside an npm script, so the error names the
  script rather than the missing tool.

### Then

```bash
npm run setup
```

Idempotent, safe to re-run. Runs preflight, points git at `.githooks`, writes a
`local.properties` for each of the two Gradle builds if absent
(`auntieos-admin/android/` and `mytribe/`, never overwriting an existing one,
which also holds signing keys), installs all three JS projects one at a time,
and then **proves it worked** by typechecking. If any step fails it says which
step, rather than exiting quietly.

**Run it in a new `git worktree` too, not only in a fresh clone.**
`local.properties` is gitignored, so a worktree never inherits one from the main
tree and the first Android command there dies with `SDK location not found`.
Exporting `ANDROID_HOME` for that one command is not the fix: it unblocks that
command and leaves the next one just as broken. `scripts/preflight.sh` names any
missing `local.properties` and points back here, so this is one less thing to
remember.

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
| `npm test` | Every JS suite (functions, geo, admin, portal) |
| `npm run test:android` | Gradle unit tests |
| `npm run test:rules` | Firestore rules, against the emulator |
| `npm run test:scripts:emulator` | Every backfill's `*.emulator.test.ts`, against the emulator. **Run it before any backfill's prod write.** |
| `npm run typecheck` | All four projects |
| `npm run build` | Functions, admin, portal. `packages/geo` has no build step — both apps consume its TypeScript source directly. |
| `npm run build:android` | `compileDebugKotlin` |
| `npm run lint` | Functions eslint |
| `npm run contracts:generate` | Rewrite the generated Contracts module from the server zod schemas |
| `npm run contracts:check` | Regenerate into memory and fail on any diff. Part of `check`. |
| `npm run e2e` | Playwright against the emulator. **Not part of `check`** |
| `npm run check` | typecheck, lint, contracts, test, build. Not e2e; release step 0b covers that by asking CI. |
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

---

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
section below is the authority on which of them a run actually builds and
distributes; `scripts/distribute-apks.sh` carries both app ids.

**Two web apps and two Android apps**, one pair per operating system, and
`npm run deploy` ships all four in one run. `mytribe/src` is easy to misread as
dead: it is a Compose Multiplatform tree whose `jvm` target is the paused
desktop build, but whose `android` target is a live delivery surface.

Not delivery targets, do not add features: `auntieos-admin/web/composeApp` (wasm
admin superseded by `auntieos-admin/src`, desktop build paused by owner ruling),
the `jvm`/desktop target of `mytribe/src` (same ruling), and
`auntieos-admin/sotu-hosting` (ops hosting, no Cloud Functions of its own).

All of it deploys into ONE Firebase project, `auntieos-ttpc`, which is why
deploys go through a wrapper.

---

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

---

## Deploying

**`npm run build` does not deploy.** It writes `dist/` on your disk and uploads
nothing. This is the mistake that has actually been made here: on 2026-07-26 the
live admin was 33 hours and ~19 merged PRs behind `main` because a green build
was read as a shipped one.

### The production run

```bash
npm run deploy:bg     # detached, logged, survives the terminal closing
npm run deploy        # foreground, when you want to answer the prompts yourself
```

That is the whole release. `scripts/release.sh` runs the steps below **in this
order**, stops at the first failure, and names the step it died in.

**Prefer `deploy:bg`.** The release takes 20 to 40 minutes, and every way of
launching it by hand has a sharp edge that was hit on 2026-08-03:

- backgrounded with `&`, step 0's confirm reads `/dev/tty`, the job takes
  SIGTTIN and stops with `[1] + suspended (tty input)`, which reads as a hang;
- `echo "release pid $!"` pasted into interactive zsh triggers history expansion
  on the `!`, eats the closing quote, and drops you at `dquote>`;
- the log path gets improvised, so the previous run's output is wherever it
  landed.

`scripts/release-bg.sh` handles all three, writes
`.release-logs/release-<stamp>-<sha>.log`, prints the `tail -f` for it, and
refuses to start a second release while one is running.

It passes `RELEASE_YES=1`, because a detached run cannot answer a prompt. That
is safe for step 0's "release this commit?" (running the command IS the answer)
and **not** automatically safe for step 3's "are all indexes Enabled?", so the
wrapper checks: if `firestore.indexes.json` changed since the last release, or
if there is no baseline to compare against, it refuses and sends you to the
foreground run. `RELEASE_BG_FORCE=1` overrides once you have checked the console
yourself, and says in its output that it did.

One exception, and it needs no flag: a **resumed** release. When an earlier run
of the exact commit being released (the pinned `RELEASE_SHA`) got past step 3
and stopped later, `.release-progress`
records the index step, the rerun skips steps 2 and 3, and there is no prompt
left to skip. `.release-state` still names the previous release until a run
finishes, so the diff says "changed" anyway; the wrapper lets that run through
and prints `resumed:` instead of refusing. It uses the same rule as the release
(exact `RELEASE_SHA`, clean tree, `RELEASE_NO_RESUME` unset), from the one copy in
`scripts/release-progress.sh`. See "A stopped release resumes on the same commit".

| # | Step | Why here |
|---|---|---|
| 0 | Preconditions | Clean tree, on `main`, synced with origin. Shipping uncommitted or stale code is the classic incident. Falls back to `gh` if the SSH agent is down, since it must verify the fact, not one transport. |
| 0a | Dependency drift | Is `node_modules` what each `package-lock.json` says it should be, for every root this run builds, tests, or deploys? Refuses and names the exact `npm ci` command, before step 1 tests anything against tools it cannot trust. See below. |
| 0b | CI verdict for HEAD | Asks GitHub whether every check is green for this exact commit, **e2e included**. `npm run check` does not run e2e, so until this existed a red e2e could not stop a release. See below. |
| 1 | `npm run check` | Typecheck, lint, test, build. Not optional theatre: this is what produces the `dist/` that step 6 uploads. |
| 1b | Secret preflight | Every secret the code DECLARES must exist. Firebase validates these before uploading, and one missing name fails the whole codebase. Refuses here, before any deploy. |
| 1c | Android build | Assembles **both** signed release APKs, operator and portal. Runs before the first deploy so a build failure costs nothing; the uploads are step 6b. |
| 2 | Firestore indexes | Before the code that queries them. A query with no index fails at RUNTIME, not at build. |
| 3 | Wait for indexes | The CLI returns when Firestore ACCEPTS an index, not when it is Enabled. The run blocks; the CLI will not. |
| 4 | Firestore rules | From `mytribe` only. Refused outright if the admin mirror has drifted. |
| 5 | Functions | Before the clients that call them. **Skipped when `mytribe/functions` is unchanged since the last release AND no declared secret is newer than it**. Otherwise deployed **by name, in batches of 25, with retries**, because the whole fleet does not fit the regional CPU quota. See below. A rerun of the **same commit** skips it once its fleet verify passed; see "A stopped release resumes on the same commit". |
| 6 | Hosting | Admin, then portal. |
| 6b | Android | Uploads both APKs from step 1c to App Distribution, each to its own Firebase app, in the same run as the web. |
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
CLI all ~227 functions at once. Each was its own Cloud Run service at 1 vCPU, a
deploy starts a new revision beside the serving one, and
`CpuAllocPerProjectRegion` in `us-central1` was 200 vCPU. The fleet did not fit.
On 2026-08-01 five full deploys each died partway (both of those numbers have
since changed; the correction is below the table):

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

**That table is history. Two things changed under it.**

PR #219 set `setGlobalOptions({ cpu: 0.25, ... })` in `mytribe/functions/src/index.ts`,
with 38 functions carrying an explicit override (26 `FULL_CPU`, 12
`FULL_CPU_SERIAL` in `lib/runtimeOptions.ts`). The fleet's draw is no longer
~227 vCPU. At 240 services it is roughly 38 + (202 x 0.25), near 90.

The quota increase requested on 2026-08-02 was approved on 2026-08-03:
`CpuAllocPerProjectRegion` in `us-central1` is now **400 vCPU**, not 200.

So the ceiling that produced 197, 201, 197 is about four times the fleet's
current draw, and the 2026-08-03 release deployed 202 functions with zero quota
errors. Read the numbers above as what a 1-vCPU fleet did against a 200 vCPU
ceiling, and nothing about today.

### The nightly release stays off until it can authenticate

`.github/workflows/nightly-release.yml` is off (`NIGHTLY_RELEASE=off`,
operator ruling 2026-09-14), and releases run by hand from the operator Mac.
Before anyone sets it to `preflight` or `on`, the hosted ubuntu runner needs
what it does not have today, all tracked in #851: Google Cloud access that can
read Secret Manager and deploy (Workload Identity), the Android signing
secrets step 1c assembles the release builds with (`KEYSTORE_PATH`,
`KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`), and a `GH_TOKEN` (or `GITHUB_TOKEN`) that can
read this repo's Actions runs, for step 0b. Without them the preflight fails
and blames the wrong thing: on 2026-09-12, 13 and 14 it reported
existing secrets as missing and a green commit as having no CI run (#850). The
workflow now stops at its first real step, "Check the runner can authenticate",
and names whichever credential is absent. That is the expected result until
#851 lands, not something to fix by re-creating secrets. Once all three exist, run
`preflight` for a few nights before `on`.

### The quota that was actually refusing the deploy

**It was never the Cloud Run CPU quota, and it is not a capacity limit at all.**
Measured 2026-08-03 by deploying all 227 functions in one batch and reading the
error text instead of inferring it:

```
HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation requests'
and limit 'Per project mutation requests per minute per region'
of service 'cloudfunctions.googleapis.com'
```

Different service from `CpuAllocPerProjectRegion`, different meter, and a **rate**
(requests per minute) rather than a ceiling (CPU held at once).

**The limit is 60 per minute per region**, read off the console the same day
(IAM & Admin -> Quotas, Service: Cloud Functions API, dimension
`region:us-central1`). Every region shows the same 60, so it is the default.

That single number accounts for the whole history. 227 functions against 60 a
minute is a floor of about four minutes of pure rate-limited pushing before any
build or retry time, which is why the successful single-batch deploy took nine
minutes and hit thirteen 429s, and why deploys that ran for two or three minutes
stopped at 197 and 201. Nothing was near a CPU ceiling; the deploys were simply
spending their minute's budget and being told to wait.

**It cannot be raised. Do not go looking for the form.** The console types this
row as a **System limit** rather than a Quota, and its **Adjustable** column
reads **No**, in every region. Confirmed the same day, along with two rows that
make the distinction concrete:

| Name | Type | Value | Adjustable |
|---|---|---|---|
| Per project mutation requests per minute per region | System limit | 60 | **No** |
| Per project read requests per minute per region | System limit | 1,200 | **No** |
| Total CPU allocation, in milli vCPU, per project per region | Quota | 200,000 | Yes |

Reads get twenty times the budget of mutations, which is why nothing but a
deploy ever notices this. Enabling the **Quota adjuster** (Quotas ->
Configurations) does not help either: it only manages rows that are adjustable,
so this one is absent from its list rather than present and switched off.

So the ceiling is 60 a minute, permanently, and the answer is to live inside it.
That is what step 5's batching does, and what the Firebase CLI's own backoff
does when a batch is too big. The cost is a few minutes on a full-fleet release,
and step 5 narrows most releases to the functions that changed, so full-fleet
deploys are rare.

Every observation that made the CPU story fall apart fits this one exactly:

- Pruning reclaimed inventory and never helped a deploy, because inventory was
  never the constraint.
- `active_revisions` read 230 against 230 services while 676 revisions existed,
  and 36 revisions pinned `min-instances`, so the project sat near 36 vCPU at
  rest while deploys failed. Nothing was near a CPU ceiling because CPU was the
  wrong meter.
- "A batch retry of the same names succeeds minutes later with no quota change"
  was the observation that broke the CPU theory. It is simply the per-minute
  window resetting.
- Successes stopping at 197, 201, 197 read as a 200 vCPU ceiling printing
  itself. It is a coincidence of scale: that is roughly how many mutations fit
  in the minutes those deploys ran.

The concurrent-container-start inference is dead too. It was a reasonable guess
at an unnamed mechanism, and the mechanism turned out to be a documented quota
nobody had read the error for.

**How much room the CPU quota actually has, read off the console the same day**
(Service: Cloud Run Admin API, `region:us-central1`):

| Quota | Limit | In use | |
|---|---|---|---|
| Total CPU allocation, in milli vCPU, per project per region | 400,000 | 16,000 | **4%** |
| Active Revisions per region | 4,000 | 240 | **6%** |
| Services per region | 1,000 | 240 | 24% |

Two things fall out of that, and both are stronger than anything inferred.

**There was never a CPU problem, by a factor of twenty-five.** 16 vCPU in use
against 400 available. Elsewhere this runbook says the fleet "draws ~90 vCPU";
that is the theoretical sum if every service were warm at once, and it is not
what the meter counts. What it counts is what is running, which is 16.

**Active Revisions was 240 while the region held 706 revisions.** That is the
July inference confirmed with a live number: idle revisions are not counted, so
the prune could never have bought deploy headroom no matter how deep it went.
The prune is retention. Nothing else.

**A single batch of all 227 landed.** 2026-08-03, ~9 minutes, via
`safe-deploy.sh mytribe -- firebase deploy --only <227 names>`. Thirteen
functions hit the 429 across fourteen retry waves; the Firebase CLI backed off
and retried each one, and all 227 finished with `Successful update operation`.
Zero permanent failures. So a whole-fleet deploy is not impossible, was never
impossible for the stated reason, and the CLI already handles this quota itself.

**Batching stays as the default anyway**, for reasons that now have the right
name attached. Pacing mutations is the correct shape of fix for a per-minute
rate limit, and staying under it beats hitting it and recovering: the retries
cost wall-clock, and a run that exhausts the CLI's backoff still ends with named
casualties. Batching also carries the per-function result parsing and the
named-casualty retry, which are worth having regardless. What changes is that
the release can stop treating a full-fleet deploy as arithmetically impossible,
because it isn't.

**If you want the durable fix, raise the right quota:** "Per project mutation
requests per minute per region" on **`cloudfunctions.googleapis.com`**, not
another Cloud Run CPU bump. The 400 vCPU increase is real headroom and worth
keeping; it was aimed at the wrong meter.

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
and `npm` stubbed, plus a fake `gradlew` per Android app so the two-app build
and distribution path runs wet without an SDK. It also covers the admin deploy
retry and its error classifier, the per-commit resume, and the checkout checks
around every deploy (#840), and the step 0a dependency-drift checks (#841). 188
cases.
Run it after touching `scripts/release.sh`. `bash scripts/release-bg.test.sh`
(26 cases) covers the detached wrapper, including a resumed run with changed
indexes and each reason a resume is refused.

Knobs, all off by default:

| Variable | Effect |
|---|---|
| `DRY_RUN=1` | Rehearse: print every firebase command, run none, write nothing, claim nothing |
| `RELEASE_SKIP_CHECK=1` | Skip step 1. Then `dist/` is whatever was last built, which may not match HEAD |
| `RELEASE_SKIP_CI_GATE=1` | Release without CI's verdict for HEAD. For when the gate is unavailable, not for when it says no |
| `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` | Also ship the AuntieOS `default` and `reconcile` codebases. `reconcile` needs the Python venv above. Each deploy is retried on a transient error; see "A stopped release resumes on the same commit" |
| `RELEASE_NO_RESUME=1` | Run every step, including the ones `.release-progress` records as already done for this commit |
| `RELEASE_FUNCTIONS_FORCE=1` | Pass `--force` to the functions deploy. Needed when a change RAISES the minimum bill; see below. Also lets firebase DELETE functions missing from source, so read the diff |
| `RELEASE_PRUNE_BRANCHES=0` | Skip deleting merged remote branches after the tag |
| `BRANCH_PRUNE_MIN_AGE_DAYS=N` | How long a merged branch stays quiet before the prune takes it (default 1) |
| `RELEASE_YES=1` | Do not prompt (CI). Preconditions still apply |
| `RELEASE_FORCE_FUNCTIONS=1` | Deploy functions even when unchanged |
| `RELEASE_SKIP_ANDROID=1` | Ship the web without **either** Android client. Off by default; shipping them together is the point of steps 1c and 6b |
| `RELEASE_SKIP_ANDROID_AUNTIEOS=1` | Drop just the operator app. The portal app still builds and ships |
| `RELEASE_SKIP_ANDROID_MYTRIBE=1` | Drop just the portal app. The operator app still builds and ships |
| `RELEASE_ANDROID_APP_ID=…` | Override the operator app's App Distribution app id. Predates the second app, so it means that one and only that one |
| `RELEASE_ANDROID_APP_ID_AUNTIEOS=…` | Same thing, said explicitly. Wins over `RELEASE_ANDROID_APP_ID` |
| `RELEASE_ANDROID_APP_ID_MYTRIBE=…` | Override the portal app's App Distribution app id |
| `RELEASE_ANDROID_GROUPS=a,b` | App Distribution group aliases to distribute to |
| `RELEASE_ANDROID_TESTERS=a@b,c@d` | Tester emails to distribute to. Neither this nor groups set means every tester on the project |
| `RELEASE_SKIP_SECRET_CHECK=1` | Skip step 1b |
| `RELEASE_SKIP_FLEET_VERIFY=1` | Skip the post-deploy fleet verify (#503). The deploy tool's own account of what landed becomes the only evidence the run has |
| `RELEASE_SKIP_PRUNE=1` | Skip the step 8 retention prune. Revisions then accumulate until someone prunes by hand |
| `RELEASE_PREDEPLOY_KEEP=N` | Prune to N per service before a **large** functions deploy (default 3, `0` disables). See the quota entry below |
| `RELEASE_PREDEPLOY_MIN_TARGETS=N` | How many functions count as large (default 50). Below it the pre-deploy prune does not run |
| `RELEASE_KEEP_REVISIONS=N` | Revisions kept per service in step 8 (default 3) |
| `PRUNE_MAX_SECONDS=N` | Wall-clock budget for a prune (default 900, `0` unbounded). It stops at the budget, says what it skipped, and the next run re-plans those |
| `RELEASE_FUNCTIONS_ALL=1` | Deploy every function, not only the ones this release can reach |
| `RELEASE_FUNCTIONS_BATCH=N` | Functions per `firebase deploy` (default 25) |
| `RELEASE_FUNCTIONS_ROUNDS=N` | Retry rounds for functions that did not land (default 3) |
| `RELEASE_FUNCTIONS_SETTLE=S` | Seconds between batches (default 30) |
| `RELEASE_RETRY_KEEP=N` | Prune depth between retry rounds (default 2, `0` disables) |

### A stopped release resumes on the same commit

On 2026-09-13 a release shipped indexes, rules and all 279 `mytribe` functions,
verified the fleet, then stopped on one dropped Secret Manager request while
deploying the admin codebases (#840):

```
Error: Failed to validate secret versions:
- FirebaseError Failed to make request to https://secretmanager.googleapis.com/v1/projects/auntieos-ttpc/secrets/CLOUDINARY_API_KEY/versions/latest
```

The secret had an enabled version. The blip stopped the release because the
admin deploys had no retry, and a rerun would have redeployed all 279 functions
(about 30 minutes, another round of Cloud Run revisions) because nothing
recorded that they had shipped.

**The admin codebase deploys retry transient errors.** `functions:default` and
`functions:reconcile` get up to `RELEASE_FUNCTIONS_ROUNDS` attempts (3),
`RELEASE_FUNCTIONS_SETTLE` seconds apart (30), the same numbers step 5 uses for
its batches. Whether to retry is read from the error text:

| Error text contains | Verdict | Retried |
|---|---|---|
| `not found`, `NOT_FOUND`, `has no versions`, `PERMISSION_DENIED`, `permission denied`, `increase the minimum bill` | permanent | no |
| `Failed to make request`, `HTTP Error: 429` or `5xx`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `socket hang up`, `DEADLINE_EXCEEDED`, `Service Unavailable`, `Bad Gateway`, `Gateway Timeout`, `Internal error encountered` | transient | yes |
| anything else | unknown | no |

A permanent marker wins even when a transient one is also in the log. A secret
that is genuinely missing fails under the same `Failed to validate secret
versions` header as the blip, and three attempts would only delay the same
refusal. An unknown error stops the run, as every failure did before.

**Finished steps are recorded per commit.** As steps complete, the release
appends `<sha> <step>` lines to `.release-progress` (gitignored, per machine). A
rerun skips a recorded step only when the line names the exact commit the run is
releasing, the tree is clean, and `RELEASE_NO_RESUME=1` is not set. When a record
for the step exists but one of those fails, the run prints which: `RELEASE_NO_RESUME=1
is set`, `it is recorded for <sha>, and this release is <sha>`, or `the working
tree is not clean` followed by `git status --short`. Skippable:

- indexes (steps 2 and 3, including the "are all indexes Enabled?" prompt). The
  resume says whether the operator typed yes at that prompt or `RELEASE_YES=1`
  answered it. `deploy:bg` and `RELEASE_BG_FORCE=1` both run with `RELEASE_YES=1`,
  so neither is recorded as a confirmation
- rules (step 4)
- the `mytribe` functions (step 5), recorded as done **only when the fleet
  verify passed**. A step 5 with nothing to deploy has its own record, and the
  resume and the tag say "nothing to deploy". A deploy whose verify could not run
  ("could not verify", `RELEASE_SKIP_FLEET_VERIFY=1`) is recorded as unverified:
  the stop message lists it as "deployed, not verified", and a rerun deploys again
- each admin codebase, separately

**The commit is pinned when the run starts.** `release.sh` reads HEAD once, as
`RELEASE_SHA`, and uses it for the progress record, the diffs, `.release-state`
and the tag. The agent shell and the operator's terminal share one checkout, so a
checkout or commit during a 20 to 40 minute run would otherwise mark the new
commit done for work the old one deployed. If HEAD moves, or the working tree
changes after the first deploy, the run stops at the next check with `REFUSED:
HEAD moved during the release` (or `the working tree changed during the
release`), naming where it was caught. The checks run at every step boundary,
before and after each functions batch, after the rules deploy, before each admin
codebase attempt and after its deploy, before step 5 is recorded, and before
`.release-state` is written.

They are that dense because the deploys read the working tree: `firebase deploy`
rebuilds `lib/` for every functions batch (the predeploy in
`mytribe/firebase.json`), the rules deploy reads `firestore.rules`, and the admin
`default` codebase uploads plain JS. A checkout that changes mid-step-5 ships the
later batches from the other commit, and the fleet verify cannot tell. The run
keeps a list of the deploys since the last passing check. When a check fails, the
refusal and the stop message name those deploys as possibly from the other commit,
name both shas, and drop their records, so a rerun deploys them again. When no
deploy ran since the last passing check, the refusal says every deploy so far was
checked.

What the working-tree check compares: `git status --porcelain`, `git diff HEAD`,
and a fingerprint of every untracked, non-ignored entry: a regular file by its
contents (`git hash-object`), a symlink by its target, a directory (git lists an
untracked nested repository as `sub/`) by its name, and a file that cannot be read
by its mode. So a changed untracked file's contents count, and a dangling
symlink, an unreadable file or a nested repository never makes the check fail.
It costs 0.09 to 0.10s on the real checkout (measured 2026-09-14, no untracked
files) and 0.17 to 0.22s with 500 untracked 4KB files.

If one of the three git reads itself exits non-zero, the check retries once a
second later, then refuses with `git could not read the working tree` and prints
the command, its exit code and git's own message. That is not a claim that
anything changed. A held `.git/index.lock` is not a cause: all three reads exit 0
with a lock present. The release's own outputs are gitignored
(checked with `git check-ignore`: both `.env.production.local` files, `lib/`,
both `dist/`, both Android build dirs, `.release-*`, and the Firebase debug logs,
which the root only ignores since #840). The two Firebase CLI calls that run
from outside a deploy tree (`appdistribution`) now run from `mytribe/`.

A change made and undone inside a single deploy is invisible to every check; the
only defence against that is not working in the checkout while a release runs.
`npm run deploy:bg` passes the sha it
launched for, and step 0 refuses if HEAD is no longer that commit. When the
wrapper let changed indexes through because of a resume, it also passes
`RELEASE_BG_EXPECTS_INDEX_RESUME=1`, and step 2 refuses if the index step is no
longer resumable by then, rather than deploying indexes and letting step 3 answer
itself.

Hosting and Android are recorded but never skipped: they are cheap to redo, and
step 7 has to compare the live sites against the bundle the rerun built. Every
skip prints a `RESUMED:` line naming the commit. The file is deleted once the
release finishes and `.release-state` is written. A dry run neither writes nor
deletes it. `RELEASE_FORCE_FUNCTIONS=1` also overrides the step 5 skip.

A resumed step 5 deploys nothing, but it still names functions that left the
code since the last release, with the `firebase functions:delete` line for each.
It recomputes the list from the built `lib/` and `.release-functions`, which is
two file reads and nothing else.

A different commit never skips anything: its sha is not in the file, and the
first step it records clears the old lines.

The rule lives in `scripts/release-progress.sh`, sourced by both `release.sh`
and `release-bg.sh`, so `npm run deploy:bg` resumes the same way the foreground
run does.

**The stop message names what is live.** A stopped run lists every step recorded
for the commit:

```
RELEASE STOPPED during: deploying the admin functions codebases (functions:default)
Completed and LIVE for e245053:
    - firestore indexes (steps 2-3)
    - firestore rules (step 4)
    - functions:mytribe, fleet verified (step 5)
```

Fix the cause and run `npm run deploy` again on the same commit. If `main` has
moved on in the meantime, the new commit gets a full run, because nothing
recorded was verified for that code.

### The release checks that the deploy actually delivered

Step 5 reads the fleet back after the functions deploy reports success, and
refuses the release if what it deployed is not there (#503).

This exists because a deploy can report success and lose functions. On
2026-08-11 a hand-run deploy lost one 25-function batch and did not stop. The
24 that already existed quietly kept serving their previous revision, so
nothing 404'd, no screen broke, and the run looked fine. The only one that left
a mark was `twilioVoice`, new that afternoon and inside the lost block, so it
was never created at all, and with it PR #349's P0 business-hours fix never
reached production. Nobody found out for eight days, and then only because an
unrelated tool happened to look.

The batch loop already refuses when firebase TELLS it a batch failed. This is
the other half: checking the fleet itself rather than the deploy tool's account
of it. Two verdicts, both refusals:

- **missing** — the name is not in the fleet. It was never created.
- **stale** — it is there, but its source predates this run, so the deploy
  claimed it and the function is still running older code.

It asks only about the names *this run* deployed. A narrowed release deploys a
subset on purpose, so the rest of the fleet is legitimately older; judging the
whole fleet would refuse every narrowed release. The fleet-wide question is the
drift diff below, which is a human-run tool and not a gate.

It runs inside step 5 rather than at the end, for step 5's own reason: the
clients must not ship ahead of the backend, and a verify that ran after hosting
would defeat that.

**When it cannot answer, the release continues.** An unreadable or suspiciously
small fleet read is reported as "could not verify" and does not fail the run,
because an empty success is indistinguishable from a real zero (ADR-0004) and
refusing a good release on a failed lookup is its own harm. Only a fleet that
was read and disagrees stops the release. `RELEASE_SKIP_FLEET_VERIFY=1` turns
it off; a dry run skips it, having deployed nothing to check.

**What it does not cover.** The AuntieOS codebases behind
`RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` (`default`, `reconcile`) are deployed in
step 5b and are not verified. They are retried on transient errors (#840), which
is not the same thing. Extending the verify to them is worth doing and is not done.

**Why there is no scheduled version.** A cron check would catch a hand-run
deploy, which is what 2026-08-11 was and what this gate cannot see. It needs a
Firebase credential in CI, and the repository has none: the only secret
`ci.yml` uses is `MAPBOX_DOWNLOADS_TOKEN`. Adding a service-account secret with
`cloudfunctions.viewer` would be enough, since listing functions is a read.
Until then, running the drift check by hand after any deploy that did not go
through `npm run deploy` is the whole of the coverage.
### Checking source and deployed runtime options agree

ADR-0004 recorded that `memory` disagreed between source and the deployed
fleet for 53 functions on 2026-08-04, and that nobody had a repeatable way to
check `cpu`, `minInstances`, `maxInstances`, `timeoutSeconds` or `region`
either — every one of those was read from source, never confirmed against
what was actually running (issue #453). `mytribe/functions/scripts/runtimeOptions`
is that check now. It resolves the exact expected shape for every function
from `index.ts`'s `setGlobalOptions` and `lib/runtimeOptions.ts`'s named
constants, with real inheritance (a function with no override gets the fleet
default; one that overrides `minInstances` still gets the fleet's `cpu`), and
diffs it against a deployed dump the operator produces. **Source is
authoritative.** ADR-0004 already worked out what the fleet's shape should
be — `cpu: 1`, `memory: 256MiB`, the named constants' `maxInstances`
policy — and decided it, not merely described it. A mismatch this tool finds
means redeploy to match source, not edit source to match whatever happens to
be running; the one exception is a deploy an operator changed on purpose for
a reason source doesn't yet capture, which is exactly the conversation this
tool exists to force before anyone touches the fleet again.

**Run it read-only first, no deployed data needed:**

```
npm --prefix mytribe/functions run runtime-options:expected
```

Prints the resolved expected shape for all ~250 functions as JSON. Useful on
its own — it's "what does source currently declare, exactly" with inheritance
already resolved — and it fails loudly (nonzero exit, every unresolved export
named) if a future function's options object uses a shape the extractor
hasn't been taught, rather than silently skipping it.

**Then get the deployed shape.** Three ways, in order of preference:

1. **`firebase functions:list --json`** (#504). Run from `mytribe/`:

   ```
   npx firebase functions:list --json > /tmp/deployed.json
   ```

   No operator step, works from an agent session, and reports ALL SIX fields
   flat on each row (`cpu`, `minInstances`, `maxInstances`, `timeoutSeconds`,
   `availableMemoryMb`, `region`). It also carries
   `source.storageSource.generation`, a GCS generation in microseconds since
   the epoch, which decodes to **when that function last deployed**. That is
   the field the diff's "Deployed source spans ..." line is computed from, and
   it is what found the lost deploy batch in #503.

   This entry used to say the six-field picture needed an operator running
   gcloud. That was true of the MCP tool below and false of the CLI; nobody
   had tried the CLI.

2. The Firebase MCP `functions_list_functions` tool also works from an agent
   session (confirmed 2026-08-19), but reports only `function`, `version`,
   `trigger`, `location` and `memory` — never `cpu`/`minInstances`/
   `maxInstances`/`timeoutSeconds`, and no deploy time. Save its raw JSON
   result (the `{"functions":[...]}` object) to a file. Use it only when the
   CLI is unavailable.

3. The operator can also run:

   ```
   gcloud functions list --v2 --format=json > /tmp/deployed.json
   ```

   (`gcloud` returns empty with exit 0 from an agent session — a false
   negative, not "no functions"; this step has to be run by a human, same as
   every other `gcloud`/`firebase deploy` step in this file.) Its
   `serviceConfig.{availableMemory,availableCpu,timeoutSeconds,
   minInstanceCount,maxInstanceCount}` carries the same six fields option 1
   does, so this is now a fallback rather than the only complete answer.

All three shapes are auto-detected; you do not tell the tool which one you
handed it.

**Then diff:**

```
npm --prefix mytribe/functions run runtime-options:diff -- /tmp/deployed.json
```

Prints only the functions that disagree — not all ~250, which is why this has
never been fixed by eyeballing a full list — plus a deploy-window line and two
buckets worth reading even when the mismatch table is empty.

**Build `lib/` before you trust any of it.** `scripts/function-targets.js`, and
anything else reading the built output, reads `mytribe/functions/lib`. A stale
`lib/` under-reports the fleet by however many functions have landed since it
was built: an eight-day-old one reported 235 of 253 and briefly made eighteen
functions look invisible to the release. `npm --prefix mytribe/functions run
build` first.

The buckets:

- **Declared in source but absent from the deployed dump.** Building this
  tool against the live fleet on 2026-08-19 found 17 (see issue #486, filed
  with the exact list), including `twilioVoice` and the whole quote-decision
  and booking-reschedule family (`acceptQuote`, `denyQuote`, `resendQuote`,
  `requestBookingReschedule`, `resolveBookingRescheduleRequest`,
  `listRescheduleRequests`) and the billing-card callables
  (`getMyPaymentMethod`, `createBillingSetupSession`, `syncMyPaymentMethod`,
  `removeMyPaymentMethod`). That's not a runtime-options mismatch — it's
  those functions never having shipped, or having shipped under a different
  name — and it's a bigger finding than the one issue #453 asked about. This
  bucket will keep moving as the fleet does; re-run the tool rather than
  trusting this count. Chase it separately; don't fold it into a
  memory/cpu conversation.
- **Deployed but not declared here.** Expect roughly a dozen: AuntieOS's own
  functions share the `auntieos-ttpc` project (`setAdminClaim`, `listAdmins`,
  the `clear_dossier_household_notes`/`nightly_reconcile`/
  `recap_recent_comms`/`synthesize_kinfolk_profile` Python functions, and a
  few more), and this bucket is where they show up. A NEW name here that
  isn't one of those is the actual signal to chase.

v1 functions (`onAuthUserCreate`, the only one in this fleet) are excluded
from field comparison entirely rather than diffed against a guessed SDK
default — see `GEN1_COMPARABLE_FIELDS` in `scripts/runtimeOptions/model.ts`
for why. It deployed to `us-east1` when this tool was built, which is worth a
look, but it's a manual observation, not something this tool asserts.

The live run on 2026-08-19 found **zero field-level mismatches** across all
234 functions present on both sides. Read plainly: the memory drift ADR-0004
recorded on 2026-08-04 is gone — some deploy between then and now already
brought the fleet back to what source declares (`256MiB` fleet-wide, plus the
two `512MiB` Twilio inbound overrides, which matched). ADR-0004 decision 5
("do not touch memory... the operator's call") is answered: nothing to touch,
carried out. That leaves the 16-function existence gap above as the real open
item, not memory.

Unit tests for the resolver and the diff live beside the code:
`scripts/runtimeOptions/model.test.ts` (fixtures: inheriting the global, one
per named constant, a deployed shape disagreeing on every field at once) and
`scripts/runtimeOptions/extractSource.test.ts` (fixtures for every call shape
the extractor recognizes). Both run under `npm --prefix mytribe/functions
test`.

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

### Templates to import after a release

Some merges add a notification template that the release cannot load for you.
The seed files ship inside the functions deploy, and templates reach Firestore
only through the importer (operator ruling, issue #468). So each row below is an
operator step after the first release that contains it.

Until a template is imported, its notification still goes out on the generic
fallback (`mytribe/functions/src/notifications/fallbackTemplate.ts`): email and
push carry content-free copy pointing at AuntieOS, and **SMS is skipped**
(operator ruling 2026-08-23, a segment costs money).

| Template | Added by | What is missing until it is imported |
|---|---|---|
| `security.account.locked.operator` | #869 | The operator's lockout alert names neither the household nor the account email, and sends no SMS. |
| `security.failedLogin.attempts.operator` | #877 | The operator's 5-failure warning does not name the household, the account email or the attempt count, and sends no SMS. |
| `security.failedLogin.budgetExhausted.operator` | #891 | The alert that an account's failed sign-ins stopped counting for 24 hours names neither the household nor the account email, and sends no SMS. |
| `security.account.locked.spike.operator` | #891 | The alert that 3 or more accounts locked within 30 minutes does not give the count or the window, and sends no SMS. |
| `security.breach_attempt.staff` | #892 | When a staff account uses "I did not ask for this reset", the alert does not name the staff account, the IP or the incident record. |

To import, follow [the template import list](#importing-notification-templates):
Admin, then **Templates**, then **Import from repo** on web or the **Import** tab
on Android, then read the plan before pressing **Import**. A template new to
Firestore shows `create` on every channel and needs nothing ticked. Do not tick
**Replace the stored copy with the repo wording** on an unrelated `skipped` row to
get it in.

#### What the failed-login lock does and does not see (#891)

The lock counts only failures our own sign-in clients report to
`recordFailedLogin`. A script that calls Firebase Auth directly never reports,
so it never warns or locks anyone here; against that, the only protection is
Firebase Auth's own throttling (`TOO_MANY_ATTEMPTS_TRY_LATER`). The reports
themselves are limited to 30 per client IP per 5 minutes (the IP Google
appended, not one the caller wrote) and 15 per email per 24 hours. When a real
account uses its 15, you get `security.failedLogin.budgetExhausted.operator`,
because for the next 24 hours nothing warns or locks that account. When 3 or
more accounts lock within 30 minutes, you get `security.account.locked.spike.operator`
on top of each lock's own alert. A locked account can still request up to 10
resets per lock from portal Android and portal desktop.

#### Confirm the IP key after the release (#891, #908, #910)

Each callable answers on two URLs, and both must key on your real address. You
run these; they call production.

Steps 2 and 3 cover `recordFailedLogin` and `requestPasswordReset`. Step 5 adds
`requestPrimaryRecovery`, which #910 moved onto the same key.

1. Get the `run.app` URL of each callable:

   ```bash
   gcloud run services describe recordfailedlogin --region us-central1 --project auntieos-ttpc --format 'value(status.url)'
   gcloud run services describe requestpasswordreset --region us-central1 --project auntieos-ttpc --format 'value(status.url)'
   ```

   If `run services describe` finds nothing, the same URL is in
   `gcloud functions describe recordFailedLogin --gen2 --region us-central1 --project auntieos-ttpc --format 'value(serviceConfig.uri)'`.

2. Send one forged report to each URL of `recordFailedLogin`. The address is not
   an account, so nobody is warned or locked:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/recordFailedLogin' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"ip-probe-891@example.com"}}'
   curl -s -X POST '<recordfailedlogin run.app URL>' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"ip-probe-891@example.com"}}'
   ```

   Both answer `{"result":{"ok":true}}`. In the Activity Log, the two newest
   `AUTH_LOGIN_FAIL` rows must each show your real address as `ip`.

3. Send one forged reset to each URL of `requestPasswordReset`, using a test
   kinfolk account you own (an audit row is written only for a real account).
   Each sends that account a reset email and uses one of its 3 resets for the day:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPasswordReset' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"<test kinfolk email>"}}'
   curl -s -X POST '<requestpasswordreset run.app URL>' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"<test kinfolk email>"}}'
   ```

   The two newest `AUTH_PASSWORD_RESET_REQUESTED` rows must show your real address.

4. In Logs Explorer, filter on `jsonPayload.event="clientIp.untrustedRightmost"`
   and on `jsonPayload.event="clientIp.noForwardedFor"` for the last hour. Both
   should be empty.

5. #910: send one forged recovery request naming a household you own. It files a
   real `recoveryRequests` row for you to review and close, emails
   `AUNTIE_NOTIFY_EMAIL`, and uses one of that household's 3 requests per address
   per hour:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPrimaryRecovery' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"familyId":"<your test tribe id>","contactMethod":"email","newContact":"ip-probe-910@example.com"}}'
   ```

   It answers `{"result":{"ok":true}}`, and the newest
   `AUTH_RECOVERY_REQUESTED` row must show your real address as `ip`.

   `getInvitePreview` and `claimInviteSignup` key the same way but write no audit
   row, so they are confirmed by step 4 being empty rather than by a row.

What a failure means:

- A row shows `1.2.3.4`: that URL adds no entry of its own, so the function keys
  on what the caller wrote. Stop and report it.
- A `clientIp.untrustedRightmost` error, or rows showing `untrusted` as `ip`: that
  URL adds more entries than one. Its `rangeClass` says what sat in the rightmost
  place (`googleFrontEnd`, `private` and so on). The function refuses to guess
  further left, so every caller on that URL shares one 30-per-5-minute bucket
  until `TRUSTED_PROXY_HOPS` in `loginSecurity.ts` is fixed in the next release.
  Report it.
- Every row shows the same Google address: the hop count is wrong in a way the
  ranges did not catch. Report it.

#### Rate-limit ledgers expire by TTL (#908)

`ipRateLimits`, `failedLoginEmailRateLimits`, `unknownLoginAttempts` and
`passwordResetEmailRateLimits` now carry `expiresAt` (their longest window plus
one hour), with TTL policies declared in `mytribe/firestore.indexes.json` next
to `notificationDedupe.expiresAt`. That file changed, so the release's index
step (step 3) asks before deploying it: a detached `deploy:bg` run refuses and
tells you to run the release in the foreground. After it deploys, the Firebase
console under Firestore, then TTL, lists the five policies; a new policy can take
a while to show as serving. Documents written before this release have no
`expiresAt` and stay until their next write. No backfill: they are a few hundred
bytes each, nothing lists these collections, and every new write carries the
field.

### Backfills to run after a release

Some merges change which key a stored setting belongs to. Run each row once,
after the first release that contains it and after that release's template
import above. Every backfill here is a dry run by default, and **before any
write, run `npm run test:scripts:emulator` and read the pass count.**

| Backfill | Added by | What it fixes |
|---|---|---|
| `backfill:operator-warning-override` | #877 | An operator who turned off or locked the failed-login warning, or one of its channels, on the Business tab saved that on `auth.failedLogin.attempts`. That key is household-only now, so the setting stopped applying to operators. This copies it to `security.failedLogin.attempts.operator`, only where that key has no setting yet. |
| `backfill:emergency-contacts` | #829 | Copies the flat `emergencyContact*` fields, and for a household with none the old `families` customFields copy, into `emergencyContacts[0]` - the array the callable and every client now read. |

For `backfill:operator-warning-override`:

1. `npm run test:scripts:emulator`
2. `npm --prefix mytribe/functions run backfill:operator-warning-override`
   Reads only. The first line is the project and the second the target: check
   they name the right project and `PRODUCTION`. Then read the old value and
   the planned `WRITE` line.
3. `npm --prefix mytribe/functions run backfill:operator-warning-override -- --allow-prod`
   Needs `GOOGLE_APPLICATION_CREDENTIALS`. It takes the project from `--project <id>`
   or from `project_id` in that credentials file and refuses to guess, and it
   refuses to run while `FIRESTORE_EMULATOR_HOST` is set.
4. Re-run step 2. It reports `target-exists`, or the same no-op as before.

The script never overwrites a setting the new key already has. It copies the
whole business-stream setting, locks and lock reason included, because a
locked channel delivers differently from an unlocked one.

For `backfill:emergency-contacts`:

1. `npm run test:scripts:emulator`
2. Rehearse the real write against a local emulator first (`--emulator-apply`,
   #893), never production: from `mytribe/`, `firebase emulators:start --only
   firestore --project mytribe-scripts-emulator-test`, then in a second
   terminal, with `FIRESTORE_EMULATOR_HOST` set to the address it printed
   (`127.0.0.1:8080` by default, from `mytribe/firebase.json`):
   `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm --prefix mytribe/functions run backfill:emergency-contacts -- --emulator-apply`
   Refuses without `FIRESTORE_EMULATOR_HOST` set, and refuses alongside
   `--allow-prod`. Read the printed counts and the per-household diff.
3. `npm --prefix mytribe/functions run backfill:emergency-contacts`
   Dry run against PRODUCTION (no `FIRESTORE_EMULATOR_HOST` this time). The
   first two lines are the project and the target: check they say the right
   project and `PRODUCTION`. Read the diff for every household and every
   stale `families` row before applying.
4. `npm --prefix mytribe/functions run backfill:emergency-contacts -- --allow-prod`
   Needs `GOOGLE_APPLICATION_CREDENTIALS` and refuses while
   `FIRESTORE_EMULATOR_HOST` is set.
5. Re-run step 3. Every plan should now report `skip` (`already-has-array` or
   `no-flat-fields`) - nothing left to migrate.

Never overwrites a non-empty `emergencyContacts` array, never bumps
`updatedAt`, and never deletes the kinfolk flat fields (they stay readable
until this run is verified). Dates on the migrated contact are the original
record's, never the migration time.

### Repairs to run after a release

A repair rewrites data a shipped defect already wrote. The code fix stops new bad
data; it does nothing for what is stored, because Firestore keeps what it was
given. Every repair here is a dry run by default, and **before any write, run
`npm run test:scripts:emulator` and read the pass count.**

| Repair | Added by | What it fixes |
|---|---|---|
| `repair:duplicate-vet-clinic-id` | #901 | Before #873 (PR #900), portal web appended a second `vetClinicId` row to `families/{id}.customFields` on every no-schema save, so a household's list grew by one row per press of Save Changes. #900 stops new duplicates but only folds a key a client actually sends, so stored ones stay. This keeps the NEWEST copy (the last in the array, which is the one portal web already displays) at the oldest copy's position, drops the rest, and leaves every other row and every timestamp alone. |

For `repair:duplicate-vet-clinic-id`:

1. `npm run test:scripts:emulator`
2. `npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod`
   Reads only. The first line printed is the target: check it names the right
   project, `PRODUCTION` and `DRY RUN (writes nothing)`. Then read the counts and
   the per-household lines. `Households whose copies disagree` is the number
   where the older copies name a different clinic from the newest, so the repair
   changes what the office would read off the record, not just the row count.
3. `npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod --apply`
   Needs `GOOGLE_APPLICATION_CREDENTIALS`. `--allow-prod` says WHERE and
   `--apply` says WHETHER TO WRITE; `--allow-prod` is refused while
   `FIRESTORE_EMULATOR_HOST` is set, and without it nothing reaches production.
   `--dry-run` forces the dry run back and wins in either flag order.
4. Re-run step 2. It reports zero households: the repair is idempotent.

`updatedAt` is not bumped and no repair stamp is written, so a repaired household
keeps the times it already had.

### Read-only reports to run after a release

These write nothing. Run each once after the first release that contains it and
read the counts. A non-zero count is a list of documents to look at, not
something to fix from the terminal.

| Report | Added by | What it answers |
|---|---|---|
| `report:duplicate-kinfolk` | #890 | Whether Add Kinfolk already made two households for one family: households with the same primary phone or email created close together, by `createdAt`, or by the document's create time for households made before `createdAt` was stamped. |
| `report:duplicate-notifications` | #832, #866 | Whether a household was already sent the same notification twice, or two payment confirmations about one invoice within 10 minutes. |

1. `npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id>`
   The first line printed is the target: check it names the right project and
   production. It refuses `--allow-prod` while `FIRESTORE_EMULATOR_HOST` is set,
   and without `--allow-prod` it runs only against the emulator.
2. `npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id>`
   It has no `--allow-prod` flag because there is nothing to allow: its test
   greps the source and fails on any write call.

### Merged branches are deleted after the tag

Immediately after step 9, `scripts/prune-merged-branches.sh` deletes remote
branches already merged into `main`. Nothing deleted one before, and by
2026-08-04 origin held 197 with 180 of them merged, so `git branch -r` was
mostly archaeology.

It runs there, past the point where the release is already true, and it can
never fail the release. Both facts are the same decision: a non-zero exit here
would turn a cosmetic problem into an operator waking up to a red release that
actually shipped.

Four things it refuses to delete: anything not an ancestor of `origin/main`
(checked per branch against that branch's remote sha, not from one `--merged`
listing), the head of any open PR (read from `gh`; a missing or unauthenticated
`gh` returns an empty list indistinguishable from "none open", so it skips
entirely rather than guess), `main` and the release's own branch, and anything
merged more recently than `BRANCH_PRUNE_MIN_AGE_DAYS` (default 1).

That last guard exists because of a real case: PR #231 merged while a second
commit was still being pushed to its branch, so the merge took the first commit
only and the branch outlived its PR carrying work that had not landed. The
ancestor check would NOT have saved it, because the branch was merged. It just
was not finished.

Every deletion is recorded first, one line per branch, to
`~/tribetails-branch-prune-<date>.txt`. Each line restores that branch with a
ref push of the recorded sha. Skipped branches are reported with counts, because
a prune that prints only its deletions reads as "everything mergeable is gone".

`RELEASE_PRUNE_BRANCHES=0` skips the step.

List releases oldest-first with `git tag -l 'release/*' | sort`. To revert:
hosting rolls back instantly from the Firebase console, as above. Functions
and rules do not, and `release.sh` itself only runs from `main`, so it cannot
redeploy a tag directly. Either check the tag out somewhere other than your
`main` worktree and run `scripts/safe-deploy.sh` against it target by target
(see below), or `git revert` forward to that state on `main` and release
normally.

### Both Android clients ship with the web

Steps 1c and 6b exist because Android did not ship at all, for a long time, and
nothing said so. The clients were built to parity, the same callables and
contracts and invoice state table, held honest by tests in every tree. The
release script shipped functions and two hosting targets and never touched
Android. Parity was real in the source tree and fiction in production: by
2026-07-28 the newest APK was versionCode 318 against a web build of 518, which
is 47 commits and ~13,400 added lines nobody could run.

Staleness was not the whole cost. The deployed rules revoked client-direct
invoice writes on 2026-07-28 (`invoices allow create/update/delete: if false`,
ADR-0002) and Android's writer moved to callables in PR #105, so any APK from
before #105 gets `PERMISSION_DENIED` on every invoice create, edit and delete.
A client that cannot ship rots against a server that keeps moving.

**Then it happened again, to the other app.** The fix landed as one hardcoded
`auntieos-admin/android`, so it ended the drift for the operator app and left
the Kinfolk Portal's Android client in the identical hole, under a comment
describing that hole. There are two registered, active Android apps in
`auntieos-ttpc`, and only one of them was in the release:

| App | Package | Source | Gradle task | APK |
|---|---|---|---|---|
| AuntieOS operator | `com.tribetails.auntieos` | `auntieos-admin/android`, module `:app` | `:app:assembleRelease` | `app/build/outputs/apk/release/app-release.apk` |
| Kinfolk Portal | `com.kinfolk.portal` | `mytribe/`, Kotlin Multiplatform, **root** module | `:assembleRelease` | `build/outputs/apk/release/kinfolk-portal-release.apk` |

The two builds are not the same shape, which is the part worth remembering.
`mytribe` applies `com.android.application` to the root project, so there is no
`:app` to address and `:app:assembleRelease` does not exist there; the APK is
named from `rootProject.name`, which is `kinfolk-portal`, not `mytribe`.

The builds run at 1c, before the first deploy, so a failure costs nothing. The
uploads run at 6b, beside hosting. **CI cannot do either**: release signing needs
the keystore, and the Mapbox SDK needs a downloads token, and both are per
machine and gitignored. That is why this lives in the release you run locally
and not in Actions. What it needs:

| Needs | For | Where |
|---|---|---|
| `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | operator app | `auntieos-admin/android/local.properties` |
| `MAPBOX_DOWNLOADS_TOKEN` | operator app | `~/.gradle/gradle.properties`, or the environment |
| `sdk.dir` (or `ANDROID_HOME`) | portal app | `mytribe/local.properties` |
| `~/.android/debug.keystore` | portal app, see signing below | Android Studio, or `keytool` |
| An App Distribution tester list | both | Firebase console, per project |

A missing keystore, token or SDK **refuses the release** at 1c rather than
shipping a web half, because a partial release is how the clients diverged to
begin with. `RELEASE_SKIP_ANDROID=1` drops both when you mean it;
`RELEASE_SKIP_ANDROID_AUNTIEOS=1` and `RELEASE_SKIP_ANDROID_MYTRIBE=1` drop one
and keep the other, which is what you want when a single app's build is broken:
the all-or-nothing switch would turn one broken app into two unshipped ones.

**The portal app is signed with the Android debug keystore.** Not the release
keystore the operator app uses. There is no Play Store listing for either app
and App Distribution rejects an unsigned APK, so the `signingConfigs` block in
`mytribe/build.gradle.kts` points `release` at `~/.android/debug.keystore` with
the well-known public `android`/`androiddebugkey` credentials. That is a real
difference in what testers install, not a formality: a debug-signed APK cannot
be upgraded in place to a release-signed one later, and it is not shippable to
Play. It is recorded here rather than quietly ridden because "release build"
and "release signing" are not the same claim.

**The portal app's version does not move.** `versionCode = 2` and
`versionName = "0.2.0"` are literals in `mytribe/build.gradle.kts`, so every
build of it reports as `0.2.0 (2)` whatever the code, and Android will not treat
a newer one as an upgrade. The operator app solved this in `auntieos-admin` by
deriving both from git (`git rev-list --count` and the short SHA); the portal app
has not, and until it does the release note is the only thing telling two of its
builds apart.

A distribution failure at 6b is loud but not fatal: the web has already landed
by then, the signed APK is on disk, and the run prints the retry command with
its audience flags. Failing the release there would report a good deploy as
broken. One app's failed upload does not stop the other's: the loop carries on,
and each app gets its own line in the run and its own line in the tag, so a tag
never says "android: distributed" when one of two went out.

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
refusal prints the command that adds a tester. One audience covers both apps:
App Distribution's roster is per project, and a second per-app list would only
be a first list to forget to update.

The operator app's `versionName` embeds the short SHA (its `build.gradle.kts`
builds it from `gitShortSha`), so a tester's screenshot names the commit it came
from without anyone checking the console. The portal app's does not; see above.

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

## Adding a new employee

**Mint the `admin` custom claim with `setAdminClaim`. Adding the uid to
`AUNTIE_OPERATOR_UIDS` is not enough, and it is not the same thing.**

RULING O-6 makes the `admin` custom claim the primary staff signal. The env
allowlist is a **logged transition fallback**, kept only until every real
operator's claim is confirmed minted, and then decommissioned. `isStaff`
(`mytribe/functions/src/lib/staffGate.ts`) is the single gate every staff check
goes through, and when it matches on the allowlist without a claim it warns:

```
admin.allowlist.fallback.used
  AUNTIE_OPERATOR_UIDS env-allowlist path matched; admin custom claim missing.
```

**That log line is the detector.** If it fires for a uid, that employee is
running on the fallback and someone skipped this step. It is a `warn`, so it
does not fail anything and will sit there indefinitely.

Why it matters beyond tidiness: **Firestore and Storage rules do not consult the
env allowlist at all.** `isAuntie()` in `mytribe/firestore.rules` is
`request.auth.token.admin == true`, the claim. So an allowlist-only employee
passes every *callable* and is refused by every *rule*, which means the
callable-backed screens work while direct reads fail. That split is confusing to
diagnose from the symptom, because most of the app looks fine.

The claim also has to be minted before that employee can hold more than one
tribe, per the 2026-08-07 ruling that only an admin may be assigned several.
`kinfolkClaim.ts` refuses to designate a household for a multi-tribe account, and
recovery is a tribe-picker selection, which is the operator flow.

**On offboarding**, revoke the claim. Removing the uid from the env allowlist
alone leaves the claim minted, and the claim is the one the rules trust.

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
step 5 checks for this now (see the deploy section).

By hand, **redeploy the functions that declare the secret, not the codebase.**
The version pin is per function, so `--only functions:mytribe` spends half an
hour and a fleet's worth of the 60-per-minute mutation budget to move one
binding. Get the names from the pairs listing below, then:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy \
  --only "functions:mytribe:NAME1,functions:mytribe:NAME2"
```

The `functions:mytribe:` prefix on each name is mandatory; a bare name matches
nothing and deploys nothing without saying so. Fall back to the whole codebase
only when the name cannot be attributed to a subset.

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

### Client build config (`VITE_*`) comes from the store too

`VITE_*` is different by mechanism, not by policy. Vite inlines
`import.meta.env.VITE_*` into the bundle at build time, so whatever the build
machine holds is what every browser downloads. That is a reason to put only
public client keys in these variables. It is not a reason to keep them on one
laptop, which is where they lived until 2026-08-24. Nothing in the repo listed
which variables existed either: `VITE_ADMIN_APPCHECK_SITE_KEY` appeared in
neither `.env.example`, so a fresh clone had no way to find out it existed.

They are declared in `scripts/client-secrets.mjs`, one row per variable per app,
and release step 0c fills them from Secret Manager before anything is built:

```bash
node scripts/client-secrets.mjs --list    # what each app declares
node scripts/client-secrets.mjs --check   # resolve it; refuse if one is empty
```

**Two namespaces, and they are not interchangeable.** `ADMIN_WEB_SENTRY_DSN` is
the name of the SECRET. `VITE_SENTRY_DSN` is the name of the BUILD variable the
app reads. `client-secrets.mjs` maps one to the other, and it is the only thing
that does. A secret created under a `VITE_`-prefixed name is a value nothing
ever fetches, which has already happened once: the admin App Check site key was
first stored as `VITE_ADMIN_APPCHECK_SITE_KEY` and had to be recreated as
`ADMIN_WEB_APPCHECK_SITE_KEY`. `--list` prints both columns, and every refusal
names both.

**To store a value**, once, per secret:

```bash
gcloud secrets create ADMIN_WEB_SENTRY_DSN --project auntieos-ttpc \
  --replication-policy=automatic
printf %s "<the value>" | gcloud secrets versions add ADMIN_WEB_SENTRY_DSN \
  --project auntieos-ttpc --data-file=-
```

Unlike a function secret, no redeploy pins a version here: the next release
reads `latest` at build time, so a rotated value ships with the next build and
nothing has to be rebound.

**Precedence**, which is Vite's own and not something the release invents:

| rank | source | who sets it |
| --- | --- | --- |
| 1 | `process.env` | an explicit inline override, and how CI passes a repo secret in |
| 2 | `<app>/.env.production.local` | the release, from Secret Manager |
| 3 | `<app>/.env.local`, `<app>/.env` | you, on your own machine |

Rank 2 is written at step 0c and removed when the release finishes, and only a
production build reads it. `vite` dev and vitest never do. So the store wins a
release build while local development keeps working with no gcloud, no
credentials and no network.

### What stops a release and what only gets named

A release **refuses** when a REQUIRED variable resolves to nothing, when its
stored secret exists and the latest version is empty, or when Secret Manager
never answered for it at all (see the timeout paragraph below). It names the
variable, the secret and the command that fixes it. Two are required today:
`ADMIN_WEB_APPCHECK_SITE_KEY` and `PORTAL_WEB_MAPBOX_PUBLIC_TOKEN`. Both back a
feature that is live and that fails invisibly without them: App Check reads
`unconfigured`, and the visit route silently drops to the SVG polyline.

Everything else is **named and shipped**. Both Sentry DSNs are optional, and
that is a deliberate reading of the actual state rather than an oversight:
checked on 2026-08-24, `auntieos-admin/.env` and `mytribe/web/.env.local` both
carry an empty `VITE_SENTRY_DSN` and no other source has one. Web Sentry has
never been switched on for either app, `lib/sentry.ts` treats a blank DSN as an
ordinary state, and nothing depends on it. A release that refused would be
blocking on a capability the product does not use, which is the same defect as a
missing gate pointed the other way. So every release warns about them, by name,
and ships. Turning Sentry on is a decision worth making; it is not this script's
to force.

`RELEASE_SKIP_CLIENT_SECRETS=1` skips the check entirely if you know what is
missing.

**Every gcloud call in this step carries a 30-second timeout.** On 2026-09-13
release step 0c sat silent for 16 minutes: a gcloud child had one socket in
SYN_SENT to Google over IPv6 (a VPN was installed; IPv4 answered instantly),
and nothing printed, so the hang read as an auth prompt (#839). It now prints a
line per secret as it fetches, and `CLIENT_SECRETS_GCLOUD_TIMEOUT_MS` (a
positive integer, milliseconds) overrides the default on a network known to be
slower. Whether it is the LIST call or one secret's ACCESS call that times out,
every affected variable is marked **unreadable, never missing**: reporting it
as missing would tell you to create a secret that may already exist. A
REQUIRED value that is unreadable refuses with its own exit code, 4, and
release.sh says the store did not answer rather than "has no value". An
OPTIONAL value that is unreadable warns instead, the same call the declaration
already makes for a value confirmed absent. Either way the advice is the same
IPv4/IPv6 check, never `gcloud secrets create`:

```bash
curl -4 -sS -o /dev/null -w '%{http_code}\n' https://secretmanager.googleapis.com
curl -6 -sS -o /dev/null -w '%{http_code}\n' https://secretmanager.googleapis.com
```

After the first secret's ACCESS call times out, the rest are marked unreadable
without being spawned: a dead route stays dead for the whole run, so the worst
case is one 30-second wait, not one per secret.

**"Could not be read" is not "is missing", so check which one you got
before creating anything (#850).** When gcloud is not installed, has no
credentials, or lists nothing at all, the step still takes values from the
apps' own `.env` files, but a required value that is not there either is
reported as `could not be read`, with the reason (`gcloud is not installed`,
`no usable credentials` plus gcloud's own line, or `listed no secrets at all`).
It refuses with exit 4. The advice is the auth check, never
`gcloud secrets create`:

```bash
gcloud auth list
gcloud secrets list --project auntieos-ttpc --limit 1
```

If the first shows no active account or the second errors or prints nothing,
the fix is signing this machine in (`gcloud auth login`), and the secrets are
probably fine. Only `REFUSED: the web apps declare client build config that has
no value ... is missing` means the store answered and does not hold the value,
and only that message prints `gcloud secrets create`. The nightly preflight
printed `is missing` on 2026-09-12, 13 and 14 for three secrets that all
existed, because its runner had no Google credentials, and they were
re-created for nothing.

**A release does not build from your `.env` when the store cannot be read.**
The `.env` fallback above applies to `node scripts/client-secrets.mjs --check`
only. Release step 0c runs `--write`, and there a required value that only a
local `.env` holds is refused with exit 4, `REFUSED: Secret Manager could not
confirm these REQUIRED values`, because the store never confirmed it. Optional
values held locally warn. Sign in and re-run, or, if you have checked the local
values and mean to ship them, `RELEASE_SKIP_CLIENT_SECRETS=1 npm run deploy`.

**A secret the store listed but would not hand over** is `could not be read`
too, with gcloud's reason and advice for that secret, never
`gcloud secrets create`: `PERMISSION_DENIED` names
`roles/secretmanager.secretAccessor` and
`gcloud secrets get-iam-policy <name> --project auntieos-ttpc`; a disabled or
destroyed latest version (`FAILED_PRECONDITION`) points at
`gcloud secrets versions list <name> --project auntieos-ttpc` and adding a
version; `NOT_FOUND` means it has no versions or was deleted between the two
calls. Any account email in gcloud's text is printed as `<account>`.

Two names are deliberately outside all of this, and **neither is in Secret
Manager, so do not go looking for them there**. `VITE_SENTRY_RELEASE` is derived:
step 0c sets it to the commit being released, because a release tag maintained by
hand names the last release someone remembered to edit it for. There is no
secret behind it and nothing to create. `VITE_APPCHECK_DEBUG_TOKEN` is
per-developer and bypasses App Check attestation. It is the one genuinely
sensitive name in the set, it stays in your own `.env.local`, and it must never
be stored centrally or set in CI.

**One trap on the Mapbox token.** `PORTAL_WEB_MAPBOX_PUBLIC_TOKEN` must hold the
**URL-restricted** `web-maps-public` token, not the `MAPBOX_PUBLIC_TOKEN` sitting
in `~/.gradle/gradle.properties`. That one is the **unrestricted mobile** token,
and the #520 design says in as many words why there are two: Mapbox validates URL
restrictions from a browser `Referer` and answers a mobile SDK request `403`, so
one restricted token cannot serve all three surfaces. The split is also what
bounds the damage. This variable is compiled into a bundle any browser can read,
so putting the unrestricted token here publishes a credential whose only
protection was that it was not published.

CI previews get these from **repo secrets named after the Secret Manager
secrets** (`.github/workflows/preview.yml`), because a GitHub runner has no
gcloud and a fork PR must never be handed credentials. An unset repo secret
builds the preview anyway and the job warns which values were empty.

```bash
gh secret set PORTAL_WEB_MAPBOX_PUBLIC_TOKEN --repo sydeast/tribetails
```

The `AIzaSy...` values in the repo are Firebase Web API keys, public by design.
Access is controlled by Firestore rules and App Check.

---

## Connecting Stripe

Deploying the code is not connecting Stripe. Three of the five steps below happen
in the Stripe dashboard and none of them can be done, or verified, from this
repo. Stripe was wired but not connected for a long time, and the failure was
**silent in every direction**, so this section exists to make "connected" a thing
you can check rather than assume.

### Why a half-connection looks exactly like a working one

The webhook answers **202** to any event it cannot use: unrecognised type
(`stripeWebhook.ts`, the unhandled-type branch) or unresolvable metadata. Stripe
treats 202 as a successful delivery. So:

- The Stripe dashboard's delivery log reads **100% success**.
- `getIntegrationsHealth` reports Stripe as configured, because it checks that
  secrets are present and deliberately does not probe.
- Nothing is red anywhere.

Meanwhile the household is charged, gets Stripe's receipt, and lands on an
invoice that still says outstanding, and the reminder cron keeps chasing them.
**Do not take a green dashboard as evidence.** Use step 5.

### 1. The secrets, and which mode they are in

Both live in Secret Manager, never in `.env` (see the Secrets section above for
why, and for the redeploy trap). Set them from `mytribe/`:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY --project auntieos-ttpc
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project auntieos-ttpc
```

Check which mode you are actually in, because test-mode keys fail in a way that
looks like nothing happening:

```bash
firebase functions:secrets:access STRIPE_SECRET_KEY --project auntieos-ttpc
```

**Read the middle segment, not the prefix.** `_live_` is production and `_test_`
is test mode, and both `sk_` (secret key) and `rk_` (restricted key) carry that
segment. Stripe now steers new integrations to restricted keys, so an `rk_live_`
is a correct production key and a check that only looks for `sk_live_` calls it
wrong.

`STRIPE_WEBHOOK_SECRET` starts `whsec_` and is **per endpoint**: a secret copied
from a different endpoint fails signature verification on every delivery, which
surfaces as 400s in the dashboard rather than as silence.

#### If it is a restricted key, these are the permissions it needs

A restricted key carries an explicit permission list, and a missing one does not
announce itself. Exactly four Stripe API calls exist in `mytribe/functions/src`,
and this is the whole list:

| Permission | Access | The call that needs it |
|---|---|---|
| Checkout Sessions | write | `stripe.checkout.sessions.create` in `portal/payInvoice.ts:103` |
| PaymentIntents | read | `stripe.paymentIntents.retrieve` in `billing/stripeWebhook.ts:272` and `billing/stripeDispute.ts:360` |
| Charges | read | `stripe.charges.retrieve` in `billing/stripeDispute.ts:399` |
| Balance transactions | read | the `expand: ['latest_charge.balance_transaction']` on that same retrieve at `billing/stripeWebhook.ts:272-274` |

**Balance transactions is the one that fails silently, and it is the one people
leave off.** It is not a call of its own; it is an expansion riding the
PaymentIntent retrieve, and it is how the REAL fee Stripe charged is captured
instead of the published rate. Without the permission the expansion comes back
empty, the retrieve itself still succeeds, and `stripeWebhook.ts` does the
honest thing with nothing: `feeCents` is **omitted from the payments document**
and `feeResolved: false` is written beside it, because a `feeCents: 0` would be
a claim that Stripe charged nothing. The only other signal is one `warn` line,
`stripe.fee.unresolved`. Every payment still applies, the invoice still reads
paid, and the fee column is empty forever. Check for that log line before
believing the fee data.

Two things need **no** permission:

- **Webhook signature verification.** `verifyStripeWebhook`
  (`mytribe/functions/src/lib/stripe.ts:44-52`) calls
  `client.webhooks.constructEvent(rawBody, signatureHeader, secret)`, which is a
  local HMAC against `STRIPE_WEBHOOK_SECRET`. It never reaches Stripe, so an API
  key permission cannot fix a signature failure and a signature failure never
  means the key is under-scoped. The SDK client it goes through is constructed
  with `STRIPE_SECRET_KEY` only because the constructor demands a key.
- **Refunds, Customers, Products and Prices.** Nothing in this codebase writes
  any of them. `payInvoice` builds its line item from inline `price_data`, so no
  Price object is created. Refunds are ignored by the standing ruling (see step
  4). Grant none of these; a key that can refund is a key that can refund by
  accident.

### 2. Redeploy the functions that declare it, and not the other 220

gcfv2 pins the secret *version* resolved at deploy time. Setting a value and not
redeploying leaves the function reading the old version, or nothing at all on a
first set. This has bitten before.

**The pin is per function, so redeploy per function.** `--only functions:mytribe`
hands the CLI the whole fleet, roughly 220 functions, against a hard 60 mutations
per minute per region (see "The quota that was actually refusing the deploy"). A
full run for one secret costs about half an hour, hits 429s, and can still finish
with a handful of functions failed. Naming the ones that declare the secret costs
under two minutes.

Ask the built artifact which functions those are, rather than grepping. The
`secrets:` arrays are built from spreads of shared constants, so a regex either
misses them or over-matches:

```bash
npm run build:functions                                        # from the repo root
node scripts/declared-secrets.js --by-function STRIPE_SECRET_KEY
```

It prints `FUNCTION<tab>SECRET` pairs. Deploy exactly the names it printed, comma
separated, each carrying the `functions:mytribe:` prefix:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy \
  --only "functions:mytribe:NAME1,functions:mytribe:NAME2"
```

`STRIPE_WEBHOOK_SECRET` is declared on `stripeWebhook` alone
(`mytribe/functions/src/billing/stripeWebhook.ts:553`), so rotating the signing
secret is a one-function deploy:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only "functions:mytribe:stripeWebhook"
```

The prefix is not optional: a bare `--only functions:stripeWebhook` matches
nothing and deploys nothing, quietly. If the script cannot answer, because the
build is stale or the name resolves nowhere, deploy the full codebase rather
than guessing a shorter list, and expect the half hour.

**When a full deploy leaves functions failed with 429, retry just those.** The
failures are still serving their previous revision, so this is mixed-version, not
an outage, and a named retry of six functions finishes in a minute and a half.
"A deploy failed partway and left named functions undeployed" under *When
something breaks* has the command that lists them and the check that each one is
serving its **new** revision afterward.

### 3. Register the endpoint

There is no hosting rewrite for the webhook, so it is the bare Cloud Functions
URL:

```
https://us-central1-auntieos-ttpc.cloudfunctions.net/stripeWebhook
```

Stripe Dashboard → Developers → Webhooks → Add endpoint.

A gen-2 deploy prints the Cloud Run form of the same endpoint instead
(`https://stripewebhook-jhpz5ib3tq-uc.a.run.app`). Both route to the same
service and either works here, because Stripe signs the request **body**, not
the URL. Use the `cloudfunctions.net` form anyway: it is what every other doc in
this repo quotes, and it does not change when a service is recreated. For Twilio
the choice is not cosmetic. See *Activating the Twilio inbound webhooks* below,
where the URL is part of the signature.

### 4. Subscribe the events the code actually handles

This is the step that makes the difference between correct-but-dormant and
working. The handler recognises exactly these:

| Event | Why |
|---|---|
| `checkout.session.completed` | **The canonical one.** `payInvoice` creates a `mode: 'payment'` Checkout Session, and this is what a completed one emits. |
| `payment_intent.succeeded` | The same payment seen from the PaymentIntent. Both are handled, and a per-PaymentIntent claim at `stripePayments/{id}` makes sure one payment applies **once**. |
| `payment_intent.payment_failed` | Writes the critical audit entry and the `invoice.charge.failed` notification. Without it a declined card is silent. |
| `charge.dispute.created` | A chargeback. Records `stripeDisputes/{id}`, flags the invoice, writes a `critical` audit entry and sends the operator-only `invoice.payment.disputed` notification. Without it the money leaves the balance and the invoice still reads paid, with nothing anywhere saying otherwise. |
| `charge.dispute.closed` | How the operator learns the dispute was won or lost. Updates the same record and flag. |
| `charge.dispute.funds_withdrawn` | The money actually leaving the Stripe balance. Records `fundsState: 'withdrawn'` on the dispute and `disputeFundsState` on the invoice, plus a `critical` `BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN` audit entry. Without it nothing here distinguishes "a dispute was opened" from "the money is gone". |
| `charge.dispute.funds_reinstated` | The money coming back. Same two fields, set to `reinstated`, audited at `info`. |
| `checkout.session.expired` | An abandoned checkout. Clears `pendingCheckoutSessionId` / `pendingAt` off the invoice, and only when the stored id is the one that expired. |

`invoice.paid` and `invoice.payment_failed` are also recognised but **unreachable**:
they need a Stripe Invoice object, and `mode: 'payment'` creates none. Do not
subscribe them expecting anything.

**Do not subscribe `charge.refunded`, `refund.created` or `refund.updated`.** They
are ignored on purpose, per the standing ruling that there are no refunds and an
account balance credit is the only destination for money owed back. The webhook
answers them 202 through a named branch that logs `stripe.refund.ignored`, so a
subscription would buy a log line and nothing else. A dispute is **not** a refund
and is handled: the cardholder's bank imposes it, the operator does not grant it.

Anything else you subscribe is answered 202 and ignored. That is deliberate, but
it means an over-broad subscription buys nothing and hides nothing.

**A chargeback does not un-pay the invoice.** That was decided, deliberately, in
`billing/stripeDispute.ts`, and here is the reasoning so nobody "fixes" it.
The invoice keeps its `paid` status and `amountDue: 0`, and gains
`disputeStatus` / `disputeId` / `disputeAmountCents` / `disputeReason` /
`disputeEvidenceDueByMs` / `disputeHasEvidence` / `disputeEvidencePastDue` /
`disputeEvidenceSubmissionCount` alongside them. Flipping it
back to outstanding would restart the reminder cron against a household over
their own bank's action, and writing a reversing payment row would invent a
repayment nobody made. Where contested money ends up is the operator's call, and
`stripeDisputes/{disputeId}` plus the `critical` activity-log entries are the
record it is contested. If the dispute is later **won**, nothing needs undoing.

**`disputeStatus` and `disputeFundsState` are two different facts, on purpose.**
`disputeStatus` mirrors Stripe's dispute lifecycle (`needs_response`,
`under_review`, `won`, `lost`): where the contest stands. `disputeFundsState`
(`withdrawn` / `reinstated`, and `fundsState` on the dispute record) says whether
the balance has actually been debited, which is an accounting fact and routinely
disagrees: a dispute sits at `needs_response` for weeks with the money already
gone. The funds events carry **no cents figure of their own**. The sum that
leaves the balance is the disputed amount plus Stripe's dispute fee, and only the
disputed amount is on the Dispute object, so a debit figure here would be wrong
by the fee. Read the real number in the Stripe balance report. Neither field is
ever cleared, for the reason above: the contest did happen.

**`disputeEvidenceDueByMs` is the deadline, and `null` means there is not one.**
Stripe's `evidence_details.due_by` is when evidence must be in to challenge the
chargeback; miss it and the dispute is lost by default, so this is the field a
`needs_response` banner counts down to. It is stored in epoch **milliseconds**,
unformatted, like every other epoch number on these records. The client renders
it in the operator's own timezone, because a date formatted on the server is
formatted in the server's.

`null` is a real and expected value, and **`0` is never stored**. Stripe sends
literal `0` when the cardholder's bank allows no response at all, so a handler
that stored it would date the deadline to 1 January 1970 and show a chargeback
half a century overdue. Both that case and a payload carrying no
`evidence_details` come through as `null`, meaning "no deadline to act on", not
"the deadline was the epoch". A screen showing `null` should say the
deadline is not stated and send the operator to the Stripe dashboard, not start
a countdown. `disputeReason` is Stripe's `reason` (`fraudulent`,
`product_not_received`, `duplicate`, …) mirrored from the dispute record so a
banner can say why. It is passed through **verbatim, with no allowlist**: the
SDK types it as a plain string, Stripe adds categories, and a reason this build
has not seen must reach the operator rather than be dropped or relabelled.

**Has the operator already answered? `disputeEvidenceSubmissionCount` says, and
the deadline cannot.** Two disputes with the same date on them read as the same
banner, and one of them may have been answered a week ago while the other has had
nothing sent at all. The first operator is waiting on Stripe and should be left
alone; the second is days from losing the money by default. Three fields separate
them, mirrored from `evidence_details` on the same lifecycle write:

- `disputeEvidenceSubmissionCount`, Stripe's `submission_count`: how many times
  evidence has actually been filed. **A count of `0` is stored as `0`**, the
  opposite of what `due_by` does with its zero: there the zero is a sentinel for
  "no deadline exists", here it is a measurement, and it is the fact that drives
  the most urgent banner on the invoice. This is the field that means "sent".
- `disputeHasEvidence`, Stripe's `has_evidence`, which says evidence has been
  **staged**, not that it has been submitted. Staged is a saved draft. A dispute
  with `disputeHasEvidence: true` and `disputeEvidenceSubmissionCount: 0` has not
  been answered, and a screen that reads the two as one would stand an operator
  down days before they lose the money.
- `disputeEvidencePastDue`, Stripe's `past_due`, meaning the **last submission
  went in after the due date** and its delivery is not guaranteed. It is not
  "the deadline has passed": Stripe documents it as defaulting to `false` when
  nothing has ever been submitted, so it stays `false` forever for the operator
  who never answered. It does not replace comparing `disputeEvidenceDueByMs`
  against the clock. It adds one state that comparison cannot produce, and only
  that one: you did answer, you answered late, do not assume it landed.

`null` on any of the three means **the payload did not say**, and it is not the
same as `false` or `0`. A screen must not render "no evidence submitted" from a
null; that sentence is an accusation, and the honest reading of a null is that
this record cannot answer the question. Only an absent `evidence_details` or a
wrong-typed value produces one.

All five fields are written on the **lifecycle** events only, exactly like
`disputeStatus`. A funds event carries the whole Dispute object, but the funds
lane orders independently of the lifecycle lane, so a late `funds_withdrawn`
writing them could put a stale deadline back on a dispute that already closed, or
tell an operator who has sent nothing that they already responded.

The funds events deliberately send **no second notification**. The operator was
already pinged by `invoice.payment.disputed` when the dispute opened, minutes
earlier, and is pinged again when it closes; the withdrawal asks nothing new of
them. The loudness lives in the audit entry and an `error`-stream log line
(`stripe.dispute.fundsWithdrawn`).

The `invoice.payment.disputed` notification needs its templates in Firestore
before the email and push copies can render (the in-app copy lands regardless).
**This is no longer a command.** The operator ruled on 2026-08-18: "no, i
shouldn't seed templates at this point, we should have a importer and allow
creation of templates in the ui" (issue #468). Templates are loaded from the
admin, and `npm run seed:notif-templates` is not part of any release procedure.
The script still exists and still reads the same seed directories, but running
it against production replaces whole documents and drops the title, category,
tags and description an operator authored in the Template Bank. The importer
merges the content fields and leaves the rest alone.
<a id="importing-notification-templates"></a>
Do this instead, on the web admin or the phone:
1. Admin, then **Templates**.
2. **Import from repo** on web, or the **Import** tab on Android.
3. Read the plan. It writes nothing yet. `invoice.payment.disputed` shows one
   line per channel: `create` where Firestore has no copy, `unchanged` where the
   stored copy already matches, `skipped` where it differs.
4. A `skipped` line means somebody edited that template here. Tick **Replace the
   stored copy with the repo wording** only if you mean to lose that edit.
5. Press **Import**. The button names how many documents it will write.
A template that is refused (a Handlebars triple stash, an unparseable seed file)
is named with the reason, and nothing for it is written, including its other two
channels.

### 5. Prove it is connected

**Do not skip this.** Every prior signal in this section can be green on a broken
connection. Two collections are written *only* by the webhook and *only* after it
has resolved a real payment:

- `stripeEvents/{eventId}` — one doc per event that got past the metadata gate.
  Dispute events reserve an id here too (`appliedOutcome: DISPUTE_OPENED` /
  `DISPUTE_CLOSED`), and they resolve the household through the PaymentIntent
  rather than the gate, so read `appliedOutcome` before treating a document here
  as proof a payment landed.
- root `payments/{eventId}` — carries a `stripeEventId` field.

Make one real payment through the portal, then check in the Firebase console for
`auntieos-ttpc`:

1. `stripeEvents` has a new document. **If it is empty, nothing has ever gotten
   through**, whatever the Stripe dashboard says.
2. A root `payments` doc exists with `stripeEventId` set, an `amountCents` in
   integer cents, and `feeResolved: true` alongside a `feeCents`.
3. The invoice reads paid, and the household got the `invoice.payment.applied`
   notification.

If 1 fails, the endpoint is not subscribed to the right events or the signing
secret is wrong. If 1 passes and 3 fails, the problem is downstream of delivery
and the logs will name it.

**`feeResolved: false` with no `feeCents` is a different failure from all of
those, and everything else on the checklist still passes.** The payment landed
correctly; only the fee did not resolve. On a restricted key the usual cause is
the missing Balance transactions read permission from step 1. Otherwise it is a
transient Stripe fault on that one retrieve, which the handler swallows on
purpose so a fee lookup can never fail a real payment. `stripe.fee.unresolved`
in the logs separates "it happened once" from "it happens every time", and
every time means the permission.

### Recovering payments taken while disconnected

`payInvoice` has always stamped the Checkout Session with `familyId` and
`invoiceId`, and the metadata gate returns *before* the event id is reserved. So
a payment swallowed while disconnected is recoverable: **resend the historical
`checkout.session.completed` event from the Stripe dashboard** (Developers →
Events → the event → Resend). It applies with amount, fee, audit entry and
notification, exactly as if it had arrived on time.

This is why the fix is not just forward-looking, and it is a better answer than
hand-entering the payments.

---

## Activating the Twilio inbound webhooks

Three deployed functions turn inbound SMS, voicemail and calls into Firestore
records: `twilioInboundSms`, `twilioInboundVoicemail` and `twilioInboundCall`
(`mytribe/functions/src/twilio/twilioInbound.ts`). Deploying them activates
nothing. Until Twilio is pointed at them they receive no traffic, and until the
matching URL is pinned they answer **403**.

`docs/twilio/README.md` is the fuller Twilio picture: both integrations, the
account's known issues, the Studio Flow. This section is the part that costs an
operator an evening.

### The three URL pins are environment variables, NOT secrets

| Env var | Set on | Value |
|---|---|---|
| `TWILIO_INBOUND_SMS_URL` | `twilioinboundsms` | `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms` |
| `TWILIO_INBOUND_VOICEMAIL_URL` | `twilioinboundvoicemail` | `.../twilioInboundVoicemail` |
| `TWILIO_INBOUND_CALL_URL` | `twilioinboundcall` | `.../twilioInboundCall` |

**`firebase functions:secrets:set` on these three names does nothing.** A gcfv2
function is mounted only the secrets its own `secrets:` array declares, and all
three exports declare `['TWILIO_AUTH_TOKEN', 'SENTRY_DSN']` and nothing else
(`twilioInbound.ts:557-590`). The handlers read the URLs straight off
`process.env` (`twilioInbound.ts:136`), which a Secret Manager entry never
reaches. A value created there sits in the project looking set, and the function
never sees it. That is the same shape as the `GOOGLE_CALENDAR_ID` failure in
the Secrets section, and worth checking for first if one of these was "already
configured".

Set them as Cloud Run environment variables instead. These are `gcloud`
commands, so the operator runs them:

```bash
gcloud run services update twilioinboundsms --region us-central1 \
  --update-env-vars TWILIO_INBOUND_SMS_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms
gcloud run services update twilioinboundvoicemail --region us-central1 \
  --update-env-vars TWILIO_INBOUND_VOICEMAIL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundVoicemail
gcloud run services update twilioinboundcall --region us-central1 \
  --update-env-vars TWILIO_INBOUND_CALL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundCall
```

Service names are the lowercased export names. The alternative route is three
lines in `mytribe/functions/.env` followed by a deploy of those three functions;
that file is for non-secret configuration only, and a URL is not a secret.
**Nothing in this repo establishes whether a `gcloud`-set variable survives the
next `firebase deploy` of the same function**, so after any redeploy of these
three, re-read the value before trusting it:

```bash
gcloud run services describe twilioinboundsms --region us-central1 \
  --format='value(spec.template.spec.containers[0].env)'
```

### Why the URL has to match character for character

Twilio's signature is an HMAC over the **exact URL it POSTed to** plus the form
parameters. `twilioVerify` prefers the pinned env value and falls back to
rebuilding the URL from the request when it is unset:

```ts
const url = (process.env[urlEnv] || '').trim() || `https://${req.hostname}${req.originalUrl}`;
```

That fallback is a coin flip. Behind Cloud Functions and its proxies the
observed `req.hostname` and `req.originalUrl` can differ from what Twilio
hashed, and when they do `validateRequest` returns false, the handler answers
**403 `bad-signature`**, and the log line is `twilioInboundSms.verify.fail`,
which reads as a signature or credentials problem and is really a missing
config. A trailing slash, `http` instead of `https`, or the console holding the
`.run.app` form while the env holds the `cloudfunctions.net` form all produce
the identical 403. Both URL forms reach the same service, so either is fine as
long as **the console and the env var hold the identical string**. Use the
`cloudfunctions.net` form, since that is what the rest of these docs quote.

**With `TWILIO_AUTH_TOKEN` unset, all three fail closed with 403** and no
signature is checked at all (`twilioInbound.ts:133-134`). That is deliberate, so
a forged request can never be accepted before activation, but it means an
unmounted auth token and a mismatched URL look exactly alike from the outside.
Rule the token out first: it is a real declared secret on all three functions,
so `functions:secrets:set` plus a redeploy of those three is the fix for that
one.

### Each surface needs TWO Twilio callbacks, both pointed at the same function

This is the part that is not visible from the Twilio console, and getting it
half right loses data permanently rather than loudly. Settled by PRs #345 and
#347; the field-by-field ownership tables live in the handler comments.

**Calls → `twilioInboundCall`.** Two callbacks land on `calls_log/{CallSid}` and
neither carries what the other does:

- the `<Record>` **recordingStatusCallback** carries `RecordingUrl` and no
  `CallStatus`;
- the **call statusCallback** carries `CallStatus` and, for a `<Record>`-verb
  recording, no `RecordingUrl`. Twilio only puts one there when `record` is set
  on the `<Dial>`.

Wire only the status callback and no call ever gets a recording link, and there
is no second copy of that link anywhere in this system. Wire only the recording
callback and every call's status stays whatever the FCM push guessed. The
handler writes each field only when a callback actually states it, precisely so
the second one to arrive cannot blank the first. Twilio gives no ordering
guarantee between separate requests.

**Voicemail → `twilioInboundVoicemail`.** Same shape on
`voicemails/{RecordingSid}`:

- **transcribeCallback** carries `TranscriptionText`, and `From`/`Caller`, and
  no `RecordingDuration`;
- the `<Record>` **recordingStatusCallback** carries `RecordingDuration` and no
  transcript, no `From` and no `Caller`.

Wire only the transcription callback, the obvious single choice since it is the
one with the words in it, and every voicemail's duration stays 0 forever.
Wire only the recording callback and there is no transcript, no caller number,
and so no kinfolk match either.

In the Studio Flow's "Record Voicemail" widget that means setting **both** the
Transcription Callback URL and the Recording Status Callback URL, both POST,
both to the `twilioInboundVoicemail` URL. Pointing two callbacks at one function
is correct and intended: they write disjoint fields onto one document, keyed by
`RecordingSid`.

### Prove it

Text the number and look for a new `sms_messages` document keyed by the Twilio
`MessageSid`. Leave a voicemail and check `voicemails` has both a `transcript`
and a non-zero `durationSec`. One without the other means one of the two
callbacks is not wired. Complete a call and check `calls_log` has both a
`status` and a `recordingUrl`. A 403 in the function's logs means the URL pin
and the console disagree, or the auth token is not mounted.

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

**Kinfolk are told "This app couldn't verify itself with our servers".** That is
App Check refusing a request, and it has a switch that needs no deploy. In the
Firestore console, set `business_settings/security.appCheckMode` to `log`. Every
running instance picks it up within 60 seconds and stops refusing anything;
`log` still records what it would have refused, so the incident stays
measurable. The three values are `off`, `log` and `enforce`, and a missing or
malformed field reads as `log`.

Which callables the switch governs is a code list, `APP_CHECK_COHORT` in
`mytribe/functions/src/lib/appCheckPolicy.ts`. Everything outside it is
untouched in every mode. To read the traffic before flipping anything, filter
Logs Explorer on `jsonPayload.appCheck`: `valid` is a verified token, `invalid`
is a token that failed verification, `absent` is no token at all, and a
`jsonPayload.event` ending in `appCheck.wouldReject` is what `enforce` would
have turned away.

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

**A deploy fails with `Could not create or update Cloud Run service <name>.
Accessing secret failed: ... Secret <NAME>/versions/1 was not found`.** The
third secret trap, and unlike the two above the SOURCE is already correct. A
gcfv2 function's deployed revision keeps the secret bindings it was created
with, so removing a secret from the code does not remove it from the service.
Delete the secret itself and every later update of that function fails on a
binding nothing in the repo declares any more.

Seen on 2026-08-05: `writeDraft`, `getDraft` and `getTrainingDoc` still bound
`N8N_SHARED_SECRET`, which was deleted when n8n was retired on 2026-07-23. The
source had moved to Bearer Firebase ID tokens in the same change. Recreating the
secret to satisfy the revision would resurrect what that change deliberately
removed, so delete the functions and let the next release recreate them from
source:

```bash
cd auntieos-admin/web
npx firebase functions:delete writeDraft getDraft getTrainingDoc \
  --region us-central1 --project auntieos-ttpc --force
```

They come back on the next deploy with a clean spec. Check the source declares
them with no `secrets:` array first, or you will delete something that cannot
return.

**A deploy stops with `The following functions are found in your project but do
not exist in your local source code`.** Firebase will not delete in
non-interactive mode, so one orphan blocks the whole codebase. It names the
function. Confirm it is genuinely retired (removed from source deliberately, no
hosting rewrite pointing at it, no caller) and then delete it by name:

```bash
npx firebase functions:delete <name> --region us-central1 --project auntieos-ttpc --force
```

On 2026-08-05 this was `sendMessage`, a proxy to a retired n8n webhook that had
outlived its source by twelve days. `functions:delete` matches against the
local source, so if the CLI answers `The specified filters do not match any
existing functions` it has usually already gone; check the audit log before
assuming otherwise.

**A PR's preview deploy fails with HTTP 429, `channel quota reached`.** Not
code, and it blocks every PR at once. Firebase Hosting caps preview channels per
site and nothing expires them early; on 2026-08-05 there were 50, going back to
PR #98, every one of them merged or closed. List and delete:

```bash
npx firebase hosting:channel:list --project auntieos-ttpc
npx firebase hosting:channel:delete <id> --project auntieos-ttpc --force
```

**A functions deploy is refused with `Pass the --force option to deploy
functions that increase the minimum bill`.** Not a quota and not a rate limit,
so retrying smaller and slower cannot help: every batch is refused identically
and instantly. Something now asks for more than it used to (memory, cpu,
minInstances), and the floor it warns about is a real recurring cost. Read the
diff, then `RELEASE_FUNCTIONS_FORCE=1 npm run deploy`. Step 5 catches this on
the first batch and names the flag rather than grinding through the rest.

The 2026-08-04 case is worth knowing because the answer was to stop paying it:
the fleet went to 512MiB to survive a cold-start OOM, which raised the floor on
12 `minInstances: 1` functions. The real cause was that `googleapis` cost 98 MB
of the 248 MB import for the sake of five functions. Narrowing it to
`@googleapis/calendar` (0.9 MB) took the import to 193 MB, the fleet back to
256MiB, and the standing bill BELOW where it started.

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
  counted, so deleting them frees nothing that was being counted. Still true on
  2026-08-03 and now with the limit alongside it: **240 active against a limit
  of 4,000**, six percent, while the region held 706 revisions.
- 36 revisions pin `min-instances=1`; the other 640 scale to zero. At rest the
  project holds ~36 CPU, nowhere near a ceiling. Measured 2026-08-03: **16 vCPU
  in use against 400 available**, four percent.
- redeploying the failed names as a batch of 20 succeeds minutes later with no
  quota change in between.

2026-08-01 settled it. A run with `RELEASE_PREDEPLOY_KEEP=2` took the inventory
from 1,250 revisions to 487, a bigger reclaim than any prune before it, and
the deploy behind it still lost 26 functions. Pruning is proven to reclaim
inventory and proven **not** to make a whole-fleet deploy fit.

Read that as: the prune reclaims something other than what is being counted.

**Answered on 2026-08-03, and it was neither of the guesses.** The enforced limit
is `Per project mutation requests per minute per region` on
`cloudfunctions.googleapis.com`, **60 per minute**, returned as an HTTP 429 in
the deploy's own error text. It is a rate, not a ceiling, which is why every
capacity measurement above came back clean and why a retry minutes later always
worked. Full write-up
and the log line are under step 5, "The quota that was actually refusing the
deploy". Everything below in this section is still correct about the prune: it
reclaims inventory, and inventory was never what was being enforced.

So the fix is batching, which is now step 5's normal behaviour.

The Cloud Run CPU increase that was the open durable fix here is **done, and was
aimed at the wrong meter**: request `b36b3ae22fb04dd1b2`, Cloud Run Admin API,
`us-central1`, 200,000 to 400,000 milli vCPU, submitted 2026-08-02 20:43 and
approved a minute later. Note it is the CLOUD RUN row; Cloud Functions API
carries a CPU row of its own, still at 200,000, and reading that one is how you
talk yourself into believing the increase never landed. In use against the
raised limit: **16,000 of 400,000, four percent**. It is worth having and fixes
nothing here. The limit
that actually binds is `Per project mutation requests per minute per region` on
`cloudfunctions.googleapis.com`, and it is **60 a minute and not adjustable**:
the console types it as a System limit with Adjustable = No. There is no request
to file. Step 5 has the evidence and what to do instead, which is to keep living
inside it.

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
scripts/prune-run-revisions.sh 3                      # retention, what step 8 does
PRUNE_MAX_SECONDS=0 scripts/prune-run-revisions.sh 3  # burning down a backlog
```

It never touches a serving revision, keeps the newest N per service, and retries
the 429s the Cloud Run API returns under load.

**How long it takes depends entirely on what else is running.** Both ends of the
range were measured on 2026-08-03:

| conditions | result |
|---|---|
| nothing else running | 296 deletions, under 5 minutes, 0 failures |
| during a release | still going at 55 minutes, killed; another run lost 30 of 197 |

Roughly six seconds per deletion at six in parallel when the API is quiet, and
unbounded when it is not. Do not plan around a per-deletion constant; an earlier
version of this section asserted ninety seconds as if it were one, generalising
from the contended case alone. **Run a backlog prune when no deploy is in
flight** and it costs minutes.

**It stops after 15 minutes by default** (`PRUNE_MAX_SECONDS`), not because the
work is inherently long but because its duration is unpredictable and step 8
sits inside a release, where an unbounded tail is what makes someone reach for
ctrl-c. That is what happened at 55 minutes: it was not stuck, it was contended,
and nothing in its output could say so. 900 is three times the measured
uncontended cost of a full backlog, so it never truncates a healthy run.
Stopping early costs nothing durable, because the plan is rebuilt from the live
inventory every run and the skipped names are simply first in line. Use `0` when
you are deliberately burning down a backlog and want it to finish.

**Async deletes were considered and rejected.** `--async` returns when the
request is accepted rather than when the revision is gone, which turns the
deleted count back into an accepted count, the distinction the script exists to
keep. There is also no `gcloud run operations` surface, so async offers no
completion signal to check afterwards. It was worth pricing while a deletion
looked like ninety seconds. At six it buys nothing worth that.

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

**After ANY hand `firebase deploy`, clear the progress record.** Either delete
it or make the next run ignore it:

```bash
rm .release-progress                  # or:
RELEASE_NO_RESUME=1 npm run deploy
```

`.release-progress` describes what the release script itself shipped for a
commit. A hand deploy changes production without touching it, so a resume would
skip steps on the strength of a record that no longer describes what is live.

**The release stopped AFTER step 5 verified** (on an admin codebase, hosting,
Android or step 7). Do not write `.release-state` by hand. Run `npm run deploy`
again on the same commit: `.release-progress` skips the steps that already
shipped, and the stop message listed them. See "A stopped release resumes on the
same commit".

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

It also does not refuse to START over this (#841): `npm run setup` runs
`preflight.sh` first, and a preflight failure that is ONLY this drift exits 2
rather than 1 and no longer stops `setup` before it can install; see
"An install either matches its lockfile or it does not" above. **Never** fix
this by running `npm ci` inside `mytribe/web`, `auntieos-admin`, or
`packages/geo` directly: they carry no lockfile of their own, so `npm ci`
there exits 0 and silently installs a smaller tree than the root's. Always
`npm run setup` (or `npm ci` at the repo root).

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

**A release refuses with "gh could not ask GitHub for CI's verdict".** Step
0b, and it says nothing about CI. Since #850 the step runs
`gh auth status --hostname github.com` before the lookup and prints its output.
It names github.com because plain `gh auth status` also fails when some other
configured host, a GitHub Enterprise login say, has a bad token. "not
authenticated, or GitHub unreachable" means that check failed: run
`gh auth login` (or export `GH_TOKEN`) and re-run. "the lookup failed" means gh is signed in but the API
call errored; the error is printed, so check the network and re-run. Neither
means CI has no run. The nightly preflight had no `GH_TOKEN` on 2026-09-12, 13
and 14, and before #850 it printed "no check runs at all" for a commit CI had
passed.

**A release refuses with "GitHub reports no check runs at all for `<sha>`".**
Also step 0b, and also working as intended. gh is signed in and answered, and
`ci.yml` has no run for this commit (the could-not-ask case above now prints
its own message). To confirm from a signed-in shell, run:

```bash
gh api "repos/sydeast/tribetails/actions/workflows/ci.yml/runs?head_sha=<sha>" --jq .total_count
```

The same query the gate itself uses now, not `commits/<sha>/check-runs`: that
endpoint counts every check run on the commit, including the watcher's own and
`main-channel.yml`'s, so it is almost never 0 and would not tell you anything.
An error (not signed in, network unreachable) means `gh` itself could not be
asked; fix that (`gh auth status`, `gh auth login`) and re-run the release. A
clean `0` means `gh` is fine and `ci.yml` genuinely has no run for this
commit: read on. Any other number means `ci.yml` does have a run and the
release gate should have found it too; re-run the release before digging
further.

This happened for real on 2026-09-13 (#838): PR #837's merge landed on main as
`92786e7` during a GitHub outage, where the merge API call itself came back a
gateway error but the merge had actually completed server-side. It is a
genuine GitHub merge, not one crafted to look like one: `gh api
repos/<owner>/<repo>/commits/92786e7 --jq .commit.verification` reports
`verified: true`, signed with a key that matches one of the two published at
`https://github.com/web-flow.gpg`, GitHub's own merge-commit identity. The
bookkeeping a merge normally does alongside that git write never finished,
though: the PR was never marked merged, and the `push` event `ci.yml`'s
`on: push` listens for never fired. `gh api
repos/<owner>/<repo>/commits/92786e7/check-suites` shows exactly one check
suite for that SHA (the operator's own hand-dispatched run, hours later),
which is proof no push-triggered suite, and so no push event, was ever
created for it, not just an absence in a best-effort log.
`.github/workflows/ci.yml` has no path filter on `push`, no `[skip ci]`-style
marker stopped it, and its push concurrency group keys on `github.run_id`
(unique per run), so none of those repo-side knobs caused it either. The
push event was simply never delivered.

Recover by hand with:

```bash
gh workflow run ci.yml --ref main
```

`.github/workflows/ci-run-watch.yml` does this automatically now. It runs
every 20 minutes on a **schedule**, deliberately not on `push` or
`check_suite`: whatever swallows a push event runs through the same delivery
pipeline a webhook-triggered watcher would also depend on, and a cron tick
does not. Once main's HEAD has zero `ci.yml` runs on record and is older than
10 minutes (`scripts/ci-run-watch.mjs`, `DEFAULT_MAX_AGE_MINUTES`), it
dispatches `ci.yml` for `main` itself and writes a warning to the run's job
summary. It will not fire twice for the same commit: before dispatching it
asks whether `ci.yml` has ANY run at all for that SHA, of any event or
status, so a run it dispatched on a previous tick already counts and stands
the next tick down. That same workflow-scoped question
(`actions/workflows/ci.yml/runs?head_sha=<sha>`) is also how `release.sh`
itself reads CI's verdict now: not every check run on the commit (a scheduled
watcher's own run, or `main-channel.yml`'s, used to count and could make a
green HEAD look pending or red), only `ci.yml`'s. `RELEASE_SKIP_CI_GATE=1` is
still there for when the gate itself cannot be asked at all (`gh` down,
unauthenticated); this is for when it can be asked and the honest answer is
"nothing has judged this commit yet".

---

## Where else to look

| File | For |
|---|---|
| `README.md` | What the repo is, why one repo |
| `auntieos-admin/CLAUDE.md` | Vertical-slice rule, error-handling philosophy |
| `mytribe/functions/CALLABLE_CONTRACT.md` | Canonical request and response shapes |
| `docs/twilio/README.md` | Both Twilio integrations, the Studio Flow, the live account's known issues |
| `scripts/safe-deploy.sh` | Deploy guards, with the reasoning in the header |
| `scripts/release.sh` | The production run, step by step, with why each step is where it is |
| `scripts/release.test.sh` | Runs the release script against a throwaway repo and stubbed CLIs |
| `scripts/prune-run-revisions.test.sh` | Holds the prune's counts to what it deleted; run it by hand, CI does not |
| `auntieos-admin/docs/runbooks/e2e.md` | The Playwright harness |
| `auntieos-admin/docs/runbooks/visual-regression.md` | Visual harness, escalate-never-approve |
| `auntieos-admin/docs/handoffs/` | What a given week found |
