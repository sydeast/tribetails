import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { listCategoriesHandler } from '../src/admin/listCategories';
import { logEvent } from '../src/lib/logger';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (logEvent as any).mockClear();
});

function req(uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data: {},
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Convenience: seed both source collections. */
function seed(categories: string[], templateCats: Array<string | null | undefined>) {
  return buildDbMock({
    queryDocs: {
      template_categories: categories.map((name, i) => ({ id: `c${i}`, data: { name } })),
      emailTemplates: templateCats.map((category, i) => ({ id: `t${i}`, data: { category } })),
    },
  }).db;
}

describe('listCategories', () => {
  // unauth/non-admin denial is enforced by wrapAdminCallable (its own test file).

  it('HAPPY: both sources empty returns empty array', async () => {
    mocks.dbFn.mockReturnValue(seed([], []));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual([]);
    expect(res.schemaVersion).toBe(1);
  });

  it('HAPPY: unions managed collection with distinct template categories', async () => {
    mocks.dbFn.mockReturnValue(seed(['Onboarding'], ['Billing', 'Reminders']));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual(['Billing', 'Onboarding', 'Reminders']);
  });

  it('HAPPY: dedups case-insensitively, keeping managed-collection casing', async () => {
    mocks.dbFn.mockReturnValue(seed(['Onboarding'], ['onboarding', 'ONBOARDING']));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual(['Onboarding']);
  });

  it('HAPPY: returns categories that exist only on templates (no managed doc)', async () => {
    mocks.dbFn.mockReturnValue(seed([], ['Billing']));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual(['Billing']);
  });

  it('HAPPY: ignores blank/whitespace/null categories', async () => {
    mocks.dbFn.mockReturnValue(seed(['  '], [null, '', '   ', 'Billing']));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual(['Billing']);
  });

  it('HAPPY: sorts alphabetically case-insensitively', async () => {
    mocks.dbFn.mockReturnValue(seed(['zeta'], ['alpha', 'Beta']));
    const res = await listCategoriesHandler(req());
    expect(res.categories).toEqual(['alpha', 'Beta', 'zeta']);
  });

  it('HAPPY: emits admin.categories.listed log with count', async () => {
    mocks.dbFn.mockReturnValue(seed(['Onboarding'], ['Billing']));
    await listCategoriesHandler(req());
    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const listed = calls.find((c: any) => c.event === 'admin.categories.listed');
    expect(listed).toBeDefined();
    expect(listed.severity).toBe('info');
    expect(listed.extra.count).toBe(2);
  });
});
