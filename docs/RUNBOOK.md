# Release runbook

How to ship `main` to production, and what to do right after. Follow it top to
bottom from the repo root on the release Mac.

Everything else that used to live here moved to `docs/runbooks/` on
2026-09-28, with cross-references repointed at the new files:

| Doc | For |
|---|---|
| `docs/runbooks/release-internals.md` | Why each release step works the way it does, the quota history, resume, fleet verify, tagging, Android signing |
| `docs/runbooks/after-release.md` | The full procedure behind each item in "After a release" below, and the status of every data script |
| `docs/runbooks/machine-setup.md` | Setting up a new machine, and why each preflight check exists |
| `docs/runbooks/troubleshooting.md` | Every symptom seen before, with its cause and fix |
| `docs/runbooks/development.md` | Day-to-day commands, the repo map, making a change |
| `docs/runbooks/secrets.md` | Server secrets and client build config |
| `docs/runbooks/household-notifications.md` | Opening and closing the household send gate |
| `docs/runbooks/staff-accounts.md` | Adding an Owner or an Auntie |
| `docs/runbooks/stripe.md` | Connecting Stripe |
| `docs/runbooks/twilio-webhooks.md` | Activating the Twilio inbound webhooks |
| `docs/DECISIONS.md` | The operator rulings the code obeys |

---

## Before a release

1. **Be on a clean, current `main`.**

   ```bash
   git checkout main
   git pull --ff-only
   git status --short
   ```

   `git status --short` must print nothing.

2. **Check the machine.**

   ```bash
   bash scripts/preflight.sh
   ```

   It changes nothing and prints the fix for anything missing. Exit 2 means
   only that `node_modules` no longer matches a lockfile. Fix it at the repo
   root, never inside `mytribe/web`, `auntieos-admin` or `packages/*`:

   ```bash
   npm ci
   npm ci --prefix mytribe/functions
   npm ci --prefix auntieos-admin/web/functions
   ```

3. **First release on a new machine only:** the Python venv the admin
   `reconcile` codebase needs, and `npm run setup`. Details in
   `docs/runbooks/machine-setup.md`.

   ```bash
   brew install python@3.13
   cd auntieos-admin/web/functions-python
   python3.13 -m venv venv && venv/bin/pip install -r requirements.txt
   cd ../../..
   ```

4. **Android signing is on this machine.** The release builds both APKs and
   refuses without these:

   | Needs | Where |
   |---|---|
   | `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | `auntieos-admin/android/local.properties` |
   | `MAPBOX_DOWNLOADS_TOKEN` | `~/.gradle/gradle.properties` |
   | `sdk.dir` | `mytribe/local.properties` |
   | `~/.android/debug.keystore` | signs the portal app |

5. **gcloud and GitHub are signed in.**

   ```bash
   gcloud auth list
   gh auth status
   ```

   If a later step sits silent for minutes, see "Release hangs at step 0c"
   under [When something breaks](#when-something-breaks).

6. **Run the reports marked "before"** in the
   [after-release list](#after-a-release). Today that is
   `report:legacy-amount-due`, which must run before the first release that
   carries #902.

---

## Run it

```bash
RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 RELEASE_PREDEPLOY_KEEP=0 npm run deploy:bg
```

That is a full release: every functions codebase, both web apps, Firestore
indexes and rules, Storage rules and both Android apps. It takes 20 to 40
minutes. `deploy:bg` detaches, writes
`.release-logs/release-<stamp>-<sha>.log` and prints the `tail -f` line for
it.

**Run it in the foreground instead when `mytribe/firestore.indexes.json`
changed since the last release.** Step 3 asks you to confirm every index is
Enabled, and `deploy:bg` refuses rather than answer for you. The next release
is one of these (#908 added the TTL policies).

```bash
RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 RELEASE_PREDEPLOY_KEEP=0 npm run deploy
```

Three rules while it runs:

- Run it from the repo root.
- Never pipe it (`| tail`, `| tee`). The script reads its own output.
- Do not check out, commit or edit anything in this checkout until it
  finishes. The release pins the commit it started on and stops if the tree
  moves.

What it does, in order. It stops at the first failure and names the step:

| # | Step |
|---|---|
| 0 | Clean tree, on `main`, in sync with origin |
| 0a | Installed dependencies match every lockfile |
| 0b | CI is green for this exact commit, e2e included |
| 0c | Web build config (`VITE_*`) fetched from Secret Manager |
| 1 | `npm run check`: typecheck, lint, contracts, seeds, tests, build |
| 1b | Every secret the functions declare exists |
| 1c | Both Android release APKs build |
| 2 | Firestore indexes deploy |
| 3 | Waits until every index is Enabled |
| 4 | Firestore rules deploy (from `mytribe` only) |
| 4b | Storage rules deploy |
| 5 | Functions deploy in batches of 25, only the ones that changed, then the fleet is read back to prove they landed. With `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1`, the admin `default` and `reconcile` codebases follow |
| 6 | Hosting: admin, then portal |
| 6b | Both APKs go to App Distribution |
| 7 | Fetches both live sites and checks they serve the bundle just built |
| 8 | Prunes old Cloud Run revisions, keeping 3 per service |
| 9 | Tags the release number step 0 chose (`v0.3.1`), pushes the tag, prunes merged branches |

Why each step is where it is: `docs/runbooks/release-internals.md`.

**Merging to `main` is not a release.** Merges publish main's web bundle to a
fixed preview channel only. The backend behind it is production, so look but
do not submit forms there.

---

## If it stops

The last lines name the step and list what is already live:

```
RELEASE STOPPED during: deploying the admin functions codebases (functions:default)
Completed and LIVE for e245053:
    - firestore indexes (steps 2-3)
    - firestore rules (step 4)
    - storage rules (step 4b)
    - functions:mytribe, fleet verified (step 5)
```

Fix the cause, then run the same command again on the same commit. It skips
what already finished for that commit and carries on. If `main` moved in the
meantime, the new commit gets a full run.

Find the refusal text under [When something breaks](#when-something-breaks).

**If you deployed anything by hand** with `firebase deploy` while a release
was stopped, delete `.release-progress` before rerunning, so the release
does not skip work your hand deploy replaced.

### The scheduled release

`.github/workflows/nightly-release.yml` runs `scripts/release.sh` on a
GitHub-hosted runner every **Monday and Thursday at 01:00 UTC** (Sunday and
Wednesday evening in Chicago), operator ruling 2026-09-30 (#1062). It kept
its "nightly" file and variable names. A run finds nothing to do and stops
when nothing has merged since the last release, so a hand release in between
costs nothing.

The `NIGHTLY_RELEASE` repository variable picks what a scheduled run does:
`off` (nothing), `preflight` (sign in, check secrets and CI, open the
keystores, deploy nothing) or `on` (a full release). Releases by hand from the
Mac work the same with any setting.

The one-time Google Cloud setup and the signing secrets exist (#851, done
2026-09-30); a manual preflight passed that day. The commands, if it ever has
to be redone, are in
[Hosted nightly release](runbooks/release-internals.md#hosted-nightly-release).
If a run stops at "Check the release variables are set" or "Check the runner
can authenticate", that setup is what it names as missing; do not re-create
secrets on a guess (#850).

---

## After a release

Do these in order, once, after the first release that contains each one. All
of them are on you: they touch production data or the live admin.

**Scripts:** run `npm run test:scripts:emulator` first and read the pass count.
Commands below use `--project auntieos-ttpc`. For a report, `--allow-prod` only
says which database to read; each one writes nothing. For a backfill or repair,
read `docs/runbooks/after-release.md` before adding `--allow-prod`, because
there it writes.

### 1. Templates

Admin web, **Templates**, **Import from repo**. Read the plan before pressing
**Import**.

- **Six templates are new** and show `create`. They need nothing ticked:
  `invoice.payment.unapplied` (#1003), `security.account.locked.operator`
  (#869), `security.failedLogin.attempts.operator` (#877),
  `security.failedLogin.budgetExhausted.operator` (#891),
  `security.account.locked.spike.operator` (#891) and
  `security.breach_attempt.staff` (#892). Until imported they go out as the
  generic fallback, and SMS is skipped.
- **Every other template changed format** in #953 and shows `skipped`. For
  each one you never edited in the Template Bank, tick
  **Replace the stored copy with the repo wording**.
- **For each one you did edit**, leave it unticked. Open it in the Template
  Bank, where it shows **Old format**, and press **Convert**. You see both
  versions before anything is saved.

Then open one template's preview on the live admin, and drag across a long
preview on your phone.

Details: "Templates to import after a release" in
`docs/runbooks/after-release.md`.

### 2. Confirm the sign-in IP key

Five `curl` probes against production that prove the failed-login and reset
limits key on your real address (#891, #908, #910). Commands and what a
failure means: "Confirm the IP key after the release" in
`docs/runbooks/after-release.md`.

### 3. Backfills and repairs

Each is a dry run until you add the flag its section names. Read the dry run
first.

| Script | Added by | Dry run |
|---|---|---|
| `backfill:operator-warning-override` | #877 | `npm --prefix mytribe/functions run backfill:operator-warning-override` |
| `backfill:emergency-contacts` | #829 | Rehearse on the emulator first; see its section |
| `backfill:invoice-amount-due` | #902 | `npm --prefix mytribe/functions run backfill:invoice-amount-due -- --project auntieos-ttpc` |
| `repair:duplicate-vet-clinic-id` | #901 | `npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project auntieos-ttpc --allow-prod` (the repair writes only with `--apply`) |

### 4. Read-only reports

Paste the output back for a ruling. None of them changes anything.

| When | Report | Command |
|---|---|---|
| **Before** the release, and again before `backfill:invoice-amount-due` | Invoices with a total and no `amountDue` (#902) | `npm --prefix mytribe/functions run report:legacy-amount-due -- --project auntieos-ttpc --allow-prod` |
| After | Double credit from auto-apply (#977) | `npm --prefix mytribe/functions run report:autoapply-double-credit -- --project auntieos-ttpc --allow-prod` |
| After | Invoices paid over their total (#982) | `npm --prefix mytribe/functions run report:over-applied-invoices -- --project auntieos-ttpc --allow-prod` |
| After | Desktop payments that never applied (#881). Refuses `--allow-prod` | `npm --prefix mytribe/functions run report:desktop-direct-payments -- --project auntieos-ttpc` |
| After | Duplicate card charges credited (docket Q5) | `npm --prefix mytribe/functions run report:duplicate-checkout-credits -- --project auntieos-ttpc --allow-prod` |
| After | Households with two Emergency Contacts (Q2) | `npm --prefix mytribe/functions run report:multiple-emergency-contacts -- --project auntieos-ttpc --allow-prod` |
| After | Two households for one family (#890) | `npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project auntieos-ttpc` |
| After | The same notice sent twice (#832, #866) | `npm --prefix mytribe/functions run report:duplicate-notifications -- --project auntieos-ttpc` |
| After | Custom fields lost to a portal save (#873) | `npm --prefix mytribe/functions run report:truncated-custom-fields -- --project auntieos-ttpc --allow-prod` |

Scripts that wait for the data re-upload, and ones never to run again, are
listed under "Scripts and the data re-upload" in
`docs/runbooks/after-release.md`.

### 5. Household notifications stay shut

A release does not open them. Households hear nothing until you switch on
**Send notices to households** and pick a send hour in Settings,
Notifications. Before you do, read `docs/runbooks/household-notifications.md`.

---

## Rolling back

- **Web:** Firebase console, Hosting, release history, roll back. Instant.
- **Functions, rules, indexes:** these do not roll back with hosting.
  `git revert` the change on `main` and run a normal release.
- List past releases with `git tag -l 'v*' --sort=v:refname`. Releases before
  v0.3.0 are `git tag -l 'release/*'`. `git show <tag>` says what that release
  shipped.

---

## Deploying one thing by hand

Only when you want a single target and not a release:

```bash
scripts/safe-deploy.sh mytribe -- firebase deploy --only functions:mytribe:NAME
scripts/safe-deploy.sh auntieos-admin -- firebase deploy --only hosting:app
scripts/safe-deploy.sh mytribe -- firebase deploy --only hosting:kinfolk_portal
scripts/safe-deploy.sh mytribe -- firebase deploy --only firestore:indexes
scripts/safe-deploy.sh mytribe -- firebase deploy --only storage
```

`hosting:app` is the live admin. Never deploy `legacy-wasm`. `DRY_RUN=1`
prints the command without running it. Then delete `.release-progress` before
the next release.

---

## Release settings

Knobs. Most are off by default; the ones with a default say so:

| Variable | Effect |
|---|---|
| `DRY_RUN=1` | Rehearse: print every firebase command, run none, write nothing, claim nothing |
| `RELEASE_SKIP_CHECK=1` | Skip step 1. Then `dist/` is whatever was last built, which may not match HEAD |
| `RELEASE_SKIP_CI_GATE=1` | Release without CI's verdict for HEAD. For when the gate is unavailable, not for when it says no |
| `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` | Also ship the AuntieOS `default` and `reconcile` codebases. `reconcile` needs the Python venv from "Before a release". Each deploy is retried on a transient error; see "A stopped release resumes on the same commit" in `docs/runbooks/release-internals.md` |
| `RELEASE_NO_RESUME=1` | Run every step, including the ones `.release-progress` records as already done for this commit |
| `RELEASE_FUNCTIONS_FORCE=1` | Pass `--force` to the functions deploy. Needed when a change RAISES the minimum bill; see `docs/runbooks/troubleshooting.md`. Also lets firebase DELETE functions missing from source, so read the diff |
| `RELEASE_PRUNE_BRANCHES=0` | Skip deleting merged remote branches after the tag |
| `BRANCH_PRUNE_MIN_AGE_DAYS=N` | How long a merged branch stays quiet before the prune takes it (default 1) |
| `RELEASE_YES=1` | Do not prompt (CI). Preconditions still apply |
| `RELEASE_BUMP=minor` or `major` | Which part of the release number goes up (default `patch`: v0.3.1 to v0.3.2). Ignored when rerunning a stopped release, which keeps the number it announced. See "Release numbers" in `docs/runbooks/release-internals.md` |
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
| `RELEASE_PREDEPLOY_KEEP=N` | Prune to N per service before a **large** functions deploy (default 3, `0` disables). See "The quota that was actually refusing the deploy" in `docs/runbooks/release-internals.md` |
| `RELEASE_PREDEPLOY_MIN_TARGETS=N` | How many functions count as large (default 50). Below it the pre-deploy prune does not run |
| `RELEASE_KEEP_REVISIONS=N` | Revisions kept per service in step 8 (default 3) |
| `PRUNE_MAX_SECONDS=N` | Wall-clock budget for a prune (default 900, `0` unbounded). It stops at the budget, says what it skipped, and the next run re-plans those |
| `RELEASE_FUNCTIONS_ALL=1` | Deploy every function, not only the ones this release can reach |
| `RELEASE_FUNCTIONS_BATCH=N` | Functions per `firebase deploy` (default 25) |
| `RELEASE_FUNCTIONS_ROUNDS=N` | Retry rounds for functions that did not land (default 3) |
| `RELEASE_FUNCTIONS_SETTLE=S` | Seconds between batches (default 30) |
| `RELEASE_RETRY_KEEP=N` | Prune depth between retry rounds (default 2, `0` disables) |

---

## When something breaks

Each of these is written up in `docs/runbooks/troubleshooting.md`; search it
for the quoted text.

| You see | Cause |
|---|---|
| `REFUSED: installed dependencies do not match their lockfile(s)` | Stale `node_modules`. Run the `npm ci` it names, at the repo root |
| "CI is not green for `<sha>`" | A check failed or is still running on that commit. Wait or fix; do not skip the gate |
| "gh could not ask GitHub for CI's verdict" | `gh` is signed out or GitHub is down. `RELEASE_SKIP_CI_GATE=1` only for that |
| "GitHub reports no check runs at all for `<sha>`" | CI never ran on that commit. Start it with `gh workflow run ci.yml --ref main`, wait for green, rerun |
| Release hangs at step 0c, silent | gcloud stuck on IPv6, usually a VPN. Compare `curl -4` and `curl -6` to `https://secretmanager.googleapis.com` (see `docs/runbooks/secrets.md`) |
| "could not be read" for a secret | gcloud is signed out. Run `gcloud auth login`; do not create the secret |
| `Failed to validate secret versions ... not found or has no versions` | A secret the code declares was never set. Step 1b prints the `firebase functions:secrets:set` command |
| `Failed to validate secret versions` with `Failed to make request` | A Secret Manager blip. The admin deploys retry it; if the run still stops, rerun and it resumes |
| `Quota exceeded ... Per project mutation requests` | The 60-a-minute deploy limit. The release retries; a rerun resumes |
| "Pass the --force option to deploy" | A change raises the minimum bill. `RELEASE_FUNCTIONS_FORCE=1`, after reading the diff |
| Functions left undeployed after a partial deploy | Retry just those names; see troubleshooting |
| `SDK location not found` | Run `npm run setup` |
| Signing errors at step 1c | `auntieos-admin/android/local.properties` is missing a key |
| `communication with agent failed` on `git push` | 1Password is locked. Unlock it and rerun |

---

## Where else to look

| File | For |
|---|---|
| `README.md` | What the repo is, why one repo |
| `auntieos-admin/CLAUDE.md` | Vertical-slice rule, error-handling philosophy |
| `mytribe/functions/CALLABLE_CONTRACT.md` | Canonical request and response shapes |
| `docs/twilio/README.md` | Both Twilio integrations, the call flow, the live account's known issues |
| `scripts/safe-deploy.sh` | Deploy guards, with the reasoning in the header |
| `scripts/release.sh` | The production run, step by step, with why each step is where it is |
| `scripts/release.test.sh` | Runs the release script against a throwaway repo and stubbed CLIs |
| `scripts/prune-run-revisions.test.sh` | Holds the prune's counts to what it deleted. CI runs it in the `deploy-guard` job |
| `auntieos-admin/docs/runbooks/e2e.md` | The Playwright harness and both Cypress suites |
| `auntieos-admin/docs/handoffs/` | What a given week found |
