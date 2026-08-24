import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

/**
 * 17.3 Home dashboard layout save.
 *
 * The layout is an ordered list of "key:size" tokens on
 * `users/{uid}.dashboardWidgets`, the SAME field android already reads and
 * writes, so a layout arranged on one surface opens arranged on the other.
 * These tests pin the three things that would silently break that: the document
 * and field written, the caller whose document is written, and the token shape
 * the schema will accept.
 */
describe('saveDashboardLayoutHandler', () => {
  it('HAPPY: merge-writes the tokens to the caller own users/{uid} doc', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    const res = await saveDashboardLayoutHandler({
      data: { tokens: ['stats:wide', 'todaysPack:compact', 'kintales:compact'] },
      auth: { uid: 'admin1' },
    } as never);

    expect(res).toEqual({
      ok: true,
      tokens: ['stats:wide', 'todaysPack:compact', 'kintales:compact'],
    });
    const write = ctx.writes.find((entry) => entry.path === 'users/admin1');
    expect(write, 'must write to users/admin1').toBeTruthy();
    expect(write?.data?.['dashboardWidgets']).toEqual([
      'stats:wide',
      'todaysPack:compact',
      'kintales:compact',
    ]);
    expect(write?.data?.['dashboardWidgetsUpdatedAt']).toBe('__SERVER_TS__');
  });

  it('HAPPY: merges, so a concurrent theme or nav save on the same doc is not clobbered', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    await saveDashboardLayoutHandler({
      data: { tokens: ['stats:wide'] },
      auth: { uid: 'admin1' },
    } as never);

    const write = ctx.writes.find((entry) => entry.path === 'users/admin1');
    expect(write?.merge, 'a full overwrite would erase theme, nav and profile fields').toBe(true);
    expect(Object.keys(write?.data ?? {}).sort()).toEqual([
      'dashboardWidgets',
      'dashboardWidgetsUpdatedAt',
    ]);
  });

  it('HAPPY: an empty list is a legal save, meaning "restore the shipped default"', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    const res = await saveDashboardLayoutHandler({
      data: { tokens: [] },
      auth: { uid: 'admin1' },
    } as never);

    expect(res.tokens).toEqual([]);
    expect(ctx.writes.find((entry) => entry.path === 'users/admin1')?.data?.['dashboardWidgets'])
      .toEqual([]);
  });

  it('writes the CALLER uid, never a uid supplied in the payload', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    await saveDashboardLayoutHandler({
      data: { tokens: ['stats:wide'], uid: 'someone-else' },
      auth: { uid: 'admin1' },
    } as never);

    expect(ctx.writes.map((entry) => entry.path)).toEqual(['users/admin1']);
  });

  it('INVALID-ARG: rejects a token that is not key:size', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    for (const bad of ['stats', 'stats:huge', ':wide', 'stats:', 'stats wide', 'stat_s:wide', '']) {
      await expect(
        saveDashboardLayoutHandler({ data: { tokens: [bad] }, auth: { uid: 'admin1' } } as never),
        `token ${JSON.stringify(bad)} must be rejected`,
      ).rejects.toThrow();
    }
    expect(ctx.writes, 'nothing may be written on a rejected payload').toEqual([]);
  });

  it('INVALID-ARG: rejects a missing tokens field and a non-array tokens field', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    await expect(
      saveDashboardLayoutHandler({ data: {}, auth: { uid: 'admin1' } } as never),
    ).rejects.toThrow();
    await expect(
      saveDashboardLayoutHandler({ data: { tokens: 'stats:wide' }, auth: { uid: 'admin1' } } as never),
    ).rejects.toThrow();
    expect(ctx.writes).toEqual([]);
  });

  it('INVALID-ARG: caps the list at 30 tokens', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    const thirty = Array.from({ length: 30 }, () => 'stats:wide');
    await expect(
      saveDashboardLayoutHandler({ data: { tokens: thirty }, auth: { uid: 'admin1' } } as never),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      saveDashboardLayoutHandler({
        data: { tokens: [...thirty, 'stats:wide'] },
        auth: { uid: 'admin1' },
      } as never),
    ).rejects.toThrow();
  });

  it('accepts a key it has never heard of, so an older server cannot break a newer client', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    await expect(
      saveDashboardLayoutHandler({
        data: { tokens: ['someFutureWidget:compact'] },
        auth: { uid: 'admin1' },
      } as never),
    ).resolves.toMatchObject({ ok: true });
  });

  it('UNAUTHENTICATED: rejects a request with no auth', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');

    await expect(
      saveDashboardLayoutHandler({ data: { tokens: [] }, auth: undefined } as never),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toEqual([]);
  });
});

/**
 * The gate itself. The exported `saveDashboardLayout` is an onCall wrapper that
 * cannot be invoked directly from a unit test, so this asserts the same
 * composition the export uses: a caller with no admin claim and no allowlist
 * entry never reaches the handler, and nothing is written.
 */
describe('saveDashboardLayout admin gate', () => {
  it('NON-ADMIN: a signed-in caller without the admin claim is denied', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');
    const gated = wrapAdminCallable('saveDashboardLayout', saveDashboardLayoutHandler);

    await expect(
      gated({ data: { tokens: ['stats:wide'] }, auth: { uid: 'kinfolk1', token: {} } } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes, 'a denied caller must not reach the write').toEqual([]);
  });

  it('UNAUTHENTICATED: the gate rejects before the handler runs', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');
    const gated = wrapAdminCallable('saveDashboardLayout', saveDashboardLayoutHandler);

    await expect(
      gated({ data: { tokens: ['stats:wide'] }, auth: undefined } as never),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toEqual([]);
  });

  it('ADMIN: a caller with the admin claim reaches the write', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const { saveDashboardLayoutHandler } = await import('../src/admin/saveDashboardLayout');
    const gated = wrapAdminCallable('saveDashboardLayout', saveDashboardLayoutHandler);

    await expect(
      gated({
        data: { tokens: ['stats:wide'] },
        auth: { uid: 'admin1', token: { admin: true } },
      } as never),
    ).resolves.toMatchObject({ ok: true });
    expect(ctx.writes.map((entry) => entry.path)).toEqual(['users/admin1']);
  });
});
