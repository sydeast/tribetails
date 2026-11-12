import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
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

  it('ERROR: a failed read propagates instead of naming a recipient', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }) }),
    });
    await expect(resolveKinfolkUid('kf1')).rejects.toThrow('unavailable');
  });
});
