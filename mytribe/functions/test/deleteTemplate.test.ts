import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { deleteTemplateHandler } from '../src/admin/deleteTemplate';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('deleteTemplate', () => {
  it('HAPPY: deletes an existing, unbound template', async () => {
    const ctx = buildDbMock({
      docs: {
        'emailTemplates/welcome.kinfolk': { subject: 's', body: 'b' },
      },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteTemplateHandler(req({ templateId: 'welcome.kinfolk' }));
    expect(res.templateId).toBe('welcome.kinfolk');
    expect(ctx.deletes).toContain('emailTemplates/welcome.kinfolk');
  });

  it('SAD: not-found when template does not exist', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { notificationTemplateBindings: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'ghost.template' })),
    ).rejects.toThrow(/not-found|not found/i);
    expect(ctx.deletes).toEqual([]);
  });

  it('SAD: refuses to delete a template still bound to a notification catalog key', async () => {
    const ctx = buildDbMock({
      docs: {
        'emailTemplates/welcome.kinfolk': { subject: 's', body: 'b' },
      },
      queryDocs: {
        notificationTemplateBindings: [
          { id: 'kin.welcome', data: { templateId: 'welcome.kinfolk', active: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'welcome.kinfolk' })),
    ).rejects.toThrow(/kin\.welcome/);
    expect(ctx.deletes).toEqual([]);
  });

  // ── #381: routing is by NAME, so the binding check above could never fire ──

  it('REGRESSION: refuses account.welcome.business, the template the walk deleted', async () => {
    // Captured at 78 minutes into the 2026-08-17 admin walk:
    //   POST deleteTemplate {"templateId":"account.welcome.business"} -> 200
    // It is catalog row 32, and nothing stopped it, because the bindings
    // collection was empty and that was the only thing being checked.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/account.welcome.business': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'account.welcome.business' })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('account.welcome.business'),
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('SAD: names the notification, not just the id, so the refusal is actionable', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/kincare.booking.confirm': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'kincare.booking.confirm' })),
    ).rejects.toThrow(/KinCare booking confirmed/);
  });

  it('SAD: refuses a direct-send literal too, not only catalog rows', async () => {
    // invite.primary never passes through the dispatcher; provisionTribe,
    // mintInvite and inviteKinfolkToPortal hand it to sendFromTemplate directly.
    // It resolves by the same naming convention, so it breaks the same way.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/invite.primary': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'invite.primary' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.deletes).toEqual([]);
  });

  it('SAD: still refuses while an override points that key at another template', async () => {
    // The key is not sending this document at this instant, but unassignTemplate
    // is one tap away and brings it straight back.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/invoice.new': { subject: 's', body: 'b' } },
      queryDocs: {
        notificationTemplateBindings: [
          { id: 'invoice.new', data: { templateId: 'tmpl_custom', active: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'invoice.new' })),
    ).rejects.toThrow(/removing the override brings this template back/i);
    expect(ctx.deletes).toEqual([]);
  });

  it('HAPPY: a template that is no catalog key and no binding still deletes', async () => {
    // The guard must not turn into "nothing can ever be deleted". A one-off
    // template nothing routes to is still the admin's to remove.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/one.off.blast': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteTemplateHandler(req({ templateId: 'one.off.blast' }));
    expect(res.templateId).toBe('one.off.blast');
    expect(ctx.deletes).toContain('emailTemplates/one.off.blast');
  });

  it('SAD: a missing template is still not-found, not a catalog refusal', async () => {
    // Order matters: existence is checked first, so deleting an already-deleted
    // catalog template reports the real state rather than a confusing guard hit.
    const ctx = buildDbMock({ docs: {}, queryDocs: { notificationTemplateBindings: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'account.welcome.business' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('SAD: invalid templateId chars rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'bad id with spaces' })),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler({
        data: { templateId: 'x' },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });
});
