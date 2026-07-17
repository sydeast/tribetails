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
