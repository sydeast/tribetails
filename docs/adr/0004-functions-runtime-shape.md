# ADR-0004: The fleet default returns to cpu 1; the quota it was cut for was never binding

Date: 2026-08-04
Status: Accepted in part, 2026-08-19. Decision 1 (correct the written record)
was implemented in the change that proposed this ADR. Decisions 2 and 3 landed
together on `perf/callable-cold-start` for issue #395: the fleet default is
`cpu: 1`, and the remeasurement decision 3 asked for is in that PR (the module
graph is 1,873 modules, 13.4 MiB of JavaScript, 0.80-1.02 s of CPU warm and
about 193 MiB resident, which is within measurement noise of the
`perf/lazy-deps` column below). One deliberate departure: `SERIAL` now pins
`cpu: 0.25` explicitly rather than becoming pure `maxInstances` policy, so the
four nightly sweep crons that use it keep the shape they have today.
Decision 5 (memory) is answered as of issue #453
(`mytribe/functions/scripts/runtimeOptions`; procedure in `docs/RUNBOOK.md`,
"Checking source and deployed runtime options agree"): the live fleet, read
2026-08-19, has zero `memory` drift against source — some deploy between
2026-08-04 and now already carried out the "nothing to touch" this ADR
anticipated. `cpu`, `minInstances` and `maxInstances` remain unconfirmed
against the live fleet (the check needs an operator-run `gcloud functions
list --v2 --format=json` dump for those three; only `memory` and `region`
were checked, via the Firebase MCP tool, which is all it reports) — see that
RUNBOOK section for the exact remaining step. Decision 4 (prune
`minInstances`) is still open and is the operator's call.

## Context

`mytribe/functions/src/index.ts:56` sets `setGlobalOptions({ cpu: 0.25, memory:
'512MiB', maxInstances: 20 })`. The comment above it, and the header of
`src/lib/runtimeOptions.ts:5-12`, both give the same reason: 240 Cloud Run
services at 1 vCPU exceeded a 200 vCPU `CpuAllocPerProjectRegion` ceiling in
`us-central1`, and that is what broke five consecutive deploys on 2026-08-01.

Everything downstream of `cpu: 0.25` follows from it. Below a full vCPU Cloud
Run pins concurrency to 1, and firebase-tools enforces that for us
(`resolveCpuAndConcurrency`: `concurrency = cpu >= 1 ? 80 : 1`). So 38 functions
carry an explicit `cpu: 1` override to buy back 80-way concurrency, and 12 of
those additionally carry `minInstances: 1` to hide the cold start that the
shared module graph imposes on every container.

That chain is sound. Its first link is not.

### The CPU quota was never the constraint, and this is already written down

`docs/RUNBOOK.md:301-408` records the correction, measured 2026-08-03 by
deploying all 227 functions in one batch and reading the error text instead of
inferring it:

```
HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation requests'
and limit 'Per project mutation requests per minute per region'
of service 'cloudfunctions.googleapis.com'
```

A rate on the Cloud Functions API, 60 per minute per region, typed by the
console as a System limit with **Adjustable: No**. Not a capacity ceiling, and
not `CpuAllocPerProjectRegion` at all. 227 mutations against 60 a minute is a
four-minute floor before any build time, which is why deploys that ran two or
three minutes stopped at 197 and 201 and looked like a 200 vCPU wall printing
itself.

The Cloud Run CPU quota, read off the console the same day
(`RUNBOOK.md:368-375`):

| Quota, `us-central1` | Limit | In use | |
|---|---|---|---|
| Total CPU allocation, milli vCPU per project per region | 400,000 | 16,000 | **4%** |
| Active Revisions per region | 4,000 | 240 | 6% |
| Services per region | 1,000 | 240 | 24% |

Two facts sit inside that first row. The limit was raised to 400 vCPU on
2026-08-03, and the meter counts **running instances, not deployed services**.
The "240 services x 1 vCPU = 240 vCPU" arithmetic that produced `cpu: 0.25`
described a quantity Google does not meter. Even before the raise, with the
whole fleet at 1 vCPU and a 200 vCPU limit, actual draw was ~36 vCPU
(`RUNBOOK.md:353-356`).

So `cpu: 0.25` bought headroom against a ceiling that had 25x headroom already,
and it did not fix the deploys. Batching fixed the deploys.

The 16 vCPU in use decomposes exactly, which is worth noting because it is the
only independent check available on any of this: 12 functions at
`minInstances: 1` and `cpu: 1` account for 12 vCPU, leaving ~4 vCPU of
traffic-driven containers, or about sixteen instances at 0.25 vCPU.

### What the module graph actually costs, measured

`require('lib/index.js')` in a bare node process, node v24.14.0, three runs each
after a warm page cache:

| branch | modules | RSS delta | total RSS | CPU (user+sys) | wall |
|---|---|---|---|---|---|
| `main` @ bbd4bd1 | 3,060 | 247-249 MB | **290-292 MB** | 1.10-1.41 s | 0.86 s |
| `perf/lazy-deps` | 1,851 | 150 MB | **193 MB** | 0.61-0.66 s | 0.48 s |

The lazy-import work removes 1,209 modules (-40%), 97 MB (-39%) and 0.49 s of
CPU (-44%). It also takes total resident memory from 290 MB back under 256 MiB,
which is the threshold the fleet outgrew on 2026-08-03.

Cold-start wall clock is that CPU figure divided by the CPU share, because
module loading is CPU-bound work with almost no IO wait:

| | cpu 1 | cpu 0.25 |
|---|---|---|
| today | ~1.1 s | ~4.4 s |
| after `perf/lazy-deps` | ~0.6 s | ~2.4 s |

Quartering the CPU does not quarter the cost of the import. It quadruples the
wall clock and bills the same vCPU-seconds, because a fixed amount of CPU work
costs a fixed number of CPU-seconds however thinly it is sliced. `cpu: 0.25` is
cheaper only for the part of a request that waits on Firestore. On the part that
computes, it converts CPU into latency at no saving.

### What the traffic actually is

Sentry (`mytribe-functions`, `tracesSampleRate` 0.1, all span data falls in
2026-08-02 to 2026-08-04, so a 30d query and a 3d query return the same 13,620
spans):

- **~1,850 requests/day**, 77/hour, 1.3/minute. Peakiness essentially zero: the
  12h and 24h rates agree to within 0.5%.
- **98.6% is Google Cloud Scheduler** hitting four notification sweeps and
  `aiBatchPollCron`. Those already run at `cpu: 1` via `FULL_CPU_SERIAL`.
- Human-originated backend traffic across the entire three days: **one sampled
  request**, ~10 extrapolated.
- p50 102 ms, p95 426 ms, p99 1,023 ms. The slowest thing in the dataset is a
  24.6 s Firestore `Query.Get`, which no CPU setting touches.
- `sum(span.duration)` over 24h is 349,392 ms against 86,400,000 ms of wall
  clock. **Average concurrency 0.004.**

Cloud Run request logs over the 24h to 2026-08-04T23:40 (complete, `has_more:
false`) give the per-function counts Sentry cannot, because Sentry never sees
a container that dies before it flushes:

```
getInvoiceLedger 684   getMyKin 4   getMyBookings 4
getMyHome         32   getMyAccess 2   getMyInvoices 1   beforeSignIn 1
```

`beforeSignIn` fired once in a day. Eight of the twelve functions holding a warm
instance recorded no requests at all.

### The natural experiment already running in the fleet

Two functions, same project, same day, same 247 MB module graph, opposite
concurrency regimes.

**`getMyHome`** (`cpu: 1`, concurrency 80, `minInstances: 1`): 32 requests
including a burst of 14 inside 3.7 seconds, served by **one instance all day**.
Handler durations across the burst climb 995 ms to 4,951 ms as fourteen requests
share one vCPU, then settle to 84 ms and 103 ms warm. No scale-out, no cold
start after the first.

**`getInvoiceLedger`** (`admin/getInvoiceLedger.ts:373`, no override, so the
global 0.25 / concurrency 1 / maxInstances 20): 684 requests, **95 distinct
instances**, up to 11 alive in a single 10-second bucket, 17 new instances
inside the minute 23:11, and:

```
8   The request was aborted because there was no available instance.
       (all within 22:02:44.977 - 22:03:04.769)
35  Default STARTUP TCP probe failed 1 time consecutively for container
       "worker" on port 8080. The instance was not started.
```

One instance per seven requests is concurrency-1 arithmetic, and hitting
`maxInstances: 20` at concurrency 1 means twenty concurrent requests is the
whole ceiling. At `cpu: 1` the same 684 requests fit in one or two containers.

Its container churn is over-determined and the ADR should say so: this function
is also **still deployed at 256 MiB** and OOMing, 228 kills after 21:30 with
readings of 256 to 274 MiB. But the OOM and the churn are the same fact seen
from two sides. A 290 MB import does not fit in 256 MiB, and concurrency 1
makes the fleet pay that import ninety-five times instead of twice.

### The 512 MiB raise has not actually landed on 53 functions

`functions_list_functions` on 2026-08-04 reports 188 functions at 512 MiB and
**53 still at 256 MiB**. Roughly ten to fourteen of those are AuntieOS's own
functions in the shared `auntieos-ttpc` project and were never in scope. The
rest are a partial deploy, and they include `getInvoiceLedger` and **every one
of the twelve `minInstances` functions**: `acceptInvite`, `addSecondaryContact`,
`beforeSignIn`, `claimInviteSignup`, `getInvitePreview`, `getKinTaleComments`,
`getMyAccess`, `getMyAccount`, `getMyBookings`, `getMyHome`, `getMyKinTales`,
`addKinTaleComment`.

Measured resident memory after import is 290 MB. Every one of those 53 is one
cold start away from the 2026-08-03 outage, and one of them is in it now.

### What the shape costs

Standing, from `minInstances`:

```
12 instances x 1 vCPU x 2,592,000 s = 31,104,000 vCPU-seconds / month
12 instances x 0.5 GiB x 2,592,000 s = 15,552,000 GiB-seconds / month
```

Request-driven, taking the higher of the two traffic readings (7,000 req/day
from the Cloud Run logs, not Sentry's 1,850) and a generous 1 second of instance
time each:

```
at cpu 1     7,000 x 1 x 30 = 210,000 vCPU-seconds / month
at cpu 0.25  7,000 x 1 x 30 x 0.25 = 52,500 vCPU-seconds / month
```

Serving every request the product receives costs **0.7% of what the twelve idle
instances cost**. The entire difference between `cpu: 0.25` and `cpu: 1` on that
traffic is 157,500 vCPU-seconds a month, or **0.5% of the standing draw**. At
published Cloud Run tier-1 idle rates the standing bill is roughly $82/month,
about $980/year, before a single request arrives; the cpu default is worth
well under a dollar a month either way.

The ratio carries the argument and needs no pricing at all. The cpu default is
not a cost decision. It has been argued as one for three days.

Worst case, if `maxInstances` were the guardrail it is described as:

| | draw if every service saturates |
|---|---|
| today (185 @ 0.25/20, 4 @ 0.25/2, 26 @ 1/10, 12 @ 1/2) | ~1,211 vCPU |
| global cpu 1 at maxInstances 20 | ~3,986 vCPU |

Both exceed 400. `maxInstances` does not bound the fleet against the quota at
either setting; the quota is its own backstop and it refuses by returning
exactly the "no available instance" 503 that `getInvoiceLedger` has already
seen eight times. What `maxInstances` bounds is one runaway function, and there
the arithmetic reverses: 20 instances at 0.25 vCPU is 5 vCPU serving 20
concurrent requests, while 20 at 1 vCPU is 20 vCPU serving 1,600. The crossover
is four concurrent requests per function. `getInvoiceLedger` sat at eleven.

### What concurrency 80 would expose

Concurrency 1 is accidentally protective in two ways, and both need naming
before recommending its removal.

**Shared module state.** At concurrency 80 a module-scope mutable holding
per-request or per-household data becomes a cross-tenant leak that is invisible
at concurrency 1. Audited: every module-scope `let` in `src/` is an idempotent
lazy client singleton (`lib/twilio.ts:4`, `lib/stripe.ts:3`, `lib/aiCopy.ts:17`,
`lib/firestoreAdmin.ts:11`, `lib/sentry.ts:3-4`,
`public/addGuestKinTaleComment.ts:22`), and every module-scope collection is a
frozen constant `Set`. No per-request or per-tenant module state exists. This
risk is real in general and absent here.

**Memory.** At 512 MiB with a 290 MB baseline, 80 concurrent requests share
220 MB, about 2.75 MB each. After `perf/lazy-deps` the baseline is 193 MB and
the share is 319 MB, about 4 MB each. The PDF builders buffer documents in
memory, and `generateInvoicePdf`, `getMyInvoicePdf` and `generateReceipt`
already run at concurrency 80 today, so this is an existing exposure rather
than a new one. It is still the reason the cpu change should follow the import
work rather than lead it.

## Decision

**1. Correct the written record now.** `index.ts:12-18` and
`lib/runtimeOptions.ts:5-12` both assert the CPU ceiling as the reason for the
current shape. It is not the reason, `RUNBOOK.md` has said so since 2026-08-03,
and a comment that survives its own refutation is how a workaround becomes an
architecture. This is comment-only, changes no runtime value, and is the only
part of this ADR implemented in the same PR.

**2. The fleet default should be `cpu: 1`, not `cpu: 0.25`.** The saving is
0.5% of a standing draw that is itself 4% of quota. The cost is that every
concurrent request to any of ~185 functions starts its own container and pays a
1.1 s, 290 MB import, which this week cost `getInvoiceLedger` 95 containers,
35 failed startup probes and 8 user-visible 503s. `runtimeOptions.ts` calls the
choice "two regimes" and it is right; the fleet is in the wrong one by default.
Nothing about the deploy path changes, because the deploy constraint is a
mutation rate and cpu does not appear in it.

**3. That flip happens after `perf/lazy-deps` lands, and is remeasured first.**
Not as caution theatre. The numbers it is decided on change by 40%: the import
goes to 193 MB and 0.61 s, which drops a cpu-1 cold start to ~0.6 s, raises the
per-request memory share at concurrency 80 by 45%, and is the difference between
"concurrency 80 is a memory risk" and "concurrency 80 has 4 MB per request."
Flipping first means deciding on numbers we can already prove are stale.

**4. Twelve `minInstances: 1` is too many, and the evidence for each is not
equal.** They are 98% of the compute bill and eight of them served nothing in
the observed day.

| function | observed 24h | keep? |
|---|---|---|
| `beforeSignIn` | 1 | **Keep.** Blocking, runs inline in every sign-in, its latency is added to every login and cannot be deferred or backgrounded. |
| `getMyHome` | 32 | **Keep.** Busiest human callable, first screen after sign-in, and the one function demonstrably doing its job. |
| `getMyAccess` | 2 | **Keep if it is on the app-open fan-out** with `getMyHome`; concurrency does not help there, see below. |
| `acceptInvite`, `claimInviteSignup`, `getInvitePreview` | 0 | **Operator call.** Rare but high-stakes: a new user's first impression. ~$20/year each to remove a ~0.6 s wait, post-lazy-deps. |
| `addSecondaryContact`, `getKinTaleComments`, `getMyKinTales`, `getMyAccount`, `addKinTaleComment` | 0 | **Drop.** In-session actions on a user whose app is already warm; a one-off 0.6 s is not worth a standing instance. |

One correction to a premise this investigation was asked to test: raising
concurrency to 80 does **not** make any `minInstances` unnecessary. Concurrency
absorbs a burst of the *same* function, and each function is its own Cloud Run
service. The observed cold-open pattern is a fan-out across five to nine
*different* callables, which is nine cold services no matter what concurrency
says. `minInstances` and concurrency solve different problems, and only
`minInstances` solves that one.

**5. Do not touch `memory` in this work, and note what changes underneath it.**
`perf/lazy-deps` takes total resident memory to 193 MB, back under 256 MiB with
63 MB of headroom. That would make the 512 MiB raise, and the `--force` flag the
release now needs because of it, unnecessary. Whether to give that headroom back
or bank it is the operator's call and belongs with the remeasurement in
decision 3, not here.

**Update, 2026-08-19 (issue #453):** answered, not by a sizing decision but by
building the repeatable check this section could only call for. Source is
authoritative — the 256 MiB this ADR already argued for, not whatever happened
to be running — and `mytribe/functions/scripts/runtimeOptions` diffs the two.
Read live against the deployed fleet the day this landed: **zero functions
disagree with source on `memory`.** The 53-function gap this ADR recorded on
2026-08-04 is gone; a deploy sometime in the fifteen days since already did
the "nothing to touch" outcome this decision anticipated. See
`docs/RUNBOOK.md`, "Checking source and deployed runtime options agree", for
the procedure and how to re-run it. `cpu`, `minInstances` and `maxInstances`
are still unconfirmed against the live fleet — the Firebase MCP tool this was
checked with reports only `memory` and `region`; getting the other three needs
an operator-run `gcloud` dump, documented in the same RUNBOOK section.

**Ahead of all of it:** 53 functions are still serving at 256 MiB against a
290 MB import, and `getInvoiceLedger` is crash-looping right now. That is an
incident, not a sizing question, and it should be finished before any of the
above is argued about further. (As of the 2026-08-19 update above, this
incident is over: the fleet is back at 256 MiB across the board.)

## Consequences

- **What decision 2 costs.** Transient draw rises from ~4 vCPU to somewhere
  under ~16, so total in-use goes from 16 vCPU to roughly 20 to 28 against a
  400 vCPU limit: 5 to 7%, from 4%. Under burst it moves the other way, since a
  concurrency-80 container replaces up to eighty concurrency-1 ones.
- **What it trades away.** Concurrency 1 is a per-request memory sandbox and a
  guarantee that no two requests ever share process state. Both go. The audit
  above says nothing in this codebase currently depends on either, but it
  becomes a standing review obligation: a module-scope mutable holding request
  data stops being a style question and becomes a data-isolation bug.
- **`lib/runtimeOptions.ts` mostly retires.** `FULL_CPU` becomes the default and
  its 26 call sites become noise. `FULL_CPU_SERIAL` and `SERIAL` survive as what
  they always really were, `maxInstances` policy, and should be renamed to say
  so. That deletion is the change's main non-numeric benefit: 38 hand-maintained
  exceptions exist only to escape a default chosen for a reason that was wrong.
- **Decision 4 makes rare paths slower on purpose.** Dropping five warm
  instances means the first invocation after an idle period pays a cold start:
  ~0.6 s post-lazy-deps, ~1.1 s before it. On functions that recorded zero
  requests in a day, that is a wait almost nobody experiences, bought for about
  $340/year.
- **Nothing here improves deploys**, and no future runtime-sizing change will.
  The deploy constraint is 60 mutations a minute, it cannot be raised, and
  batching already lives inside it.

## What could not be verified

- **Deployed `cpu`, `minInstances`, `maxInstances` and `concurrency`, for any
  function.** `functions_list_functions` returns only trigger, location, memory
  and runtime; no Firebase MCP tool exposes the rest, and `gcloud` returns empty
  output with exit 0 in this environment, which is a false negative rather than
  an answer. Every cpu and concurrency figure here is read from source, not from
  the running fleet. Given that memory was already 53 functions out of sync
  between source and deployment, source is not proof of what is deployed.
  **Update, 2026-08-19 (issue #453):** `memory` and `region` are no longer in
  this bucket — `mytribe/functions/scripts/runtimeOptions` checked both live
  and found zero drift (decision 5, above). `cpu`, `minInstances` and
  `maxInstances` remain here; confirming them needs an operator-run `gcloud
  functions list --v2 --format=json` dump, which this tool also accepts (see
  `docs/RUNBOOK.md`) — nothing changed about `gcloud`'s availability from an
  agent session.
- **The quota numbers are second-hand.** 400,000 milli vCPU limit, 16,000 in
  use, is quoted from `RUNBOOK.md:371-375`, recorded off the console on
  2026-08-03. Not re-read live, for the same tooling reason.
- **Total request volume.** Sentry says 1,850/day at 10% sampling; Cloud Run
  request logs imply ~7,000/day but the query capped at 1,000 entries covering
  3.4 hours. The ADR uses the higher figure where a higher figure weakens its
  own argument.
- **Total OOM count.** The query returned 1,000 entries with `has_more: true`,
  so >1,000 in 24h is a floor, not a count.
- **CPU and memory utilisation percentiles.** No Cloud Monitoring access
  through the available tools. The only memory readings available are the OOM
  lines themselves, which report usage at the moment of the kill.
- **Cloud Run free-tier and per-second prices.** Quoted from published rates
  from memory, not fetched. The dollar figures should be treated as
  order-of-magnitude. The ratios they are derived from (0.7%, 0.5%, 98%) come
  from measured quantities and hold regardless of price.
- **Whether `getMyAccess` is on the same app-open fan-out as `getMyHome`.**
  Two requests in 24h is too little to tell, and the client call sites were not
  read for this ADR.
- **Concurrency-80 behaviour under real load.** The product has never run above
  average concurrency 0.004. Everything decision 2 claims about burst behaviour
  is arithmetic plus one 14-request natural experiment, not a load test.
