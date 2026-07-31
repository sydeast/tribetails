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
/**
 * The 5-step wizard's additions. Every one is OPTIONAL, and the first test
 * below is the reason: the single-page dialog this wizard replaces is still
 * deployed in older bundles and sends none of them.
 */
describe('createMultiDateBookingRequest wizard fields (per-visit location, billing, communication)', () => {
  it('still accepts the frozen legacy payload, which carries none of the new fields', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }] }),
    );
    expect(res.visitCount).toBe(1);
    // Absent is persisted as a DECISION, not left undefined for a reader to
    // guess at: no billing stated, and both communication toggles off.
    const env = envelope(ctx);
    expect(env?.data.billing).toBeNull();
    expect(env?.data.communication).toEqual({ emailConfirmation: false, timeVisibility: false });
    expect(visitWrites(ctx)[0]?.data.location).toBeNull();
  });
  it('persists a per-visit location on the visit doc, not on the envelope', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [
          { startTimeMs: Date.now() + DAY, serviceName: 'Walk', location: 'Back gate' },
          { startTimeMs: Date.now() + 2 * DAY, serviceName: 'Walk', location: 'Boarding kennel' },
        ],
      }),
    );
    // Two places in one series is the case that would be lost by rolling this
    // up to the envelope, so it is the case the test pins.
    expect(visitWrites(ctx).map((w) => w.data.location)).toEqual(['Back gate', 'Boarding kennel']);
    expect(envelope(ctx)?.data).not.toHaveProperty('location');
  });
  it('trims a padded location rather than storing the operator\'s whitespace', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk', location: '  Back gate  ' }],
      }),
    );
    expect(visitWrites(ctx)[0]?.data.location).toBe('Back gate');
  });
  it('rejects a blank location instead of storing an empty label', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({
          kinfolkId: 'kf1',
          visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk', location: '   ' }],
        }),
      ),
    ).rejects.toBeTruthy();
  });
  it('accepts an explicit null location, the "no particular place" the wizard sends', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk', location: null }],
      }),
    );
    expect(visitWrites(ctx)[0]?.data.location).toBeNull();
  });
  it('persists the billing preference on the envelope', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        billing: { mode: 'new-invoice' },
        visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }],
      }),
    );
    expect(envelope(ctx)?.data.billing).toEqual({ mode: 'new-invoice' });
  });
  it('rejects a billing mode the enum does not name, rather than storing free text', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({
          kinfolkId: 'kf1',
          billing: { mode: 'bill-them-later' },
          visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }],
        }),
      ),
    ).rejects.toBeTruthy();
  });
  it('persists both communication toggles exactly as sent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        communication: { emailConfirmation: true, timeVisibility: true },
        visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }],
      }),
    );
    expect(envelope(ctx)?.data.communication).toEqual({
      emailConfirmation: true,
      timeVisibility: true,
    });
  });
  it('rejects a half-stated communication object rather than defaulting the missing half', async () => {
    // Silently defaulting `emailConfirmation` is how a household gets an email
    // nobody chose to send.
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      createMultiDateBookingRequestHandler(
        req({
          kinfolkId: 'kf1',
          communication: { timeVisibility: true },
          visits: [{ startTimeMs: Date.now() + DAY, serviceName: 'Walk' }],
        }),
      ),
    ).rejects.toBeTruthy();
  });
  it("still accepts ANDROID's exact payload, which the wizard has not reached yet", async () => {
    // BookingRepository.createMultiDateBookingRequest builds precisely these
    // keys (kinfolkId, pattern, notes, weeklyDays, kinIds, and per visit
    // startTimeMs/endTimeMs/serviceId/serviceName). Android ships the
    // single-page form against this callable, so this is the payload that must
    // keep parsing for the phone to keep working while its wizard is built.
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const t = Date.now() + DAY;
    const res = await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        pattern: 'weekly',
        notes: 'Gate code 1234',
        weeklyDays: [1, 3],
        kinIds: ['k1'],
        visits: [
          { startTimeMs: t, endTimeMs: t + 30 * 60_000, serviceName: 'Dog Walk', serviceId: 'svc_walk' },
        ],
      }),
    );
    expect(res.visitCount).toBe(1);
    const env = envelope(ctx);
    expect(env?.data.pattern).toBe('weekly');
    expect(env?.data.notes).toBe('Gate code 1234');
    expect(env?.data.kinIds).toEqual(['k1']);
  });
  it('carries a different service and time per visit, which the wizard now produces', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const t1 = Date.now() + DAY;
    const t2 = Date.now() + DAY + 4 * 60 * 60 * 1000; // same day, later
    await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        visits: [
          { startTimeMs: t1, serviceName: 'Dog Walk', serviceId: 'svc_walk' },
          { startTimeMs: t2, serviceName: 'Drop In' },
        ],
      }),
    );
    const visits = visitWrites(ctx);
    expect(visits).toHaveLength(2);
    // Two visits on one day, at two times, with two services: none of which the
    // single-page dialog could express (it sent one service and one time for
    // every date).
    expect(visits[0]?.data.serviceName).toBe('Dog Walk');
    expect(visits[1]?.data.serviceName).toBe('Drop In');
    expect(visits[0]?.data.priceCents).toBe(2500);
    expect(visits[1]?.data.priceCents).toBeNull();
  });
});
