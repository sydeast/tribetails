import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), revokeRefreshTokens: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ revokeRefreshTokens: mocks.revokeRefreshTokens }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__', arrayRemove: (v: unknown) => ({ __arrayRemove: v }) } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.revokeRefreshTokens.mockReset();
});

function call(data: unknown, uid = 'admin-uid') {
  return { data, auth: { uid } } as never;
}

async function load() {
  return import('../src/admin/removeMember');
}

describe('removeMemberHandler', () => {
  it('rejects invalid args', async () => {
    const { removeMemberHandler } = await load();
    await expect(removeMemberHandler(call({ familyId: 'f' }))).rejects.toThrow();
  });

  it('rejects a member that does not exist', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMemberHandler } = await load();
    await expect(
      removeMemberHandler(call({ familyId: 'fam1', targetUid: 'ghost' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('#1018 item 1: an ACTIVE secondary kinfolk person record goes back to NONE, with memberUid and inviteId cleared', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/fam1/members/sec-uid': { role: 'SECONDARY', status: 'ACTIVE' },
        'clients/sec-uid': { kinfolkIds: ['fam1'] },
      },
      queryDocs: {
        'families/fam1/secondaryKinfolk': [
          { id: 'p1', data: { name: 'Sam Lee', access: 'ACTIVE', memberUid: 'sec-uid', inviteId: 'inv1' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMemberHandler } = await load();
    const res = await removeMemberHandler(call({ familyId: 'fam1', targetUid: 'sec-uid' }));
    expect(res).toEqual({ ok: true });

    const memberWrite = ctx.writes.find((w) => w.path === 'families/fam1/members/sec-uid');
    expect(memberWrite?.data).toMatchObject({ status: 'SUSPENDED' });

    const personWrite = ctx.writes.find((w) => w.path === 'families/fam1/secondaryKinfolk/p1');
    expect(personWrite?.data).toMatchObject({ access: 'NONE', memberUid: null, inviteId: null, updatedBy: 'admin-uid' });

    expect(mocks.revokeRefreshTokens).toHaveBeenCalledWith('sec-uid');
  });

  it('a removed PRIMARY (no secondaryKinfolk row matches) writes nothing extra and still succeeds', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/fam1/members/pri-uid': { role: 'PRIMARY', status: 'ACTIVE' },
        'clients/pri-uid': { kinfolkIds: ['fam1'] },
      },
      queryDocs: { 'families/fam1/secondaryKinfolk': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMemberHandler } = await load();
    const res = await removeMemberHandler(call({ familyId: 'fam1', targetUid: 'pri-uid' }));
    expect(res).toEqual({ ok: true });
    expect(ctx.writes.some((w) => w.path.startsWith('families/fam1/secondaryKinfolk/'))).toBe(false);
  });

  it('leaves an INVITED or already-NONE person alone (no memberUid match)', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/fam1/members/sec-uid': { role: 'SECONDARY', status: 'ACTIVE' },
        'clients/sec-uid': { kinfolkIds: ['fam1'] },
      },
      queryDocs: {
        'families/fam1/secondaryKinfolk': [
          { id: 'p1', data: { name: 'Sam Lee', access: 'INVITED', memberUid: null, inviteId: 'inv1' } },
          { id: 'p2', data: { name: 'Other', access: 'NONE', memberUid: null, inviteId: null } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMemberHandler } = await load();
    await removeMemberHandler(call({ familyId: 'fam1', targetUid: 'sec-uid' }));
    expect(ctx.writes.some((w) => w.path.startsWith('families/fam1/secondaryKinfolk/'))).toBe(false);
  });
});
