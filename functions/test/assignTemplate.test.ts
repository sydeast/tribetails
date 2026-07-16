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
    expect(write?.data.triggerKey).toBe('kincare.booking.confirm');
  });

  it('HAPPY: triggerKey can be overridden', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await assignTemplateHandler(
      req({ catalogKey: 'cat.k', templateId: 't1', triggerKey: 'custom.trigger' }),
    );
    const write = ctx.writes.find((w) => w.path === 'notificationTemplateBindings/cat.k');
    expect(write?.data.triggerKey).toBe('custom.trigger');
  });

  it('SAD: template not found throws not-found', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(req({ catalogKey: 'cat.k', templateId: 'missing' })),
    ).rejects.toThrow();
  });

  it('SAD: invalid audience rejected', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/t1': { subject: 's', body: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler(
        req({ catalogKey: 'cat.k', templateId: 't1', audience: 'nobody' as any }),
      ),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplateHandler({
        data: { catalogKey: 'cat.k', templateId: 't1' },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });
});
