import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getHouseholdKinRoster } from './kinRoster';

beforeEach(() => {
  call.mockReset();
});

describe('getHouseholdKinRoster', () => {
  it('asks for one household by its id', async () => {
    call.mockResolvedValue({ kin: [], chooseKin: false });
    await getHouseholdKinRoster('kf1');
    expect(call).toHaveBeenCalledWith('getHouseholdKinRoster', { kinfolkId: 'kf1' });
  });

  it('returns the Kin and whether they can be chosen', async () => {
    call.mockResolvedValue({
      kin: [
        { id: 'k1', name: 'Biscuit', householdId: 'flat1' },
        { id: 'k2', name: 'Gravy' },
      ],
      chooseKin: true,
    });
    expect(await getHouseholdKinRoster('kf1')).toEqual({
      kin: [
        { id: 'k1', name: 'Biscuit', householdId: 'flat1' },
        { id: 'k2', name: 'Gravy', householdId: null },
      ],
      chooseKin: true,
    });
  });

  it('reads choosing as off unless the server says exactly true', async () => {
    for (const chooseKin of [false, undefined, null, 'true', 1]) {
      call.mockResolvedValue({ kin: [], chooseKin });
      expect((await getHouseholdKinRoster('kf1')).chooseKin).toBe(false);
    }
  });

  it('keeps a Kin with no name, as a null name, and drops a row with no id', async () => {
    call.mockResolvedValue({
      kin: [{ id: 'k1', name: '  ' }, { id: 'k2', name: null }, { name: 'No Id' }, { id: '' }, null],
      chooseKin: false,
    });
    expect((await getHouseholdKinRoster('kf1')).kin).toEqual([
      { id: 'k1', name: null, householdId: null },
      { id: 'k2', name: null, householdId: null },
    ]);
  });

  it('does not repeat a card id that is the same as the id', async () => {
    call.mockResolvedValue({ kin: [{ id: 'k1', name: 'Biscuit', householdId: 'k1' }], chooseKin: false });
    expect((await getHouseholdKinRoster('kf1')).kin[0]).toEqual({ id: 'k1', name: 'Biscuit', householdId: null });
  });

  it('throws when an older server answers with no Kin list, so the form says it could not load them', async () => {
    call.mockResolvedValue({});
    await expect(getHouseholdKinRoster('kf1')).rejects.toThrow();
    call.mockResolvedValue(null);
    await expect(getHouseholdKinRoster('kf1')).rejects.toThrow();
  });

  it('passes a failed call on to the caller', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(getHouseholdKinRoster('kf1')).rejects.toThrow('permission-denied');
  });
});
