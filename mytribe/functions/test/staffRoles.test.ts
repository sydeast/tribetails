import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), getUsers: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: () => ({ auth: () => ({ getUsers: mocks.getUsers }) }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { staffRoleOf, staffRolesByUid } from '../src/lib/staffRoles';
import { listStaffHandler } from '../src/admin/listStaff';
import { AUDIT_EVENTS, AUDIT_EVENT_TITLES } from '../src/lib/auditEvents';

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.dbFn.mockReset();
  mocks.getUsers.mockReset();
});

/**
 * #1820. The Activity Log stores one role for the owner and a caretaker, so the
 * admin clients ask the roster which of the two an actor is.
 */
describe('#1820 staffRoleOf', () => {
  it('reads the owner from the admin claim', () => {
    expect(staffRoleOf('u1', {}, { admin: true })).toBe('owner');
  });
  it('reads an Auntie from the staffRole claim', () => {
    expect(staffRoleOf('u1', {}, { staffRole: 'auntie' })).toBe('auntie');
  });
  it('an account carrying both claims is the Auntie', () => {
    expect(staffRoleOf('u1', {}, { admin: true, staffRole: 'auntie' })).toBe('auntie');
  });
  it('falls back to the staff record when the claims could not be read', () => {
    expect(staffRoleOf('u1', { staffRole: 'auntie' }, undefined)).toBe('auntie');
  });
  it('reads the owner from the allowlist fallback', () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'boot-1';
    expect(staffRoleOf('boot-1', {}, undefined)).toBe('owner');
    expect(staffRoleOf('boot-1', {}, {})).toBe('owner');
  });
  it('guesses nothing for an account that is neither', () => {
    expect(staffRoleOf('u1', {}, {})).toBeNull();
    expect(staffRoleOf('u1', undefined, undefined)).toBeNull();
    expect(staffRoleOf('u1', { staffRole: 'owner' }, undefined)).toBeNull();
  });
});

describe('#1820 staffRolesByUid', () => {
  it('asks Auth once for the whole roster', async () => {
    mocks.getUsers.mockResolvedValue({
      users: [
        { uid: 'o1', customClaims: { admin: true } },
        { uid: 'a1', customClaims: { staffRole: 'auntie' } },
        { uid: 'n1' },
      ],
    });
    const roles = await staffRolesByUid(['o1', 'a1', 'n1'], [{}, {}, {}], 'test');
    expect(mocks.getUsers).toHaveBeenCalledTimes(1);
    expect([...roles]).toEqual([
      ['o1', 'owner'],
      ['a1', 'auntie'],
    ]);
  });

  it('answers from the staff records when Auth cannot be read', async () => {
    mocks.getUsers.mockRejectedValue(new Error('auth down'));
    const roles = await staffRolesByUid(['o1', 'a1'], [{}, { staffRole: 'auntie' }], 'test');
    expect([...roles]).toEqual([['a1', 'auntie']]);
  });
});

describe('#1820 listStaff says which staff member is the owner', () => {
  it('returns a role beside each name', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          staff: [
            { id: 'o1', data: { displayName: 'Olive' } },
            { id: 'a1', data: { displayName: 'Ada', staffRole: 'auntie' } },
            { id: 'n1', data: { displayName: 'Nell' } },
          ],
        },
      }).db,
    );
    mocks.getUsers.mockResolvedValue({
      users: [
        { uid: 'o1', customClaims: { admin: true } },
        { uid: 'a1', customClaims: { staffRole: 'auntie' } },
        { uid: 'n1', customClaims: {} },
      ],
    });
    const res = await listStaffHandler({ data: {}, auth: { uid: 'o1' } } as never);
    expect(res.staff).toEqual([
      { uid: 'a1', displayName: 'Ada', email: null, role: 'auntie' },
      { uid: 'n1', displayName: 'Nell', email: null, role: null },
      { uid: 'o1', displayName: 'Olive', email: null, role: 'owner' },
    ]);
  });
});

/** The keys the later Activity Log changes write, declared once (#1820). */
describe('#1820 event keys declared ahead of their writers', () => {
  const titled = Object.keys(AUDIT_EVENT_TITLES);

  it('every titled key is a declared event whose value is its own name', () => {
    expect(titled.length).toBeGreaterThan(0);
    for (const key of titled) {
      expect((AUDIT_EVENTS as Record<string, string>)[key]).toBe(key);
    }
  });

  it('every title is plain words: no stored key, no em dash, brand casing kept', () => {
    for (const title of Object.values(AUDIT_EVENT_TITLES)) {
      expect(title).not.toMatch(/[A-Z]{2,}_|_/);
      expect(title).not.toContain('—');
      expect(title).not.toMatch(/\bkin\b|\bkinfolk\b|Kintale|kintale/);
      expect(title.trim()).toBe(title);
      expect(title.length).toBeGreaterThan(3);
    }
  });
});
