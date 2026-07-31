import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import type { MemberPermissions } from '../src/lib/schema';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => mocks.dbFn.mockReset());

describe('addSecondaryContactHandler', () => {
  it('rejects unauth', async () => {
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(addSecondaryContactHandler({ data: { invitedEmail: 'a@x.com' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects malformed email', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { invitedEmail: 'not-email' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });

  it('creates inviteRequest with sanitized label and lowercased email', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'PARTNER@X.COM', secondaryLabel: '  Co<>Parent  ' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.inviteId).toBeTypeOf('string');
    const wrote = ctx.adds.find((a) => a.collection === 'inviteRequests');
    expect(wrote).toBeDefined();
    expect(wrote!.data.invitedEmail).toBe('partner@x.com');
    expect(wrote!.data.secondaryLabel).toMatch(/CoParent/);
    expect(wrote!.data.tribeId).toBe('3');
    expect(wrote!.data.proposedRole).toBe('SECONDARY');
    // home_access defaults to false and is included in proposedPermissions
    expect((wrote!.data.proposedPermissions as MemberPermissions).home_access).toBe(false);
  });

  it('WARNING-19: rejects a SECONDARY member (privilege escalation) and mints nothing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        // ACTIVE secondary member — passes the kinfolkIds check but is NOT primary.
        'families/3/members/u1': {
          role: 'SECONDARY',
          status: 'ACTIVE',
          permissions: { billing_full: false, kintales_only: true },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({
        data: { kinfolkId: '3', invitedEmail: 'partner@x.com', permissions: { billing_full: true } },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    // No invite minted.
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
  });

  it('WARNING-19: still ALLOWS a PRIMARY member to mint', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.inviteId).toBeTypeOf('string');
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeDefined();
  });

  it('accepts home_access=true and persists it in proposedPermissions', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com', permissions: { home_access: true } },
      auth: { uid: 'u1' },
    } as any);
    expect(res.inviteId).toBeTypeOf('string');
    const wrote = ctx.adds.find((a) => a.collection === 'inviteRequests');
    expect((wrote!.data.proposedPermissions as MemberPermissions).home_access).toBe(true);
  });
});
describe('addSecondaryContactHandler — pending-invite dedupe (S7-BLOCKER-2)', () => {
  it('returns the existing PENDING invite for the same tribe+email instead of duplicating', async () => {
    const farFuture = { toMillis: () => Date.now() + 86400 * 1000 };
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        inviteRequests: [
          { id: 'inv-existing', data: { tribeId: '3', invitedEmail: 'dupe@x.test', status: 'PENDING', expiresAt: farFuture } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { invitedEmail: 'Dupe@X.test' },
      auth: { uid: 'u1', token: {} },
    } as any);
    expect(res.inviteId).toBe('inv-existing');
    expect(ctx.adds).toHaveLength(0);
  });
  it('an EXPIRED pending invite does not dedupe — a fresh one is created', async () => {
    const past = { toMillis: () => Date.now() - 1000 };
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        inviteRequests: [
          { id: 'inv-stale', data: { tribeId: '3', invitedEmail: 'dupe@x.test', status: 'PENDING', expiresAt: past } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { invitedEmail: 'dupe@x.test' },
      auth: { uid: 'u1', token: {} },
    } as any);
    expect(res.inviteId).not.toBe('inv-stale');
    expect(ctx.adds).toHaveLength(1);
  });
});
