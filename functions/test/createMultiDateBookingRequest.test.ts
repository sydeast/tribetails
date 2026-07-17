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
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed() {
  return buildDbMock({
    docs: {
      'kinfolk/kf1': { firstName: 'Jamie', lastName: 'Halbrook' },
      'base_services/svc_walk': { name: 'Dog Walk', priceCents: 2500 },
    },
  });
}

/** The single parent envelope write (not a kinCares child). */
function envelope(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find(
    (w) => /^families\/kf1\/bookings\/[^/]+$/.test(w.path),
  );
}
function visitWrites(ctx: ReturnType<typeof seed>) {
  return ctx.writes.filter((w) => w.path.includes('/kinCares/'));
}

describe('createMultiDateBookingRequest happy path', () => {
  it('writes one envelope + one kinCares per non-consecutive visit', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const t1 = Date.now() + 3 * DAY;
    const t2 = Date.now() + 10 * DAY; // non-consecutive
    const res = await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [
          { startTimeMs: t1, serviceName: 'Dog Walk', serviceId: 'svc_walk' },
          { startTimeMs: t2, serviceName: 'Dog Walk', serviceId: 'svc_walk' },
        ],
      }),
    );
    expect(res.visitCount).toBe(2);
    expect(res.visitIds).toHaveLength(2);
    const env = envelope(ctx);
    expect(env?.data.envelopeStatus).toBe('requested');
    expect(env?.data.visitCount).toBe(2);
    expect(env?.data.pattern).toBe('individual');
    expect(visitWrites(ctx)).toHaveLength(2);
  });

  it('resolves price + name from the base_services catalog, never a client price', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        // A client-asserted priceCents:0 must be discarded for the catalog's 2500.
        visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'whatever', serviceId: 'svc_walk', priceCents: 0 }],
      }),
    );
    const v = visitWrites(ctx)[0];
    expect(v?.data.priceCents).toBe(2500);
    expect(v?.data.serviceName).toBe('Dog Walk');
  });

  it('stores the weekly recurrence metadata on the envelope', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        pattern: 'weekly',
        weeklyDays: [1, 3],
        visits: [
          { startTimeMs: Date.now() + DAY, serviceName: 'Walk' },
          { startTimeMs: Date.now() + 8 * DAY, serviceName: 'Walk' },
        ],
      }),
    );
    const env = envelope(ctx);
    expect(env?.data.pattern).toBe('weekly');
    expect(env?.data.weeklyDays).toEqual([1, 3]);
  });

  it('writes a BOOKING_SUBMITTED audit entry as the operator (AUNTIE)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }] }),
    );
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BOOKING_SUBMITTED', actorRole: 'AUNTIE', actorUid: 'admin1' }),
    );
  });
});

describe('createMultiDateBookingRequest validation + auth', () => {
  it('rejects a missing household (not-found)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({ kinfolkId: 'ghost', visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }] }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects a visit in the past (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({ kinfolkId: 'kf1', visits: [{ startTimeMs: Date.now() - DAY, serviceName: 'Walk' }] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects endTime <= startTime (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const t = Date.now() + DAY;
    await expect(
      createMultiDateBookingRequestHandler(
        req({ kinfolkId: 'kf1', visits: [{ startTimeMs: t, endTimeMs: t - 1, serviceName: 'Walk' }] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an empty visits array (zod)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(req({ kinfolkId: 'kf1', visits: [] })),
    ).rejects.toBeTruthy();
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({ kinfolkId: 'kf1', visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }] }, null),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
