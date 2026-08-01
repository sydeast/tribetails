/**
 * Which secret names the deployed functions DECLARE, read from the artifact the
 * Firebase CLI itself validates.
 *
 * WHY `__endpoint` AND NOT THE SOURCE. The `secrets:` arrays are built from
 * spreads of shared constants (`GOOGLE_OAUTH_SECRETS`) and from `defineSecret`
 * params, so a regex over the TypeScript either misses declarations or invents
 * them. `__endpoint.secretEnvironmentVariables` is the same structure the CLI
 * reads before it uploads anything, so an answer derived from it agrees with the
 * validator by construction rather than by resemblance.
 *
 * THIS IS THE ONE IMPLEMENTATION. `scripts/declared-secrets.js` (the release
 * preflight that refuses a deploy when a declared secret was never created) and
 * `getIntegrationsHealth` (which tells the operator whether a name is bound to
 * anything at all) both call in here. Two copies of this walk would be two
 * answers to one question, and the operator-facing one would be the one nobody
 * noticed had drifted.
 *
 * A DECLARED SECRET IS NOT A SET SECRET. This says a name is bound to at least
 * one deployed function. Whether Secret Manager holds a value for it is the
 * release preflight's question, and whether it reached a running function is
 * `process.env`'s. All three are reported separately because they fail
 * separately.
 */

/** The subset of a Firebase endpoint this walk reads. */
interface EndpointLike {
  secretEnvironmentVariables?: Array<{ key?: unknown } | null | undefined>;
}

/**
 * Every secret name declared by any export of `moduleExports`, sorted and
 * de-duplicated.
 *
 * ONE AWKWARD EXPORT MUST NOT BLIND THE WALK. v1 providers build a resource name
 * inside their own `__endpoint` getter and throw when the project environment is
 * unset, which is how the release script first failed. A throwing getter is
 * skipped rather than fatal: this exists to reduce the chance of a bad deploy,
 * and reporting nothing because one export is difficult would defeat that.
 */
export function collectDeclaredSecrets(moduleExports: unknown): string[] {
  const names = new Set<string>(collectDeclaredSecretPairs(moduleExports).map(([, key]) => key));
  return [...names].sort();
}

/**
 * Every (exportName, secretName) declaration pair, sorted by function then
 * secret. The per-function view scripts/declared-secrets.js exposes as
 * `--by-function` (added for the #145 secrets-freshness work) reads THIS,
 * and the flat list above derives from it, so both modes are one walk and
 * cannot drift.
 */
export function collectDeclaredSecretPairs(moduleExports: unknown): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (typeof moduleExports !== 'object' || moduleExports === null) return pairs;
  for (const [exportName, value] of Object.entries(moduleExports as Record<string, unknown>)) {
    let endpoint: EndpointLike | undefined;
    try {
      endpoint = (value as { __endpoint?: EndpointLike } | null | undefined)?.__endpoint;
    } catch {
      continue;
    }
    if (!endpoint || !Array.isArray(endpoint.secretEnvironmentVariables)) continue;
    for (const entry of endpoint.secretEnvironmentVariables) {
      const key = entry?.key;
      if (typeof key === 'string' && key !== '') pairs.push([exportName, key]);
    }
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/** A declared-secret read that says so when it could not be made. */
export interface DeclaredSecrets {
  /**
   * False when the walk could not run. Every `names` entry is then meaningless,
   * and a caller must say "we could not look" rather than "nothing is declared".
   * The two read identically to an operator otherwise, and the first one invites
   * them to go set a secret that was already bound.
   */
  known: boolean;
  names: string[];
  /** Empty when `known`. Otherwise what went wrong, for the operator to read. */
  reason: string;
}

/**
 * Runs `load` and walks whatever it yields.
 *
 * `load` is a seam, not decoration: in a deployed function it hands back the
 * already-initialised functions index (the module Firebase itself loaded, so
 * this costs a cache hit and no work), and a unit test hands back a stand-in
 * rather than importing two hundred modules to ask one question.
 */
export async function loadDeclaredSecrets(load: () => Promise<unknown>): Promise<DeclaredSecrets> {
  try {
    const names = collectDeclaredSecrets(await load());
    if (names.length === 0) {
      // Zero declared secrets is not a state this codebase can be in: SENTRY_DSN
      // alone is on nearly every function. An empty answer therefore means the
      // walk found nothing to walk, which is a failure wearing a success's
      // clothes, so it is reported as one.
      return { known: false, names: [], reason: 'No function declared any secret, which cannot be right.' };
    }
    return { known: true, names, reason: '' };
  } catch (err) {
    return {
      known: false,
      names: [],
      reason: err instanceof Error ? err.message : 'The declared-secret list could not be read.',
    };
  }
}
