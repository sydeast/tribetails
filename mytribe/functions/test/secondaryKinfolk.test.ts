import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * Secondary kinfolk with no portal access (operator rulings 2026-09-27, R1 and
 * Q3). A person record under families/{id}/secondaryKinfolk, never an invite,
 * never a member doc. The refusals matter most: no permissions, no invite, no
 * role can ride in through this door.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const KIN = {
  firstName: 'Dana',
  lastName: 'Mercer',
  phoneNumber: '(805) 555-0100',
  email: 'dana@example.com',
  emergencyContacts: [{ name: 'Rae Park', phone: '+18055550199' }],
};

function household(
  people: Array<{ id: string; data: Record<string, unknown> }> = [],
  caller: { uid: string; member?: Record<string, unknown> } = { uid: 'primary-uid', member: { role: 'PRIMARY', status: 'ACTIVE' } },
) {
  return buildDbMock({
    docs: {
      [`clients/${caller.uid}`]: { kinfolkIds: ['fam1'] },
      ...(caller.member ? { [`families/fam1/members/${caller.uid}`]: caller.member } : {}),
      'kinfolk/fam1': KIN,
      ...Object.fromEntries(people.map((p) => [`families/fam1/secondaryKinfolk/${p.id}`, p.data])),
    },
    queryDocs: { 'families/fam1/secondaryKinfolk': people },
  });
}

function call(data: unknown, uid = 'primary-uid', token: Record<string, unknown> = {}) {
  return { data, auth: { uid, token } } as never;
}

async function load() {
  return import('../src/portal/secondaryKinfolk');
}

describe('saveSecondaryKinfolkHandler', () => {
  it('rejects unauth', async () => {
    const { saveSecondaryKinfolkHandler } = await load();
    await expect(saveSecondaryKinfolkHandler({ data: { name: 'Sam' }, auth: undefined } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('ADD: a name alone creates a person with no portal access, no invite, and nothing logged but ids', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    const res = await saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: ' Sam Lee ' }));
    expect(res.created).toBe(true);
    const add = ctx.adds.find((a) => a.collection === 'families/fam1/secondaryKinfolk');
    expect(add?.data).toMatchObject({ name: 'Sam Lee', phone: null, email: null, access: 'NONE', memberUid: null, inviteId: null, createdBy: 'primary-uid' });
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
    expect(ctx.writes.some((w) => w.path.includes('/members/'))).toBe(false);
    expect(res.person).toMatchObject({ name: 'Sam Lee', access: 'NONE' });
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('Sam');
  });

  it('ADD: phone and email are optional; given, the phone is stored E.164 and the email lowercased', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    await saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam Lee', phone: '(805) 555-0177', email: ' Sam@Example.com ' }));
    const add = ctx.adds.find((a) => a.collection === 'families/fam1/secondaryKinfolk');
    expect(add?.data).toMatchObject({ phone: '+18055550177', email: 'sam@example.com' });
  });

  it('THE WALL: refuses permissions, invitedEmail, role and access by name, and writes nothing', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    for (const extra of [{ permissions: { billing_full: true } }, { invitedEmail: 'a@b.com' }, { role: 'SECONDARY' }, { access: 'ACTIVE' }]) {
      await expect(saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', ...extra }))).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a blank name, a bad phone and a bad email with plain sentences', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const m = await load();
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: '  ' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_NAME_REQUIRED_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', phone: '12' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_PHONE_INVALID_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', email: 'nope' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_EMAIL_INVALID_MESSAGE });
    expect(ctx.adds).toHaveLength(0);
  });

  it('refuses the primary themselves, and the Emergency Contact', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const m = await load();
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'dana  mercer' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_IS_PRIMARY_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', phone: '805 555 0100' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_IS_PRIMARY_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', email: 'DANA@example.com' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_IS_PRIMARY_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Rae Park' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_IS_EMERGENCY_CONTACT_MESSAGE });
    await expect(m.saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam', phone: '8055550199' }))).rejects.toMatchObject({ message: m.SECONDARY_KINFOLK_IS_EMERGENCY_CONTACT_MESSAGE });
    expect(ctx.adds).toHaveLength(0);
  });

  it('EDIT: a diff of the three fields; a cleared phone lands as null; access, memberUid and provenance are never written', async () => {
    const ctx = household([{ id: 'p1', data: { name: 'Sam Lee', phone: '+18055550177', email: null, access: 'ACTIVE', memberUid: 'sam-uid', createdBy: 'x' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    const res = await saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', personId: 'p1', name: 'Sam Leigh', phone: '' }));
    const w = ctx.writes.find((x) => x.path === 'families/fam1/secondaryKinfolk/p1');
    expect(w?.data).toEqual({ name: 'Sam Leigh', phone: null, email: null, updatedAt: '__SERVER_TS__', updatedBy: 'primary-uid' });
    expect(res).toMatchObject({ created: false, person: { access: 'ACTIVE', memberUid: 'sam-uid', name: 'Sam Leigh' } });
  });

  it('EDIT: a person who is gone is not-found', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    await expect(saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', personId: 'gone', name: 'Sam' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('GATE: an ACTIVE SECONDARY cannot add anyone', async () => {
    const ctx = household([], { uid: 'sec-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    await expect(saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam' }, 'sec-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds).toHaveLength(0);
  });

  it('GATE: staff with the admin claim may add on any household (adding is not inviting)', async () => {
    const ctx = household([], { uid: 'op-uid' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveSecondaryKinfolkHandler } = await load();
    const res = await saveSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', name: 'Sam' }, 'op-uid', { admin: true }));
    expect(res.created).toBe(true);
  });
});

describe('listSecondaryKinfolkHandler', () => {
  it('lists every person with its access state, sorted by name', async () => {
    const ctx = household([
      { id: 'p2', data: { name: 'Zoe', access: 'INVITED' } },
      { id: 'p1', data: { name: 'Ada', phone: '+18055550177', access: 'NONE' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listSecondaryKinfolkHandler } = await load();
    const res = await listSecondaryKinfolkHandler(call({ kinfolkId: 'fam1' }));
    expect(res.people.map((p) => [p.personId, p.name, p.access])).toEqual([
      ['p1', 'Ada', 'NONE'],
      ['p2', 'Zoe', 'INVITED'],
    ]);
    expect(res.people[0]).toMatchObject({ phone: '+18055550177', email: null, memberUid: null });
  });
});

describe('removeSecondaryKinfolkHandler', () => {
  it('deletes a person with no portal access', async () => {
    const ctx = household([{ id: 'p1', data: { name: 'Sam', access: 'NONE' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeSecondaryKinfolkHandler } = await load();
    await expect(removeSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', personId: 'p1' }))).resolves.toEqual({ ok: true });
    expect(ctx.deletes).toContain('families/fam1/secondaryKinfolk/p1');
  });

  it('deletes an INVITED person too, so a revoked or expired invite never strands the record', async () => {
    const ctx = household([{ id: 'p1', data: { name: 'Sam', access: 'INVITED', inviteId: 'i1' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeSecondaryKinfolkHandler } = await load();
    await removeSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', personId: 'p1' }));
    expect(ctx.deletes).toContain('families/fam1/secondaryKinfolk/p1');
  });

  it('refuses a person with portal access, so no member is stranded', async () => {
    const ctx = household([{ id: 'p1', data: { name: 'Sam', access: 'ACTIVE', memberUid: 'sam-uid' } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const m = await load();
    await expect(m.removeSecondaryKinfolkHandler(call({ kinfolkId: 'fam1', personId: 'p1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: m.SECONDARY_KINFOLK_HAS_ACCESS_MESSAGE,
    });
    expect(ctx.deletes).toHaveLength(0);
  });
});
