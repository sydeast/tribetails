import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { getHouseholdKinRoster } from './portal';

// Replace the single callables choke point so the test asserts the exact
// payload the wrapper builds, without touching the network.
vi.mock('../lib/fns', () => ({ call: vi.fn() }));

// #1822 / #1862: the Kin a booking covers, and whether they can be chosen, as
// the server answers it. The same list the office's booking forms show.
describe('getHouseholdKinRoster wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
  });

  it('asks for the household by its id', async () => {
    vi.mocked(call).mockResolvedValue({ kin: [], chooseKin: false } as never);
    await getHouseholdKinRoster('fam1');
    expect(call).toHaveBeenCalledWith('getHouseholdKinRoster', { kinfolkId: 'fam1' });
  });

  it('names no household when none is given, and the server picks the caller’s own', async () => {
    vi.mocked(call).mockResolvedValue({ kin: [], chooseKin: false } as never);
    await getHouseholdKinRoster();
    expect(call).toHaveBeenCalledWith('getHouseholdKinRoster', {});
  });

  it('returns the Kin in the server’s order and whether they can be chosen', async () => {
    vi.mocked(call).mockResolvedValue({
      kin: [
        { id: 'k2', name: 'Willow' },
        { id: 'k1', name: 'Buddy' },
      ],
      chooseKin: true,
    } as never);
    await expect(getHouseholdKinRoster('fam1')).resolves.toEqual({
      kin: [
        { id: 'k2', name: 'Willow' },
        { id: 'k1', name: 'Buddy' },
      ],
      chooseKin: true,
    });
  });

  it('reads choosing as off unless the server says exactly true', async () => {
    for (const chooseKin of [false, undefined, null, 'true', 1]) {
      vi.mocked(call).mockResolvedValue({ kin: [], chooseKin } as never);
      expect((await getHouseholdKinRoster('fam1')).chooseKin).toBe(false);
    }
  });

  it('keeps a Kin with no name, as a null name, and drops a row with no id', async () => {
    vi.mocked(call).mockResolvedValue({
      kin: [{ id: 'k1', name: ' ' }, { id: 'k2', name: null }, { name: 'No Id' }, { id: '' }, null],
      chooseKin: false,
    } as never);
    expect((await getHouseholdKinRoster('fam1')).kin).toEqual([
      { id: 'k1', name: null },
      { id: 'k2', name: null },
    ]);
  });

  it('never passes an admin record id on to the household', async () => {
    vi.mocked(call).mockResolvedValue({
      kin: [{ id: 'k1', name: 'Buddy', adminId: 'flat1' }],
      chooseKin: false,
    } as never);
    expect((await getHouseholdKinRoster('fam1')).kin[0]).toEqual({ id: 'k1', name: 'Buddy' });
  });

  it('throws when an older server answers with no Kin list, so the wizard falls back to the household’s own Kin', async () => {
    vi.mocked(call).mockResolvedValue({} as never);
    await expect(getHouseholdKinRoster('fam1')).rejects.toThrow();
    vi.mocked(call).mockResolvedValue(null as never);
    await expect(getHouseholdKinRoster('fam1')).rejects.toThrow();
  });

  it('does not swallow a rejection', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('permission-denied'));
    await expect(getHouseholdKinRoster('fam1')).rejects.toThrow('permission-denied');
  });
});
