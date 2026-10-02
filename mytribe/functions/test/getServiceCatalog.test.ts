import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/** The live AuntieOS KinCare-types map at business_settings/business_settings.serviceRates. */
const LIVE_SERVICE_RATES = {
  '30Minute': '25',
  '45Minute': '35',
  '60Minute': '45',
  '90Minute': '60',
  'Half-Day 6Hrs': '100',
  '2Hrs': '80',
};

describe('getServiceCatalogHandler', () => {
  it('rejects unauth', async () => {
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    await expect(getServiceCatalogHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('serves the AuntieOS serviceRates map as the primary catalog source', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceRates: LIVE_SERVICE_RATES },
      },
      queryDocs: {
        // Stale legacy doc must NOT leak into the result when serviceRates exists.
        base_services: [{ id: 'stale1', data: { title: '30 min', basePrice: 25, durationMinutes: 30, active: true } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services.map((s) => ({ id: s.id, name: s.name, priceCents: s.priceCents, durationMinutes: s.durationMinutes }))).toEqual([
      { id: '30Minute', name: '30 Minute', priceCents: 2500, durationMinutes: 30 },
      { id: '45Minute', name: '45 Minute', priceCents: 3500, durationMinutes: 45 },
      { id: '60Minute', name: '60 Minute', priceCents: 4500, durationMinutes: 60 },
      { id: '90Minute', name: '90 Minute', priceCents: 6000, durationMinutes: 90 },
      { id: '2Hrs', name: '2 Hrs', priceCents: 8000, durationMinutes: 120 },
      { id: 'Half-Day 6Hrs', name: 'Half-Day 6 Hrs', priceCents: 10000, durationMinutes: 360 },
    ]);
    for (const s of res.services) {
      expect(s.category).toBeNull();
      expect(s.priceMinCents).toBeNull();
      expect(s.priceMaxCents).toBeNull();
      expect(s.isOvernight).toBe(false);
    }
  });

  it('skips serviceRates entries with unparseable or non-positive rates', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          serviceRates: { '30Minute': '25', Broken: 'abc', Free: '0', Negative: '-5' },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services.map((s) => s.id)).toEqual(['30Minute']);
  });

  it('falls back to base_services when serviceRates is missing, mapping the stale title/basePrice shape', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        base_services: [
          { id: 'svc1', data: { title: '30 min', basePrice: 25, durationMinutes: 30, active: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services).toHaveLength(1);
    expect(res.services[0]).toMatchObject({ id: 'svc1', name: '30 min', priceCents: 2500, durationMinutes: 30 });
  });

  it('falls back when serviceRates is an empty map', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceRates: {} },
      },
      queryDocs: {
        base_services: [{ id: 's1', data: { name: 'House Checks', priceCents: 1500 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services.map((s) => s.id)).toEqual(['s1']);
  });

  it('fallback filters junk docs with no real name AND no price', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        base_services: [
          { id: 'junk-doc-id', data: { active: true } },
          { id: 's1', data: { name: 'House Checks', priceCents: 1500 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services.map((s) => s.id)).toEqual(['s1']);
  });

  it('fallback reads base_services (legacy name/price shape, ranged prices)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        base_services: [
          { id: 's1', data: { name: 'Overnight Stays', category: 'Held Down at Home', priceCents: 15000, isOvernight: true } },
          { id: 's2', data: { name: "Auntie's In", category: 'Held Down at Home', priceMinCents: 1500, priceMaxCents: 8000 } },
          { id: 's3', data: { name: 'House Checks', category: 'Quick Visits', priceMinCents: 1500, priceMaxCents: 2000 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services).toHaveLength(3);
    const overnight = res.services.find((s) => s.id === 's1');
    expect(overnight?.priceCents).toBe(15000);
    expect(overnight?.isOvernight).toBe(true);
    const aunties = res.services.find((s) => s.id === 's2');
    expect(aunties?.priceMinCents).toBe(1500);
    expect(aunties?.priceMaxCents).toBe(8000);
  });

  it('fallback skips inactive services', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        base_services: [
          { id: 'active', data: { name: 'A', priceCents: 100, active: true } },
          { id: 'archived', data: { name: 'B', priceCents: 200, active: false } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.services.map((s) => s.id)).toEqual(['active']);
  });
});

describe('serviceRates pure mappers', () => {
  it('mapServiceRates maps the live map exactly (sorted shortest visit first)', async () => {
    const { mapServiceRates } = await import('../src/portal/getServiceCatalog');
    const out = mapServiceRates(LIVE_SERVICE_RATES);
    expect(out.map((s) => [s.id, s.name, s.priceCents, s.durationMinutes])).toEqual([
      ['30Minute', '30 Minute', 2500, 30],
      ['45Minute', '45 Minute', 3500, 45],
      ['60Minute', '60 Minute', 4500, 60],
      ['90Minute', '90 Minute', 6000, 90],
      ['2Hrs', '2 Hrs', 8000, 120],
      ['Half-Day 6Hrs', 'Half-Day 6 Hrs', 10000, 360],
    ]);
  });

  it('#1092: mapServiceRates takes a typed length over the name, and the name when none was typed', async () => {
    const { mapServiceRates } = await import('../src/portal/getServiceCatalog');
    const out = mapServiceRates({ Overnight: '120', '2Hrs': '80' }, { Overnight: '720', '2Hrs': '' });
    expect(out.map((s) => [s.id, s.durationMinutes])).toEqual([
      ['2Hrs', 120],
      ['Overnight', 720],
    ]);
  });

  it('mapServiceRates returns [] for missing / non-map inputs', async () => {
    const { mapServiceRates } = await import('../src/portal/getServiceCatalog');
    expect(mapServiceRates(undefined)).toEqual([]);
    expect(mapServiceRates(null)).toEqual([]);
    expect(mapServiceRates('25')).toEqual([]);
    expect(mapServiceRates(['25'])).toEqual([]);
    expect(mapServiceRates({})).toEqual([]);
  });

  it('mapServiceRates rounds fractional dollar rates to whole cents', async () => {
    const { mapServiceRates } = await import('../src/portal/getServiceCatalog');
    expect(mapServiceRates({ '30Minute': '25.505' })[0].priceCents).toBe(2551);
  });

  it('prettifyRateKey inserts a space before Minute/Hrs', async () => {
    const { prettifyRateKey } = await import('../src/portal/getServiceCatalog');
    expect(prettifyRateKey('30Minute')).toBe('30 Minute');
    expect(prettifyRateKey('2Hrs')).toBe('2 Hrs');
    expect(prettifyRateKey('Half-Day 6Hrs')).toBe('Half-Day 6 Hrs');
    expect(prettifyRateKey('Overnight')).toBe('Overnight');
  });

  it('durationFromRateKey parses obvious durations, null otherwise', async () => {
    const { durationFromRateKey } = await import('../src/portal/getServiceCatalog');
    expect(durationFromRateKey('30Minute')).toBe(30);
    expect(durationFromRateKey('90Minute')).toBe(90);
    expect(durationFromRateKey('2Hrs')).toBe(120);
    expect(durationFromRateKey('Half-Day 6Hrs')).toBe(360);
    expect(durationFromRateKey('Overnight')).toBeNull();
  });

  it('mapBaseServiceDoc prefers name/priceCents over title/basePrice', async () => {
    const { mapBaseServiceDoc } = await import('../src/portal/getServiceCatalog');
    const both = mapBaseServiceDoc('d1', { name: 'A', title: 'B', priceCents: 1500, basePrice: 99 });
    expect(both.name).toBe('A');
    expect(both.priceCents).toBe(1500);
    const stale = mapBaseServiceDoc('d1', { title: '30 min', basePrice: 25.5 });
    expect(stale.name).toBe('30 min');
    expect(stale.priceCents).toBe(2550);
  });

  it('isRenderableService rejects id-named priceless docs only', async () => {
    const { mapBaseServiceDoc, isRenderableService } = await import('../src/portal/getServiceCatalog');
    expect(isRenderableService(mapBaseServiceDoc('junk', {}))).toBe(false);
    expect(isRenderableService(mapBaseServiceDoc('junk', { basePrice: 25 }))).toBe(true);
    expect(isRenderableService(mapBaseServiceDoc('junk', { name: 'Real Name' }))).toBe(true);
    expect(isRenderableService(mapBaseServiceDoc('junk', { priceMinCents: 1500 }))).toBe(true);
  });
});
// D-2026-09-28-VISIT-PRICES-ARE-BILLING (#1037): a member without billing
// access gets the catalog with the price keys removed, not nulled.
describe('getServiceCatalogHandler: visit prices are billing information', () => {
  const RATES = { '30Minute': '25', '60Minute': '45' };
  const PRICE_KEYS = ['priceCents', 'priceMinCents', 'priceMaxCents'];
  function household(extraDocs: Record<string, unknown> = {}) {
    return buildDbMock({
      docs: {
        'business_settings/business_settings': { serviceRates: RATES },
        'clients/pk1': { kinfolkIds: ['fam1'] },
        'clients/sk-bill': { kinfolkIds: ['fam1'] },
        'clients/sk-none': { kinfolkIds: ['fam1'] },
        'families/fam1/members/pk1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
        'families/fam1/members/sk-bill': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: true } },
        'families/fam1/members/sk-none': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } },
        ...extraDocs,
      },
    });
  }
  async function callAs(uid: string, data: unknown = {}, token: Record<string, unknown> = {}) {
    mocks.dbFn.mockReturnValue(household().db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    return getServiceCatalogHandler({ data, auth: { uid, token } } as any);
  }
  it('PRIMARY sees every price', async () => {
    const res = await callAs('pk1');
    expect(res.pricesVisible).toBe(true);
    expect(res.services.map((s) => s.priceCents)).toEqual([2500, 4500]);
  });
  it('SECONDARY with billing_full sees every price', async () => {
    const res = await callAs('sk-bill', { kinfolkId: 'fam1' });
    expect(res.pricesVisible).toBe(true);
    expect(res.services.map((s) => s.priceCents)).toEqual([2500, 4500]);
  });
  it('SECONDARY without billing_full gets the services with no price field at all', async () => {
    const res = await callAs('sk-none', { kinfolkId: 'fam1' });
    expect(res.pricesVisible).toBe(false);
    expect(res.services.map((s) => s.name)).toEqual(['30 Minute', '60 Minute']);
    for (const s of res.services) {
      for (const k of PRICE_KEYS) expect(Object.prototype.hasOwnProperty.call(s, k)).toBe(false);
    }
    expect(JSON.stringify(res)).not.toMatch(/2500|4500/);
  });
  it('strips the base_services fallback too, and keeps a row the junk guard kept by its price', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/sk-none': { kinfolkIds: ['fam1'] },
        'families/fam1/members/sk-none': { role: 'SECONDARY', status: 'ACTIVE', permissions: {} },
      },
      queryDocs: {
        base_services: [{ id: 'svc1', data: { basePrice: 25, priceMinCents: 1000, priceMaxCents: 3000, active: true } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const res = await getServiceCatalogHandler({ data: {}, auth: { uid: 'sk-none' } } as any);
    expect(res.pricesVisible).toBe(false);
    expect(res.services.map((s) => s.id)).toEqual(['svc1']);
    for (const k of PRICE_KEYS) expect(Object.prototype.hasOwnProperty.call(res.services[0], k)).toBe(false);
  });
  it('an unresolvable household (2+ tribes, none named) gets the catalog without prices, not an error', async () => {
    const res = await callAs('multi', {}, {});
    // `multi` has no clients doc in this fixture: no tribe linked at all.
    expect(res.pricesVisible).toBe(false);
    expect(res.services).toHaveLength(2);
    for (const s of res.services) expect(s.priceCents).toBeUndefined();
    const ctx = household({ 'clients/two': { kinfolkIds: ['fam1', 'fam2'] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getServiceCatalogHandler } = await import('../src/portal/getServiceCatalog');
    const two = await getServiceCatalogHandler({ data: {}, auth: { uid: 'two' } } as any);
    expect(two.pricesVisible).toBe(false);
    expect(two.services[0].priceCents).toBeUndefined();
  });
  it('a household the caller does not belong to hides prices rather than borrowing that household\'s answer', async () => {
    const res = await callAs('sk-none', { kinfolkId: 'someone-else' });
    expect(res.pricesVisible).toBe(false);
    expect(res.services[0].priceCents).toBeUndefined();
  });
  it('the owner sees prices without naming a household', async () => {
    const res = await callAs('owner1', {}, { admin: true });
    expect(res.pricesVisible).toBe(true);
    expect(res.services.map((s) => s.priceCents)).toEqual([2500, 4500]);
  });
});
