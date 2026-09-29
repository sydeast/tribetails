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
      // Skip user-fault codes from Sentry, they pollute the issue feed without
      // signalling a server bug. Capture programmer faults + server faults only.
      const userFaultCodes = new Set([
        'unauthenticated',
        'permission-denied',
        'not-found',
        'invalid-argument',
        'failed-precondition',
        'already-exists',
        'out-of-range',
      ]);
      const shouldCapture = !isHttpsError || !userFaultCodes.has(code);
      const sentryId = shouldCapture
        ? captureFunctionError(err, { function: name, requestId, uid: req.auth?.uid, clientErrorId, code })
        : undefined;
      logEvent({
        severity: 'error',
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
