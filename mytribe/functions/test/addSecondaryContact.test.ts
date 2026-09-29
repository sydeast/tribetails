import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import type { MemberPermissions } from '../src/lib/schema';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), sendMock: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: mocks.sendMock }));

/** #957: the invite set reads the email frame once and hands it to every send (here the default, nothing stored). */
const FRAME = expect.objectContaining({ accentColor: '#df8431', footerText: expect.any(String) });
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.sendMock.mockReset();
  mocks.sendMock.mockResolvedValue('m-1');
  delete process.env.AUNTIE_OPERATOR_UIDS;
  // #1018 item 3: addSecondaryContact now sends the same invite emails
  // mintInviteFromPrimary does, guarded the same way (lib/inviteEmails.ts).
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
  delete process.env.AUNTIE_NOTIFY_EMAIL;
  delete process.env.AUNTIE_OS_REVIEW_BASE_URL;
});

describe('addSecondaryContactHandler', () => {
  it('rejects unauth', async () => {
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(addSecondaryContactHandler({ data: { invitedEmail: 'a@x.com' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('STAFF GATE: denies a stranger (not staff, kinfolkIds does not include the target)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'partner@x.com' }, auth: { uid: 'stranger' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
    expect(mocks.sendMock).not.toHaveBeenCalled();
  });

  // Operator ruling 2026-09-27 (Q3): the admin invites only the primary; the
  // primary invites the secondary. Staff used to pass the bypass here.
  it('STAFF GATE: an operator with the admin claim is refused, and nothing is written', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/3': { firstName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler, ONLY_PRIMARY_INVITES_MESSAGE } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'partner@x.com' }, auth: { uid: 'op-uid', token: { admin: true } } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied', message: ONLY_PRIMARY_INVITES_MESSAGE });
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
    expect(mocks.sendMock).not.toHaveBeenCalled();
  });
  it('STAFF GATE: an operator on the AUNTIE_OPERATOR_UIDS allowlist (no admin claim) is refused too', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/3': { firstName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'partner@x.com' }, auth: { uid: 'op-uid' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
  });
  it('PERSON: an invite for a secondary kinfolk the primary added carries personId and marks them INVITED', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': { role: 'PRIMARY', status: 'ACTIVE' },
        'families/3/secondaryKinfolk/p1': { name: 'Sam Lee', access: 'NONE', memberUid: null },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'sam@x.com', personId: 'p1' }, auth: { uid: 'u1' } } as any);
    const invite = ctx.adds.find((a) => a.collection === 'inviteRequests');
    expect(invite?.data.personId).toBe('p1');
    const person = ctx.writes.find((w) => w.path === 'families/3/secondaryKinfolk/p1');
    expect(person?.data).toMatchObject({ access: 'INVITED', inviteId: res.inviteId });
    expect(mocks.sendMock).toHaveBeenCalledWith('invite.secondary', 'sam@x.com', expect.objectContaining({ claimUrl: `https://claim.tribetails.com?invite=${res.inviteId}` }), FRAME);
  });
  it('PERSON: refuses a person who already has portal access, or one who is gone, and writes nothing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': { role: 'PRIMARY', status: 'ACTIVE' },
        'families/3/secondaryKinfolk/p1': { name: 'Sam Lee', access: 'ACTIVE', memberUid: 'sam-uid' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'sam@x.com', personId: 'p1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'sam@x.com', personId: 'nope' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.adds.find((a) => a.collection === 'inviteRequests')).toBeUndefined();
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.sendMock).not.toHaveBeenCalled();
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
    expect(mocks.sendMock).not.toHaveBeenCalled();
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

// #1018 item 3: addSecondaryContact sends no email itself before this change
// (onInviteRequestCreate is an explicit no-op), so the portal's "Invite
// sent." was never true. It now sends the same three emails
// mintInviteFromPrimary sends, through the shared lib/inviteEmails.ts helper.
describe('addSecondaryContactHandler — invite emails (#1018 item 3)', () => {
  it('sends invite.secondary to the invited address with the claim link, and marks the invite EMAIL_SENT', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'PARTNER@X.COM', secondaryLabel: 'Co-Parent' },
      auth: { uid: 'u1', token: { name: 'Dana Primary' } },
    } as any);
    expect(mocks.sendMock).toHaveBeenCalledWith('invite.secondary', 'partner@x.com', {
      primaryDisplayName: 'Dana Primary',
      secondaryDisplayName: 'partner@x.com',
      secondaryLabel: 'CoParent',
      tribeName: '3',
      claimUrl: `https://claim.tribetails.com?invite=${res.inviteId}`,
      expiresInDays: 14,
    }, FRAME);
    const wrote = ctx.adds.find((a) => a.collection === 'inviteRequests');
    const updated = ctx.writes.find((w) => w.path === `inviteRequests/${wrote!.id}`);
    expect(updated?.data).toMatchObject({ status: 'EMAIL_SENT' });
  });

  it('falls back to "Your Kin Parent" when the caller has no name on their token', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1' },
    } as any);
    const call = mocks.sendMock.mock.calls.find((c) => c[0] === 'invite.secondary')!;
    expect((call[2] as Record<string, unknown>).primaryDisplayName).toBe('Your Kin Parent');
  });

  it('sends invite.primary-receipt to the caller\'s own token email', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1', token: { email: 'Dana@X.com' } },
    } as any);
    expect(mocks.sendMock).toHaveBeenCalledWith('invite.primary-receipt', 'dana@x.com', expect.objectContaining({ invitedEmail: 'partner@x.com' }), FRAME);
  });

  it('falls back to the clients doc email for the receipt when the token carries none', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'], email: 'Dana@Stored.com' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1' },
    } as any);
    expect(mocks.sendMock).toHaveBeenCalledWith('invite.primary-receipt', 'dana@stored.com', expect.anything(), FRAME);
  });

  it('sends no primary-receipt when no address can be resolved', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1' },
    } as any);
    const templates = mocks.sendMock.mock.calls.map((c) => c[0]);
    expect(templates).not.toContain('invite.primary-receipt');
  });

  it('does not send invite.auntie-notify when AUNTIE_NOTIFY_EMAIL is unset', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com' },
      auth: { uid: 'u1' },
    } as any);
    const templates = mocks.sendMock.mock.calls.map((c) => c[0]);
    expect(templates).not.toContain('invite.auntie-notify');
  });

  it('sends invite.auntie-notify with the permissions CSV and a normalized review URL when both vars are configured', async () => {
    process.env.AUNTIE_NOTIFY_EMAIL = 'auntie@tribetails.com';
    process.env.AUNTIE_OS_REVIEW_BASE_URL = 'https://auntie.tribetails.com/review/';
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    const res = await addSecondaryContactHandler({
      data: { kinfolkId: '3', invitedEmail: 'partner@x.com', permissions: { billing_full: true, home_access: true } },
      auth: { uid: 'u1' },
    } as any);
    const call = mocks.sendMock.mock.calls.find((c) => c[0] === 'invite.auntie-notify')!;
    const data = call[2] as Record<string, unknown>;
    // trailing slash stripped, not doubled
    expect(data.auntieReviewUrl).toBe(`https://auntie.tribetails.com/review/invites/${res.inviteId}`);
    expect(data.permissionsCsv).toContain('billing_full');
    expect(data.permissionsCsv).toContain('home_access');
  });

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it('throws failed-precondition and writes nothing when unset, before even checking the staff gate', async () => {
      delete process.env.CLAIM_LINK_BASE_URL;
      const ctx = buildDbMock({ docs: {} });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
      await expect(
        addSecondaryContactHandler({
          data: { kinfolkId: '3', invitedEmail: 'a@b.com' },
          auth: { uid: 'op-uid', token: { admin: true } },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('CLAIM_LINK_BASE_URL') });
      expect(ctx.adds).toHaveLength(0);
      expect(ctx.writes).toHaveLength(0);
      expect(mocks.sendMock).not.toHaveBeenCalled();
    });
  });

  describe('AUNTIE_OS_REVIEW_BASE_URL guard', () => {
    it('throws failed-precondition and writes nothing when AUNTIE_NOTIFY_EMAIL is set but the review base URL is not', async () => {
      process.env.AUNTIE_NOTIFY_EMAIL = 'auntie@tribetails.com';
      const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
      await expect(
        addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'partner@x.com' }, auth: { uid: 'u1' } } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('AUNTIE_OS_REVIEW_BASE_URL') });
      expect(ctx.adds).toHaveLength(0);
      expect(mocks.sendMock).not.toHaveBeenCalled();
    });
  });

  it('a send failure is never swallowed: it throws out of the handler, and the invite is left PENDING, not EMAIL_SENT', async () => {
    mocks.sendMock.mockRejectedValueOnce(new Error('smtp2go: rejected'));
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addSecondaryContactHandler } = await import('../src/portal/addSecondaryContact');
    await expect(
      addSecondaryContactHandler({ data: { kinfolkId: '3', invitedEmail: 'partner@x.com' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow('smtp2go: rejected');
    // The invite doc was already created (this is not a swallowed failure,
    // it is an honest one: created, not delivered).
    const wrote = ctx.adds.find((a) => a.collection === 'inviteRequests');
    expect(wrote).toBeDefined();
    expect(wrote!.data.status).toBe('PENDING');
    expect(ctx.writes.some((w) => w.path === `inviteRequests/${wrote!.id}`)).toBe(false);
  });

  it('re-sends the invite email on a deduped retry, so a client that saw a false "failed" still gets a real send', async () => {
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
    expect(mocks.sendMock).toHaveBeenCalledWith('invite.secondary', 'dupe@x.test', expect.anything(), FRAME);
    const updated = ctx.writes.find((w) => w.path === 'inviteRequests/inv-existing');
    expect(updated?.data).toMatchObject({ status: 'EMAIL_SENT' });
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
