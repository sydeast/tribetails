import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { assignTemplatesToCategoryHandler } from '../src/admin/assignTemplatesToCategory';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('assignTemplatesToCategory', () => {
  it('HAPPY: merges the category onto every named template in one batch', async () => {
    const ctx = buildDbMock({
      docs: {
        'emailTemplates/a': { subject: 's', body: 'b' },
        'emailTemplates/b': { subject: 's', body: 'b' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await assignTemplatesToCategoryHandler(
      req({ category: 'Booking', templateIds: ['a', 'b'] }),
    );

    expect(res).toEqual({ category: 'Booking', assigned: 2, templateIds: ['a', 'b'] });
    const aWrite = ctx.writes.find((w) => w.path === 'emailTemplates/a');
    const bWrite = ctx.writes.find((w) => w.path === 'emailTemplates/b');
    expect(aWrite?.data.category).toBe('Booking');
    expect(aWrite?.merge).toBe(true);
    expect(aWrite?.data.updatedBy).toBe('admin1');
    expect(bWrite?.data.category).toBe('Booking');
  });

  it('HAPPY: upserts the (inline-created) category into the managed pool', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/a': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await assignTemplatesToCategoryHandler(req({ category: 'Brand New', templateIds: ['a'] }));

    const catWrite = ctx.writes.find((w) => w.path === 'template_categories/brand-new');
    expect(catWrite).toBeDefined();
    expect(catWrite?.data.name).toBe('Brand New');
    expect(catWrite?.merge).toBe(true);
  });

  it('HAPPY: dedupes repeated ids so a template is only written once', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/a': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await assignTemplatesToCategoryHandler(
      req({ category: 'Booking', templateIds: ['a', 'a', 'a'] }),
    );

    expect(res.assigned).toBe(1);
    expect(ctx.writes.filter((w) => w.path === 'emailTemplates/a')).toHaveLength(1);
  });

  it('HAPPY: trims the category name before writing', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/a': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await assignTemplatesToCategoryHandler(
      req({ category: '  Booking  ', templateIds: ['a'] }),
    );

    expect(res.category).toBe('Booking');
    expect(ctx.writes.find((w) => w.path === 'emailTemplates/a')?.data.category).toBe('Booking');
  });

  it('SAD: fails loud naming a missing template, and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/a': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      assignTemplatesToCategoryHandler(req({ category: 'Booking', templateIds: ['a', 'ghost'] })),
    ).rejects.toThrow(/ghost/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: a blank templateId is rejected by the schema', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplatesToCategoryHandler(req({ category: 'Booking', templateIds: [''] })),
    ).rejects.toThrow();
  });

  it('SAD: an empty templateIds array is rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplatesToCategoryHandler(req({ category: 'Booking', templateIds: [] })),
    ).rejects.toThrow();
  });

  it('SAD: a blank category is rejected', async () => {
    const ctx = buildDbMock({ docs: { 'emailTemplates/a': { subject: 's', body: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplatesToCategoryHandler(req({ category: '   ', templateIds: ['a'] })),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      assignTemplatesToCategoryHandler({
        data: { category: 'Booking', templateIds: ['a'] },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });
});
