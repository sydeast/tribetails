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
| `npm run e2e` | Playwright against the emulator |
| `npm run check` | typecheck, lint, test, build. What CI runs. |
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
| 0 | Preconditions | Clean tree, on `main`, synced with origin. Shipping uncommitted or stale code is the classic incident. |
| 1 | `npm run check` | Typecheck, lint, test, build. Not optional theatre: this is what produces the `dist/` that step 6 uploads. |
| 2 | Firestore indexes | Before the code that queries them. A query with no index fails at RUNTIME, not at build. |
| 3 | Wait for indexes | The CLI returns when Firestore ACCEPTS an index, not when it is Enabled. The run blocks; the CLI will not. |
| 4 | Firestore rules | From `mytribe` only. Refused outright if the admin mirror has drifted. |
| 5 | Functions | Before the clients that call them: a client calling a function that is not there fails at runtime. |
| 6 | Hosting | Admin, then portal. |
| 7 | Verify | Fetches both live sites and compares the hashed bundle they reference against the one just built. |

Step 7 is the one whose absence hid the stale admin. Hosting can report a
successful release while browsers still get the old bundle. A release that
cannot prove it landed has told you nothing.

Knobs, all off by default:

| Variable | Effect |
|---|---|
| `DRY_RUN=1` | Print every firebase command, run none |
| `RELEASE_SKIP_CHECK=1` | Skip step 1. Then `dist/` is whatever was last built, which may not match HEAD |
| `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` | Also ship the AuntieOS `default` and `reconcile` codebases |
| `RELEASE_YES=1` | Do not prompt (CI). Preconditions still apply |

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

`grep -rn "secrets: \[" mytribe/functions/src` for the current list.

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
against old types. `npm run setup` will NOT fix this: it skips any project whose
`node_modules` directory exists, without checking staleness. Reinstall
explicitly:

```bash
FORCE_INSTALL=1 npm run setup
```

or `npm --prefix <project> ci` for just the affected project. `npm ci` rather
than `npm install`, so what lands is exactly the lockfile.

**Gradle: "SDK location not found".** Run `npm run setup`.

**Release build complains about signing.** `local.properties` needs
`KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`. Debug builds
and unit tests do not. The build names whichever is missing.

**CI red, local green.** The e2e job is the usual difference: a real browser
against the emulator catches font, cascade and auth problems jsdom cannot see.
Run `npm run e2e`.

---

## Where else to look

| File | For |
|---|---|
| `README.md` | What the repo is, why one repo |
| `auntieos-admin/CLAUDE.md` | Vertical-slice rule, error-handling philosophy |
| `mytribe/functions/CALLABLE_CONTRACT.md` | Canonical request and response shapes |
| `scripts/safe-deploy.sh` | Deploy guards, with the reasoning in the header |
| `auntieos-admin/docs/runbooks/e2e.md` | The Playwright harness |
| `auntieos-admin/docs/runbooks/visual-regression.md` | Visual harness, escalate-never-approve |
| `auntieos-admin/docs/handoffs/` | What a given week found |
