import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listStaff, staffLabel } from './staff';

beforeEach(() => {
  call.mockReset();
});

describe('listStaff (admin callable, lazy)', () => {
  it('calls listStaff with an empty payload and unwraps the staff array', async () => {
    call.mockResolvedValue({
      staff: [{ uid: 'u1', displayName: 'Auntie Ruth', email: 'ruth@example.com' }],
    });
    await expect(listStaff()).resolves.toEqual([
      { uid: 'u1', displayName: 'Auntie Ruth', email: 'ruth@example.com' },
    ]);
    expect(call).toHaveBeenCalledWith('listStaff', {});
  });

  it('reads an absent or malformed staff field as an empty roster, never undefined', async () => {
    call.mockResolvedValue({});
    await expect(listStaff()).resolves.toEqual([]);
    call.mockResolvedValue({ staff: 'nope' });
    await expect(listStaff()).resolves.toEqual([]);
  });

  it('drops rows with no uid rather than rendering an unassignable picker entry', async () => {
    call.mockResolvedValue({ staff: [{ displayName: 'Ghost' }, { uid: 'u2', displayName: 'Real' }] });
    await expect(listStaff()).resolves.toEqual([{ uid: 'u2', displayName: 'Real', email: null }]);
  });

  it('propagates a callable failure fail-loud', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(listStaff()).rejects.toThrow('permission-denied');
  });
});

describe('staffLabel', () => {
  it('prefers the display name', () => {
    expect(staffLabel({ uid: 'u1', displayName: 'Auntie Ruth', email: 'r@x.com' })).toBe('Auntie Ruth');
  });

  it('falls back to the email, then to the uid, never to a blank control', () => {
    expect(staffLabel({ uid: 'u1', displayName: '  ', email: 'r@x.com' })).toBe('r@x.com');
    expect(staffLabel({ uid: 'u1', displayName: null, email: null })).toBe('u1');
  });
});
