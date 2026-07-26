# Apps runbook

How to set this repo up, run it, test it, build it, deploy it, and unstick it.

`README.md` covers what the repo IS and why it is one repo. This covers what you
DO with it. The runbooks under `auntieos-admin/docs/runbooks/` are dated incident
records, not standing instructions; this file is the standing one.

Everything below was checked against the repo on 2026-07-26. Where a command has
a trap attached, the trap is the reason the command is written the way it is.

---

## 1. The map

Five things build and ship independently. There is no root build.

| Path | What | Toolchain | Ships to |
|---|---|---|---|
| `mytribe/functions` | The real backend. Every callable. | Node 22, vitest | Firebase functions codebase `mytribe` |
| `mytribe/web` | Kinfolk portal (households) | Vite + React, vitest | `kinfolk.tribetails.com` |
| `auntieos-admin/src` | The live operator admin | Vite + React, vitest | `auntie.tribetails.com` |
| `auntieos-admin/android` | Operator Android app | Gradle | APK |
| `auntieos-admin/web/functions` | AuntieOS-owned functions | Node 22, `node --test` | Firebase codebase `default` |

Two things exist but are NOT delivery targets, and you should not add features to
either: `auntieos-admin/web/composeApp` (Kotlin Multiplatform, whose wasm admin is
superseded by `auntieos-admin/src`, and whose desktop build is paused by owner
ruling) and `auntieos-admin/sotu-hosting` (ops hosting, unrelated to the product).

All of it deploys into ONE Firebase project, `auntieos-ttpc`. That single fact is
behind most of the deploy rules in section 5.

---

## 2. First-time setup

### Enable the pre-commit hook

Do this first, once per clone. It is not automatic, and a clone without it
commits straight past the credential scan and the rules-drift check.

```bash
git config core.hooksPath .githooks
```

Verify with `git config core.hooksPath`, which should print `.githooks`.

The hook scans staged content for key MATERIAL (not filenames), checks that the
two `firestore.rules` copies are byte-identical, and runs the MyTribe functions
tests. It takes about a second on a docs change. Bypass with `--no-verify` only
with a reason in the commit message.

### Node

`mytribe/functions` and `auntieos-admin/web/functions` declare `"node": "22"`,
which is the deployed runtime. A newer local Node runs the test suites fine, but
the deployed runtime is what the functions actually execute on, so do not rely on
anything newer than 22 in `functions/src`.

### Install per project

There is no workspace root, so install in each folder you intend to touch.

```bash
npm --prefix mytribe/functions ci
npm --prefix mytribe/web ci
npm --prefix auntieos-admin ci
```

### Android SDK path

`auntieos-admin/android/local.properties` is gitignored and Gradle refuses to
build without it. A fresh clone or a new git worktree will not have one, and the
failure names the fix:

```
SDK location not found. Define a valid SDK location with an ANDROID_HOME
environment variable or by setting the sdk.dir path in local.properties
```

Copy it from an existing checkout, or write `sdk.dir=/Users/<you>/Library/Android/sdk`.

### Environment files

Copy the examples and read their comments, which explain what deliberately does
NOT belong in them:

```bash
cp auntieos-admin/.env.example auntieos-admin/.env
cp mytribe/web/.env.example mytribe/web/.env.local
```

Both are optional to fill in. The apps run with them empty, disabling Sentry and
using an auto-generated App Check debug token.

**No server secret belongs in a `.env` file.** Every real secret lives in Google
Secret Manager, bound per function through `secrets: [...]` in that function's
options. A value copied into `.env` is silently ignored while looking
authoritative, which is a worse failure than an obviously missing one. See
section 6.

The one exception is `VITE_*`, which is not an exception to the secrecy rule but
to the mechanism: Vite INLINES `import.meta.env.VITE_*` into the bundle at BUILD
time, so the value must exist when `vite build` runs and then ships inside the
JavaScript every browser downloads. Only put public client keys there. A Sentry
DSN qualifies; it is write-only ingestion, rate-limited on Sentry's side.

---

## 3. Day to day

### Run

| What | Command | Port |
|---|---|---|
| Admin | `npm --prefix auntieos-admin run dev` | **5174** |
| Portal | `npm --prefix mytribe/web run dev` | 5173 |

The admin is pinned to 5174 specifically so both can run side by side. If you
have a `.claude/launch.json` that says 5173 for the admin, it is wrong and the
browser preview will open on an empty port while the server sits on 5174.

### Test

```bash
npm --prefix mytribe/functions test     # vitest
npm --prefix mytribe/web test           # vitest
npm --prefix auntieos-admin test        # vitest
```

```bash
cd auntieos-admin/android && ./gradlew testDebugUnitTest
```

Gradle suites are deliberately NOT in the pre-commit hook; they are far too slow
for a commit gate and CI runs them on the pull request.

**Take a baseline before your first edit.** These suites are large (roughly 2000
functions, 3500 admin, 1700 Android at the time of writing) and knowing which
failures you inherited is the difference between a five-minute fix and an hour.

### Typecheck and build

```bash
npm --prefix mytribe/functions run build   # tsc, emits
npm --prefix auntieos-admin run build      # tsc --noEmit && vite build
npm --prefix mytribe/web run build
```

For a typecheck alone, `cd` first. `npx` has no `--prefix` flag: passing one
makes it print its own help and exit 0, which reads exactly like a passing
typecheck and is not one.

```bash
cd auntieos-admin && npx tsc --noEmit
```

```bash
cd auntieos-admin/android && ./gradlew compileDebugKotlin
```

`npm run build` on both Vite apps typechecks first, so a green `build` implies a
green `tsc`. The reverse is not true: `tsc --noEmit` will not catch a bundling
failure.

### Lint and format

```bash
npm --prefix mytribe/functions run lint      # eslint
npm --prefix mytribe/functions run format    # prettier, writes
```

Lint currently reports around 750 pre-existing warnings and **0 errors**. Judge
your change by the error count, not the warning count.

### Firestore rules tests

Needs the emulator, which the script starts and stops for you:

```bash
npm --prefix mytribe/functions run test:rules
```

### End-to-end (admin, against the emulator)

```bash
npm --prefix auntieos-admin run e2e:install   # once: Chromium + deps
npm --prefix auntieos-admin run e2e
```

This boots the auth and firestore emulators, runs Playwright, and tears down. It
exists because a real browser catches things jsdom cannot: a font that never
renders because the family name is wrong, and CSS cascade bugs visible only in
the emitted bundle. See `auntieos-admin/docs/runbooks/e2e.md`.

### Visual regression

`auntieos-admin/visual/` has its own harness and baselines, and it renders the
COMPOSE app, not the React admin. Read
`auntieos-admin/docs/runbooks/visual-regression.md` before running or approving
anything there. Never approve a baseline to make a red row green; escalate it.

### Local emulators

From `mytribe/`, ports are pinned in `firebase.json`:

| Emulator | Port |
|---|---|
| UI | 4000 |
| Hosting | 5000 |
| Functions | 5001 |
| Firestore | 8080 |
| Auth | 9099 |
| Storage | 9199 |

```bash
npm --prefix mytribe/functions run serve   # builds, then starts the functions emulator
```

---

## 4. Making a change

The house rule is a **full vertical slice**: backend callable + zod validation +
frontend wiring + routes + component + error handling + tests, on the React admin
AND Android. A missing callable means build the callable. See
`auntieos-admin/CLAUDE.md`, which is the authority on this and overrides habit.

The only legitimate thing to defer is something needing an EXTERNAL SECRET the
operator must physically provide. For those: stop, and name the exact secret.

Branch per task, never commit on `main`, one concern per PR. A PR stacked on
another merges into ITS OWN BASE, not into main. If you stack, watch for the
failure that has already happened here: base branch merges to main first, your PR
then merges into an already-merged branch, GitHub says MERGED, and your code is
not on main. Check with `git merge-base --is-ancestor <sha> origin/main`.

### The contract freeze

Three surfaces hand-mirror the callable request shapes: the React admin, Android,
and in some cases the portal. Nothing but review discipline keeps them in sync,
so `mytribe/functions/test/callableContract.test.ts` FREEZES the field set of
every cross-app callable, and `mytribe/functions/CALLABLE_CONTRACT.md` beside it
is the human source the mirrors are built from.

When you intentionally change a shape, do all three in the same change: update
the doc, update the frozen set, update every client mirror. A red test there is
the guard working.

---

## 5. Deploying

**Everything goes through `scripts/safe-deploy.sh`.** Not as a style preference:
both trees declare a `firestore.rules` file and both deploy into the same
project, so `firebase deploy --only firestore` from the wrong tree overwrites the
project's live rules with a stale mirror.

```bash
scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets>
```

`<prefix>` is `auntieos-admin` or `mytribe`. The wrapper enforces five things:

1. Rules push ONLY from `mytribe`, and only when the mirror at
   `auntieos-admin/web/firestore.rules` is byte-identical to it.
2. `--project` is pinned to `auntieos-ttpc`; a different one is refused.
3. A bare `firebase deploy` with no `--only` is refused. It would ship hosting,
   every functions codebase, rules AND indexes at once.
4. An admin functions deploy runs from `auntieos-admin/web`, where those
   codebases are actually declared.
5. Every refusal prints, in red, what was stopped and why, and exits non-zero.

### Dry run first

```bash
DRY_RUN=1 scripts/safe-deploy.sh mytribe -- firebase deploy --only functions:mytribe
```

Prints the firebase command it would run and does nothing else.

### The four you actually run

```bash
# the callables
scripts/safe-deploy.sh mytribe -- firebase deploy --only functions:mytribe

# live React admin at auntie.tribetails.com
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:app

# kinfolk portal
scripts/safe-deploy.sh mytribe -- firebase deploy --only hosting:kinfolk_portal

# firestore indexes (rules go the same way, from mytribe only)
scripts/safe-deploy.sh mytribe -- firebase deploy --only firestore:indexes
```

### Order that matters

**Deploy a new composite index BEFORE the code that queries it.** A query with no
index fails at runtime; it does not fail at build. Ship the index, wait for it to
finish building in the console, then ship the function.

**Deploy the function before the client that calls it**, for the same reason in
the other direction: a client calling a callable that is not deployed yet gets an
error the user sees.

### Hosting targets

Defined in `.firebaserc`, and the names are not self-explanatory:

| Target | Site | What |
|---|---|---|
| `app` | `auntieos-ttpc` | The LIVE React admin, `auntie.tribetails.com` |
| `legacy-wasm` | `auntieos-admin` | The SUPERSEDED Compose wasm build |
| `kinfolk_portal` | `kinfolk-portal` | The household portal |
| `mytribe_beta` | `mytribe-kinfolk-beta` | Beta portal |
| `sotu` | `auntieos` | Ops hosting, unrelated to the product |

The trap is `legacy-wasm`, whose site is literally named `auntieos-admin`. It is
NOT the admin anyone uses. `hosting:app` is.

---

## 6. Secrets

Server secrets live in Google Secret Manager, never in the repo and never in a
`.env`. Set one with:

```bash
firebase functions:secrets:set SECRET_NAME --project auntieos-ttpc
```

Run it from `mytribe/`. It prompts for the value, so the value never appears in
your shell history.

**Setting a secret does nothing until a function declares it.** The secret must
appear in that function's `secrets: [...]` array AND be redeployed. This has
already gone wrong once: a setup doc told the operator to set a
`GOOGLE_CALENDAR_ID` that no function ever read, so the setup looked complete and
did nothing. If you add a secret, add a test that reads the function's
`__endpoint` and asserts the name is declared.

Secrets currently bound by one function or another include `ANTHROPIC_API_KEY`,
`AUNTIE_OPERATOR_UIDS`, `CLOUDINARY_*`, `EMAIL_FROM`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `MAPBOX_ACCESS_TOKEN`, `SENTRY_DSN`,
`SMTP2GO_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`TRIBE_PIN_PEPPER`, `TWILIO_*` and `WEB_API_KEY`. Grep for `secrets: [` to get
the current list rather than trusting this one.

The `AIzaSy...` values in the repo are Firebase Web API keys. Those are designed
to be public: they identify the project, and access is controlled by Firestore
rules and App Check, not by hiding them.

---

## 7. Firestore query traps

Each of these fails SILENTLY. No error, just wrong or empty results, which is why
they are worth memorising rather than rediscovering.

**Equality skips documents that lack the field.** `where('invoiceId','==','')`
misses every document that never wrote `invoiceId` at all. Filter in memory when
absent and empty mean the same thing to you.

**`where('x','==',null)` matches only documents that HAVE the field** set to null.
On a collection where nothing has been archived yet, `where('archivedAt','==',null)`
returns ZERO rows.

**Firestore orders every Timestamp after every string.** A Timestamp bound against
an ISO-string field matches nothing and does not error. `kin_care_sessions.startTime`
and the four channel collections' `timestamp` are ISO STRINGS; range-query them
lexically. Invoices page on `date`, not `createdAt`, for exactly this reason.

**`orderBy` skips documents missing the sorted field**, so a writer that forgets
`timestamp` makes its rows invisible rather than raising.

**Status casing is unenforced.** `where('status','==','completed')` silently drops
a row stored as `Completed`. Normalize in memory, always.

**Money is integer cents.** Float dollar fields on invoices are a server-derived
projection, never an input. Read `paidCents`, never `amountDue`, to decide whether
an invoice is settled: a pre-2026-07-25 write set `amountDue` to 0 even for a
partial payment.

---

## 8. Troubleshooting

**Gradle: "SDK location not found"**
`auntieos-admin/android/local.properties` is missing. It is gitignored, so a
fresh clone or a new git worktree never has one. See section 2.

**`npm ci` fails with `EACCES` renaming into `~/.npm/_cacache`**
Two installs are fighting over the shared npm cache, which happens when parallel
work runs in several worktrees. Give the install its own cache:

```bash
npm ci --cache /tmp/npm-cache-$$
```

**`git fetch` or `git push`: `sign_and_send_pubkey: signing failed ... communication with agent failed`**
The 1Password SSH agent is not responding. It is usually transient; retry, and
unlock or restart 1Password if it persists. This one is dangerous because a
failed `fetch` leaves stale refs and everything downstream silently answers the
wrong question. `gh` uses an HTTPS token and keeps working, so cross-check with
`gh pr view` before believing a local git answer.

**Browser preview opens an empty page for the admin**
Port mismatch. The admin dev server binds **5174**; anything pointing at 5173 is
looking at the portal's port.

**A callable works locally and 500s in production**
Check the secret is DECLARED in that function's `secrets: [...]`, not just set in
Secret Manager. See section 6.

**A query returns nothing, with no error**
Almost always section 7. Check the field type before you check anything else.

**A client mirror test goes red after a backend change**
That is the contract freeze doing its job. Update
`mytribe/functions/CALLABLE_CONTRACT.md`, the frozen set in
`callableContract.test.ts`, and every client mirror, in the same change.

**Tests pass locally, CI is red**
CI runs a path-filtered matrix (admin, admin e2e, AuntieOS functions, MyTribe
functions, portal). The e2e job is the usual difference: it runs a real browser
against the emulator and catches font, cascade and auth problems that jsdom
cannot see.

---

## 9. Where else to look

| File | For |
|---|---|
| `README.md` | What the repo is, why one repo |
| `auntieos-admin/CLAUDE.md` | Vertical-slice rule, error-handling philosophy, project routing |
| `mytribe/functions/CALLABLE_CONTRACT.md` | Canonical request and response shapes |
| `scripts/safe-deploy.sh` | The deploy guards, with the reasoning in the header |
| `auntieos-admin/docs/runbooks/e2e.md` | The Playwright harness |
| `auntieos-admin/docs/runbooks/visual-regression.md` | The visual harness and its escalate-never-approve rule |
| `auntieos-admin/docs/handoffs/` | What a given week found, so it is not re-learned |
