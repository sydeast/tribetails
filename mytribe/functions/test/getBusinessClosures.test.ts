import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { getBusinessClosuresHandler } from '../src/portal/getBusinessClosures';

function req(data: unknown, uid: string | null = 'kin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
});

/**
 * C1: the portal's booking wizard cannot read `business_settings` directly
 * (admin-only in firestore.rules), so this is the one seam it uses to learn
 * which dates are closed -- resolved server-side through the same
 * closureRecurrence math the write-path guard uses, so what this returns and
 * what requestBooking will actually refuse never drift apart.
 */
describe('getBusinessClosures', () => {
  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(
      getBusinessClosuresHandler(req({ fromDate: '2026-08-01', toDate: '2026-08-31' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a malformed date or an inverted range', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(
      getBusinessClosuresHandler(req({ fromDate: 'not-a-date', toDate: '2026-08-31' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      getBusinessClosuresHandler(req({ fromDate: '2026-08-31', toDate: '2026-08-01' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a range wider than the cap', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(
      getBusinessClosuresHandler(req({ fromDate: '2026-01-01', toDate: '2026-12-31' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('resolves both once and recurring closures inside the range, sorted, with names', async () => {
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': {
          companyHolidays: ['2026-09-14|Owner away', 'yearly:09-07|Labor observance'],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await getBusinessClosuresHandler(req({ fromDate: '2026-09-01', toDate: '2026-09-30' }));
    expect(res.closures).toEqual([
      { date: '2026-09-07', name: 'Labor observance' },
      { date: '2026-09-14', name: 'Owner away' },
    ]);
  });

  it('returns [] when there are no closures configured', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    const res = await getBusinessClosuresHandler(req({ fromDate: '2026-09-01', toDate: '2026-09-30' }));
    expect(res.closures).toEqual([]);
  });

  it('a closure outside the requested range is not returned', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessClosuresHandler(req({ fromDate: '2026-09-01', toDate: '2026-09-30' }));
    expect(res.closures).toEqual([]);
  });
});

/** #1301: days the operator leaves with no hours are closed days too, read off the same settings doc. */
describe('getBusinessClosures: weekly days off (#1301)', () => {
  const HOURS = {
    Monday: '08:00-18:00', Tuesday: '08:00-18:00', Wednesday: '08:00-18:00', Thursday: '08:00-18:00',
    Friday: '08:00-18:00', Saturday: '09:00-13:00', Sunday: '',
  };
  async function run(settings: Record<string, unknown> | null) {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: settings ? { 'business_settings/business_settings': settings } : {} }).db,
    );
    return getBusinessClosuresHandler(req({ fromDate: '2026-09-01', toDate: '2026-09-14' }));
  }
  it('closes every blank weekday in the range', async () => {
    const res = await run({ businessHours: HOURS });
    expect(res.closures).toEqual([
      { date: '2026-09-06', name: 'Sundays' },
      { date: '2026-09-13', name: 'Sundays' },
    ]);
  });
  it('lets a company holiday keep its own name on a day off', async () => {
    const res = await run({ businessHours: HOURS, companyHolidays: ['2026-09-06|Owner away'] });
    expect(res.closures[0]).toEqual({ date: '2026-09-06', name: 'Owner away' });
    expect(res.closures).toHaveLength(2);
  });
  it('invents nothing: no map, a missing key, or unreadable hours close nothing', async () => {
    expect((await run({})).closures).toEqual([]);
    expect((await run(null)).closures).toEqual([]);
    const { Sunday: _s, ...noSunday } = HOURS;
    expect((await run({ businessHours: noSunday })).closures).toEqual([]);
    expect((await run({ businessHours: { ...HOURS, Sunday: 'by appointment' } })).closures).toEqual([]);
  });
  it('skips a date with special hours, because the weekly pattern is wrong for it', async () => {
    const res = await run({ businessHours: HOURS, specialHours: ['2026-09-06|10-2'] });
    expect(res.closures).toEqual([{ date: '2026-09-13', name: 'Sundays' }]);
  });
});
