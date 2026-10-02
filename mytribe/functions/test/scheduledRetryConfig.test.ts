/**
 * #1142. Five scheduled runs failed in a week on transient faults (a 503, a
 * broken stream, DNS, a cold instance failing its readiness check) and none was
 * retried, because no job set a `retryCount`. This reads the endpoint the real
 * `onSchedule` builds for every exported scheduled function, so a new job that
 * forgets the retry policy, or a refactor that drops it, fails here rather than
 * in production.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const DIR = join(__dirname, '..', 'src', 'scheduled');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
interface Endpoint {
  scheduleTrigger?: {
    retryConfig?: {
      retryCount?: number;
      minBackoffSeconds?: number;
      maxBackoffSeconds?: number;
      maxDoublings?: number;
    };
  };
}
async function scheduledEndpoints(): Promise<Array<[string, Endpoint]>> {
  const out: Array<[string, Endpoint]> = [];
  for (const file of FILES) {
    const mod = (await import(join(DIR, file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      const ep = (value as { __endpoint?: Endpoint } | undefined)?.__endpoint;
      if (ep?.scheduleTrigger) out.push([name, ep]);
    }
  }
  return out;
}
describe('scheduled job retry policy', () => {
  it('finds every scheduled job', async () => {
    const names = (await scheduledEndpoints()).map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(['invoiceOverdueCron', 'outboundFanoutSweep', 'notificationScheduledSweep', 'notificationDebounceSweep']));
    expect(names.length).toBeGreaterThanOrEqual(16);
  });
  it('gives every job 3 retries with a backoff', async () => {
    const eps = await scheduledEndpoints();
    for (const [name, ep] of eps) {
      const rc = ep.scheduleTrigger?.retryConfig;
      expect(rc?.retryCount, `${name} retryCount`).toBe(3);
      expect(rc?.minBackoffSeconds, `${name} minBackoffSeconds`).toBeGreaterThan(0);
      expect(rc?.maxBackoffSeconds, `${name} maxBackoffSeconds`).toBeGreaterThanOrEqual(rc?.minBackoffSeconds ?? 0);
    }
  });
  it('keeps the minute-cadence sweeps inside their own minute', async () => {
    const eps = new Map(await scheduledEndpoints());
    for (const name of ['outboundFanoutSweep', 'notificationDebounceSweep']) {
      const rc = eps.get(name)?.scheduleTrigger?.retryConfig;
      expect(rc?.maxBackoffSeconds, name).toBeLessThanOrEqual(30);
    }
  });
});
