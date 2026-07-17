import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { randomUUID } from 'node:crypto';

export type TriggerHandler<E> = (event: E) => Promise<void> | void;

/**
 * Wraps a Firestore / Auth / Pub/Sub trigger handler so faults are routed to
 * Sentry instead of being swallowed by the v2 framework. Re-throws the error
 * so Cloud Functions retry semantics are preserved.
 */
export function wrapTrigger<E>(name: string, handler: TriggerHandler<E>): TriggerHandler<E> {
  return async (event: E): Promise<void> => {
    initSentry();
    const start = Date.now();
    const requestId = randomUUID();
    try {
      await handler(event);
      logEvent({
        severity: 'info',
        function: name,
        event: `${name}.success`,
        requestId,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const sentryId = captureFunctionError(err, { function: name, requestId, kind: 'trigger' });
      logEvent({
        severity: 'error',
        function: name,
        event: `${name}.failure`,
        requestId,
        errorMessage: (err as Error)?.message,
        durationMs: Date.now() - start,
        extra: { sentryId },
      });
      throw err;
    }
  };
}
