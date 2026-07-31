import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

describe('createKinCareSessionHandler', () => {
  it('rejects unauth', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createKinCareSessionHandler } = await import('../src/admin/createKinCareSession');
    await expect(
      createKinCareSessionHandler({
        data: { kinfolkId: '3', serviceType: 'walk', startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T11:00:00Z' },
        auth: undefined,
      } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('resolves real kin names onto the session it creates (not kinNames: [])', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido' },
        'families/3/kin/k2': { name: 'Whiskers' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createKinCareSessionHandler } = await import('../src/admin/createKinCareSession');

    await createKinCareSessionHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1', 'k2'],
        serviceType: 'walk',
        startTime: '2026-08-01T10:00:00Z',
        endTime: '2026-08-01T11:00:00Z',
      },
      auth: { uid: 'admin1' },
    } as any);

    expect(ctx.adds).toHaveLength(1);
    const written = ctx.adds[0].data;
    expect(written.kinIds).toEqual(['k1', 'k2']);
    expect(written.kinNames).toEqual(['Fido', 'Whiskers']);
  });

  it('tolerates a missing kin doc rather than failing the session creation', async () => {
    const ctx = buildDbMock({ docs: { 'families/3/kin/k1': { name: 'Fido' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createKinCareSessionHandler } = await import('../src/admin/createKinCareSession');

    const r = await createKinCareSessionHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1', 'missing-kin'],
        serviceType: 'walk',
        startTime: '2026-08-01T10:00:00Z',
        endTime: '2026-08-01T11:00:00Z',
      },
      auth: { uid: 'admin1' },
    } as any);

    expect(r.ok).toBe(true);
    expect(ctx.adds[0].data.kinNames).toEqual(['Fido']);
  });

  it('writes kinNames: [] when no kinIds are given (no lookup attempted)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createKinCareSessionHandler } = await import('../src/admin/createKinCareSession');

    await createKinCareSessionHandler({
      data: {
        kinfolkId: '3',
        serviceType: 'walk',
        startTime: '2026-08-01T10:00:00Z',
        endTime: '2026-08-01T11:00:00Z',
      },
      auth: { uid: 'admin1' },
    } as any);

    expect(ctx.adds[0].data.kinIds).toEqual([]);
    expect(ctx.adds[0].data.kinNames).toEqual([]);
  });
});
