import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { FULL_PERMISSIONS, KINTALES_ONLY_PERMISSIONS } from '../src/lib/schema';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

const primaryMemberDoc = (uid: string) => ({
  uid,
  displayName: 'Pat Primary',
  role: 'PRIMARY',
  status: 'ACTIVE',
  secondaryLabel: null,
  permissions: FULL_PERMISSIONS,
});

const secondaryMemberDoc = (uid: string, label: string, permissions: Record<string, unknown>, email?: string) => ({
  uid,
  displayName: 'Sam Secondary',
  role: 'SECONDARY',
  status: 'ACTIVE',
  secondaryLabel: label,
  permissions,
  ...(email ? { email } : {}),
});

describe('listMembersHandler', () => {
  it('throws unauthenticated without auth', async () => {
    const { listMembersHandler } = await import('../src/portal/listMembers');
    await expect(
      listMembersHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('PRIMARY lists members and gets secondaries with permissions/role/status/label', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/primary-uid': { kinfolkIds: ['fam-1'] },
        // requireKinfolkPrimary reads the caller's member doc directly.
        'families/fam-1/members/primary-uid': primaryMemberDoc('primary-uid'),
      },
      queryDocs: {
        'families/fam-1/members': [
          { id: 'primary-uid', data: primaryMemberDoc('primary-uid') },
          {
            id: 'sec-1',
            data: secondaryMemberDoc('sec-1', 'Spouse', FULL_PERMISSIONS, 'spouse@example.com'),
          },
          {
            id: 'sec-2',
            data: secondaryMemberDoc('sec-2', 'Dog Walker', KINTALES_ONLY_PERMISSIONS),
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    const res = await listMembersHandler({ data: { kinfolkId: 'fam-1' }, auth: { uid: 'primary-uid' } } as any);

    expect(res.members).toHaveLength(3);

    const sec1 = res.members.find((m) => m.uid === 'sec-1')!;
    expect(sec1.role).toBe('SECONDARY');
    expect(sec1.status).toBe('ACTIVE');
    expect(sec1.secondaryLabel).toBe('Spouse');
    expect(sec1.permissions.home_access).toBe(true);
    expect(sec1.permissions.billing_full).toBe(true);
    expect(sec1.invitedEmail).toBe('spouse@example.com');

    const sec2 = res.members.find((m) => m.uid === 'sec-2')!;
    expect(sec2.secondaryLabel).toBe('Dog Walker');
    expect(sec2.permissions.home_access).toBe(false);
    expect(sec2.permissions.kintales_only).toBe(true);
    expect(sec2.permissions.billing_full).toBe(false);
    // email field absent on this doc -> null, never fabricated from displayName.
    expect(sec2.invitedEmail).toBeNull();

    // No writes — read-only callable.
    expect(ctx.writes).toHaveLength(0);
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.deletes).toHaveLength(0);
  });

  it('returns the full permissions shape (all six flags) for every member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/primary-uid': { kinfolkIds: ['fam-1'] },
        'families/fam-1/members/primary-uid': primaryMemberDoc('primary-uid'),
      },
      queryDocs: {
        'families/fam-1/members': [
          // sparse permissions doc -> handler must default the missing flags.
          { id: 'sec-1', data: { uid: 'sec-1', role: 'SECONDARY', status: 'ACTIVE', secondaryLabel: 'X', permissions: { kin_edit: true } } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    const res = await listMembersHandler({ data: { kinfolkId: 'fam-1' }, auth: { uid: 'primary-uid' } } as any);
    const sec1 = res.members.find((m) => m.uid === 'sec-1')!;
    expect(Object.keys(sec1.permissions).sort()).toEqual(
      ['billing_full', 'home_access', 'kin_edit', 'kintales_only', 'messaging_direct', 'messaging_group'],
    );
    expect(sec1.permissions.kin_edit).toBe(true);
    expect(sec1.permissions.home_access).toBe(false);
  });

  it('SECONDARY caller is DENIED (permission-denied) — listing is primary-only', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/sec-uid': { kinfolkIds: ['fam-1'] },
        // Secondary with FULL permissions still cannot list members.
        'families/fam-1/members/sec-uid': secondaryMemberDoc('sec-uid', 'Spouse', FULL_PERMISSIONS),
      },
      queryDocs: {
        'families/fam-1/members': [
          { id: 'sec-uid', data: secondaryMemberDoc('sec-uid', 'Spouse', FULL_PERMISSIONS) },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    await expect(
      listMembersHandler({ data: { kinfolkId: 'fam-1' }, auth: { uid: 'sec-uid' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('Operator (AUNTIE_OPERATOR_UIDS) is ALLOWED to list any family', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        // operator has no client doc / no membership; resolveKinfolkAccess + requireKinfolkPrimary both bypass.
        'clients/op-uid': null,
        // RULING O-6 hardening 1: staff branch existence-checks kinfolk/{id}.
        'kinfolk/777': { firstName: 'Test' },
      },
      queryDocs: {
        'families/777/members': [
          { id: 'p', data: primaryMemberDoc('p') },
          { id: 'sec-1', data: secondaryMemberDoc('sec-1', 'Folk', KINTALES_ONLY_PERMISSIONS) },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    const res = await listMembersHandler({ data: { kinfolkId: '777' }, auth: { uid: 'op-uid' } } as any);
    expect(res.members.map((m) => m.uid).sort()).toEqual(['p', 'sec-1']);
  });

  it('Legacy account (caller has no member doc) is ALLOWED — anti-lockout', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/legacy-uid': { kinfolkIds: ['fam-legacy'] },
        // No families/fam-legacy/members/legacy-uid doc -> requireKinfolkPrimary falls back to allow.
        'families/fam-legacy/members/legacy-uid': null,
      },
      queryDocs: {
        'families/fam-legacy/members': [
          { id: 'sec-1', data: secondaryMemberDoc('sec-1', 'Helper', KINTALES_ONLY_PERMISSIONS) },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    const res = await listMembersHandler({ data: {}, auth: { uid: 'legacy-uid' } } as any);
    expect(res.members).toHaveLength(1);
    expect(res.members[0].secondaryLabel).toBe('Helper');
  });

  it('SUSPENDED caller member doc is DENIED', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/susp-uid': { kinfolkIds: ['fam-1'] },
        'families/fam-1/members/susp-uid': { uid: 'susp-uid', role: 'PRIMARY', status: 'SUSPENDED', permissions: FULL_PERMISSIONS },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    await expect(
      listMembersHandler({ data: { kinfolkId: 'fam-1' }, auth: { uid: 'susp-uid' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('no-tribe caller (empty kinfolkIds) -> failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    await expect(
      listMembersHandler({ data: {}, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('caller requesting a foreign kinfolkId (not in their list) -> permission-denied', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['mine'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listMembersHandler } = await import('../src/portal/listMembers');
    await expect(
      listMembersHandler({ data: { kinfolkId: 'not-mine' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
