import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listStaff, loadStaffNames, resetStaffNamesForTest, staffLabel, staffNamesByUid } from './staff';

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

/**
 * #1564: screens that hold a staff uid (the Gallery's uploader line) show the
 * person instead, from one shared listStaff read.
 */
describe('staff names by uid (#1564)', () => {
  beforeEach(() => resetStaffNamesForTest());

  it('maps each uid to its picker label', () => {
    const names = staffNamesByUid([
      { uid: 'a', displayName: 'E2E Admin', email: 'e2e-admin@tribetails.com' },
      { uid: 'b', displayName: null, email: 'catch@hanasamku.com' },
    ]);
    expect(names.get('a')).toBe('E2E Admin');
    expect(names.get('b')).toBe('catch@hanasamku.com');
  });

  it('reads once for every caller', async () => {
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null }] });
    const [one, two] = await Promise.all([loadStaffNames(), loadStaffNames()]);
    expect(one.get('a')).toBe('E2E Admin');
    expect(two).toBe(one);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a failed read gives an empty map and is tried again next time', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    expect((await loadStaffNames()).size).toBe(0);
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null }] });
    expect((await loadStaffNames()).get('a')).toBe('E2E Admin');
  });
});
