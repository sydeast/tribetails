import { CallableRequest } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';

/**
 * O-3 App Check, L2 runtime enforcement
 * (docs/O3_APP_CHECK_RULING_2026-07-13.md, D2).
 *
 * L1 was telemetry only: `wrapCallable` logged whether `req.app` was populated
 * and changed nothing. This module is the layer that can actually refuse a
 * request, and it is deliberately NOT the platform's `enforceAppCheck` option
 * (that is L3). The difference is the kill switch. `enforceAppCheck` is a
 * deploy-time flag on ~230 functions with no CI behind them, so reverting it is
 * a ten-minute redeploy. The mode below is one Firestore field, effective
 * within a minute, flippable from a phone. The ruling's whole argument for L2
 * is that the first enforcement flip on live family traffic needs the fast
 * revert, and D2 is explicit that L3 comes only after L2 has run clean for a
 * week on the same cohort.
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
 * Runtime enforcement mode, read from Firestore rather than compiled in.
 *
 * - `off`     — the gate does nothing at all. L1 telemetry still logs.
 * - `log`     — every request that WOULD be rejected is logged as such, and
 *               served anyway. This is what proves a cohort is quiet before
 *               anyone risks refusing a real family's request.
 * - `enforce` — cohort requests without a verified token are refused.
 */
export type AppCheckMode = 'off' | 'log' | 'enforce';

/**
 * The mode when the settings doc is missing, malformed, or unreadable.
 *
 * `log`, not `off`: a fresh project should produce the would-reject counts the
 * grace period is measured from without anyone remembering to seed a document,
 * and `log` refuses nothing. It is not `enforce` for the obvious reason — a
 * Firestore blip must never become an outage — and App Check is explicitly not
 * this system's authorization boundary (`req.auth` claims and firestore.rules
 * are), so failing open costs nothing that was load-bearing.
 */
const DEFAULT_MODE: AppCheckMode = 'log';

/** One cheap read per instance per minute, per the ruling's D2. */
const MODE_CACHE_TTL_MS = 60_000;

let cachedMode: { mode: AppCheckMode; readAt: number } | null = null;

function parseMode(raw: unknown): AppCheckMode {
  return raw === 'off' || raw === 'log' || raw === 'enforce' ? raw : DEFAULT_MODE;
}

/**
 * Current mode, cached for [MODE_CACHE_TTL_MS].
 *
 * Called only for functions that are actually in an enforced cohort, so the
 * other ~230 callables never pay for a read they cannot act on.
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
    // per request. Deliberately not logged here — wrapCallable already logs the
    // mode it acted on with every gated request.
    cachedMode = { mode: DEFAULT_MODE, readAt: now };
    return DEFAULT_MODE;
  }
}

/** Test seam. Nothing in `src/` calls this. */
export function resetAppCheckModeCache(): void {
  cachedMode = null;
}

/**
 * Cohort 1: callables that ONLY the React portal calls.
 *
 * The membership rule is not "portal-facing", it is "no other client can
 * possibly send this". Cross-checked 2026-08-24 against every callable name the
 * React tree invokes (`web/src/**`) and every one the Compose tree invokes
 * (`src/**`, which is the Android app, the retiring jsMain web build and the
 * desktop build sharing one `commonMain`). Of the 50 names the portal calls, 49
 * are also reachable from the Compose tree; `getBusinessClosures` is the one
 * that is not. The AuntieOS admin tree does not call it either.
 *
 * One name is a small cohort and that is the correct size for it. The ruling
 * calls cohort 1 "the proving ground" — its job is to exercise the reject path
 * against real traffic where a mistake cannot reach a client that was never
 * going to attest. Cohort 2 (the whole `wrapCallable` surface) is gated on the
 * jsMain retirement AND on the portal's two reCAPTCHA loaders being unified,
 * because until that lands a kinfolk who signs in through the form spends that
 * whole session unattested by design (web/src/lib/boot.ts).
 */
export const APP_CHECK_COHORT: readonly string[] = ['getBusinessClosures'];

export function isAppCheckCohort(functionName: string): boolean {
  return APP_CHECK_COHORT.includes(functionName);
}

/**
 * `allow` — serve it. `observe` — serve it, but record that enforcement would
 * have refused. `reject` — refuse it.
 */
export type AppCheckDecision = 'allow' | 'observe' | 'reject';

export function appCheckDecision(input: {
  mode: AppCheckMode;
  status: AppCheckStatus;
  inCohort: boolean;
}): AppCheckDecision {
  if (!input.inCohort || input.mode === 'off') return 'allow';
  if (input.status === 'valid') return 'allow';
  return input.mode === 'enforce' ? 'reject' : 'observe';
}

/**
 * The refusal message, which a kinfolk can actually see.
 *
 * No jargon about attestation, and no suggestion that they did something
 * wrong: the realistic causes are an old tab, a privacy extension that ate the
 * reCAPTCHA script, or a build we shipped. Reloading genuinely fixes the first
 * two.
 */
export const APP_CHECK_REJECT_MESSAGE =
  "This app couldn't verify itself with our servers. Reload the page and try again.";
