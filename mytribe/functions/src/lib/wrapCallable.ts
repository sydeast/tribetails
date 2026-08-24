import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { assertSessionNotRevoked, type RevocationCheck } from './sessionRevocation';
import { randomUUID } from 'node:crypto';
import {
  APP_CHECK_REJECT_MESSAGE,
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
 * VERIFIED App Check token, even with enforcement fully off — this is what
 * lets the grace-period metric (valid-token rate from portal/Android origins)
 * be measured before anything is ever rejected. `wrapAdminCallable` delegates
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
 * O-3 L2: the gate that can actually refuse.
 *
 * Costs nothing for a function outside the enforced cohort — no Firestore
 * read, no await — which is why it sits in front of ~230 callables without
 * being on any of their critical paths. For a cohort member it reads the
 * runtime mode (cached 60s, one read per instance per minute) and either
 * serves, records a would-have-refused, or refuses.
 *
 * `unauthenticated` is the code, per D2. `wrapCallable`'s own error path
 * already classifies that as user-fault, so a refusal logs and audits without
 * filling Sentry with events that are working as designed.
 */
async function gateOnAppCheck(name: string, req: CallableRequest<unknown>, requestId: string): Promise<void> {
  const inCohort = isAppCheckCohort(name);
  if (!inCohort) return;
  const status = appCheckStatusOf(req);
  const mode = await currentAppCheckMode();
  const decision = appCheckDecision({ mode, status, inCohort });
  if (decision === 'allow') return;
  logEvent({
    severity: 'warn',
    function: name,
    event: `${name}.appCheck.${decision === 'reject' ? 'rejected' : 'wouldReject'}`,
    requestId,
    uid: req.auth?.uid,
    ...appCheckFields(req),
    extra: { appCheckMode: mode },
  });
  if (decision === 'reject') throw new HttpsError('unauthenticated', APP_CHECK_REJECT_MESSAGE);
}

export function wrapCallable<T, R>(name: string, handler: Handler<T, R>): Handler<T, R> {
  return async (req: CallableRequest<T>): Promise<R> => {
    initSentry(); // lazy init at first invocation (env var is bound by then)
    const start = Date.now();
    const requestId = randomUUID();
    const clientErrorId = randomUUID();
    // #557: 'not-run' until the revocation gate is actually reached. It is a
    // distinct value from 'skipped' on purpose: 'skipped' means the caller was
    // unauthenticated so there was nothing to look up, whereas this means an
    // EARLIER gate refused first. Collapsing the two would let an App Check
    // refusal masquerade in the logs as an ordinary anonymous call.
    let authCheck: RevocationCheck = { outcome: 'not-run', durationMs: 0 };
    try {
      // ORDER: App Check (O-3 L2, #556) first, session revocation (#557)
      // second. Both refuse with `unauthenticated`, both sit ahead of the
      // handler, and they answer different questions, so the order is a
      // decision rather than an accident:
      //
      //  - App Check asks "is this request from a client build we trust". It
      //    costs nothing outside the enforced cohort (a synchronous array
      //    lookup and an early return), so putting it first adds no latency to
      //    the ~230 callables it does not police.
      //  - Revocation asks "is the person behind this token still in a live
      //    session". That one costs an Identity Toolkit lookup. Running it
      //    second means a request we are about to refuse for failing
      //    attestation never spends that lookup, or the quota behind it.
      //  - Ordering it this way also keeps the App Check grace-period metric
      //    honest: every cohort request reaches the App Check decision, rather
      //    than some of them being pre-empted by an auth refusal and never
      //    showing up in the valid-token rate D2 gates L3 on.
      //
      // Neither gate masks the other. They stay distinguishable to the caller
      // (an App Check refusal carries no `details`; a revocation refusal
      // carries `details.reason`, which is exactly what the portal and Android
      // clients branch on before signing anybody out) and in the logs
      // (`appCheck` / the `.appCheck.rejected` line vs `authCheck: 'revoked'`).
      //
      // Inside the try on purpose, both of them: a refusal is a failure like
      // any other and belongs in the failure log and the audit trail.
      await gateOnAppCheck(name, req, requestId);
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
