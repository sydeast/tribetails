import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { assignTemplateHandler } from '../src/admin/assignTemplate';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('assignTemplate', () => {
  it('HAPPY: writes binding doc for active assignment', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/welcome.kinfolk.v2': { subject: 's', body: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await assignTemplateHandler(
      req({
        catalogKey: 'kincare.booking.confirm',
        templateId: 'welcome.kinfolk.v2',
        audience: 'kinfolk',
        active: true,
      }),
    );
    expect(res.catalogKey).toBe('kincare.booking.confirm');
    expect(res.templateId).toBe('welcome.kinfolk.v2');
    expect(res.active).toBe(true);
    const write = ctx.writes.find(
      (w) => w.path === 'notificationTemplateBindings/kincare.booking.confirm',
    );
    expect(write).toBeDefined();
    expect(write?.data.templateId).toBe('welcome.kinfolk.v2');
    expect(write?.data.audience).toBe('kinfolk');
    expect(write?.data.active).toBe(true);
    expect(write?.data.triggerKey).toBeUndefined(); // AO-30
  });

  it('HAPPY: a direct-send key (sendFromTemplate literal) is bindable too', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await assignTemplateHandler(req({ catalogKey: 'invite.primary', templateId: 't1' }));
    expect(res.catalogKey).toBe('invite.primary');
    expect(ctx.writes.some((w) => w.path === 'notificationTemplateBindings/invite.primary')).toBe(true);
  });

  it('HAPPY: triggerKey can be overridden', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await assignTemplateHandler(
      req({ catalogKey: 'invoice.new', templateId: 't1', triggerKey: 'custom.trigger' }),
    );
    const write = ctx.writes.find((w) => w.path === 'notificationTemplateBindings/invoice.new');
    expect(write?.data.triggerKey).toBe('custom.trigger');
  });

  it('AO-30: an omitted triggerKey is NOT written, so a re-assign never clobbers a custom trigger', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await assignTemplateHandler(req({ catalogKey: 'invoice.new', templateId: 't1', active: false }));
    const write = ctx.writes.find((w) => w.path === 'notificationTemplateBindings/invoice.new');
    expect(write).toBeDefined();
    expect('triggerKey' in write!.data).toBe(false);
  });

  // ── #382: a mistyped catalog key used to return 200 and do nothing forever ──

  it('SAD: an unknown catalog key is rejected as invalid-argument, naming the key', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(req({ catalogKey: 'kincare.bookng.confirm', templateId: 't1' })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('kincare.bookng.confirm'),
    });
    // And nothing was written, which is the whole point.
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: the key is checked BEFORE the template, so a typo is not masked by a valid template', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(req({ catalogKey: 'not.a.real.key', templateId: 'missing' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: a retired alias key is rejected and points at the key that replaced it', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(req({ catalogKey: 'kincare.report.sent', templateId: 't1' })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('kintale.published'),
    });
  });

  it('SAD: template not found throws not-found', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(req({ catalogKey: 'invoice.new', templateId: 'missing' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('SAD: invalid audience rejected', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(
        req({ catalogKey: 'invoice.new', templateId: 't1', audience: 'nobody' as any }),
      ),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler({
        data: { catalogKey: 'invoice.new', templateId: 't1' },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });
});
