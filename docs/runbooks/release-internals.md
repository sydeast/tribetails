# Release internals

Why `scripts/release.sh` does each step the way it does, the incidents that shaped it, and how its guards work. Read this when a step surprises you or before changing the script. To run a release, follow `docs/RUNBOOK.md`; nothing here is a step you have to do.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

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

**A full release sets two knobs.** This is the command for a normal release:

```bash
RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 RELEASE_PREDEPLOY_KEEP=0 npm run deploy:bg
```

- `RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` also ships the AuntieOS `default` and
  `reconcile` codebases. Without it, everything behind an `/api/` hosting
  rewrite keeps running whatever was deployed last.
- `RELEASE_PREDEPLOY_KEEP=0` skips the revision prune before the functions
  deploy. Batching is what keeps the deploy under the CPU quota; the pre-deploy
  prune does not help and costs time on every run. Step 8 still prunes after
  verification.

`nightly-release.yml` uses the same set.

**Run it from the repo root, and never pipe it through anything.** The script
resolves every path from the root, writes state and reads its own output, so
`npm run deploy | tail` changes both its exit status and what it can see. To
watch a background run, use the `tail -f` line `deploy:bg` prints.

**Merging to `main` is not a release.** `.github/workflows/main-channel.yml`
publishes main's HEAD to one fixed Firebase Hosting preview channel per web app
on every merge that touches web code, and prints the URLs. Only the static
bundle changes there: Functions, Firestore and Auth behind those URLs are
production, so walk the channel but do not submit forms against it. Production
moves only when this release runs.

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
| 0c | Client build config (`VITE_*`) | Writes each web app's `.env.production.local` from Secret Manager. Runs before step 1 because `vite build` inlines these values; a value that arrives later ships as an empty string. See "Client build config (`VITE_*`) comes from the store too". |
| 1 | `npm run check` | Typecheck, lint, contracts, seeds, test, build. Not optional theatre: this is what produces the `dist/` that step 6 uploads. |
| 1b | Secret preflight | Every secret the code DECLARES must exist. Firebase validates these before uploading, and one missing name fails the whole codebase. Refuses here, before any deploy. |
| 1c | Android build | Assembles **both** signed release APKs, operator and portal. Runs before the first deploy so a build failure costs nothing; the uploads are step 6b. |
| 2 | Firestore indexes | Before the code that queries them. A query with no index fails at RUNTIME, not at build. |
| 3 | Wait for indexes | The CLI returns when Firestore ACCEPTS an index, not when it is Enabled. The run blocks; the CLI will not. |
| 4 | Firestore rules | From `mytribe` only. Refused outright if the admin mirror has drifted. |
| 4b | Storage rules | From `mytribe` only, same as step 4. `mytribe/firebase.json` is the only `firebase.json` that declares a storage section, so there is no admin mirror to drift. Used to be no step at all: a `storage.rules` fix (#999) shipped nowhere in a real release unless someone ran `scripts/safe-deploy.sh mytribe -- firebase deploy --only storage` by hand. |
| 5 | Functions | Before the clients that call them. **Skipped when `mytribe/functions` is unchanged since the last release AND no declared secret is newer than it**. Otherwise deployed **by name, in batches of 25, with retries**, because the whole fleet does not fit the regional CPU quota. See below. A rerun of the **same commit** skips it once its fleet verify passed; see "A stopped release resumes on the same commit". |
| 6 | Hosting | Admin, then portal. |
| 6b | Android | Uploads both APKs from step 1c to App Distribution, each to its own Firebase app, in the same run as the web. |
| 7 | Verify | Fetches both live sites and compares the hashed bundle they reference against the one just built. |
| 8 | Prune revisions | Deletes old Cloud Run revisions, keeping the newest 3 per service and every serving one. Runs after verification, because those revisions are rollback targets. Was 10, which floored the sweep above every inventory level that has ever caused trouble; see below. |
| 9 | Tag the release | Annotates `release/YYYY.MM.DD-<sha>`, naming what actually shipped, and pushes just that tag to origin. Runs after step 7, so nothing gets tagged unless it was verified live. |

**Why step 5 is conditional.** Redeploying the codebase mints a new Cloud Run
revision for every one of its ~285 functions even when nothing changed, and a
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
whole-fleet deploy; `RELEASE_FORCE_FUNCTIONS=1` is the override, and the
warning names it.

**Why step 5 deploys by name in batches.** `--only functions:mytribe` hands the
CLI the whole fleet at once (~227 functions then, ~285 now). Each was its own Cloud Run service at 1 vCPU, a
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

So the ceiling that produced 197, 201, 197 was then about four times the
fleet's draw, and the 2026-08-03 release deployed 202 functions with zero quota
errors. Read the numbers above as what a 1-vCPU fleet did against a 200 vCPU
ceiling, and nothing about today.

**The 0.25 setting is also history.** The fleet default went back to `cpu: 1`
on 2026-08-18 under ADR-0004 (see the comment at the top of
`mytribe/functions/src/index.ts`). What keeps a full deploy under the 400 vCPU
quota now is the batching in step 5, not a fractional CPU.

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
against 400 available. Under the `cpu: 0.25` setting of that time this runbook said the fleet "draws
~90 vCPU"; that was the theoretical sum if every service were warm at once, and it is not
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

**Only what changed.** A one-function change has no business redeploying the
whole fleet. `.release-state` names the last released commit, so `git diff
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
  A local pass says this machine agrees today. "CI red, local green" in `docs/runbooks/troubleshooting.md` says
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
around every deploy (#840), and the step 0a dependency-drift checks (#841). 199
cases.
Run it after touching `scripts/release.sh`. `bash scripts/release-bg.test.sh`
(26 cases) covers the detached wrapper, including a resumed run with changed
indexes and each reason a resume is refused.

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
- storage rules (step 4b). `mytribe/firebase.json` is the only `firebase.json`
  that declares a storage section, so unlike rules there is no admin mirror to
  drift; a `storage.rules` fix used to ship nowhere in a real release until a
  hand-run `firebase deploy --only storage` shipped it, which this step ends
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
before and after each functions batch, after the rules deploy, after the
storage rules deploy, before each admin codebase attempt and after its deploy,
before step 5 is recorded, and before `.release-state` is written.

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
    - storage rules (step 4b)
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

- **missing**: the name is not in the fleet. It was never created.
- **stale**: it is there, but its source predates this run, so the deploy
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
`RELEASE_INCLUDE_ADMIN_FUNCTIONS=1` (`default`, `reconcile`) are deployed at
the end of step 5, before hosting, and are not verified. They are retried on transient errors (#840), which
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
either; every one of those was read from source, never confirmed against
what was actually running (issue #453). `mytribe/functions/scripts/runtimeOptions`
is that check now. It resolves the exact expected shape for every function
from `index.ts`'s `setGlobalOptions` and `lib/runtimeOptions.ts`'s named
constants, with real inheritance (a function with no override gets the fleet
default; one that overrides `minInstances` still gets the fleet's `cpu`), and
diffs it against a deployed dump the operator produces. **Source is
authoritative.** ADR-0004 already worked out what the fleet's shape should
be (`cpu: 1`, `memory: 256MiB`, the named constants' `maxInstances`
policy) and decided it, not merely described it. A mismatch this tool finds
means redeploy to match source, not edit source to match whatever happens to
be running; the one exception is a deploy an operator changed on purpose for
a reason source doesn't yet capture, which is exactly the conversation this
tool exists to force before anyone touches the fleet again.

**Run it read-only first, no deployed data needed:**

```
npm --prefix mytribe/functions run runtime-options:expected
```

Prints the resolved expected shape for all ~285 functions as JSON. Useful on
its own, since it's "what does source currently declare, exactly" with inheritance
already resolved, and it fails loudly (nonzero exit, every unresolved export
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
   `trigger`, `location` and `memory`, never `cpu`/`minInstances`/
   `maxInstances`/`timeoutSeconds`, and no deploy time. Save its raw JSON
   result (the `{"functions":[...]}` object) to a file. Use it only when the
   CLI is unavailable.

3. The operator can also run:

   ```
   gcloud functions list --v2 --format=json > /tmp/deployed.json
   ```

   (`gcloud` returns empty with exit 0 from an agent session, a false
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

Prints only the functions that disagree, not all ~285, which is why this has
never been fixed by eyeballing a full list, plus a deploy-window line and two
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
  `removeMyPaymentMethod`). That's not a runtime-options mismatch: it's
  those functions never having shipped, or having shipped under a different
  name, and it's a bigger finding than the one issue #453 asked about. This
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
default (see `GEN1_COMPARABLE_FIELDS` in `scripts/runtimeOptions/model.ts`
for why). It deployed to `us-east1` when this tool was built, which is worth a
look, but it's a manual observation, not something this tool asserts.

The live run on 2026-08-19 found **zero field-level mismatches** across all
234 functions present on both sides. Read plainly: the memory drift ADR-0004
recorded on 2026-08-04 is gone: some deploy between then and now already
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
hosting rolls back instantly from the Firebase console. Functions
and rules (Firestore and Storage) do not, and `release.sh` itself only runs
from `main`, so it cannot redeploy a tag directly. Either check the tag out
somewhere other than your
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
uploads run at 6b, beside hosting. Release signing needs the keystore and the
Mapbox SDK needs a downloads token, and both are per machine and gitignored.
The operator Mac has them. `nightly-release.yml` restores the same files from
repository secrets before it calls `release.sh` (see
[Hosted nightly release](#hosted-nightly-release)); it stays off until the
operator has set those up, so today the release runs locally. What it needs:

| Needs | For | Where |
|---|---|---|
| `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | operator app | `auntieos-admin/android/local.properties` |
| `SENTRY_DSN` | operator app (compiled in; without it the APK reports no crashes) | `auntieos-admin/android/local.properties` |
| `MAPBOX_PUBLIC_TOKEN` | both apps (compiled in; without it the maps are blank) | `~/.gradle/gradle.properties` |
| `MAPBOX_DOWNLOADS_TOKEN` | both apps (`mytribe/settings.gradle.kts` resolves the Mapbox SDK with it too) | `~/.gradle/gradle.properties`, or the environment |
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

**Both apps derive their version from git.** `versionCode` is the commit count
(`git rev-list --count HEAD`), which only grows on a linear history, so Android
accepts each build as an upgrade. `versionName` carries the short SHA
(`0.2.0-<sha>` for the portal app in `mytribe/build.gradle.kts`), so two builds
are always told apart.

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
from without anyone checking the console. The portal app's does the same.

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
scripts/safe-deploy.sh mytribe -- firebase deploy --only storage
```

Storage rules are `mytribe`-only too, same as Firestore rules, but
`auntieos-admin` declares no storage section at all, so there is no mirror to
drift and nothing to refuse there. This used to be the ONLY way storage rules
shipped: `scripts/release.sh` deployed indexes and Firestore rules but never
Storage rules (step 4b closes that gap), so a `storage.rules` change landed on
`main` and stayed off production until someone ran the command above by hand.

Doing it this way puts the ordering above back in your head. Prefer the run.

**Hosting target names lie.** `hosting:app` is the live admin. The target called
`legacy-wasm`, whose site is literally named `auntieos-admin`, belonged to the
wasm build deleted in #481; nothing builds it, so do not deploy it. The target
lists are per tree: `auntieos-admin/.firebaserc` (`app`, `sotu`, `legacy-wasm`)
and `mytribe/.firebaserc` (`kinfolk_portal`, `mytribe_beta`). There is no root
`.firebaserc`.

## Hosted nightly release

`.github/workflows/nightly-release.yml` runs `scripts/release.sh` on a
GitHub-hosted ubuntu runner (#851). It is built and merged, and it stays off
(`NIGHTLY_RELEASE=off`, ruling D-2026-09-14-NIGHTLY-OFF) until the setup below
exists. After that, the only step left is a manual `preflight` run.

### What the workflow does

In order, and only when the mode is `preflight` or `on`:

1. Refuses if `NIGHTLY_WIF_PROVIDER` or `NIGHTLY_SERVICE_ACCOUNT` is unset.
2. Signs in to Google Cloud through Workload Identity as `github-release`. No
   key file exists anywhere; GitHub's OIDC token is exchanged for a
   short-lived one.
3. Sets up `gcloud`, then runs the credential check from #850. `GH_TOKEN` is
   the job's own token, set on the job so that check can see it, and
   `gh auth status --hostname github.com` must pass.
4. Stops if nothing has merged since the last `release/*` tag.
5. Installs what the Mac already has: Node 22, `npm ci` in all three roots
   step 0a checks, `firebase-tools` 15.18.0, Python 3.13 and the `reconcile`
   venv, JDK 17 and 21, Gradle. The runner's own Android SDK is used through
   `sdk.dir=$ANDROID_HOME`.
6. Sets a git identity, because step 9's `git tag -a` fails without one and a
   release with no tag is shipped again the next night.
7. Restores the signing material from repository secrets: the operator app's
   release keystore (into `$RUNNER_TEMP`), both `local.properties` files,
   `~/.android/debug.keystore` and `~/.gradle/gradle.properties`.
8. Opens both keystores with `keytool` and prints both SHA-256 fingerprints in
   the run summary. A preflight never builds an APK, so this is the only thing
   in a preflight that proves the signing secrets are right.
9. Runs `npm run deploy` (preflight builds `mytribe/functions` first so step
   1b compares the declared secrets for real).
10. Deletes everything step 7 wrote, in an `always()` step.

**Cost of a full run.** The runner starts empty every night, so it has no
`.release-state` and deploys the whole functions fleet (about an hour), on top
of `npm run check` and two cold Gradle builds. The job is capped at 180
minutes.

### Setup, once, on the operator Mac

Run these from the repo root on `main`. They sign in as you, so run them
yourself; nothing here can be run from an agent session.

**1. Names used below.** Check the project number it prints. It should be
`153396971788`, the number inside both Android app IDs.

```bash
PROJECT=auntieos-ttpc
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="github-release@${PROJECT}.iam.gserviceaccount.com"
echo "$PROJECT_NUMBER"
```

**2. The APIs Workload Identity uses.** Safe to run when they are already on.

```bash
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT"
```

**3. The service account.**

```bash
gcloud iam service-accounts create github-release \
  --project "$PROJECT" \
  --display-name "GitHub hosted nightly release (#851)"
```

**4. The pool and its provider.** The attribute condition is the lock: only a
workflow in `sydeast/tribetails` running on `refs/heads/main` gets a token.
A fork, a pull request branch or any other repository is refused by Google
before the service account is ever involved.

```bash
gcloud iam workload-identity-pools create github \
  --project "$PROJECT" --location global \
  --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc tribetails \
  --project "$PROJECT" --location global \
  --workload-identity-pool github \
  --display-name "sydeast/tribetails on main" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository == 'sydeast/tribetails' && assertion.ref == 'refs/heads/main'"
```

**5. Let that provider act as the service account.**

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/sydeast/tribetails"
```

**6. The roles a release uses.** One per thing `release.sh` does, and nothing
for what it does not do (it never creates projects, edits IAM on the project,
or touches Auth users or Firestore data).

| Role | Why the release needs it |
|---|---|
| `roles/cloudfunctions.admin` | Step 5 creates and updates functions in all three codebases, and reads the fleet back with `functions:list` to verify it. |
| `roles/run.admin` | 2nd gen functions are Cloud Run services: the deploy sets their invoker policy. Step 8 lists and deletes old revisions. |
| `roles/cloudscheduler.admin` | About 25 scheduled functions (`onSchedule`, and the Python `nightly_reconcile`) are Cloud Scheduler jobs the deploy creates and updates. |
| `roles/eventarc.admin` | About 25 Firestore-triggered functions are Eventarc triggers the deploy creates and updates. |
| `roles/secretmanager.admin` | Steps 0c and 1b list secrets and read the `VITE_*` values. The deploy also grants each function's runtime account access to the secrets it declares, which is a change to the secret's own IAM policy; no narrower predefined role allows that. |
| `roles/firebasehosting.admin` | Step 6 deploys both sites. |
| `roles/firebaserules.admin` | Steps 4 and 4b deploy Firestore and Storage rules. |
| `roles/datastore.indexAdmin` | Step 2 deploys indexes and step 3 waits for them to finish building. |
| `roles/firebaseappdistro.admin` | Step 1c reads the tester list, step 6b uploads both APKs. |
| `roles/artifactregistry.reader` | The functions deploy reads the cleanup policy on the `gcf-artifacts` repository before it builds. |
| `roles/serviceusage.serviceUsageConsumer` | `firebase-tools` checks the APIs it calls are enabled. |
| `roles/firebase.viewer` | `firebase-tools` reads the project's Firebase configuration at the start of each command. |

```bash
for role in \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/cloudscheduler.admin \
  roles/eventarc.admin \
  roles/secretmanager.admin \
  roles/firebasehosting.admin \
  roles/firebaserules.admin \
  roles/datastore.indexAdmin \
  roles/firebaseappdistro.admin \
  roles/artifactregistry.reader \
  roles/serviceusage.serviceUsageConsumer \
  roles/firebase.viewer
do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$SA" --role "$role" --condition None --quiet > /dev/null
done
```

**7. Let it deploy functions that run as other accounts.** A deploy has to be
allowed to "act as" each function's runtime account. This is granted on those
three accounts only, not on the project: the 2nd gen default (compute), the
1st gen default (`onAuthUserCreate` is a v1 trigger), and the calendar sync
account `syncGoogleCalendarBusyEvents` pins.

```bash
for runtime_sa in \
  "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  "${PROJECT}@appspot.gserviceaccount.com" \
  "auntieos-admin-calendar-sync@${PROJECT}.iam.gserviceaccount.com"
do
  gcloud iam service-accounts add-iam-policy-binding "$runtime_sa" \
    --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser --quiet > /dev/null
done
```

**8. The two repository variables.** The workflow reads the provider and the
account from these, so a renamed pool is a settings change, not a code change.

```bash
gh variable set NIGHTLY_WIF_PROVIDER --repo sydeast/tribetails \
  --body "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/tribetails"
gh variable set NIGHTLY_SERVICE_ACCOUNT --repo sydeast/tribetails --body "$SA"
```

**9. The Android secrets, copied from the files the Mac signs with.** Every
value goes through a pipe into `gh secret set`, so none of them lands in your
shell history or on screen. `prop` reads one line of the operator app's
`local.properties` exactly as written, which is how Gradle will read it back
on the runner.

```bash
LP=auntieos-admin/android/local.properties
GP="$HOME/.gradle/gradle.properties"
prop() { grep "^$1=" "$2" | head -1 | cut -d= -f2- | tr -d '\n'; }

base64 < "$(prop KEYSTORE_PATH "$LP")" | tr -d '\n' | gh secret set AUNTIEOS_KEYSTORE_B64 --repo sydeast/tribetails
prop KEYSTORE_PASSWORD "$LP" | gh secret set AUNTIEOS_KEYSTORE_PASSWORD --repo sydeast/tribetails
prop KEY_ALIAS "$LP" | gh secret set AUNTIEOS_KEY_ALIAS --repo sydeast/tribetails
prop KEY_PASSWORD "$LP" | gh secret set AUNTIEOS_KEY_PASSWORD --repo sydeast/tribetails
prop SENTRY_DSN "$LP" | gh secret set AUNTIEOS_ANDROID_SENTRY_DSN --repo sydeast/tribetails
prop MAPBOX_PUBLIC_TOKEN "$GP" | gh secret set ANDROID_MAPBOX_PUBLIC_TOKEN --repo sydeast/tribetails
base64 < "$HOME/.android/debug.keystore" | tr -d '\n' | gh secret set MYTRIBE_DEBUG_KEYSTORE_B64 --repo sydeast/tribetails
```

`MAPBOX_DOWNLOADS_TOKEN` is already a repository secret: CI's Android jobs use
it. Leave it unless those jobs warn that it is missing or Mapbox answers 401,
and then set it from the same file:

```bash
prop MAPBOX_DOWNLOADS_TOKEN "$GP" | gh secret set MAPBOX_DOWNLOADS_TOKEN --repo sydeast/tribetails
```

**The debug keystore must be the Mac's own file.** The Kinfolk Portal APK is
signed with `~/.android/debug.keystore`. Android installs an update only when
it is signed by the same key as the installed app, so a runner that made its
own debug key would ship builds no tester could install over the current one.
The preflight run prints the fingerprint of the key it restored. Compare it with
the Mac's:

```bash
keytool -list -v -keystore "$HOME/.android/debug.keystore" -storepass android -alias androiddebugkey | grep SHA256
```

**10. Prove it.** Start a preflight by hand and watch it:

```bash
gh workflow run nightly-release.yml --repo sydeast/tribetails --ref main -f mode=preflight
gh run watch --repo sydeast/tribetails "$(gh run list --repo sydeast/tribetails --workflow nightly-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

A passing preflight has signed in through Workload Identity, read Secret Manager
(steps 0c and 1b), read CI's verdict with the job token (step 0b), installed
every dependency root, built the `reconcile` venv, and opened both keystores.
Compare the two fingerprints in its summary with the Mac's before going on.
If the run says "Nothing merged since the last release", it stopped after the
credential check and proved none of the rest; run it again after the next merge.

**11. Then the switch.** A few nights of `preflight`, then `on`:

```bash
gh variable set NIGHTLY_RELEASE --repo sydeast/tribetails --body preflight
gh variable set NIGHTLY_RELEASE --repo sydeast/tribetails --body on
```

To turn it off again at any point:

```bash
gh variable set NIGHTLY_RELEASE --repo sydeast/tribetails --body off
```

### What only a full run can prove

A preflight deploys nothing, so three things are first tested by the first `on`
night: the role list in step 6 (a missing permission fails that step and names
the permission), the two Gradle release builds on this runner, and the App
Distribution upload and tag push. The run stops at the first failure, as it
does on the Mac. If it stops in step 5 or later, production may be part-way
through a release. Fix the cause, then either release from the Mac or start
another full run with `gh workflow run nightly-release.yml --repo sydeast/tribetails --ref main -f mode=full`.
The runner keeps no `.release-progress`, so a rerun there repeats every step
instead of resuming.
