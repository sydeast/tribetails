import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import {
  EMPTY_SERVICE_NAME_CATALOG,
  looksLikeServiceCode,
  serviceDisplayName,
  serviceNameCatalogFrom,
} from '../src/lib/serviceDisplayName';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/** The operator's KinCare list as `business_settings` stores it. */
const SETTINGS = {
  serviceRates: { '30Minute': '25', '60Minute': '40', Overnight: '120' },
  serviceDurations: { Overnight: '720' },
};
const CATALOG = serviceNameCatalogFrom(SETTINGS);

describe('serviceDisplayName (#1297)', () => {
  it('names a stored code by the one KinCare that runs that long', () => {
    expect(serviceDisplayName('visit_60', CATALOG)).toBe('60 Minute');
    expect(serviceDisplayName('VISIT_60', CATALOG)).toBe('60 Minute');
    expect(serviceDisplayName('60Mins', CATALOG)).toBe('60 Minute');
  });

  it('matches a near-spelling of a catalog key and returns the catalog name', () => {
    expect(serviceDisplayName('30 Minute', CATALOG)).toBe('30 Minute');
    expect(serviceDisplayName('30minute', CATALOG)).toBe('30 Minute');
    expect(serviceDisplayName('overnight', CATALOG)).toBe('Overnight');
  });

  it('follows a rename in settings: the name is business data, not a table in code', () => {
    const renamed = serviceNameCatalogFrom({ serviceRates: { 'Quick Check': '25' }, serviceDurations: { 'Quick Check': '30' } });
    expect(serviceDisplayName('visit_30', renamed)).toBe('Quick Check');
  });

  it('refuses to guess between two KinCares of the same length', () => {
    const twoHours = serviceNameCatalogFrom({ serviceRates: { Walk: '20', Sit: '30' }, serviceDurations: { Walk: '60', Sit: '60' } });
    expect(serviceDisplayName('visit_60', twoHours)).toBeNull();
  });

  it('falls back to the visit\'s stored name, then a typed label, never to a code', () => {
    expect(serviceDisplayName('visit_60', EMPTY_SERVICE_NAME_CATALOG, '60-Minute Drop-In')).toBe('60-Minute Drop-In');
    expect(serviceDisplayName('Drop-in Visit', EMPTY_SERVICE_NAME_CATALOG)).toBe('Drop-in Visit');
    expect(serviceDisplayName('visit_60', EMPTY_SERVICE_NAME_CATALOG)).toBeNull();
    expect(serviceDisplayName('', CATALOG)).toBeNull();
    expect(serviceDisplayName(undefined, CATALOG)).toBeNull();
  });

  it('tells a code from a name', () => {
    expect(looksLikeServiceCode('visit_60')).toBe(true);
    expect(looksLikeServiceCode('overnight_care')).toBe(true);
    expect(looksLikeServiceCode('30 Minute Quick Check')).toBe(false);
    expect(looksLikeServiceCode('Overnight')).toBe(false);
  });
});

describe('the portal callables carry the resolved name (#1297, #1288)', () => {
  it('getMyBookings sends serviceLabel on kinCares and on envelope-less sessions', async () => {
    const future = Date.now() + 86400_000;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': SETTINGS,
        'families/3/bookings/env-a': { envelopeStatus: 'confirmed', pattern: 'individual' },
      },
      collectionGroupDocs: {
        kinCares: [
          {
            id: 'kc1',
            path: 'families/3/bookings/env-a/kinCares/kc1',
            data: { familyId: '3', batchId: 'env-a', status: 'confirmed', serviceType: 'visit_60', title: 'Midday drop-in', startTime: Timestamp.fromMillis(future) },
          },
        ],
      },
      queryDocs: {
        kin_care_sessions: [
          { id: 's1', data: { kinfolkId: '3', status: 'SCHEDULED', serviceType: 'visit_30', startTime: new Date(future).toISOString() } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const kc = res.upcoming.find((b) => b.id === 'kc1');
    const session = res.upcoming.find((b) => b.id === 's1');
    expect(kc?.serviceLabel).toBe('60 Minute');
    expect(kc?.serviceType).toBe('visit_60');
    expect(session?.serviceLabel).toBe('30 Minute');
    // The session's title used to be its raw code.
    expect(session?.title).toBe('30 Minute');
  });

  it('getMyVisits sends serviceLabel', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'business_settings/business_settings': SETTINGS },
      queryDocs: {
        kin_care_sessions: [{ id: 'v1', data: { kinfolkId: '3', status: 'DEPARTED', serviceType: 'visit_60', startTime: '2026-07-01T10:00:00Z' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    const res = await getMyVisitsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.visits[0].serviceLabel).toBe('60 Minute');
  });

  it('getMyInvoices: client, service name and amount on a legacy one-visit invoice', async () => {
    // The shape of test-kinfolk-001-invoice-open on the 2026-11-01 walk: no
    // `client`, a `kinfolkName`, no stored lines the reader accepts, and one
    // session with no price on it.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'The Rivera Tribe' },
        'business_settings/business_settings': SETTINGS,
        'kin_care_sessions/vis_3': { serviceType: 'visit_60', startTime: '2026-10-20T10:00:00Z' },
      },
      queryDocs: {
        invoices: [
          { id: 'inv-open', data: { kinfolkId: '3', status: 'open', total: 45, amountDue: 45, kinfolkName: 'Rivera', sessionIds: ['vis_3'] } },
          { id: 'inv-bare', data: { kinfolkId: '3', status: 'open', total: 10, amountDue: 10 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const inv = res.open.find((i) => i.id === 'inv-open')!;
    expect(inv.client).toBe('Rivera');
    expect(inv.lineItems).toHaveLength(1);
    expect(inv.lineItems![0].label).toBe('60 Minute');
    expect(inv.lineItems![0].amountCents).toBe(4500);
    // No `client`, no `kinfolkName`: the household's own display name.
    expect(res.open.find((i) => i.id === 'inv-bare')!.client).toBe('The Rivera Tribe');
  });

  it('getMyInvoices leaves two unpriced visit lines blank rather than splitting the total', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': SETTINGS,
        'kin_care_sessions/a': { serviceType: 'visit_60' },
        'kin_care_sessions/b': { serviceType: 'visit_30' },
      },
      queryDocs: {
        invoices: [{ id: 'inv-2', data: { kinfolkId: '3', status: 'open', total: 65, amountDue: 65, sessionIds: ['a', 'b'] } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const lines = res.open[0].lineItems!;
    expect(lines.map((l) => l.label)).toEqual(['60 Minute', '30 Minute']);
    expect(lines.map((l) => l.amountCents)).toEqual([null, null]);
  });

  it('getMyInvoices names a stored line whose description is a code, and keeps typed text as typed', async () => {
    const { mapStoredLineItem } = await import('../src/portal/getMyInvoices');
    const coded = mapStoredLineItem({ description: 'visit_60', qty: 1, unitCents: 4000, discountCents: 0, sessionId: '' }, 0, null, CATALOG);
    const typed = mapStoredLineItem({ description: 'Extra walk, rainy day', qty: 1, unitCents: 1000, discountCents: 0, sessionId: '' }, 1, null, CATALOG);
    expect(coded.label).toBe('60 Minute');
    expect(coded.amountCents).toBe(4000);
    expect(typed.label).toBe('Extra walk, rainy day');
  });
});
