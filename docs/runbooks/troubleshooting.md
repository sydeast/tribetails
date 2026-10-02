# Troubleshooting

Symptoms seen here before, with the cause and the fix. `docs/RUNBOOK.md` indexes the ones a release hits.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

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

## When something breaks

**A query returns nothing, with no error.** Almost always the section above.
Check the field type first.

**App Check never refuses a request.** Ruling
D-2026-09-28-APP-CHECK-ONLY-LOGS (`docs/DECISIONS.md`, docket Q9): "No: App
Check only logs. Sign-in and rate limits protect every function." If a
kinfolk is refused, look at sign-in, session revocation or a rate limit, not
App Check. The old refusal message ("This app couldn't verify itself with our
servers") no longer exists anywhere in the server.

`business_settings/security.appCheckMode` takes `off` or `log`, and a missing
or malformed field reads as `log`. Neither refuses anything. The field is read
only for callables in `APP_CHECK_COHORT`
(`mytribe/functions/src/lib/appCheckPolicy.ts`), which stays empty by the same
ruling, and the functions test suite fails if a name is added. So today the
field is never read at all. A value of `enforce` left over from before the
ruling would read as `log` and log `appCheck.enforceIgnored`; set it to `log`
or delete it so the settings doc does not suggest protection that is not
there.

To read App Check traffic, filter Logs Explorer on `jsonPayload.appCheck`:
`valid` is a verified token, `invalid` is a token that failed verification,
`absent` is no token at all.

**A callable works locally and 500s in production.** The secret is set but not
DECLARED in that function's `secrets: [...]`. See `docs/runbooks/secrets.md`.

**A secret is set, set again, and the feature still says it is unset.** The
declaration is not the problem; the deploy is. `functions:secrets:set` mints a
version and binds nothing, and a gcfv2 function reads the version it was deployed
with, so a value set after the last deploy is invisible to the running code.
Confirm the declaration is there, then redeploy:

```bash
node scripts/declared-secrets.js --by-function GOOGLE_OAUTH   # the pairs
scripts/safe-deploy.sh mytribe -- firebase deploy \
  --only "functions:mytribe:NAME1,functions:mytribe:NAME2"    # just those names
```

Deploy the names the first command printed, not the whole codebase; see
`docs/runbooks/secrets.md` for why. Release step 5 also refuses to skip the functions
deploy when a declared secret is newer than the last release, so `npm run
deploy` covers this too. The AuntieOS Settings, Calendar section names which of
the three setup steps is outstanding rather than reporting one generic failure.

**A functions deploy fails with `Failed to validate secret versions ... not
found or has no versions`.** The inverse trap: a secret the code DECLARES that
nobody ever SET. Firebase validates every declared secret before uploading, so
one missing name fails the ENTIRE codebase, not just the function declaring it.
Release step 1b now catches this before anything deploys and prints the exact
`firebase functions:secrets:set` command per missing name. To check by hand:

```bash
node scripts/declared-secrets.js
```

That reads the built `__endpoint`s (the same structure the CLI validates)
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

**A preview URL rejects sign-in with an unauthorized-domain error, and the deploy
log shows `Unable to add channel domain to Firebase Auth`.** The deploy
credential (`github-hosting-deploy@auntieos-ttpc.iam.gserviceaccount.com`) lacks
`firebaseauth.configs.update`. `firebase hosting:channel:deploy` adds the
channel's host to Auth authorized domains with one `UpdateConfig` call and
syncs the list with a second; `hosting:channel:delete` removes it again, so the
list does not grow with closed PRs once the permission exists. A denied call is
only a warning in the CLI, so the deploy still goes green, but each one lands as
a permission-denied ERROR in the production logs. Grant the narrow custom role
(the operator runs this; the account holds `roles/firebasehosting.admin` and
`roles/firebase.viewer` today):

```bash
gcloud iam roles create previewAuthDomains --project auntieos-ttpc \
  --title "Preview auth domains" \
  --permissions firebaseauth.configs.get,firebaseauth.configs.update
gcloud projects add-iam-policy-binding auntieos-ttpc \
  --member serviceAccount:github-hosting-deploy@auntieos-ttpc.iam.gserviceaccount.com \
  --role projects/auntieos-ttpc/roles/previewAuthDomains
```

Do not use `roles/firebaseauth.admin` for this: it also lets the CI key create
and delete users. Previews run against production data, so sign in to look and
do not submit forms there.

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
batches" in `docs/runbooks/release-internals.md`. If you are reading this entry it is because you ran a
whole-codebase deploy by hand: `firebase deploy --only functions:mytribe`, or
`npm run deploy` from inside `mytribe/functions/`, which is the package script
and is not the release. That second one is the "stray" row in the table in `docs/runbooks/release-internals.md`:
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
same commit" in `docs/runbooks/release-internals.md`.

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
"An install either matches its lockfile or it does not" in `docs/runbooks/machine-setup.md`. **Never** fix
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
