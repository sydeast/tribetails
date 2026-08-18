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
    const res = await getMyHomeHandler({
      data: { kinfolkId: 'demo-1' },
      auth: { uid: 'u1' },
    } as any);

    expect(res).not.toHaveProperty('currentVisit');
    expect(res).not.toHaveProperty('upcomingBookings');
    expect(res).not.toHaveProperty('recentBookings');
    // The fields legacy DOES decode must survive untouched. `payMethods`
    // (PR30) is the one addition since O-19 was pinned.
    expect(Object.keys(res).sort()).toEqual(
      ['bannerDismissedByUser', 'businessLogoUrl', 'businessName', 'displayName', 'kinfolkId', 'payMethods', 'portal'].sort(),
    );
  });

  /**
   * PR30: `payMethods` carries the operator's configured processors — resolved
   * URL + label off `resolvePayMethods`, never the raw `venmoHandle` off the
   * settings doc. This is the field the portal was blind to before this task
   * (`invoicePdf.ts`'s "How to pay" line was the only place these handles ever
   * reached a household).
   */
  it('PR30: resolves configured payment methods off business_settings, never raw handles', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['demo-1'] },
        'families/demo-1': { displayName: 'The Foster' },
        'business_settings/business_settings': { venmoHandle: '@auntie', paypalHandle: '' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: { kinfolkId: 'demo-1' }, auth: { uid: 'u1' } } as any);

    expect(res.payMethods.map((m) => m.id)).toEqual(['stripe', 'venmo']);
    expect(res.payMethods.find((m) => m.id === 'venmo')).toEqual({
      id: 'venmo',
      label: 'Pay with Venmo',
      kind: 'link',
      url: 'https://venmo.com/u/auntie',
    });
    expect(JSON.stringify(res.payMethods)).not.toMatch(/venmoHandle|@auntie/);
  });

  it('PR30: offers Stripe alone when no processor is configured', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['demo-1'] },
        'families/demo-1': { displayName: 'The Foster' },
        'business_settings/business_settings': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: { kinfolkId: 'demo-1' }, auth: { uid: 'u1' } } as any);

    expect(res.payMethods).toEqual([{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null }]);
  });

  /**
   * #379. The third rung of the display-name ladder opens `kinfolk/{id}`, the
   * only place this handler touches the AuntieOS canonical household record.
   * That document carries `internalNotes` (staff-only, the field the admin UI
   * labels "Anything that doesn't belong on the dossier yet"), and the handler
   * must take firstName and lastName off it and nothing else.
   *
   * Firestore rules no longer let a household read this document at all, so
   * this callable is now one of the only routes by which anything from it can
   * reach a portal screen. That makes the projection load-bearing, not tidy.
   *
   * Mutation-checked: spread the snapshot into the response and this goes red.
   */
  it('#379: the kinfolk name fallback takes first/last only, never internalNotes', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': null,
        'dossiers/3': null,
        'kinfolk/3': {
          firstName: 'Dana',
          lastName: 'Mercer',
          internalNotes: 'Owner disputes every invoice. Do not discount again.',
          referralSource: 'Vet referral, do not mention',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyHomeHandler } = await import('../src/portal/getMyHome');
    const res = await getMyHomeHandler({ data: {}, auth: { uid: 'u1' } } as any);

    expect(res.displayName).toBe('Dana Mercer');
    expect(res).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(res)).not.toMatch(/disputes every invoice|referralSource|Vet referral/);
  });
});
