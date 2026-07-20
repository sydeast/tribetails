import { describe, it, expect, vi, beforeEach } from 'vitest';

let store: Record<string, { count?: number; windowStart?: number } | undefined> = {};

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => ({ __path: p }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { __path: string }) => ({ data: () => store[ref.__path] }),
        set: (ref: { __path: string }, v: { count: number; windowStart: number }) => {
          store[ref.__path] = v;
        },
      };
      await fn(tx);
    },
  }),
}));

beforeEach(() => {
  store = {};
});

describe('enforceRateLimit', () => {
  it('allows up to the max within a window then throws resource-exhausted', async () => {
    const { enforceRateLimit } = await import('../src/lib/rateLimit');
    for (let i = 0; i < 3; i++) {
      await enforceRateLimit('test', 'ip1', 3, 3600);
    }
    await expect(enforceRateLimit('test', 'ip1', 3, 3600)).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('resets after the window elapses', async () => {
    const { enforceRateLimit } = await import('../src/lib/rateLimit');
    await enforceRateLimit('test', 'ip1', 1, 3600);
    // Force the stored window into the past.
    const key = Object.keys(store)[0];
    store[key] = { count: 1, windowStart: Date.now() - 3601 * 1000 };
    await expect(enforceRateLimit('test', 'ip1', 1, 3600)).resolves.toBeUndefined();
  });

  it('keys are isolated per scope and key', async () => {
    const { enforceRateLimit } = await import('../src/lib/rateLimit');
    await enforceRateLimit('test', 'ip1', 1, 3600);
    await expect(enforceRateLimit('test', 'ip2', 1, 3600)).resolves.toBeUndefined();
    await expect(enforceRateLimit('other', 'ip1', 1, 3600)).resolves.toBeUndefined();
  });
});
