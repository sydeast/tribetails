import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2228: removing an Auntie's role also takes her off the business admin list
 * and unregisters her work devices from business notices, in one logged step.
 *
 * Before this, `grant-staff-role.mjs --role none` removed the claim, swallowed
 * a failed staff-record delete, and left her uid on `businessSettings/admins`.
 * With the claim and the staff record both gone, that uid cannot be told apart
 * from an owner known only from the allowlist, so the send-time filter kept
 * sending her business notices.
 */

interface FakeUser {
  uid: string;
  email: string;
  displayName?: string;
  customClaims: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  users: new Map<string, FakeUser>(),
  /** When set, `getUser` rejects with this for every uid. */
  getUserError: null as null | (Error & { code?: string }),
  syncKinfolkClaim: vi.fn(async () => ({ kinfolkId: 'fam-a' })),
}));

function notFound(): Error & { code: string } {
  return Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
}

const fakeAuth = {
  getUserByEmail: vi.fn(async (email: string) => {
    for (const u of mocks.users.values()) if (u.email === email) return u;
    throw notFound();
  }),
  getUser: vi.fn(async (uid: string) => {
    if (mocks.getUserError) throw mocks.getUserError;
    const u = mocks.users.get(uid);
    if (!u) throw notFound();
    return u;
  }),
  getUsers: vi.fn(async (ids: Array<{ uid: string }>) => ({
    users: ids.map(({ uid }) => mocks.users.get(uid)).filter((u): u is FakeUser => !!u),
    notFound: ids.filter(({ uid }) => !mocks.users.has(uid)),
  })),
  setCustomUserClaims: vi.fn(async (uid: string, claims: Record<string, unknown> | null) => {
    const u = mocks.users.get(uid);
    if (u) u.customClaims = { ...(claims ?? {}) };
  }),
  createUser: vi.fn(async (args: { email: string; displayName?: string }) => {
    const uid = `new-${mocks.users.size + 1}`;
    mocks.users.set(uid, { uid, email: args.email, customClaims: {} });
    return { uid };
  }),
};

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => fakeAuth,
  getAdmin: () => ({ auth: () => fakeAuth }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/kinfolkClaim', () => ({ syncKinfolkClaim: mocks.syncKinfolkClaim }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
  };
});

import { logEvent } from '../src/lib/logger';
import { endStaffBusinessAccess, isHouseholdAppPlatform } from '../src/lib/staffAccessEnd';
import { resolveBusinessAdminUids } from '../src/lib/businessAdmins';
import { parseGrantStaffRoleArgs, runGrantStaffRole } from '../scripts/grantStaffRole';
import { onClientsWrite } from '../src/triggers/onClientsWrite';

const ADMINS = 'businessSettings/admins';
const AUNTIE_EMAIL = 'catch@hanasamku.com';
const OWNER_EMAIL = 'e2e-admin@tribetails.com';
const ORIGINAL_ENV = process.env.AUNTIE_OPERATOR_UIDS;

type Docs = Record<string, Record<string, unknown> | null>;

function dbWith(docs: Docs) {
  const mock = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(mock.db);
  return { ...mock, docs };
}

function addUser(uid: string, email: string, customClaims: Record<string, unknown>) {
  mocks.users.set(uid, { uid, email, customClaims: { ...customClaims } });
}

/** The world the issue describes: owner `op1` and Auntie `a1` both on the list. */
function auntieWorld(extra: Docs = {}) {
  addUser('op1', OWNER_EMAIL, { admin: true });
  addUser('a1', AUNTIE_EMAIL, { staffRole: 'auntie' });
  return dbWith({
    [ADMINS]: { uids: ['op1', 'a1'] },
    'staff/a1': { uid: 'a1', email: AUNTIE_EMAIL, staffRole: 'auntie' },
    // Her AuntieOS Android phone, an older admin-app registration with no
    // platform, and a household portal registration under the same uid.
    'fcm_tokens/tok-a1-phone': { uid: 'a1', platform: 'android' },
    'fcm_tokens/tok-a1-old': { uid: 'a1' },
    'fcm_tokens/tok-a1-portal': { uid: 'a1', platform: 'android-mytribe' },
    'fcm_tokens/tok-op1': { uid: 'op1', platform: 'android' },
    ...extra,
  });
}

function auditLines(docs: Docs) {
  return Object.entries(docs).filter(
    ([path, data]) => path.startsWith('activity_log/') && data?.['actionType'] === 'PERM_STAFF_ROLE_REMOVED',
  );
}

function tokensOf(docs: Docs, uid: string): string[] {
  return Object.entries(docs)
    .filter(([path, data]) => path.startsWith('fcm_tokens/') && data?.['uid'] === uid)
    .map(([path]) => path.slice('fcm_tokens/'.length))
    .sort();
}

function collector() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) } };
}

function loggedEvents(event: string) {
  return vi
    .mocked(logEvent)
    .mock.calls.map((c) => c[0])
    .filter((f) => f.event === event);
}

async function deleteClient(uid: string, before: Record<string, unknown> = {}) {
  await onClientsWrite.run({
    id: `evt-${uid}`,
    params: { uid },
    data: {
      before: { data: () => before, exists: true },
      after: { data: () => undefined, exists: false },
    },
  } as never);
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.users.clear();
  mocks.getUserError = null;
  vi.mocked(logEvent).mockClear();
  fakeAuth.setCustomUserClaims.mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = ORIGINAL_ENV;
});

describe('which device registrations are business-notice devices', () => {
  it('the household portal platforms are kept, the admin app is not', () => {
    expect(isHouseholdAppPlatform('web')).toBe(true);
    expect(isHouseholdAppPlatform('android-mytribe')).toBe(true);
    expect(isHouseholdAppPlatform('desktop-mytribe')).toBe(true);
    expect(isHouseholdAppPlatform('web-mytribe')).toBe(true);
    expect(isHouseholdAppPlatform('android')).toBe(false);
    expect(isHouseholdAppPlatform(undefined)).toBe(false);
  });
});

describe('endStaffBusinessAccess', () => {
  it('takes her off the list, clears her admin-app devices and writes one log line, in one transaction', async () => {
    const world = auntieWorld();

    const result = await endStaffBusinessAccess({
      uid: 'a1',
      claimsBefore: { staffRole: 'auntie' },
      source: 'grant-staff-role',
    });

    expect(result).toEqual({
      outcome: 'ended',
      removedFromList: true,
      listEmptied: false,
      defaultAssigneeCleared: false,
      devicesCleared: 2,
      householdDevicesKept: 1,
    });
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'a1')).toEqual(['tok-a1-portal']);
    expect(tokensOf(world.docs, 'op1')).toEqual(['tok-op1']);
    expect(world.db.runTransaction).toHaveBeenCalledTimes(1);

    const lines = auditLines(world.docs);
    expect(lines).toHaveLength(1);
    const line = lines[0]![1]!;
    expect(line).toMatchObject({
      targetId: 'a1',
      actorRole: 'SYSTEM',
      status: 'SUCCESS',
      severity: 'warn',
      seq: 1,
      payload: { source: 'grant-staff-role', removedFromList: true, devicesCleared: 2 },
    });
    // Plain words on the Activity Log, no ids.
    expect(String(line['description'])).not.toMatch(/a1|uid|fcm|businessSettings/);
    expect(world.docs['activity_log_chain_head/current']?.['seq']).toBe(1);
  });

  it('a re-run changes nothing and writes no second line', async () => {
    const world = auntieWorld();
    await endStaffBusinessAccess({ uid: 'a1', claimsBefore: { staffRole: 'auntie' }, source: 'grant-staff-role' });
    const writesAfterFirst = world.writes.length;

    const again = await endStaffBusinessAccess({ uid: 'a1', claimsBefore: {}, source: 'grant-staff-role' });

    expect(again.outcome).toBe('nothing-to-change');
    expect(world.writes.length).toBe(writesAfterFirst);
    expect(auditLines(world.docs)).toHaveLength(1);
  });

  it('never removes an owner: the owner claim, before the change', async () => {
    const world = dbWith({
      [ADMINS]: { uids: ['op1'] },
      'staff/op1': { staffRole: 'auntie' },
      'fcm_tokens/tok-op1': { uid: 'op1', platform: 'android' },
    });

    const result = await endStaffBusinessAccess({ uid: 'op1', claimsBefore: { admin: true }, source: 'onClientsWrite' });

    expect(result.outcome).toBe('owner-kept');
    expect(world.writes).toEqual([]);
    expect(world.deletes).toEqual([]);
    expect(world.db.runTransaction).not.toHaveBeenCalled();
  });

  it('never removes an owner known only from the allowlist', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op9';
    const world = dbWith({ [ADMINS]: { uids: ['op9'] }, 'staff/op9': { staffRole: 'auntie' } });

    const result = await endStaffBusinessAccess({ uid: 'op9', claimsBefore: null, source: 'onClientsWrite' });

    expect(result.outcome).toBe('owner-kept');
    expect(world.writes).toEqual([]);
  });

  it('a double-claimed account is the owner once her staff role is gone, so it stays', async () => {
    const world = dbWith({ [ADMINS]: { uids: ['d1'] }, 'fcm_tokens/tok-d1': { uid: 'd1', platform: 'android' } });

    const result = await endStaffBusinessAccess({
      uid: 'd1',
      claimsBefore: { admin: true, staffRole: 'auntie' },
      source: 'grant-staff-role',
    });

    expect(result.outcome).toBe('owner-kept');
    expect(world.docs[ADMINS]?.['uids']).toEqual(['d1']);
    expect(tokensOf(world.docs, 'd1')).toEqual(['tok-d1']);
  });

  it('touches nothing without evidence she is an Auntie (a household, or a uid nobody can name)', async () => {
    const world = dbWith({
      [ADMINS]: { uids: ['op1', 'h1'] },
      'fcm_tokens/tok-h1': { uid: 'h1', platform: 'web' },
      'fcm_tokens/tok-h1-app': { uid: 'h1', platform: 'android' },
    });

    const result = await endStaffBusinessAccess({
      uid: 'h1',
      claimsBefore: { role: 'kinfolk', kinfolkId: 'fam-a' },
      source: 'onClientsWrite',
    });

    expect(result.outcome).toBe('not-staff');
    expect(world.writes).toEqual([]);
    expect(world.deletes).toEqual([]);
    expect(tokensOf(world.docs, 'h1')).toEqual(['tok-h1', 'tok-h1-app']);
  });

  it('her staff record is evidence when the claims are already gone', async () => {
    const world = auntieWorld();
    const result = await endStaffBusinessAccess({ uid: 'a1', claimsBefore: {}, source: 'grant-staff-role' });
    expect(result.outcome).toBe('ended');
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
  });

  it('clears the default assignee when it names her', async () => {
    const world = auntieWorld({ [ADMINS]: { uids: ['a1', 'op1'], defaultAssigneeUid: 'a1' } });

    const result = await endStaffBusinessAccess({ uid: 'a1', claimsBefore: { staffRole: 'auntie' }, source: 'grant-staff-role' });

    expect(result.defaultAssigneeCleared).toBe(true);
    expect(world.docs[ADMINS]).toMatchObject({ uids: ['op1'], defaultAssigneeUid: '__DELETE__' });
  });

  it('when she was the only one on the list, the list is emptied and that is logged at error', async () => {
    const world = auntieWorld({ [ADMINS]: { uids: ['a1'] } });

    const result = await endStaffBusinessAccess({ uid: 'a1', claimsBefore: { staffRole: 'auntie' }, source: 'grant-staff-role' });

    expect(result).toMatchObject({ outcome: 'ended', listEmptied: true });
    expect(world.docs[ADMINS]?.['uids']).toEqual([]);
    expect(loggedEvents('staffAccess.end.done')[0]?.severity).toBe('error');
  });

  it('clears her devices even when she was never on the list', async () => {
    const world = auntieWorld({ [ADMINS]: { uids: ['op1'] } });

    const result = await endStaffBusinessAccess({ uid: 'a1', claimsBefore: { staffRole: 'auntie' }, source: 'grant-staff-role' });

    expect(result).toMatchObject({ outcome: 'ended', removedFromList: false, devicesCleared: 2 });
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(auditLines(world.docs)).toHaveLength(1);
  });

  it('a failed commit leaves the list, the devices and the log as they were', async () => {
    const world = auntieWorld();
    world.db.runTransaction.mockRejectedValueOnce(new Error('ABORTED: contention'));

    await expect(
      endStaffBusinessAccess({ uid: 'a1', claimsBefore: { staffRole: 'auntie' }, source: 'grant-staff-role' }),
    ).rejects.toThrow(/ABORTED/);
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1', 'a1']);
    expect(tokensOf(world.docs, 'a1')).toHaveLength(3);
    expect(auditLines(world.docs)).toHaveLength(0);
  });
});

describe('grant-staff-role --role none', () => {
  it('parses the command line', () => {
    expect(parseGrantStaffRoleArgs(['--email', AUNTIE_EMAIL, '--role', 'none'])).toEqual({
      email: AUNTIE_EMAIL,
      role: 'none',
    });
    expect(parseGrantStaffRoleArgs(['--email', AUNTIE_EMAIL, '--role', 'admin'])).toBeNull();
    expect(parseGrantStaffRoleArgs(['--role', 'none'])).toBeNull();
  });

  it('removes the claim, takes her off the list, clears her work devices, then deletes her staff record', async () => {
    const world = auntieWorld();
    const { out, lines, errors } = collector();

    const code = await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(mocks.users.get('a1')?.customClaims).toEqual({});
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'a1')).toEqual(['tok-a1-portal']);
    expect(world.docs['staff/a1']).toBeUndefined();
    expect(auditLines(world.docs)).toHaveLength(1);
    expect(lines).toContain('Taken off the business admin list.');
    expect(lines).toContain('Work devices unregistered from business notices: 2.');
    // The staff record goes LAST: after the list and the devices.
    const staffDelete = world.deletes.indexOf('staff/a1');
    const tokenDelete = world.deletes.indexOf('fcm_tokens/tok-a1-phone');
    expect(tokenDelete).toBeGreaterThanOrEqual(0);
    expect(staffDelete).toBeGreaterThan(tokenDelete);
  });

  it('afterwards her devices get no business notice', async () => {
    const world = auntieWorld();
    await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, collector().out);

    // No claim and no staff record left: exactly the account the send-time
    // filter cannot tell from an owner. Only being off the list keeps her out.
    expect(mocks.users.get('a1')?.customClaims).toEqual({});
    expect(world.docs['staff/a1']).toBeUndefined();

    const recipients = await resolveBusinessAdminUids('recipientResolver(payment.received)');
    expect(recipients).toEqual(['op1']);
    // And no admin-app registration of hers is left for a business push to find.
    const pushTargets = recipients.flatMap((uid) => tokensOf(world.docs, uid));
    expect(pushTargets).toEqual(['tok-op1']);
    expect(tokensOf(world.docs, 'a1').filter((t) => !t.endsWith('portal'))).toEqual([]);
  });

  it('reports a failed staff-record delete and exits non-zero', async () => {
    const world = auntieWorld();
    const realCollection = world.db.collection;
    world.db.collection = (path: string) => {
      const col = realCollection(path);
      if (path !== 'staff') return col;
      const realDoc = col.doc;
      col.doc = (id?: string) => {
        const ref = realDoc(id);
        ref.delete = vi.fn(async () => {
          throw new Error('PERMISSION_DENIED: missing or insufficient permissions');
        });
        return ref;
      };
      return col;
    };
    const { out, errors } = collector();

    const code = await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out);

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/FAILED to delete the staff record for catch@hanasamku\.com: PERMISSION_DENIED/);
    expect(errors.join('\n')).toMatch(/Re-run this command/);
    // The list and devices were already done, so she is off the list.
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
  });

  it('a failed list transaction is reported, exits non-zero, and keeps her staff record for the re-run', async () => {
    const world = auntieWorld();
    world.db.runTransaction.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    const { out, errors } = collector();

    const code = await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out);

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/FAILED to take catch@hanasamku\.com off the business admin list/);
    // Nothing changed, so the re-run still has her claim as evidence.
    expect(mocks.users.get('a1')?.customClaims).toEqual({ staffRole: 'auntie' });
    expect(world.docs['staff/a1']).toMatchObject({ staffRole: 'auntie' });
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1', 'a1']);

    const again = collector();
    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, again.out)).toBe(0);
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(mocks.users.get('a1')?.customClaims).toEqual({});
    expect(world.docs['staff/a1']).toBeUndefined();
  });

  it('an Auntie with a claim and no staff record is still finished when the claim step fails', async () => {
    const world = auntieWorld({ 'staff/a1': null });
    fakeAuth.setCustomUserClaims.mockRejectedValueOnce(new Error('auth unavailable'));
    const { out, errors } = collector();

    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out)).toBe(1);
    expect(errors.join('\n')).toMatch(/FAILED to remove the staff role claim from catch@hanasamku\.com/);
    // The list and devices go first, so she is already off the list.
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'a1')).toEqual(['tok-a1-portal']);

    // Her claim is still there, so the re-run knows she is an Auntie and finishes.
    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, collector().out)).toBe(0);
    expect(mocks.users.get('a1')?.customClaims).toEqual({});
    expect(auditLines(world.docs)).toHaveLength(1);
  });

  it('a second run after a complete one is a clean no-op', async () => {
    const world = auntieWorld();
    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, collector().out)).toBe(0);
    const writes = world.writes.length;

    const again = collector();
    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, again.out)).toBe(0);

    expect(world.writes.length).toBe(writes);
    expect(auditLines(world.docs)).toHaveLength(1);
    expect(again.errors).toEqual([]);
  });

  it('refuses an owner with no staff role, and changes nothing', async () => {
    const world = dbWith({ [ADMINS]: { uids: ['op1'] }, 'staff/op1': { notificationPrefs: { x: true } } });
    addUser('op1', OWNER_EMAIL, { admin: true });
    const { out, errors } = collector();

    const code = await runGrantStaffRole({ email: OWNER_EMAIL, role: 'none' }, out);

    expect(code).toBe(2);
    expect(errors.join('\n')).toMatch(/owner claim and no staff role; nothing to revoke/);
    expect(fakeAuth.setCustomUserClaims).not.toHaveBeenCalled();
    expect(world.writes).toEqual([]);
    expect(world.deletes).toEqual([]);
  });

  it('a double-claimed account loses the staff role and stays on the list with its record', async () => {
    const world = dbWith({
      [ADMINS]: { uids: ['d1'] },
      'staff/d1': { staffRole: 'auntie', notificationPrefs: { x: true } },
    });
    addUser('d1', OWNER_EMAIL, { admin: true, staffRole: 'auntie' });
    const { out } = collector();

    expect(await runGrantStaffRole({ email: OWNER_EMAIL, role: 'none' }, out)).toBe(0);

    expect(mocks.users.get('d1')?.customClaims).toEqual({ admin: true });
    expect(world.docs[ADMINS]?.['uids']).toEqual(['d1']);
    expect(world.docs['staff/d1']).toMatchObject({ staffRole: '__DELETE__', notificationPrefs: { x: true } });
    expect(world.deletes).toEqual([]);
  });

  it('a double-claimed account whose record step failed is finished by the re-run', async () => {
    const world = dbWith({
      [ADMINS]: { uids: ['d1'] },
      'staff/d1': { staffRole: 'auntie', notificationPrefs: { x: true } },
    });
    addUser('d1', OWNER_EMAIL, { admin: true, staffRole: 'auntie' });
    const realCollection = world.db.collection;
    let failUpdate = true;
    world.db.collection = (path: string) => {
      const col = realCollection(path);
      if (path !== 'staff') return col;
      const realDoc = col.doc;
      col.doc = (id?: string) => {
        const ref = realDoc(id);
        const realUpdate = ref.update;
        ref.update = vi.fn(async (data: Record<string, unknown>) => {
          if (failUpdate) {
            failUpdate = false;
            throw new Error('UNAVAILABLE');
          }
          return realUpdate(data);
        });
        return ref;
      };
      return col;
    };

    const first = collector();
    expect(await runGrantStaffRole({ email: OWNER_EMAIL, role: 'none' }, first.out)).toBe(1);
    expect(first.errors.join('\n')).toMatch(/FAILED to take the staff role off the staff record for e2e-admin@tribetails\.com: UNAVAILABLE/);
    // The claim is already off, so the account now looks like a plain owner.
    expect(mocks.users.get('d1')?.customClaims).toEqual({ admin: true });
    expect(world.docs['staff/d1']).toMatchObject({ staffRole: 'auntie' });

    const again = collector();
    expect(await runGrantStaffRole({ email: OWNER_EMAIL, role: 'none' }, again.out)).toBe(0);
    expect(again.errors).toEqual([]);
    expect(world.docs['staff/d1']).toMatchObject({ staffRole: '__DELETE__', notificationPrefs: { x: true } });
    expect(world.docs[ADMINS]?.['uids']).toEqual(['d1']);
    expect(world.deletes).toEqual([]);
  });

  it('a failed account lookup is named and exits non-zero without changing anything', async () => {
    const world = auntieWorld();
    fakeAuth.getUserByEmail.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'auth/internal-error' }));
    const { out, errors } = collector();

    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out)).toBe(1);

    expect(errors.join('\n')).toMatch(/FAILED to look up the account for catch@hanasamku\.com: UNAVAILABLE/);
    expect(world.writes).toEqual([]);
    expect(world.deletes).toEqual([]);
    expect(fakeAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('a failed read-back after a complete run still exits 0', async () => {
    const world = auntieWorld();
    const realGetUser = fakeAuth.getUser.getMockImplementation()!;
    let calls = 0;
    fakeAuth.getUser.mockImplementation(async (uid: string) => {
      calls += 1;
      // The first read is the claims before the change; the last is the read-back.
      if (calls > 1) throw new Error('UNAVAILABLE');
      return realGetUser(uid);
    });
    const { out, lines, errors } = collector();
    try {
      expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out)).toBe(0);
    } finally {
      fakeAuth.getUser.mockImplementation(realGetUser);
    }

    expect(errors).toEqual([]);
    expect(lines.join('\n')).toMatch(/Done\. The claims could not be read back just now/);
    expect(world.docs['staff/a1']).toBeUndefined();
  });

  it('no account: nothing to revoke', async () => {
    dbWith({});
    const { out, errors } = collector();
    expect(await runGrantStaffRole({ email: AUNTIE_EMAIL, role: 'none' }, out)).toBe(2);
    expect(errors[0]).toMatch(/nothing to revoke/);
  });
});

describe('grant-staff-role --role auntie (unchanged)', () => {
  it('mints the claim and writes her staff record', async () => {
    const world = dbWith({});
    addUser('a2', 'pawsome@hanasamku.com', { role: 'kinfolk' });

    expect(await runGrantStaffRole({ email: 'pawsome@hanasamku.com', role: 'auntie' }, collector().out)).toBe(0);

    expect(mocks.users.get('a2')?.customClaims).toEqual({ role: 'kinfolk', staffRole: 'auntie' });
    expect(world.docs['staff/a2']).toMatchObject({ uid: 'a2', staffRole: 'auntie' });
  });

  it('says where she can sign in today', async () => {
    dbWith({});
    addUser('a2', 'pawsome@hanasamku.com', {});
    const { out, lines } = collector();

    expect(await runGrantStaffRole({ email: 'pawsome@hanasamku.com', role: 'auntie' }, out)).toBe(0);

    expect(lines).toContain(
      'She signs in on the AuntieOS web app. The AuntieOS Android app and the desktop console admit only an owner today.',
    );
  });

  it('a failed staff-record write is named and exits non-zero', async () => {
    const world = dbWith({});
    addUser('a2', 'pawsome@hanasamku.com', {});
    const realCollection = world.db.collection;
    world.db.collection = (path: string) => {
      const col = realCollection(path);
      if (path !== 'staff') return col;
      const realDoc = col.doc;
      col.doc = (id?: string) => {
        const ref = realDoc(id);
        ref.set = vi.fn(async () => {
          throw new Error('PERMISSION_DENIED');
        });
        return ref;
      };
      return col;
    };
    const { out, errors } = collector();

    expect(await runGrantStaffRole({ email: 'pawsome@hanasamku.com', role: 'auntie' }, out)).toBe(1);
    expect(errors.join('\n')).toMatch(/FAILED to write the staff record for pawsome@hanasamku\.com: PERMISSION_DENIED/);
  });

  it('refuses an account holding the owner claim', async () => {
    const world = dbWith({});
    addUser('op1', OWNER_EMAIL, { admin: true });
    const { out, errors } = collector();

    expect(await runGrantStaffRole({ email: OWNER_EMAIL, role: 'auntie' }, out)).toBe(1);
    expect(errors[0]).toMatch(/REFUSED/);
    expect(world.writes).toEqual([]);
  });
});

describe('onClientsWrite: deleting an Auntie\'s clients doc ends her staff access', () => {
  it('reads her claims before the wipe, takes her off the list and clears her work devices', async () => {
    const world = auntieWorld();

    await deleteClient('a1');

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith('a1', null);
    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'a1')).toEqual(['tok-a1-portal']);
    expect(auditLines(world.docs)[0]?.[1]?.['payload']).toMatchObject({ source: 'onClientsWrite' });
  });

  it('an owner whose clients doc is deleted stays on the list', async () => {
    addUser('op1', OWNER_EMAIL, { admin: true });
    const world = dbWith({
      [ADMINS]: { uids: ['op1'] },
      'staff/op1': { staffRole: 'auntie' },
      'fcm_tokens/tok-op1': { uid: 'op1', platform: 'android' },
    });

    await deleteClient('op1');

    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'op1')).toEqual(['tok-op1']);
    expect(auditLines(world.docs)).toHaveLength(0);
  });

  it('an ordinary household deletion leaves the list and its devices alone', async () => {
    addUser('h1', 'pawsome@hanasamku.com', { role: 'kinfolk', kinfolkId: 'fam-a' });
    const world = dbWith({
      [ADMINS]: { uids: ['op1'] },
      'fcm_tokens/tok-h1': { uid: 'h1', platform: 'web' },
    });

    await deleteClient('h1');

    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'h1')).toEqual(['tok-h1']);
    expect(world.writes.filter((w) => w.path !== 'kinfolk/fam-a')).toEqual([]);
  });

  it('when her sign-in account cannot be read, nothing is changed', async () => {
    const world = auntieWorld();
    mocks.getUserError = Object.assign(new Error('auth unavailable'), { code: 'auth/internal-error' });

    await deleteClient('a1');

    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1', 'a1']);
    expect(tokensOf(world.docs, 'a1')).toHaveLength(3);
    expect(loggedEvents('claim.read.failed')[0]?.severity).toBe('warn');
  });

  it('when her sign-in account is already gone, her staff record decides', async () => {
    const world = auntieWorld();
    mocks.users.delete('a1');

    await deleteClient('a1');

    expect(world.docs[ADMINS]?.['uids']).toEqual(['op1']);
    expect(tokensOf(world.docs, 'a1')).toEqual(['tok-a1-portal']);
  });
});
