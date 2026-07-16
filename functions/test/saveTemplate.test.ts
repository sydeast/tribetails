import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { saveTemplateHandler } from '../src/admin/saveTemplate';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('saveTemplate', () => {
  it('HAPPY: creates new template with createdAt + createdBy', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 'Welcome to TribeTails',
        body: 'Hello {{firstName}}',
        category: 'Onboarding',
        tags: ['onboarding', 'welcome'],
      }),
    );
    expect(res.templateId).toBe('welcome.kinfolk');
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write).toBeDefined();
    expect(write?.data.subject).toBe('Welcome to TribeTails');
    expect(write?.data.body).toBe('Hello {{firstName}}');
    expect(write?.data.createdBy).toBe('admin1');
    expect(write?.data.tags).toEqual(['onboarding', 'welcome']);
  });

  it('HAPPY: updates existing template (no createdAt overwrite)', async () => {
    const ctx = buildDbMock({
      docs: {
        'emailTemplates/welcome.kinfolk': {
          subject: 'old subject',
          body: 'old body',
          createdAt: 'preserved',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 'New subject',
        body: 'New body',
      }),
    );
    expect(res.templateId).toBe('welcome.kinfolk');
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write?.data.subject).toBe('New subject');
    expect(write?.data.updatedBy).toBe('admin1');
    expect(write?.data.createdBy).toBeUndefined();
  });

  it('HAPPY: upserts the chosen category into template_categories (grows the pool)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(
      req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b', category: 'Onboarding' }),
    );
    const catWrite = ctx.writes.find((w) => w.path === 'template_categories/onboarding');
    expect(catWrite).toBeDefined();
    expect(catWrite?.data.name).toBe('Onboarding');
    expect(catWrite?.merge).toBe(true);
  });

  it('HAPPY: no category => no template_categories write', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b' }));
    expect(ctx.writes.some((w) => w.path.startsWith('template_categories/'))).toBe(false);
  });

  it('SAD: invalid templateId chars rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(req({ templateId: 'bad id with spaces', subject: 's', body: 'b' })),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler({
        data: { templateId: 'x', subject: 's', body: 'b' },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });

  it('SAD: empty subject rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(req({ templateId: 'x', subject: '', body: 'b' })),
    ).rejects.toThrow();
  });
});
