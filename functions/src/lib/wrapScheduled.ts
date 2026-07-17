import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { randomUUID } from 'node:crypto';

export type ScheduledHandler<C> = (ctx: C) => Promise<void> | void;

/**
 * Wraps an `onSchedule` handler so errors are reported to Sentry. Scheduled
 * job failures are otherwise invisible, Cloud Scheduler retries silently.
 */
export function wrapScheduled<C>(name: string, handler: ScheduledHandler<C>): ScheduledHandler<C> {
  return async (ctx: C): Promise<void> => {
    initSentry();
    const start = Date.now();
    const requestId = randomUUID();
    try {
      await handler(ctx);
      logEvent({
        severity: 'info',
        function: name,
        event: `${name}.success`,
        requestId,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const sentryId = captureFunctionError(err, { function: name, requestId, kind: 'scheduled' });
      logEvent({
        severity: 'critical',
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
