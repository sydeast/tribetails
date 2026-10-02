/**
 * #1142. A scheduled run that throws is retried by Cloud Scheduler (the
 * `retryCount` in each job's options), and a run that has used up its retries
 * must leave one named line an alert can match. `wrapScheduled` is where both
 * live, and it had no test.
 *
 * The attempt count is kept on `scheduled_runs/{job}` and keyed by the event's
 * `scheduleTime`, which Cloud Scheduler repeats on a retry of the same tick. A
 * counter that cannot be read or written must never hide a failure, so the
 * unreadable case is treated as final.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  logEvent: vi.fn(),
  capture: vi.fn(() => 'sentry-id'),
  store: new Map<string, Record<string, unknown>>(),
  failRead: false,
}));
vi.mock('../src/lib/logger', () => ({ logEvent: h.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: h.capture }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (h.failRead) throw new Error('unavailable');
        const data = h.store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (data: Record<string, unknown>) => {
        h.store.set(path, { ...(h.store.get(path) ?? {}), ...data });
      },
    }),
  }),
}));
import { wrapScheduled } from '../src/lib/wrapScheduled';
import { SCHEDULE_RETRY_COUNT } from '../src/lib/runtimeOptions';
const TICK = { scheduleTime: '2026-10-02T08:31:00Z' };
const boom = async (): Promise<void> => {
  throw new Error('503 from upstream');
};
function events(): string[] {
  return h.logEvent.mock.calls.map((c) => (c[0] as { event: string }).event);
}
beforeEach(() => {
  h.logEvent.mockClear();
  h.capture.mockClear();
  h.store.clear();
  h.failRead = false;
});
describe('wrapScheduled', () => {
  it('logs success and does not touch the failure counter', async () => {
    await wrapScheduled('sweepA', async () => {})(TICK);
    expect(events()).toEqual(['sweepA.success']);
    expect(h.store.size).toBe(0);
  });
  it('rethrows so Cloud Scheduler sees the failure and retries', async () => {
    await expect(wrapScheduled('sweepA', boom)(TICK)).rejects.toThrow('503 from upstream');
  });
  it('marks an early attempt as retrying, not final', async () => {
    await expect(wrapScheduled('sweepA', boom)(TICK)).rejects.toThrow();
    expect(events()).toContain('sweepA.failure');
    expect(events()).not.toContain('sweepA.failure.final');
    const failure = h.logEvent.mock.calls.map((c) => c[0]).find((c) => c.event === 'sweepA.failure');
    expect(failure.extra).toMatchObject({ attempt: 1, final: false });
  });
  it('logs sweepA.failure.final at critical, with a Sentry id, once the retries are spent', async () => {
    const run = wrapScheduled('sweepA', boom);
    for (let i = 0; i < SCHEDULE_RETRY_COUNT + 1; i += 1) {
      await expect(run(TICK)).rejects.toThrow();
    }
    const finals = h.logEvent.mock.calls.map((c) => c[0]).filter((c) => c.event === 'sweepA.failure.final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      severity: 'critical',
      function: 'sweepA',
      extra: { attempt: SCHEDULE_RETRY_COUNT + 1, sentryId: 'sentry-id', scheduleTime: TICK.scheduleTime },
    });
  });
  it('starts counting again on the next tick', async () => {
    const run = wrapScheduled('sweepA', boom);
    for (let i = 0; i < SCHEDULE_RETRY_COUNT + 1; i += 1) await expect(run(TICK)).rejects.toThrow();
    h.logEvent.mockClear();
    await expect(run({ scheduleTime: '2026-10-02T08:32:00Z' })).rejects.toThrow();
    expect(events()).not.toContain('sweepA.failure.final');
  });
  it('keeps each job on its own counter', async () => {
    for (let i = 0; i < SCHEDULE_RETRY_COUNT; i += 1) await expect(wrapScheduled('sweepA', boom)(TICK)).rejects.toThrow();
    await expect(wrapScheduled('sweepB', boom)(TICK)).rejects.toThrow();
    expect(events()).not.toContain('sweepA.failure.final');
    expect(events()).not.toContain('sweepB.failure.final');
  });
  it('treats an unreadable counter as final rather than hiding the failure', async () => {
    h.failRead = true;
    await expect(wrapScheduled('sweepA', boom)(TICK)).rejects.toThrow();
    expect(events()).toContain('sweepA.failure.final');
  });
  it('treats a run with no scheduleTime (a manual call) as final', async () => {
    await expect(wrapScheduled('sweepA', boom)(undefined)).rejects.toThrow();
    expect(events()).toContain('sweepA.failure.final');
  });
});
