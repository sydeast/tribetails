import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), authFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: mocks.authFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.authFn.mockReset();
  mocks.logEventFn.mockReset();
});

import { resolveKinfolkUid } from '../src/lib/resolveKinfolkUid';

/** Seeds documents, and the members collections the PRIMARY query reads, from one map. */
function seed(docs: Record<string, Record<string, unknown>>) {
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
  for (const [path, data] of Object.entries(docs)) {
    const m = /^(families\/[^/]+\/members)\/([^/]+)$/.exec(path);
    if (m) (queryDocs[m[1]!] ??= []).push({ id: m[2]!, data });
  }
  const ctx = buildDbMock({ docs, queryDocs });
  mocks.dbFn.mockReturnValue(ctx.db);
}

describe('resolveKinfolkUid', () => {
  it('HAPPY: returns the stored login when it is an ACTIVE member of that household', async () => {
    seed({
      'kinfolk/kf1': { uid: 'user-abc' },
      'families/kf1/members/user-abc': { uid: 'user-abc', role: 'PRIMARY', status: 'ACTIVE' },
    });
    expect(await resolveKinfolkUid('kf1')).toBe('user-abc');
  });

  it('HAPPY: an ACTIVE SECONDARY member is a household login too', async () => {
    seed({
      'kinfolk/kf1': { uid: 'user-two' },
      'families/kf1/members/user-two': { uid: 'user-two', role: 'SECONDARY', status: 'ACTIVE' },
    });
    expect(await resolveKinfolkUid('kf1')).toBe('user-two');
  });

  it('SAD: returns null when kinfolk doc missing', async () => {
    seed({});
    expect(await resolveKinfolkUid('missing')).toBeNull();
  });

  it('SAD: returns null when uid field is empty string', async () => {
    seed({ 'kinfolk/kf1': { uid: '' } });
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });

  it('EDGE: returns null when uid field absent from doc', async () => {
    seed({ 'kinfolk/kf1': { otherField: 'x' } });
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });

  // #1840: the Nov 10 walk. The demo household's record carried the Admin's
  // own login and nobody had ever claimed it.
  it('NEGATIVE: a stored login with no member record in the household is nobody', async () => {
    seed({ 'kinfolk/kf1': { uid: 'uid_admin' }, 'staff/uid_admin': { displayName: 'Admin' } });

    expect(await resolveKinfolkUid('kf1')).toBeNull();
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        event: 'notification.household.recipient.not_a_member',
        familyId: 'kf1',
        extra: expect.objectContaining({ member: 'missing' }),
      }),
    );
  });

  it('NEGATIVE: a member who was removed (SUSPENDED) or only invited is nobody', async () => {
    seed({
      'kinfolk/kf1': { uid: 'user-gone' },
      'families/kf1/members/user-gone': { uid: 'user-gone', role: 'PRIMARY', status: 'SUSPENDED' },
      'kinfolk/kf2': { uid: 'user-new' },
      'families/kf2/members/user-new': { uid: 'user-new', role: 'SECONDARY', status: 'INVITED' },
    });

    expect(await resolveKinfolkUid('kf1')).toBeNull();
    expect(await resolveKinfolkUid('kf2')).toBeNull();
  });

  it('NEGATIVE: membership of a different household does not count', async () => {
    seed({
      'kinfolk/kf1': { uid: 'user-other' },
      'families/kf2/members/user-other': { uid: 'user-other', role: 'PRIMARY', status: 'ACTIVE' },
    });
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });

  it('a stored login that is no member gives way to the ACTIVE PRIMARY of the same household', async () => {
    seed({
      'kinfolk/kf1': { uid: 'uid_admin' },
      'families/kf1/members/user-pk': { uid: 'user-pk', role: 'PRIMARY', status: 'ACTIVE' },
      'families/kf1/members/user-sk': { uid: 'user-sk', role: 'SECONDARY', status: 'ACTIVE' },
      'families/kf2/members/user-zz': { uid: 'user-zz', role: 'PRIMARY', status: 'ACTIVE' },
    });

    expect(await resolveKinfolkUid('kf1')).toBe('user-pk');
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.household.recipient.not_a_member',
        extra: expect.objectContaining({ redirectedTo: 'primary' }),
      }),
    );
  });

  it('a blank stored login is nobody even when the household has members (an unlinked login stays unlinked)', async () => {
    seed({
      'kinfolk/kf1': { uid: '' },
      'families/kf1/members/user-pk': { uid: 'user-pk', role: 'PRIMARY', status: 'ACTIVE' },
    });
    expect(await resolveKinfolkUid('kf1')).toBeNull();
  });

  it('a staff login that really is a member of the household is its login', async () => {
    seed({
      'kinfolk/kf1': { uid: 'uid_admin' },
      'staff/uid_admin': { displayName: 'Admin' },
      'families/kf1/members/uid_admin': { uid: 'uid_admin', role: 'PRIMARY', status: 'ACTIVE' },
    });
    expect(await resolveKinfolkUid('kf1')).toBe('uid_admin');
  });

  describe('legacy primary until the backfill runs (#2096)', () => {
    function withClaims(claims: Record<string, unknown> | Error) {
      mocks.authFn.mockReturnValue({
        getUser: vi.fn(() => (claims instanceof Error ? Promise.reject(claims) : Promise.resolve({ customClaims: claims }))),
      });
    }
    const LEGACY = {
      'kinfolk/kf1': { uid: 'user-old' },
      'clients/user-old': { kinfolkIds: ['kf1'] },
    };

    it('HAPPY: a login linked before the member model is still told', async () => {
      seed(LEGACY);
      withClaims({ role: 'kinfolk', kinfolkId: 'kf1' });
      expect(await resolveKinfolkUid('kf1')).toBe('user-old');
      expect(mocks.logEventFn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'notification.household.recipient.legacy_primary', familyId: 'kf1' }),
      );
    });

    it('HAPPY: a legacy primary who has since invited a SECONDARY is still told', async () => {
      seed({ ...LEGACY, 'families/kf1/members/user-two': { role: 'SECONDARY', status: 'ACTIVE' } });
      withClaims({});
      expect(await resolveKinfolkUid('kf1')).toBe('user-old');
    });

    it('NEGATIVE (#1840): the Admin, by claim alone, listed on a demo household is nobody', async () => {
      seed({ 'kinfolk/kf1': { uid: 'uid_admin' }, 'clients/uid_admin': { kinfolkIds: ['kf1'] } });
      withClaims({ admin: true, role: 'kinfolk', kinfolkId: 'kf1' });
      expect(await resolveKinfolkUid('kf1')).toBeNull();
      expect(mocks.logEventFn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'notification.household.recipient.not_a_member' }),
      );
    });

    it('NEGATIVE: an Auntie assigned the tribe is nobody', async () => {
      seed({ 'kinfolk/kf1': { uid: 'uid_auntie' }, 'clients/uid_auntie': { kinfolkIds: ['kf1'] } });
      withClaims({ staffRole: 'auntie', role: 'kinfolk', kinfolkId: 'kf1' });
      expect(await resolveKinfolkUid('kf1')).toBeNull();
    });

    it('NEGATIVE: a login with a staff record is nobody, and no auth lookup is made', async () => {
      seed({ ...LEGACY, 'staff/user-old': { displayName: 'x' } });
      withClaims({});
      expect(await resolveKinfolkUid('kf1')).toBeNull();
      expect(mocks.authFn).not.toHaveBeenCalled();
    });

    it('NEGATIVE: a login whose client record does not list the household is nobody', async () => {
      seed({ 'kinfolk/kf1': { uid: 'user-old' }, 'clients/user-old': { kinfolkIds: ['kf2'] } });
      withClaims({});
      expect(await resolveKinfolkUid('kf1')).toBeNull();
      expect(mocks.authFn).not.toHaveBeenCalled();
    });

    it('NEGATIVE: a removed member keeps a record and is never a legacy primary', async () => {
      seed({ ...LEGACY, 'families/kf1/members/user-old': { role: 'PRIMARY', status: 'SUSPENDED' } });
      withClaims({});
      expect(await resolveKinfolkUid('kf1')).toBeNull();
    });

    it('NEGATIVE: a household with an ACTIVE PRIMARY goes to its PRIMARY, not the legacy login', async () => {
      seed({ ...LEGACY, 'families/kf1/members/user-pk': { role: 'PRIMARY', status: 'ACTIVE' } });
      withClaims({});
      expect(await resolveKinfolkUid('kf1')).toBe('user-pk');
    });

    it('SAD: a deleted login is nobody', async () => {
      seed(LEGACY);
      withClaims(Object.assign(new Error('gone'), { code: 'auth/user-not-found' }));
      expect(await resolveKinfolkUid('kf1')).toBeNull();
    });

    it('ERROR: any other auth failure propagates', async () => {
      seed(LEGACY);
      withClaims(Object.assign(new Error('auth down'), { code: 'auth/internal-error' }));
      await expect(resolveKinfolkUid('kf1')).rejects.toThrow('auth down');
    });
  });

  it('ERROR: a failed read propagates instead of naming a recipient', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }) }),
    });
    await expect(resolveKinfolkUid('kf1')).rejects.toThrow('unavailable');
  });
});
