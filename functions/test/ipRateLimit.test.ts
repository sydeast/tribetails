import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  txGet: vi.fn(),
  txSet: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn(async () => []) }));

function makeDbWithTimestamps(timestamps: number[]) {
  mocks.txGet.mockResolvedValue({ data: () => ({ timestamps }) });
  mocks.txSet.mockResolvedValue(undefined);

  mocks.dbFn.mockReturnValue({
    collection: () => ({
      doc: () => 'docRef',
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<void>) => {
      const tx = { get: mocks.txGet, set: mocks.txSet };
      await fn(tx);
    }),
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.txGet.mockReset();
  mocks.txSet.mockReset();
  mocks.dbFn.mockReset();
});

describe('checkIpRateLimit', () => {
  it('HAPPY: under limit — passes without throwing', async () => {
    makeDbWithTimestamps([]);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit('1.2.3.4')).resolves.toBeUndefined();
  });

  it('SAD: at limit (30 recent calls) — throws resource-exhausted', async () => {
    const now = Date.now();
    const recent = Array.from({ length: 30 }, (_, i) => now - i * 1000);
    makeDbWithTimestamps(recent);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit('1.2.3.4')).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('EDGE: expired timestamps do not count — passes when 30 old + 0 recent', async () => {
    const expired = Array.from({ length: 30 }, (_, i) => Date.now() - 10 * 60 * 1000 - i * 1000);
    makeDbWithTimestamps(expired);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit('1.2.3.4')).resolves.toBeUndefined();
  });
});
