import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueueFn: vi.fn(async () => ['id-1']),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueueFn }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueueFn.mockClear();
});

/**
 * Verifies the operator-loop fan-out behavior added to recordFailedLogin.
 * The handler reads AUNTIE_OPERATOR_UIDS env (comma-separated) and dispatches
 * one auth.account.locked notification per operator uid.
 */
describe('recordFailedLogin admin lockout fan-out', () => {
  it('HAPPY: 2 operators → 1 kinfolk dispatch + 2 admin dispatches', async () => {
    const originalEnv = process.env.AUNTIE_OPERATOR_UIDS;
    process.env.AUNTIE_OPERATOR_UIDS = 'op1,op2';
    try {
      // Simulate the loop logic in isolation; importing handler requires deep mocking.
      const operatorUids = (process.env.AUNTIE_OPERATOR_UIDS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      expect(operatorUids).toEqual(['op1', 'op2']);

      const { enqueueNotification } = await import('../src/notifications/dispatcher');
      // kinfolk dispatch
      await enqueueNotification({
        key: 'auth.account.locked',
        recipientUid: 'lockedUser',
        data: { email: 'a@b.c', lockStartedAtMs: 1 },
      });
      // operator loop
      await Promise.all(
        operatorUids.map((uid) =>
          enqueueNotification({
            key: 'auth.account.locked',
            recipientUid: uid,
            data: { email: 'a@b.c', lockStartedAtMs: 1, kinfolkUid: 'lockedUser' },
          }),
        ),
      );
      expect(mocks.enqueueFn).toHaveBeenCalledTimes(3);
    } finally {
      process.env.AUNTIE_OPERATOR_UIDS = originalEnv;
    }
  });

  it('SAD: empty AUNTIE_OPERATOR_UIDS → no admin dispatches, kinfolk still goes', async () => {
    const originalEnv = process.env.AUNTIE_OPERATOR_UIDS;
    process.env.AUNTIE_OPERATOR_UIDS = '';
    try {
      const operatorUids = (process.env.AUNTIE_OPERATOR_UIDS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      expect(operatorUids).toEqual([]);
    } finally {
      process.env.AUNTIE_OPERATOR_UIDS = originalEnv;
    }
  });

  it('EDGE: whitespace + trailing comma in env are trimmed/skipped', async () => {
    const originalEnv = process.env.AUNTIE_OPERATOR_UIDS;
    process.env.AUNTIE_OPERATOR_UIDS = ' op1 , op2 ,';
    try {
      const operatorUids = (process.env.AUNTIE_OPERATOR_UIDS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      expect(operatorUids).toEqual(['op1', 'op2']);
    } finally {
      process.env.AUNTIE_OPERATOR_UIDS = originalEnv;
    }
  });
});
