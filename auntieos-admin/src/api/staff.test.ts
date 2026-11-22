import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  listStaff,
  loadStaffNames,
  loadStaffRoles,
  loadStaffRoster,
  resetStaffNamesForTest,
  assignedAuntieLabel,
  staffLabel,
  staffName,
  staffPersonLabel,
  staffNamesByUid,
  staffRolesByUid,
} from './staff';

beforeEach(() => {
  call.mockReset();
});

describe('listStaff (admin callable, lazy)', () => {
  it('calls listStaff with an empty payload and unwraps the staff array', async () => {
    call.mockResolvedValue({
      staff: [{ uid: 'u1', displayName: 'Auntie Ruth', email: 'ruth@example.com' }],
    });
    await expect(listStaff()).resolves.toEqual([
      { uid: 'u1', displayName: 'Auntie Ruth', email: 'ruth@example.com', role: null },
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
    await expect(listStaff()).resolves.toEqual([{ uid: 'u2', displayName: 'Real', email: null, role: null }]);
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

  it('maps each uid to the person, never their email (#1882)', () => {
    const names = staffNamesByUid([
      { uid: 'a', displayName: 'E2E Admin', email: 'e2e-admin@tribetails.com' },
      { uid: 'b', displayName: null, email: 'catch@hanasamku.com', role: 'owner' },
      { uid: 'c', displayName: 'pawsome@hanasamku.com', email: null, role: 'auntie' },
      { uid: 'd', displayName: null, email: null },
    ]);
    expect(names.get('a')).toBe('E2E Admin');
    // #1882: no name on file reads as the role, the words the visit notes sign with.
    expect(names.get('b')).toBe('Office');
    expect(names.get('c')).toBe('Auntie');
    expect(names.get('d')).toBe('Staff');
  });

  it('reads once for every caller', async () => {
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null }] });
    const [one, two] = await Promise.all([loadStaffNames(), loadStaffNames()]);
    expect(one.get('a')).toBe('E2E Admin');
    expect(two).toBe(one);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('#1962 the roster, the names and (#1820) the roles share the one read', async () => {
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null, role: 'owner' }] });
    const [roster, names, roles] = await Promise.all([loadStaffRoster(), loadStaffNames(), loadStaffRoles()]);
    expect(roster).toEqual([{ uid: 'a', displayName: 'E2E Admin', email: null, role: 'owner' }]);
    expect(names.get('a')).toBe('E2E Admin');
    expect(roles.get('a')).toBe('owner');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('#1962 a failed roster read gives an empty roster and is tried again next time', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    expect(await loadStaffRoster()).toEqual([]);
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null }] });
    expect(await loadStaffRoster()).toHaveLength(1);
    expect((await loadStaffNames()).get('a')).toBe('E2E Admin');
  });

  it('a failed read gives an empty map and is tried again next time', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    expect((await loadStaffNames()).size).toBe(0);
    call.mockResolvedValue({ staff: [{ uid: 'a', displayName: 'E2E Admin', email: null }] });
    expect((await loadStaffNames()).get('a')).toBe('E2E Admin');
  });
});

/** #1820: the roster says which staff account is the owner and which an Auntie. */
describe('staff roles by uid (#1820)', () => {
  beforeEach(() => resetStaffNamesForTest());

  it('reads the role the server sends and drops anything else', async () => {
    call.mockResolvedValue({
      staff: [
        { uid: 'o', displayName: 'Olive', email: null, role: 'owner' },
        { uid: 'a', displayName: 'Ada', email: null, role: 'auntie' },
        { uid: 'n', displayName: 'Nell', email: null, role: null },
        { uid: 'x', displayName: 'Xan', email: null, role: 'SYSTEM' },
        { uid: 'old', displayName: 'Older deploy', email: null },
      ],
    });
    const staff = await listStaff();
    expect(staff.map((m) => m.role)).toEqual(['owner', 'auntie', null, null, null]);
    expect([...staffRolesByUid(staff)]).toEqual([
      ['o', 'owner'],
      ['a', 'auntie'],
    ]);
  });

  it('shares the one roster read with the names', async () => {
    call.mockResolvedValue({ staff: [{ uid: 'o', displayName: 'Olive', email: null, role: 'owner' }] });
    const [names, roles] = await Promise.all([loadStaffNames(), loadStaffRoles()]);
    expect(names.get('o')).toBe('Olive');
    expect(roles.get('o')).toBe('owner');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a failed read relabels nobody', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    expect((await loadStaffRoles()).size).toBe(0);
  });
});

// #1857: Staffing named the owner by her sign-in email, then "Assigned".
describe('Staffing names (#1857)', () => {
  const owner = { uid: 'u1', displayName: 'e2e-admin@tribetails.com', email: 'e2e-admin@tribetails.com', role: 'owner' as const };
  const ruth = { uid: 'u2', displayName: ' Auntie Ruth ', email: 'catch@hanasamku.com', role: 'auntie' as const };
  it('staffName is the name only: never an email, a uid or blank', () => {
    expect(staffName(ruth)).toBe('Auntie Ruth');
    expect(staffName(owner)).toBeNull();
    expect(staffName({ uid: 'u3', displayName: 'u3', email: null })).toBeNull();
    expect(staffName({ uid: 'u3', displayName: '  ', email: null })).toBeNull();
  });

  it('staffPersonLabel falls back to the role word', () => {
    expect(staffPersonLabel(ruth)).toBe('Auntie Ruth');
    expect(staffPersonLabel(owner)).toBe('Office');
    expect(staffPersonLabel({ uid: 'u4', displayName: null, email: null, role: 'auntie' })).toBe('Auntie');
    expect(staffPersonLabel({ uid: 'u5', displayName: null, email: 'pawsome@hanasamku.com' })).toBe('Staff');
  });

  it('assignedAuntieLabel: stored name, else the roster, else "Assigned" until the roster answers', () => {
    expect(assignedAuntieLabel(null, null, null)).toBe('Unassigned');
    expect(assignedAuntieLabel('u2', 'Auntie Ruth', null)).toBe('Auntie Ruth');
    expect(assignedAuntieLabel('u2', null, null)).toBe('Assigned');
    expect(assignedAuntieLabel('u2', null, [ruth])).toBe('Auntie Ruth');
    expect(assignedAuntieLabel('u1', 'e2e-admin@tribetails.com', [owner])).toBe('Office');
    expect(assignedAuntieLabel('gone', null, [ruth])).toBe('Staff');
    expect(assignedAuntieLabel('u2', null, [])).toBe('Assigned');
  });
});
