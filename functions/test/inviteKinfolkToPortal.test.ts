import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  sendFromTemplateFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: mocks.sendFromTemplateFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-id');
  mocks.sendFromTemplateFn.mockReset().mockResolvedValue('tpl-id');
});

const auth = { uid: 'admin-1' };

describe('inviteKinfolkToPortalHandler (#14)', () => {
  it('throws not-found when the kinfolk does not exist', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { inviteKinfolkToPortalHandler } = await import('../src/admin/inviteKinfolkToPortal');
    await expect(
      inviteKinfolkToPortalHandler({ data: { kinfolkId: 'k1' }, auth } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('returns no_email when the kinfolk has no email', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/k1': { firstName: 'Dana', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { inviteKinfolkToPortalHandler } = await import('../src/admin/inviteKinfolkToPortal');
    const r = await inviteKinfolkToPortalHandler({ data: { kinfolkId: 'k1' }, auth } as any);
    expect(r.status).toBe('no_email');
    expect(mocks.sendFromTemplateFn).not.toHaveBeenCalled();
  });

  it('returns already_active when the household has a claimed PRIMARY', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/k1': { email: 'dana@example.com', firstName: 'Dana', lastName: 'Doe' } },
      queryDocs: { 'families/k1/members': [{ id: 'm1', data: { role: 'PRIMARY', status: 'ACTIVE' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { inviteKinfolkToPortalHandler } = await import('../src/admin/inviteKinfolkToPortal');
    const r = await inviteKinfolkToPortalHandler({ data: { kinfolkId: 'k1' }, auth } as any);
    expect(r.status).toBe('already_active');
    expect(mocks.sendFromTemplateFn).not.toHaveBeenCalled();
  });

  it('sends a PRIMARY invite, ensures the family doc, and audits', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/k1': { email: 'Dana@Example.com', firstName: 'Dana', lastName: 'Doe' } },
      queryDocs: { 'families/k1/members': [] }, // no active primary
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { inviteKinfolkToPortalHandler } = await import('../src/admin/inviteKinfolkToPortal');
    const r = await inviteKinfolkToPortalHandler({ data: { kinfolkId: 'k1' }, auth } as any);

    expect(r.status).toBe('sent');
    expect(r.inviteId).toBeTypeOf('string');

    // Family envelope created (did not exist).
    const familyWrite = ctx.writes.find((w) => w.path === 'families/k1');
    expect(familyWrite?.data.displayName).toBe('Dana Doe');

    // Invite request created (lowercased email) + email sent via the PRIMARY template.
    const invite = ctx.adds.find((a) => a.collection === 'inviteRequests');
    expect(invite?.data.invitedEmail).toBe('dana@example.com');
    expect(invite?.data.proposedRole).toBe('PRIMARY');
    expect(mocks.sendFromTemplateFn).toHaveBeenCalledWith(
      'invite.primary', 'Dana@Example.com', expect.objectContaining({ tribeName: 'Dana Doe' }),
    );
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'MEMBERSHIP_INVITE_SENT', familyId: 'k1' }),
    );
  });
});
