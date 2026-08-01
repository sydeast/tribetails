import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { randomUUID } from 'node:crypto';

export type Handler<T, R> = (req: CallableRequest<T>) => Promise<R>;

/**
 * O-3 App Check L1 telemetry (docs/O3_APP_CHECK_RULING_2026-07-13.md, D2):
 * pure signal, no behavior change. `req.app` is populated by the platform
 * whenever the request carried a verified App Check token, even with
 * enforcement fully off — this is what lets the grace-period metric
 * (valid-token rate from portal/Android origins) be measured before
 * anything is ever rejected. `wrapAdminCallable` delegates to this wrapper
 * rather than logging separately, so this single call site covers every
 * onCall function that routes through either wrapper (all of them).
 */
function appCheckFields(req: CallableRequest<unknown>): { appCheck: 'valid' | 'absent'; origin?: string } {
  const origin = req.rawRequest?.headers?.origin;
  return {
    appCheck: req.app ? 'valid' : 'absent',
    ...(typeof origin === 'string' ? { origin } : {}),
  };
}

export function wrapCallable<T, R>(name: string, handler: Handler<T, R>): Handler<T, R> {
  return async (req: CallableRequest<T>): Promise<R> => {
    initSentry(); // lazy init at first invocation (env var is bound by then)
    const start = Date.now();
    const requestId = randomUUID();
    const clientErrorId = randomUUID();
    try {
      const result = await handler(req);
      logEvent({
        severity: 'info',
        function: name,
        event: `${name}.success`,
        requestId,
        uid: req.auth?.uid,
        durationMs: Date.now() - start,
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
