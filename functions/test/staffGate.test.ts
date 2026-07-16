import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

beforeEach(() => {
  mocks.logEvent.mockClear();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('isStaff (RULING O-6, Q1: unified staff/operator signal)', () => {
  it('claim-only uid (not on the env allowlist) passes, no deprecation log', async () => {
    const { isStaff } = await import('../src/lib/staffGate');
    expect(isStaff('u1', true, 'testFn')).toBe(true);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('env-allowlist-only uid (no claim) passes AND emits the deprecation log', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const { isStaff } = await import('../src/lib/staffGate');
    expect(isStaff('op1', false, 'testFn')).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        function: 'testFn',
        event: 'admin.allowlist.fallback.used',
        uid: 'op1',
      }),
    );
  });

  it('neither claim nor allowlist fails, no log', async () => {
    const { isStaff } = await import('../src/lib/staffGate');
    expect(isStaff('stranger', false, 'testFn')).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('both claim and allowlist: passes, no fallback log (claim already satisfies it)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const { isStaff } = await import('../src/lib/staffGate');
    expect(isStaff('op1', true, 'testFn')).toBe(true);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('undefined uid always fails, no log', async () => {
    const { isStaff } = await import('../src/lib/staffGate');
    expect(isStaff(undefined, true, 'testFn')).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
