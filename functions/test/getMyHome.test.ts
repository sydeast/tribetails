import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('getMyHomeHandler', () => {
  it('throws unauthenticated without auth', async () => {
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    await expect(
      getMyHomeHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('throws when caller has no kinfolkIds', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    await expect(
      getMyHomeHandler({ data: {}, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('blocks access to a kinfolkId not in the caller list', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['demo-1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    await expect(
      getMyHomeHandler({ data: { kinfolkId: 'other' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('returns the family displayName when families doc has one', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['demo-1'] },
        'families/demo-1': { displayName: 'The Foster' },
        'dossiers/demo-1': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: { kinfolkId: 'demo-1' }, auth: { uid: 'u1' } } as any);
    expect(res.kinfolkId).toBe('demo-1');
    expect(res.displayName).toBe('The Foster');
  });

  it('falls back to dossier kinfolkName when families displayName missing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': null,
        'dossiers/3': { kinfolkName: 'Nora' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.displayName).toBe('Nora');
  });

  it('operator can access any kinfolkId regardless of clients/{uid}.kinfolkIds', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': null,
        'families/777': { displayName: 'Stranger Tribe' },
        'dossiers/777': null,
        // RULING O-6 hardening 1: the staff branch now existence-checks
        // kinfolk/{id} before trusting a requested cross-tenant id.
        'kinfolk/777': { firstName: 'Stranger' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: { kinfolkId: '777' }, auth: { uid: 'op-uid' } } as any);
    expect(res.kinfolkId).toBe('777');
    expect(res.displayName).toBe('Stranger Tribe');
  });

  it('non-operator still blocked from foreign kinfolkId even if exists', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['mine'] },
        'families/777': { displayName: 'Stranger Tribe' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    await expect(
      getMyHomeHandler({ data: { kinfolkId: '777' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('falls all the way back to "Tribe {id}"', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['9'] },
        'families/9': null,
        'dossiers/9': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.displayName).toBe('Tribe 9');
  });

  /**
   * O-19. currentVisit/upcomingBookings/recentBookings were Phase-2A placeholders
   * typed `null`/`never[]`, and Home has since gotten that data from
   * getMyBookings/getMyKinTales/getMyKin instead. Nothing has ever read them.
   * This pins their ABSENCE so nobody re-adds a stub field the callers ignore.
   *
   * Safe against the legacy Compose rollback path (still one Hosting release
   * away until O-2): legacy's MyHomeResult does not declare these fields, and
   * PortalApi.getMyHome decodes by explicit key lookup, so a missing key is a
   * no-op there rather than a decode failure.
   */
  it('O-19: returns identity/config only, with no stubbed visit/booking fields', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['demo-1'] },
        'families/demo-1': { displayName: 'The Foster' },
        'dossiers/demo-1': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = (await getMyHomeHandler({
      data: { kinfolkId: 'demo-1' },
      auth: { uid: 'u1' },
    } as any)) as Record<string, unknown>;

    expect(res).not.toHaveProperty('currentVisit');
    expect(res).not.toHaveProperty('upcomingBookings');
    expect(res).not.toHaveProperty('recentBookings');
    // The fields legacy DOES decode must survive untouched.
    expect(Object.keys(res).sort()).toEqual(
      ['bannerDismissedByUser', 'businessLogoUrl', 'businessName', 'displayName', 'kinfolkId', 'portal'].sort(),
    );
  });
});
