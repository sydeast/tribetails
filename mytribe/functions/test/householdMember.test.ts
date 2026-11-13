import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { FULL_PERMISSIONS } from '../src/lib/schema';
import {
  activeMemberRecord,
  decidePrimaryLink,
  isStaffClaims,
  primaryLinkRefusalText,
  primaryMemberRecord,
  readPrimaryLinkFacts,
  type PrimaryLinkFacts,
  type PrimaryLinkRefusal,
} from '../src/lib/householdMember';

/**
 * #2096: the one member-record shape and the one "may this login be made the
 * household's PRIMARY" rule, shared by acceptInvite, setKinfolkClaim, the
 * test-login scripts and backfillHouseholdMembers.
 */

const FREE: PrimaryLinkFacts = {
  householdExists: true,
  loginExists: true,
  email: 'catch@hanasamku.com',
  memberStatus: null,
  activePrimaryUids: [],
  isStaff: false,
  listedOnHousehold: true,
  otherHouseholds: [],
};

function fakeAuth(user: { email?: string; customClaims?: Record<string, unknown> } | Error) {
  return {
    getUser: vi.fn(() => (user instanceof Error ? Promise.reject(user) : Promise.resolve(user))),
  } as never;
}

describe('activeMemberRecord / primaryMemberRecord', () => {
  it('HAPPY: is exactly the record acceptInvite writes, field for field', () => {
    const rec = activeMemberRecord(
      {
        uid: 'u1',
        displayName: 'catch@hanasamku.com',
        role: 'SECONDARY',
        secondaryLabel: 'Partner',
        permissions: FULL_PERMISSIONS,
        invitedAt: 'INVITED_TS',
      },
      'NOW',
    );
    expect(rec).toEqual({
      uid: 'u1',
      displayName: 'catch@hanasamku.com',
      role: 'SECONDARY',
      secondaryLabel: 'Partner',
      permissions: FULL_PERMISSIONS,
      status: 'ACTIVE',
      invitedAt: 'INVITED_TS',
      joinedAt: 'NOW',
      updatedAt: 'NOW',
    });
  });

  it('HAPPY: a PRIMARY linked without an invite has full permissions and no invite time', () => {
    expect(primaryMemberRecord('u1', null, 'NOW')).toMatchObject({
      role: 'PRIMARY',
      status: 'ACTIVE',
      permissions: FULL_PERMISSIONS,
      secondaryLabel: null,
      invitedAt: null,
      displayName: null,
    });
  });
});

describe('isStaffClaims', () => {
  it.each([
    [{ admin: true }, true],
    [{ staffRole: 'auntie' }, true],
    [{ staffRole: 'bookkeeper' }, true],
    [{ admin: false }, false],
    [{ role: 'kinfolk', kinfolkId: 'k1' }, false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (claims, staff) => {
    expect(isStaffClaims(claims as Record<string, unknown> | null)).toBe(staff);
  });
});

describe('decidePrimaryLink', () => {
  it('HAPPY: a free login on a household with no PRIMARY becomes its PRIMARY', () => {
    expect(decidePrimaryLink('u1', FREE)).toEqual({ action: 'create_primary' });
  });

  it('HAPPY: an ACTIVE member needs nothing (a re-run is a no-op)', () => {
    expect(decidePrimaryLink('u1', { ...FREE, memberStatus: 'ACTIVE', activePrimaryUids: ['u1'] })).toEqual({
      action: 'none',
    });
  });

  it('HAPPY: the household being already PRIMARY-less except for this login is fine', () => {
    expect(decidePrimaryLink('u1', { ...FREE, activePrimaryUids: ['u1'] })).toEqual({ action: 'create_primary' });
  });

  const refusals: Array<[string, Partial<PrimaryLinkFacts>, PrimaryLinkRefusal]> = [
    ['no household record', { householdExists: false }, 'no_household'],
    ['no account', { loginExists: false }, 'no_login'],
    ['a staff login (#1840)', { isStaff: true }, 'staff_login'],
    ['a removed member', { memberStatus: 'SUSPENDED' }, 'member_record_not_active'],
    ['an invited-only member', { memberStatus: 'INVITED' }, 'member_record_not_active'],
    ['a login on another household', { otherHouseholds: ['k2'] }, 'belongs_to_another_household'],
    ['a household with another PRIMARY', { activePrimaryUids: ['u-pk'] }, 'household_has_primary'],
  ];
  it.each(refusals)('NEGATIVE: refuses %s', (_label, patch, why) => {
    expect(decidePrimaryLink('u1', { ...FREE, ...patch })).toEqual({ action: 'refuse', why });
  });

  it('NEGATIVE: a staff login that is an ACTIVE member is left as it is, not refused', () => {
    expect(decidePrimaryLink('u1', { ...FREE, isStaff: true, memberStatus: 'ACTIVE' })).toEqual({ action: 'none' });
  });

  it('every refusal has plain words with no ids in them', () => {
    for (const [, , why] of refusals) {
      const text = primaryLinkRefusalText(why);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[_{}/]|uid|kinfolkId/);
    }
  });
});

describe('readPrimaryLinkFacts', () => {
  it('HAPPY: reads the household, the member, the PRIMARY, staff, the client listing and the stamps', async () => {
    const { db } = buildDbMock({
      docs: {
        'families/k1': { displayName: 'H' },
        'clients/u1': { kinfolkIds: ['k1', 'k2', ''] },
      },
      queryDocs: {
        'families/k1/members': [
          { id: 'u-pk', data: { role: 'PRIMARY', status: 'ACTIVE' } },
          { id: 'u-old', data: { role: 'PRIMARY', status: 'SUSPENDED' } },
        ],
        kinfolk: [
          { id: 'k1', data: { uid: 'u1' } },
          { id: 'k3', data: { uid: 'u1' } },
        ],
      },
    });
    const facts = await readPrimaryLinkFacts(
      { db: db as never, auth: fakeAuth({ email: 'catch@hanasamku.com', customClaims: {} }) },
      'k1',
      'u1',
    );
    expect(facts).toEqual({
      householdExists: true,
      loginExists: true,
      email: 'catch@hanasamku.com',
      memberStatus: null,
      activePrimaryUids: ['u-pk'],
      isStaff: false,
      listedOnHousehold: true,
      otherHouseholds: ['k2', 'k3'],
    });
  });

  it('NEGATIVE: a staff record or a staff claim both mark the login as staff', async () => {
    const withDoc = buildDbMock({ docs: { 'staff/u1': {} } });
    expect(
      (await readPrimaryLinkFacts({ db: withDoc.db as never, auth: fakeAuth({ customClaims: {} }) }, 'k1', 'u1')).isStaff,
    ).toBe(true);
    const bare = buildDbMock();
    expect(
      (await readPrimaryLinkFacts({ db: bare.db as never, auth: fakeAuth({ customClaims: { admin: true } }) }, 'k1', 'u1'))
        .isStaff,
    ).toBe(true);
  });

  it('SAD: a member record with no readable status is not ACTIVE', async () => {
    const { db } = buildDbMock({ docs: { 'families/k1/members/u1': { role: 'PRIMARY' } } });
    const facts = await readPrimaryLinkFacts({ db: db as never, auth: fakeAuth({}) }, 'k1', 'u1');
    expect(facts.memberStatus).toBe('UNKNOWN');
    expect(decidePrimaryLink('u1', facts)).toMatchObject({ action: 'refuse' });
  });

  it('SAD: a login with no account is a fact, not a throw', async () => {
    const { db } = buildDbMock({ docs: { 'families/k1': {} } });
    const facts = await readPrimaryLinkFacts(
      { db: db as never, auth: fakeAuth(Object.assign(new Error('x'), { code: 'auth/user-not-found' })) },
      'k1',
      'u1',
    );
    expect(facts.loginExists).toBe(false);
    expect(facts.email).toBeNull();
    expect(decidePrimaryLink('u1', facts)).toEqual({ action: 'refuse', why: 'no_login' });
  });

  it('ERROR: any other auth failure propagates', async () => {
    const { db } = buildDbMock();
    await expect(
      readPrimaryLinkFacts(
        { db: db as never, auth: fakeAuth(Object.assign(new Error('auth down'), { code: 'auth/internal-error' })) },
        'k1',
        'u1',
      ),
    ).rejects.toThrow('auth down');
  });
});
