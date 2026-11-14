import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1866 (regression of #1581): a 30-minute visit booked through the admin
 * booking wizard read "Visit length 0" on Auntie Time, with no end time, while
 * the same KinCare made with Schedule > New visit read 30.
 *
 * Why #1581's fix (PR #1692) did not hold: it fixed `createKinCareSession`
 * (New visit) and taught the detail screens to fall back to the visit's window.
 * The wizard goes another way. Every client sends `serviceId: null` and
 * `endTimeMs: null` to `createMultiDateBookingRequest`, which stored no end;
 * the series approval looked the KinCare's length up by id alone, found none,
 * and created the session with `endTime: ''` and `serviceDurationMinutes: 0`.
 * With no end there was no window to fall back to either.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/defaultAssignee', () => ({ resolveDefaultAssignee: vi.fn().mockResolvedValue(null) }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { kinCareLengthForVisit } from '../src/lib/serviceDisplayName';
import { storedVisitEndIso } from '../src/admin/approveBookingSeriesCore';

const MIN = 60_000;
const SETTINGS = {
  timeZone: 'America/Chicago',
  serviceRates: { '30MinuteQuickCheck': '25', '45MinuteCuddles': '35', Overnight: '90' },
  serviceDurations: { '45MinuteCuddles': '45', Overnight: '720' },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});
afterEach(() => {
  vi.useRealTimers();
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('kinCareLengthForVisit', () => {
  it('finds the length by the KinCare name when the visit has no id', () => {
    expect(kinCareLengthForVisit(null, '30 Minute Quick Check', SETTINGS)).toBe(30);
  });
  it('uses the length the operator typed for the named KinCare', () => {
    expect(kinCareLengthForVisit(null, '45 Minute Cuddles', SETTINGS)).toBe(45);
    expect(kinCareLengthForVisit(null, 'Overnight', SETTINGS)).toBe(720);
  });
  it('still prefers the id when one is stored', () => {
    expect(kinCareLengthForVisit('Overnight', '30 Minute Quick Check', SETTINGS)).toBe(720);
  });
  it('falls back to the length a name states when the catalog does not have it', () => {
    expect(kinCareLengthForVisit(null, '60 Minute Walk', SETTINGS)).toBe(60);
  });
  it('gives no answer for a name with no length anywhere', () => {
    expect(kinCareLengthForVisit(null, 'Meet and greet', SETTINGS)).toBeNull();
    expect(kinCareLengthForVisit(null, '', SETTINGS)).toBeNull();
    expect(kinCareLengthForVisit(undefined, undefined, undefined)).toBeNull();
  });
  it('refuses to guess between two KinCares that match one name and differ in length', () => {
    const settings = {
      serviceRates: { '30Minute': '20', '30 Minute': '22' },
      serviceDurations: { '30Minute': '30', '30 Minute': '40' },
    };
    expect(kinCareLengthForVisit(null, '30minute', settings)).toBeNull();
  });
});

describe('storedVisitEndIso (#1866)', () => {
  const read = async () => SETTINGS as Record<string, unknown>;
  it('works out the end from the KinCare name on a visit with no id and no end', async () => {
    const end = await storedVisitEndIso(
      '2026-11-12T15:00:00.000Z',
      { serviceName: '30 Minute Quick Check', serviceId: null, endTime: null },
      read,
    );
    expect(end).toBe('2026-11-12T15:30:00.000Z');
  });
  it('keeps a stored end', async () => {
    const end = await storedVisitEndIso(
      '2026-11-12T15:00:00.000Z',
      { serviceName: '30 Minute Quick Check', endTime: '2026-11-12T15:20:00.000Z' },
      read,
    );
    expect(end).toBe('2026-11-12T15:20:00.000Z');
  });
  it('leaves the end blank when nothing names a length, and never reads settings for a nameless visit', async () => {
    const reader = vi.fn(read);
    expect(await storedVisitEndIso('2026-11-12T15:00:00.000Z', {}, reader)).toBe('');
    expect(reader).not.toHaveBeenCalled();
    expect(await storedVisitEndIso('2026-11-12T15:00:00.000Z', { serviceName: 'Meet and greet' }, read)).toBe('');
  });
});

describe('createMultiDateBookingRequest stores each visit’s end (#1866)', () => {
  function seed(settings: Record<string, unknown> | null = SETTINGS) {
    return buildDbMock({
      docs: {
        'kinfolk/kf1': { firstName: 'Jamie', lastName: 'Wren' },
        ...(settings ? { 'business_settings/business_settings': settings } : {}),
      },
    });
  }
  function visitWrites(ctx: ReturnType<typeof seed>) {
    return ctx.writes.filter((w) => w.path.includes('/kinCares/'));
  }
  function endMs(v: { data: Record<string, any> }): number | null {
    const e = v.data.endTime;
    return e && typeof e.toMillis === 'function' ? e.toMillis() : null;
  }

  it('gives a wizard visit (name only, no id, no end) the KinCare’s length', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createMultiDateBookingRequestHandler } = await import('../src/admin/createMultiDateBookingRequest');
    // 09:00 Chicago on Nov 12, the walk's booking.
    const start = Date.parse('2026-11-12T15:00:00.000Z');
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        idempotencyKey: 'req_1762900000001_a',
        visits: [{ startTimeMs: start, endTimeMs: null, serviceName: '30 Minute Quick Check', serviceId: null, priceCents: null }],
      }),
    );
    const [v] = visitWrites(ctx);
    expect(endMs(v!)).toBe(start + 30 * MIN);
  });

  it('uses the typed length of a KinCare, and an evening visit keeps its own end', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createMultiDateBookingRequestHandler } = await import('../src/admin/createMultiDateBookingRequest');
    // 22:45 Chicago on Nov 12 is 04:45 UTC on Nov 13.
    const start = Date.parse('2026-11-13T04:45:00.000Z');
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        idempotencyKey: 'req_1762900000002_b',
        visits: [{ startTimeMs: start, endTimeMs: null, serviceName: '45 Minute Cuddles', serviceId: null, priceCents: null }],
      }),
    );
    expect(endMs(visitWrites(ctx)[0]!)).toBe(start + 45 * MIN);
  });

  it('keeps an end the admin sent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createMultiDateBookingRequestHandler } = await import('../src/admin/createMultiDateBookingRequest');
    const start = Date.parse('2026-11-12T15:00:00.000Z');
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        idempotencyKey: 'req_1762900000003_c',
        visits: [{ startTimeMs: start, endTimeMs: start + 20 * MIN, serviceName: '30 Minute Quick Check', serviceId: null, priceCents: null }],
      }),
    );
    expect(endMs(visitWrites(ctx)[0]!)).toBe(start + 20 * MIN);
  });

  it('stores no end for a KinCare nothing gives a length, as before', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createMultiDateBookingRequestHandler } = await import('../src/admin/createMultiDateBookingRequest');
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        idempotencyKey: 'req_1762900000004_d',
        visits: [{ startTimeMs: Date.parse('2026-11-12T15:00:00.000Z'), serviceName: 'Meet and greet' }],
      }),
    );
    expect(visitWrites(ctx)[0]!.data.endTime).toBeNull();
  });
});

describe('approveBookingSeriesCore books a wizard visit with its length (#1866)', () => {
  it('a visit stored with a name, no id and no end becomes a 30-minute session', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/kf1/bookings/b1': { kinfolkName: 'The Wrens' },
        'business_settings/business_settings': SETTINGS,
      },
      queryDocs: {
        'families/kf1/bookings/b1/kinCares': [
          {
            id: 'v1',
            data: {
              startTime: '2026-11-12T15:00:00.000Z',
              endTime: null,
              serviceId: null,
              serviceName: '30 Minute Quick Check',
              kinIds: ['k1'],
              kinNames: ['Fido'],
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    await approveBookingSeriesCore({ kinfolkId: 'kf1', batchId: 'b1', actorUid: 'admin1', actorRole: 'AUNTIE' });
    const s = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(s?.data.endTime).toBe('2026-11-12T15:30:00.000Z');
    expect(s?.data.serviceDurationMinutes).toBe(30);
  });
});
