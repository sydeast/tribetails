/**
 * Shared runtime sizing for the MyTribe Functions fleet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every one of the 226 v2 functions in this codebase took the firebase-functions
 * default of 1 vCPU / 256MiB, because nothing here ever called `setGlobalOptions`
 * and nothing set `cpu`. `us-central1` allows 200 vCPU per project per region
 * (`run.googleapis.com/cpu_allocation`, quota `CpuAllocPerProjectRegion`), and
 * the project holds 240 Cloud Run services once AuntieOS's 14 are counted. The
 * fleet has been over the ceiling, which is why full deploys on 2026-08-01 died
 * partway with "Quota exceeded for total allowable CPU per project per region".
 *
 * `index.ts` now calls `setGlobalOptions({ cpu: 0.25, memory: '512MiB',
 * maxInstances: 20 })`, so the fleet default is a quarter vCPU. The constants
 * below are the explicit exceptions, applied at each function's own definition
 * site so the reason travels with the function.
 *
 * THE MEMORY NUMBER IS LOAD-BEARING, AND IT IS THE SAME FACT AS THE PARAGRAPH
 * BELOW. Because the runtime loads the entire module graph on every cold start,
 * the ~1.44s measured there has a memory twin: the whole codebase's import
 * footprint, paid by every function. It reached 257-271 MiB on 2026-08-03 and
 * OOMed against a 256MiB limit before the readiness probe, which took the
 * fleet down intermittently and surfaced in browsers as CORS errors. Raised to
 * 512MiB on 2026-08-04. Adding exports here costs memory on every function in
 * the codebase, not only on the new one.
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
 * Loading this codebase's module graph costs ~1.44s of CPU (measured:
 * `require('./lib/index.js')` = 1.07s user + 0.37s sys), because the Functions
 * runtime loads all of `index.js` whatever the target is. At 0.25 vCPU that is
 * roughly 5.8s of wall clock on a cold start. That is tolerable on a nightly
 * cron and not tolerable on a login, which is what the split below encodes.
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
