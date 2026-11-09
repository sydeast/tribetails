import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { assertSessionNotRevoked, type RevocationCheck } from './sessionRevocation';
import { randomUUID } from 'node:crypto';
import {
  appCheckDecision,
  appCheckStatusOf,
  currentAppCheckMode,
  isAppCheckCohort,
  type AppCheckStatus,
} from './appCheckPolicy';

export type Handler<T, R> = (req: CallableRequest<T>) => Promise<R>;

/**
 * O-3 App Check telemetry (docs/O3_APP_CHECK_RULING_2026-07-13.md, D2).
 *
 * `req.app` is populated by the platform whenever the request carried a
 * VERIFIED App Check token, with no enforcement anywhere. Since
 * D-2026-09-28-APP-CHECK-ONLY-LOGS this telemetry is all App Check does: it is
 * logged on every call and never used to refuse one. `wrapAdminCallable` delegates
 * to this wrapper rather than logging separately, so this single call site
 * covers every onCall function that routes through either wrapper (all of
 * them).
 *
 * L1 logged two states, `valid` and `absent`. Three are logged now: a token
 * that arrived and failed verification is its own event, not a synonym for no
 * token at all. See appCheckPolicy.ts.
 */
function appCheckFields(req: CallableRequest<unknown>): { appCheck: AppCheckStatus; origin?: string } {
  const origin = req.rawRequest?.headers?.origin;
  return {
    appCheck: appCheckStatusOf(req),
    ...(typeof origin === 'string' ? { origin } : {}),
  };
}

/**
 * O-3 cohort observation. It never refuses: App Check only logs
 * (D-2026-09-28-APP-CHECK-ONLY-LOGS, docs/DECISIONS.md). This used to be O-3's
 * L2 gate, which could throw `unauthenticated` in an `enforce` mode; that mode
 * and the throw are gone.
 *
 * Costs nothing for a function outside the cohort: no Firestore read, no
 * await. The cohort is empty by ruling, so today that is every callable. For a
 * cohort member in `log` mode, a request with no verified token gets a
 * `<name>.appCheck.wouldReject` line and is served.
 */
async function observeAppCheck(name: string, req: CallableRequest<unknown>, requestId: string): Promise<void> {
  const inCohort = isAppCheckCohort(name);
  if (!inCohort) return;
  const status = appCheckStatusOf(req);
  const mode = await currentAppCheckMode();
  const decision = appCheckDecision({ mode, status, inCohort });
  if (decision === 'allow') return;
  logEvent({
    severity: 'warn',
    function: name,
    event: `${name}.appCheck.wouldReject`,
    requestId,
    uid: req.auth?.uid,
    ...appCheckFields(req),
    extra: { appCheckMode: mode },
  });
}

/**
 * #1504, WARM ON INTENT. The payload a client sends to wake a write callable's
 * Cloud Run instance when the household OPENS the form that will call it, so
 * the save itself lands on a running instance instead of paying the cold start.
 *
 * The marker is the whole payload, `{ __warm: true }` and no other key. A real
 * call never sends that shape, and a payload with any other key in it is a real
 * call that happens to carry a stray field: it goes to the handler and its own
 * schema, never down the short circuit. A looser test (say, "has `__warm`")
 * would let a genuine save with an extra key be skipped silently.
 */
export const WARM_MARKER_KEY = '__warm';
/** True only for the exact warm payload. See {@link WARM_MARKER_KEY}. */
export function isWarmRequest(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && keys[0] === WARM_MARKER_KEY && (data as Record<string, unknown>)[WARM_MARKER_KEY] === true;
}
/** What a warm call answers. Clients drop it; it exists so the reply is not empty. */
export interface WarmReply {
  ok: true;
  warm: true;
}
/**
 * Every onCall goes through here (directly, or through `wrapAdminCallable`).
 *
 * THE WARM SHORT CIRCUIT (#1504). A request whose payload is exactly the warm
 * marker returns `{ ok: true, warm: true }` without running the handler: no
 * read beyond the gates below, no write, no audit entry, no notification. It
 * still passes the same gates as any other call first, in the same order:
 *   - App Check observation (logs only, as for every call);
 *   - session revocation (#557), so a revoked session is refused exactly as
 *     its real save would be;
 *   - sign-in. `onCall` itself does not require one and most handlers check
 *     it themselves, which the short circuit skips, so the warm branch refuses
 *     an unauthenticated caller with `unauthenticated` on its own. An anonymous
 *     warm is refused like any other anonymous call.
 *
 * What a warm call does NOT pass through, on purpose:
 *   - The handler's own rate limit. A warm is a no-op, so nothing it could
 *     repeat costs more than the instance it keeps awake.
 *   - `wrapAdminCallable`'s staff gate, which runs INSIDE the handler this
 *     wrapper is given. A signed-in household that sent the marker to an admin
 *     callable would therefore get the warm reply. Accepted: it reveals no data
 *     and changes nothing, the cost is one instance kept awake, and the portal
 *     only ever warms its own saves. Refusing it would need a staff check (a
 *     claim read) on a path whose whole point is to be cheap.
 *
 * Logged as `<name>.warm` at info, never `<name>.success`, so handler timing
 * and success counts read from the logs stay about real calls.
 */
export function wrapCallable<T, R>(name: string, handler: Handler<T, R>): Handler<T, R> {
  return async (req: CallableRequest<T>): Promise<R> => {
    initSentry(); // lazy init at first invocation (env var is bound by then)
    const start = Date.now();
    const requestId = randomUUID();
    const clientErrorId = randomUUID();
    // #557: 'not-run' until the revocation gate is actually reached. It is a
    // distinct value from 'skipped' on purpose: 'skipped' means the caller was
    // unauthenticated so there was nothing to look up, whereas this means
    // something ahead of the gate threw first. Since
    // D-2026-09-28-APP-CHECK-ONLY-LOGS nothing ahead of it refuses (App Check
    // only logs), so this value should not appear; if it does, the step above
    // the gate failed unexpectedly, and the log line says so.
    let authCheck: RevocationCheck = { outcome: 'not-run', durationMs: 0 };
    try {
      // ORDER: App Check observation first, session revocation (#557)
      // second. App Check never refuses (D-2026-09-28-APP-CHECK-ONLY-LOGS);
      // it only logs. It still runs first so that every cohort request is
      // observed, rather than some being pre-empted by a revocation refusal
      // and never showing up in the valid-token numbers. It costs nothing
      // outside the cohort (a synchronous array lookup and an early return),
      // and the cohort is empty by ruling.
      //
      // Revocation asks "is the person behind this token still in a live
      // session" and refuses with `unauthenticated` plus `details.reason`,
      // which the portal and Android clients branch on before signing anybody
      // out. Sign-in and rate limits, not App Check, protect every function.
      await observeAppCheck(name, req, requestId);
      // #557: `onCall` verified this token's signature and expiry, not whether
      // the session behind it was revoked. See sessionRevocation.ts for the
      // policy and what it costs.
      //
      // The inner try exists only so the log line tells the truth: a refusal
      // throws instead of returning, and without it the failure line would
      // report the pre-gate value instead of naming the refusal.
      const checkStart = Date.now();
      try {
        authCheck = await assertSessionNotRevoked(req, name);
      } catch (refusal) {
        authCheck = { outcome: 'revoked', durationMs: Date.now() - checkStart };
        throw refusal;
      }
      if (isWarmRequest(req.data)) {
        if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
        logEvent({
          severity: 'info',
          function: name,
          event: `${name}.warm`,
          requestId,
          uid: req.auth.uid,
          durationMs: Date.now() - start,
          authCheck: authCheck.outcome,
          authCheckMs: authCheck.durationMs,
          ...appCheckFields(req),
        });
        const reply: WarmReply = { ok: true, warm: true };
        return reply as unknown as R;
      }
      const result = await handler(req);
      logEvent({
        severity: 'info',
        function: name,
        event: `${name}.success`,
        requestId,
        uid: req.auth?.uid,
        durationMs: Date.now() - start,
        authCheck: authCheck.outcome,
        authCheckMs: authCheck.durationMs,
        ...appCheckFields(req),
      });
      return result;
    } catch (err) {
      const isHttpsError = err instanceof HttpsError;
      const code = isHttpsError ? err.code : 'internal';
      const message = isHttpsError ? err.message : 'An error occurred. It\'s been reported to Auntie.';
      // One classification drives both Sentry and the log line (#1520). A
      // user-fault code is a refused call, an expected state the client
      // handles (a form schema no admin has seeded yet, a session that ended,
      // a caller outside the staff gate): it stays out of Sentry, where it
      // would pollute the issue feed without signalling a server bug, and it
      // logs at warn, so Cloud Logging and the real-run harness (which fails a
      // test on any `severity: error` line) do not read it as a fault either.
      // Everything else, a non-HttpsError or a server-fault code (internal,
      // unavailable, deadline-exceeded, resource-exhausted, data-loss, unknown,
      // aborted, cancelled, unimplemented), is captured and logs at error.
      const userFaultCodes = new Set([
        'unauthenticated',
        'permission-denied',
        'not-found',
        'invalid-argument',
        'failed-precondition',
        'already-exists',
        'out-of-range',
      ]);
      const isUserFault = isHttpsError && userFaultCodes.has(code);
      const sentryId = isUserFault
        ? undefined
        : captureFunctionError(err, { function: name, requestId, uid: req.auth?.uid, clientErrorId, code });
      logEvent({
        severity: isUserFault ? 'warn' : 'error',
        function: name,
        event: `${name}.failure`,
        requestId,
        uid: req.auth?.uid,
        errorCode: code,
        errorMessage: isHttpsError ? message : (err as Error).message,
        durationMs: Date.now() - start,
        authCheck: authCheck.outcome,
        authCheckMs: authCheck.durationMs,
        extra: { sentryId, clientErrorId },
        ...appCheckFields(req),
      });
      try {
        await writeAuditEntry({
          status: 'FAILURE',
          event: AUDIT_EVENTS.ERROR_FUNCTION_FAILURE,
          severity: 'warn',
          actorRole: req.auth?.uid ? 'PRIMARY' : 'SYSTEM',
          actorUid: req.auth?.uid,
          payload: { function: name, code, sentryId, clientErrorId, requestId },
        });
      } catch {
        // audit best-effort; don't mask original
      }
      if (isHttpsError) throw err;
      throw new HttpsError('internal', message, { clientErrorId });
    }
  };
}
