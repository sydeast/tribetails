import { CallableRequest } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * O-3 App Check (docs/O3_APP_CHECK_RULING_2026-07-13.md), as narrowed by
 * D-2026-09-28-APP-CHECK-ONLY-LOGS (docs/DECISIONS.md): "No: App Check only
 * logs. Sign-in and rate limits protect every function."
 *
 * This module used to be O-3's L2 layer, the one that could refuse a request
 * through an `enforce` mode. That mode is gone. App Check is telemetry here and
 * nothing else: every callable logs `appCheck: valid | invalid | absent`
 * (see `appCheckStatusOf` and wrapCallable.ts), and no mode, cohort or setting
 * can turn that into a refusal. The platform `enforceAppCheck` option (O-3's
 * L3) is never set on any function, for the same reason.
 */

/** Header the client SDKs put the attestation in. Lower-cased: Node lower-cases incoming header names. */
const APP_CHECK_HEADER = 'x-firebase-appcheck';

/**
 * What the platform made of this request's attestation.
 *
 * `valid` means VERIFIED, not merely present. firebase-functions calls the
 * Admin SDK's `getAppCheck().verifyToken()` and only then sets `req.app`
 * (node_modules/firebase-functions/lib/common/providers/https.js, around the
 * `checkAppCheckToken` helper); a forged or expired token leaves `req.app`
 * undefined whatever the enforcement setting is. So a truthy `req.app` is a
 * cryptographic fact, not a claim the client got to make.
 *
 * `invalid` and `absent` are the two ways to not have one, and telling them
 * apart is the point. A request carrying a token that FAILED verification is a
 * different event from a request that never had one: the first is a client
 * whose attestation is broken (or an attacker), the second is a client that
 * does not attest yet — a desktop build, a link-preview bot, a session that
 * chose the auth reCAPTCHA loader (see web/src/lib/boot.ts). Folding them
 * together, which is what L1 did, makes the grace-period metric unreadable
 * exactly where it matters.
 */
export type AppCheckStatus = 'valid' | 'invalid' | 'absent';

export function appCheckStatusOf(req: CallableRequest<unknown>): AppCheckStatus {
  if (req.app) return 'valid';
  const raw = req.rawRequest?.headers?.[APP_CHECK_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  return typeof token === 'string' && token.length > 0 ? 'invalid' : 'absent';
}

/**
 * Runtime mode, read from Firestore rather than compiled in. Two values only.
 *
 * - `off`: the cohort gate does nothing at all. Per-call telemetry still logs.
 * - `log`: a cohort request without a verified token is logged as
 *   `<name>.appCheck.wouldReject` and served.
 *
 * There is no `enforce`. D-2026-09-28-APP-CHECK-ONLY-LOGS (docs/DECISIONS.md)
 * removed it: App Check never refuses a request, so a value that promised to
 * turn refusals on would be a setting that cannot do what it says
 * (D-FEATURE-FLAGS-FUNCTIONAL). A stored `enforce` reads as `log` and logs a
 * warning, see [parseMode].
 */
export type AppCheckMode = 'off' | 'log';

/**
 * The mode when the settings doc is missing, malformed, or unreadable, and
 * when it still says `enforce`.
 *
 * `log`, not `off`: it refuses nothing either way, and `log` keeps the
 * would-reject line should a cohort ever exist again. App Check is not this
 * system's authorization boundary (`req.auth` claims, firestore.rules and the
 * callables' rate limits are), so nothing load-bearing hangs on this value.
 */
const DEFAULT_MODE: AppCheckMode = 'log';

/** One cheap read per instance per minute, per O-3 D2. */
const MODE_CACHE_TTL_MS = 60_000;

let cachedMode: { mode: AppCheckMode; readAt: number } | null = null;

/**
 * `enforce` was a valid value until D-2026-09-28-APP-CHECK-ONLY-LOGS. A
 * settings doc written before then may still hold it. It is read as `log`,
 * never as a refusal, and says so in the logs so the operator can clear the
 * field. The warning fires once per cache refresh (at most once a minute per
 * instance), not once per request.
 */
function parseMode(raw: unknown): AppCheckMode {
  if (raw === 'off' || raw === 'log') return raw;
  if (raw === 'enforce') {
    logEvent({
      severity: 'warn',
      function: 'appCheckPolicy',
      event: 'appCheck.enforceIgnored',
      errorMessage:
        "business_settings/security.appCheckMode is 'enforce', which no longer exists. " +
        "App Check only logs (D-2026-09-28-APP-CHECK-ONLY-LOGS). Treating it as 'log'. " +
        "Set the field to 'log' or 'off', or delete it.",
    });
  }
  return DEFAULT_MODE;
}

/**
 * Current mode, cached for [MODE_CACHE_TTL_MS].
 *
 * Called only for functions in [APP_CHECK_COHORT], which is empty by ruling,
 * so in practice no callable pays for this read.
 */
export async function currentAppCheckMode(): Promise<AppCheckMode> {
  const now = Date.now();
  if (cachedMode && now - cachedMode.readAt < MODE_CACHE_TTL_MS) return cachedMode.mode;
  try {
    const snap = await db().collection('business_settings').doc('security').get();
    const mode = parseMode(snap.data()?.['appCheckMode']);
    cachedMode = { mode, readAt: now };
    return mode;
  } catch {
    // Cache the fallback too, so a Firestore outage does not turn into one read
    // per request. Not logged here: wrapCallable logs the mode it acted on.
    cachedMode = { mode: DEFAULT_MODE, readAt: now };
    return DEFAULT_MODE;
  }
}

/** Test seam. Nothing in `src/` calls this. */
export function resetAppCheckModeCache(): void {
  cachedMode = null;
}

/**
 * The callables the `log` mode watches for would-reject lines. Empty, and it
 * stays empty by ruling.
 *
 * D-2026-09-28-APP-CHECK-ONLY-LOGS (docs/DECISIONS.md): "No: App Check only
 * logs. Sign-in and rate limits protect every function." No callable joins
 * this list, including the admin-web-only ones that #987 left eligible.
 * `test/appCheckCohortEmpty.test.ts` fails if a name is added. Changing that
 * takes a new operator ruling, not a code change.
 *
 * History. It held `getBusinessClosures` on a hand check from 2026-08-24 that
 * said no Compose client calls it. The check was wrong: the shared
 * `PortalApi.kt` calls it for the booking wizard on Android and desktop. #987
 * emptied the list and added `test/appCheckComposeReachable.test.ts`, which
 * fails if a name here is reachable from a client with no App Check. That test
 * still runs, but with the list empty by ruling it passes trivially; the
 * emptiness test is the one that bites.
 */
export const APP_CHECK_COHORT: readonly string[] = [];

/**
 * #886: callables whose clients cannot all send an App Check token.
 *
 * `recordFailedLogin` is called right after a failed sign-in by six clients: both
 * web apps, the Android admin, the portal Android app, the portal desktop REST
 * client and the desktop console. The two desktop clients have no App Check SDK
 * at all, and a web sign-in session is unattested by design
 * (web/src/lib/boot.ts). `requestPasswordReset` is the way out of a lockout,
 * and the portal desktop REST client (`RestAuthClient.sendPasswordReset`) calls
 * it with no token either.
 *
 * Kept as a second, narrower guard beside the empty cohort:
 * `appCheckFailedLoginGuard.test.ts` fails if a name here is added to
 * [APP_CHECK_COHORT].
 */
export const UNATTESTED_CLIENT_CALLABLES: readonly string[] = ['recordFailedLogin', 'requestPasswordReset'];

export function isAppCheckCohort(functionName: string): boolean {
  return APP_CHECK_COHORT.includes(functionName);
}

/**
 * `allow`: serve it. `observe`: serve it, and log that the request carried no
 * verified token. There is no refusing decision: App Check only logs
 * (D-2026-09-28-APP-CHECK-ONLY-LOGS).
 */
export type AppCheckDecision = 'allow' | 'observe';

export function appCheckDecision(input: {
  mode: AppCheckMode;
  status: AppCheckStatus;
  inCohort: boolean;
}): AppCheckDecision {
  if (!input.inCohort || input.mode === 'off') return 'allow';
  if (input.status === 'valid') return 'allow';
  return 'observe';
}
