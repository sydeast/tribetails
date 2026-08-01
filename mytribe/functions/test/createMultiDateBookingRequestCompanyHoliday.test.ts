import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/defaultAssignee', () => ({ resolveDefaultAssignee: vi.fn().mockResolvedValue(null) }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createMultiDateBookingRequestHandler } from '../src/admin/createMultiDateBookingRequest';

beforeEach(() => {
  mocks.dbFn.mockReset();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(companyHolidays: string[]) {
  return buildDbMock({
    docs: {
      'kinfolk/kf1': { firstName: 'Jamie', lastName: 'Halbrook' },
      'business_settings/business_settings': { companyHolidays },
    },
  });
}

/**
 * C1: the admin equivalent of requestBooking is refused the same way -- an
 * operator cannot create a booking request for a household on a closed day
 * either, and there is no `overrideCompanyHoliday`-style field to bypass it
 * with (unlike `overrideBusyConflict`, which this callable DOES accept).
 */
describe('createMultiDateBookingRequest company-holiday guard', () => {
  it('rejects a visit landing on a closed day, writes nothing', async () => {
    const ctx = seed(['2026-12-25|Christmas']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      createMultiDateBookingRequestHandler(
        req({
          kinfolkId: 'kf1',
          visits: [{ startTimeMs: Date.parse('2026-12-25T15:00:00.000Z'), serviceName: 'Walk' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(0);
  });

  it('an unrelated overrideBusyConflict:true does NOT bypass the holiday guard', async () => {
    const ctx = seed(['2026-12-25|Christmas']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      createMultiDateBookingRequestHandler(
        req({
          kinfolkId: 'kf1',
          visits: [{ startTimeMs: Date.parse('2026-12-25T15:00:00.000Z'), serviceName: 'Walk' }],
          overrideBusyConflict: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('an open day still creates the envelope', async () => {
    const ctx = seed(['2026-12-25|Christmas']);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [{ startTimeMs: Date.parse('2026-12-24T15:00:00.000Z'), serviceName: 'Walk' }],
      }),
    );
    expect(res.batchId).toBeTypeOf('string');
    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(1);
  });
});
