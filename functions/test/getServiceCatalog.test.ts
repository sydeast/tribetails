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
