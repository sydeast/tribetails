/**
 * Did the functions this release claimed to deploy actually deploy? (#503)
 *
 * On 2026-08-11 a hand-run deploy lost one 25-function batch and did not stop.
 * The 24 that already existed quietly kept serving their previous revision, so
 * nothing 404'd, no screen broke, and the run reported success. Only
 * `twilioVoice`, new that afternoon and inside the lost block, left a mark, and
 * nobody found it for eight days.
 *
 * That is the failure this answers, and it is deliberately NOT the same
 * question as the runtime-options drift diff. The diff compares the whole fleet
 * against source and is a human-run tool: it currently reports 203 functions
 * whose cpu source raised in #428 and no deploy has picked up yet, which is
 * true, useful, and completely wrong to fail a release on. A narrowed release
 * deploys a subset by design, so gating on fleet-wide agreement would refuse
 * every narrowed release forever.
 *
 * This asks only about the names THIS run deployed:
 *
 *   MISSING  the name is not in the fleet at all. It was never created.
 *   STALE    it exists, but its source predates this run, so the deploy
 *            reported success and the function is serving older code.
 *
 * Both are refusals. Everything else is somebody else's question.
 */

/** Deploy timestamps are GCS server time and the release clock is local. */
export const CLOCK_SKEW_MS = 10 * 60 * 1000;

export interface VerifyDeployInput {
  /** The names this run deployed, snapshotted BEFORE the batch loop consumed them. */
  names: string[];
  /** Every function name the fetched fleet reports. */
  deployedNames: Set<string>;
  /** name -> epoch ms, for the rows that carry a generation. */
  deployedAtMs: Record<string, number>;
  /** When this release started, epoch ms. */
  sinceMs: number;
}

export interface VerifyDeployResult {
  missing: string[];
  stale: string[];
  /** Checked for existence but not for freshness, because no generation was reported. */
  unstamped: string[];
  checked: number;
}

export function verifyDeployedNames(input: VerifyDeployInput): VerifyDeployResult {
  const { names, deployedNames, deployedAtMs, sinceMs } = input;
  const cutoff = sinceMs - CLOCK_SKEW_MS;
  const missing: string[] = [];
  const stale: string[] = [];
  const unstamped: string[] = [];

  for (const name of names) {
    if (!deployedNames.has(name)) {
      missing.push(name);
      continue;
    }
    const at = deployedAtMs[name];
    if (at === undefined) {
      // A v1 function, or a dump shape that cannot report deploy times. Its
      // existence was confirmed above; claiming it is stale on the strength of
      // a field nobody reported would refuse a good release.
      unstamped.push(name);
      continue;
    }
    if (at < cutoff) stale.push(name);
  }

  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    missing: missing.sort(byName),
    stale: stale.sort(byName),
    unstamped: unstamped.sort(byName),
    checked: names.length,
  };
}

/**
 * Is the fetched fleet believable enough to judge against?
 *
 * An empty or truncated result must read as "could not verify", never as "zero
 * functions are deployed". That distinction is the whole lesson of the gcloud
 * false negative in ADR-0004: an empty success is indistinguishable from a real
 * zero unless something refuses to treat them the same.
 */
export function fleetLooksComplete(fetchedCount: number, expectedCount: number): boolean {
  if (fetchedCount === 0) return false;
  return fetchedCount >= Math.floor(expectedCount / 2);
}
