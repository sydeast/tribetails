# Machine setup

What a machine needs before it can build, test or release, and why each check exists. The short version (commands only) is under "Before a release" in `docs/RUNBOOK.md`.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

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
