/**
 * Shared runtime sizing for the MyTribe Functions fleet.
 *
 * WHY THIS EXISTS, AND WHY THAT REASON DID NOT SURVIVE
 * ----------------------------------------------------
 * Every one of the 226 v2 functions in this codebase took the firebase-functions
 * default of 1 vCPU / 256MiB, because nothing here ever called `setGlobalOptions`
 * and nothing set `cpu`. On 2026-08-01 that was read as the cause of five failed
 * full deploys: `us-central1` allowed 200 vCPU per project per region
 * (`run.googleapis.com/cpu_allocation`, quota `CpuAllocPerProjectRegion`), the
 * project holds 240 Cloud Run services once AuntieOS's 14 are counted, and
 * 240 x 1 vCPU is over the line. `index.ts` was changed to
 * `setGlobalOptions({ cpu: 0.25, ... })` on that basis, and the constants below
 * are the exceptions it forced.
 *
 * That diagnosis was wrong, measured 2026-08-03 and written up in
 * docs/RUNBOOK.md. The deploys were refused by a per-minute mutation rate limit
 * on cloudfunctions.googleapis.com (60/min, unraisable), which batching fixed.
 * And `CpuAllocPerProjectRegion` meters running instances rather than deployed
 * services, so the fleet never drew what the arithmetic claimed: the console
 * read 16,000 of 400,000 milli vCPU in use, four percent. The quarter-vCPU
 * default bought headroom that already existed, and the concurrency cliff
 * described below is what it cost.
 *
 * docs/adr/0004-functions-runtime-shape.md has the measurements and recommends
 * returning the fleet default to cpu 1, which would retire FULL_CPU and leave
 * the two constants below as what they always really were: maxInstances policy.
 * Until that lands, the exceptions here are load-bearing and the reasons they
 * give are still correct. Only the reason for the DEFAULT they escape is not.
 *
 * THE MEMORY NUMBER IS LOAD-BEARING, AND IT IS THE SAME FACT AS THE PARAGRAPH
 * BELOW. Because the runtime loads the entire module graph on every cold start,
 * the CPU cost measured there has a memory twin: the whole codebase's import
 * footprint, paid by every function. It reached 257-271 MiB on 2026-08-03 and
 * OOMed against a 256MiB limit before the readiness probe, which took the
 * fleet down intermittently and surfaced in browsers as CORS errors. Raised to
 * 512MiB on 2026-08-04 and returned to 256MiB the same day once the graph was
 * cut (below). Adding exports here costs memory on every function in the
 * codebase, not only on the new one.
 *
 * SIX SDKs CAME OUT OF THAT GRAPH ON 2026-08-04 and are now loaded inside the
 * handlers that use them (@googleapis/calendar, @google-cloud/recaptcha-enterprise,
 * twilio, stripe, pdf-lib, @anthropic-ai/sdk). Measured on the built lib/:
 * import RSS 245MB -> 150MB, process RSS after import 288MB -> 192MB, 3512
 * modules -> 1851. What is left is firebase-functions and its Firestore/gRPC
 * stack (~56MB, genuinely every function's), @sentry/node (~26MB, imported by
 * 147 of the 227), and this codebase's own compiled modules. Adding a
 * file-scope import of a heavy SDK puts it back on all 227.
 *
 * DEFERRING A HEAVY SDK IS NOT THE SAME AS MAKING IT CHEAP. The `googleapis`
 * bundle still cost +97 MiB at first use even from inside the handler, which
 * put the five Calendar functions over 256MiB at the moment an operator pressed
 * a button. It was replaced with `@googleapis/calendar`, the one-API package,
 * at +0.9 MiB. When a dependency is only needed for one API, take that package.
 *
 * THE CONCURRENCY CLIFF (the thing that makes 1 vCPU worth paying for)
 * -------------------------------------------------------------------
 * Cloud Run refuses concurrency above 1 on a container with less than a full
 * CPU, and firebase-tools enforces it for us: `resolveCpuAndConcurrency` sets
 * `concurrency = cpu >= 1 ? 80 : 1` (deploy/functions/prepare.ts), and
 * `endpointsAreValid` throws on any function that asks for both. So the choice
 * is not a smooth dial, it is two regimes:
 *
 *   cpu 0.25 -> concurrency 1.  One request per instance. Cheap, and every
 *               concurrent request pays a cold start.
 *   cpu 1    -> concurrency 80. One warm instance absorbs a burst.
 *
 * Loading this codebase's module graph costs ~0.7s of CPU, because the Functions
 * runtime loads all of `index.js` whatever the target is. At 0.25 vCPU that is
 * roughly 2.8s of wall clock on a cold start. That is tolerable on a nightly
 * cron and not tolerable on a login, which is what the split below encodes.
 *
 * It was ~1.44s until the lazy-import change above. Re-measured on one machine
 * across the same change so the halving is a comparison and not two anecdotes:
 * `require('./lib/index.js')` went from 1.15s user + 0.38s sys to 0.57s user +
 * 0.12s sys. The absolute figure moves with the machine; treat the ratio, not
 * the second, as the durable number, and re-measure before quoting it.
 *
 * `maxInstances` is the runaway-billing cap. Nothing set one before, so a loop
 * or a spike could scale to the Cloud Run default of 100 and bill unbounded.
 */

/**
 * A full vCPU, so Cloud Run keeps 80-way concurrency, plus a 10-instance cap
 * (= 800 concurrent requests, which nothing in this product approaches).
 *
 * Use for: latency-critical user-facing paths, genuinely CPU-bound work, and
 * webhooks a third party retries into. The comment at each call site says which.
 */
export const FULL_CPU = { cpu: 1, maxInstances: 10 } as const;

/**
 * A full vCPU with a 2-instance cap. For jobs where more than one copy running
 * at once is a hazard rather than throughput: one-shot operator bulk actions and
 * crons that fan out sends. Two, not one, so a run that overlaps the next tick
 * is absorbed instead of shed; needing a third means the job is stuck, and
 * shedding is then the right answer.
 */
export const FULL_CPU_SERIAL = { cpu: 1, maxInstances: 2 } as const;

/**
 * The global 0.25 vCPU with the same 2-instance cap. For crons that only sweep
 * or delete: no fan-out, no user waiting, no reason to buy a full CPU.
 */
export const SERIAL = { maxInstances: 2 } as const;
