import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { deleteTemplateHandler } from '../src/admin/deleteTemplate';
import { isLiveCatalogKey } from '../src/notifications/catalogKeys';

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

  it('WARNS: an unacknowledged delete of a live-key template is refused, naming the key', async () => {
    // Captured at 78 minutes into the 2026-08-17 admin walk:
    //   POST deleteTemplate {"templateId":"account.welcome.business"} -> 200
    // Nothing stopped it, because the bindings collection was empty and that was
    // the only thing being checked. `account.welcome.kinfolk` is the same shape
    // and is still live, so it stands in for the state that used to go silent.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/account.welcome.kinfolk': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'account.welcome.kinfolk' })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('account.welcome.kinfolk'),
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('WARNS: the refusal carries machine-readable details, so a client never has to read the prose', async () => {
    // The two failed-precondition cases end differently: this one can be
    // acknowledged past, the binding one cannot. A client that told them apart
    // by matching English would be one copy edit from offering "Delete anyway"
    // on a delete that can never succeed.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/kincare.booking.confirm': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'kincare.booking.confirm' })),
    ).rejects.toMatchObject({
      details: {
        reason: 'live-catalog-key',
        templateId: 'kincare.booking.confirm',
        label: 'KinCare booking confirmed',
        acknowledgeable: true,
      },
    });
  });

  it('HAPPY: acknowledgeLiveKey deletes the live-key template, because an operator is allowed to mean it', async () => {
    // Operator ruling, 2026-08-18: "that was my doing I did not need that type of
    // notification. I should be able to delete templates without being yelled
    // at." The warning is a confirmation to proceed through, not a wall.
    const ctx = buildDbMock({
      docs: { 'emailTemplates/kincare.booking.confirm': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteTemplateHandler(
      req({ templateId: 'kincare.booking.confirm', acknowledgeLiveKey: true }),
    );
    expect(res.templateId).toBe('kincare.booking.confirm');
    expect(ctx.deletes).toContain('emailTemplates/kincare.booking.confirm');
  });

  it('SAD: acknowledgeLiveKey: false is not an acknowledgement', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/kincare.booking.confirm': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(
        req({ templateId: 'kincare.booking.confirm', acknowledgeLiveKey: false }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.deletes).toEqual([]);
  });

  it('SAD: acknowledgeLiveKey does NOT get past a binding, which has its own one-tap remedy', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/welcome.kinfolk': { subject: 's', body: 'b' } },
      queryDocs: {
        notificationTemplateBindings: [
          { id: 'kin.welcome', data: { templateId: 'welcome.kinfolk', active: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'welcome.kinfolk', acknowledgeLiveKey: true })),
    ).rejects.toThrow(/kin\.welcome/);
    expect(ctx.deletes).toEqual([]);
  });

  it('RETIRED: account.welcome.business is no longer a live key, so it deletes with no warning at all', async () => {
    // Where the two halves of this change meet. Once the catalog row is retired
    // the key stops being live, so there is nothing left to warn about: no
    // acknowledgement asked for, no refusal, just a delete.
    expect(isLiveCatalogKey('account.welcome.business')).toBe(false);
    const ctx = buildDbMock({
      docs: { 'emailTemplates/account.welcome.business': { subject: 's', body: 'b' } },
      queryDocs: { notificationTemplateBindings: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteTemplateHandler(req({ templateId: 'account.welcome.business' }));
    expect(res.templateId).toBe('account.welcome.business');
    expect(ctx.deletes).toContain('emailTemplates/account.welcome.business');
  });

  it('SAD: names the notification, not just the id, so the warning is actionable', async () => {
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

  it('SAD: a missing template is still not-found, not a live-key warning', async () => {
    // Order matters: existence is checked first, so deleting an already-deleted
    // catalog template reports the real state rather than a confusing guard hit.
    const ctx = buildDbMock({ docs: {}, queryDocs: { notificationTemplateBindings: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteTemplateHandler(req({ templateId: 'account.welcome.kinfolk' })),
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
