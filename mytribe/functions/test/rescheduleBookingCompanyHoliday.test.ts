import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

/**
 * C1: dragging (or bulk-moving) a visit onto a closed day is a fresh slot
 * request onto the NEW window, so it is guarded the same way a create is.
 */
describe('rescheduleBooking company-holiday guard', () => {
  it('rejects a reschedule onto a closed day and leaves the session unwritten', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': { startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T11:00:00Z' },
        'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      rescheduleBookingHandler(
        req({ sessionId: 's1', startTime: '2026-12-25T15:00:00.000Z', endTime: '2026-12-25T16:00:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/s1' && w.data.startTime === '2026-12-25T15:00:00.000Z')).toBeUndefined();
  });

  it('rescheduling onto an open day still succeeds', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': { startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T11:00:00Z' },
        'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({ sessionId: 's1', startTime: '2026-12-24T15:00:00.000Z', endTime: '2026-12-24T16:00:00.000Z' }),
    );
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
    expect(write?.data.startTime).toBe('2026-12-24T15:00:00.000Z');
  });

  it('still 404s for an unknown session, before any holiday check runs', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      rescheduleBookingHandler(req({ sessionId: 'nope', startTime: '2026-12-24T15:00:00.000Z', endTime: '2026-12-24T16:00:00.000Z' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
