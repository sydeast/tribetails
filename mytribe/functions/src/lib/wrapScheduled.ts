import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { db } from './firestoreAdmin';
import { SCHEDULE_RETRY_COUNT } from './runtimeOptions';
import { randomUUID } from 'node:crypto';

export type ScheduledHandler<C> = (ctx: C) => Promise<void> | void;

/**
 * Which attempt at this tick just failed, and whether it was the last one
 * Cloud Scheduler will make (#1142).
 *
 * The count lives on `scheduled_runs/{job}` (denied to every client, written by
 * the Admin SDK) next to the hourly jobs' run marker, keyed by the event's
 * `scheduleTime`, which Cloud Scheduler repeats on a retry of the same tick.
 * Anything that stops the count being trusted reads as FINAL, so a broken
 * counter makes a failure louder, never quieter: no `scheduleTime` (a manual
 * call, nothing retries it) and an unreadable document both land here.
 */
async function recordFailedAttempt(
  name: string,
  scheduleTime: string | undefined,
): Promise<{ attempt: number; final: boolean }> {
  if (!scheduleTime) return { attempt: 1, final: true };
  try {
    const ref = db().doc(`scheduled_runs/${name}`);
    const snap = await ref.get();
    const stored = snap.exists ? snap.data() : undefined;
    const attempt =
      stored?.failedScheduleTime === scheduleTime && typeof stored.failedAttempts === 'number'
        ? stored.failedAttempts + 1
        : 1;
    await ref.set({ failedScheduleTime: scheduleTime, failedAttempts: attempt }, { merge: true });
    return { attempt, final: attempt > SCHEDULE_RETRY_COUNT };
  } catch {
    return { attempt: 1, final: true };
  }
}
/**
 * Wraps an `onSchedule` handler so errors are reported to Sentry. Scheduled
 * job failures are otherwise invisible. Cloud Scheduler retries a failed run
 * (`retryCount` in each job's options), so every failed attempt logs
 * `<name>.failure` with its attempt number, and the attempt that spends the
 * last retry also logs `<name>.failure.final`, the one line to alert on.
 *
 * A run that never reaches this handler (a 503 or DNS fault in front of it, an
 * instance that fails its readiness check) logs nothing from here. Cloud
 * Scheduler's own `AttemptFinished` entries are the record of those.
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
      const scheduleTime = (ctx as { scheduleTime?: string } | undefined)?.scheduleTime;
      const { attempt, final } = await recordFailedAttempt(name, scheduleTime);
      const sentryId = captureFunctionError(err, {
        function: name,
        requestId,
        kind: 'scheduled',
        attempt,
        final,
      });
      const fields = {
        severity: 'critical' as const,
        function: name,
        requestId,
        errorMessage: (err as Error)?.message,
        durationMs: Date.now() - start,
        extra: { sentryId, attempt, final, scheduleTime: scheduleTime ?? null },
      };
      logEvent({ ...fields, event: `${name}.failure` });
      if (final) logEvent({ ...fields, event: `${name}.failure.final` });
      throw err;
    }
  };
}
