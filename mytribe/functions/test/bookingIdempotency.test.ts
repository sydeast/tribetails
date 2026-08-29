import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #644: the retry #630 wants is only safe if a second attempt at one submission
 * cannot write a second booking.
 *
 * The assertion that matters in almost every test here is a COUNT OF WRITES,
 * not the returned batchId. Two attempts have always agreed on the id once the
 * client supplies it; what used to differ is that the second one wrote another
 * envelope and another full set of visit documents underneath it. So these
 * tests assert what was actually persisted, and only then that the reply the
 * caller sees is the first attempt's reply.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), approveFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/defaultAssignee', () => ({ resolveDefaultAssignee: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/admin/approveBookingSeriesCore', () => ({ approveBookingSeriesCore: mocks.approveFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createMultiDateBookingRequestHandler } from '../src/admin/createMultiDateBookingRequest';
import { requestBookingHandler, writeEnvelope } from '../src/portal/requestBooking';

const DAY = 24 * 60 * 60 * 1000;
const KEY = 'req_1756400000000_a1b2c3';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
  mocks.approveFn.mockReset();
  mocks.approveFn.mockResolvedValue({ sessionsCreated: 1, failedVisits: [] });
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Base fixture: a household that exists and one catalog service. */
function baseDocs(): Record<string, Record<string, unknown> | null> {
  return {
    'kinfolk/kf1': { firstName: 'Jamie', lastName: 'Halbrook' },
    'base_services/svc_walk': { name: 'Dog Walk', priceCents: 2500 },
  };
}

/** The envelope a first attempt would have left behind, keyed on KEY. */
function storedEnvelope(uid: string, visitIds: string[]) {
  return {
    [`families/kf1/bookings/${KEY}`]: {
      familyId: 'kf1',
      requestBatchId: KEY,
      requestedByUid: uid,
      envelopeStatus: 'requested',
      visitIds,
      visitCount: visitIds.length,
    },
  };
}

function envelopeWrites(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w) => /^families\/kf1\/bookings\/[^/]+$/.test(w.path));
}
function visitWrites(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w) => w.path.includes('/kinCares/'));
}

function visits(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    startTimeMs: Date.now() + (i + 1) * DAY,
    serviceName: 'Dog Walk',
    serviceId: 'svc_walk',
  }));
}

describe('#644 createMultiDateBookingRequest — a retry with the same key writes nothing', () => {
  it('replays the stored envelope instead of booking a second time', async () => {
    // The state a dropped-reply retry actually meets: the first attempt's
    // envelope is committed, and the caller never saw the answer.
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('admin1', ['v1', 'v2']) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', idempotencyKey: KEY, visits: visits(2) }),
    );

    // The bug this exists to prevent, asserted as the count of documents:
    expect(envelopeWrites(ctx)).toHaveLength(0);
    expect(visitWrites(ctx)).toHaveLength(0);
    // ...and the caller still gets the first attempt's answer, ids included.
    expect(res).toEqual({ batchId: KEY, visitIds: ['v1', 'v2'], visitCount: 2 });
  });

  it('writes no second audit row for the replayed request', async () => {
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('admin1', ['v1']) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', idempotencyKey: KEY, visits: visits(1) }),
    );
    // A second BOOKING_SUBMITTED for one booking is a duplicate in the audit
    // log the operator reads, even though it costs no booking document.
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('replays even when the visit has since slipped into the past-start grace', async () => {
    // The operator's OWN retry, a minute after a visible error. Re-running the
    // guards would refuse this with `invalid-argument` for a booking that is
    // already stored and perfectly fine.
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('admin1', ['v1']) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createMultiDateBookingRequestHandler(
      req({
        kinfolkId: 'kf1',
        idempotencyKey: KEY,
        visits: [{ startTimeMs: Date.now() - 10 * 60_000, serviceName: 'Dog Walk', serviceId: 'svc_walk' }],
      }),
    );
    expect(res.batchId).toBe(KEY);
    expect(visitWrites(ctx)).toHaveLength(0);
  });

  it('recovers the visit ids by scan when the envelope predates the denormalized field', async () => {
    const docs = { ...baseDocs(), ...storedEnvelope('admin1', []) };
    delete (docs[`families/kf1/bookings/${KEY}`] as Record<string, unknown>)['visitIds'];
    const ctx = buildDbMock({
      docs,
      queryDocs: {
        [`families/kf1/bookings/${KEY}/kinCares`]: [
          { id: 'old1', data: { status: 'requested' } },
          { id: 'old2', data: { status: 'requested' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', idempotencyKey: KEY, visits: visits(2) }),
    );
    expect(res.visitIds).toEqual(['old1', 'old2']);
    expect(visitWrites(ctx)).toHaveLength(0);
  });

  it('refuses a key that belongs to a different caller rather than handing back their envelope', async () => {
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('someone-else', ['v1']) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createMultiDateBookingRequestHandler(req({ kinfolkId: 'kf1', idempotencyKey: KEY, visits: visits(1) })),
    ).rejects.toMatchObject({ code: 'already-exists' });
    expect(envelopeWrites(ctx)).toHaveLength(0);
  });

  it('uses the key as the envelope id on the FIRST attempt', async () => {
    const ctx = buildDbMock({ docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createMultiDateBookingRequestHandler(
      req({ kinfolkId: 'kf1', idempotencyKey: KEY, visits: visits(2) }),
    );
    expect(res.batchId).toBe(KEY);
    expect(envelopeWrites(ctx)).toHaveLength(1);
    expect(envelopeWrites(ctx)[0]?.path).toBe(`families/kf1/bookings/${KEY}`);
    // The ids the replay above will hand back are stored on the envelope, not
    // left to be re-derived from a subcollection scan.
    expect(envelopeWrites(ctx)[0]?.data['visitIds']).toEqual(res.visitIds);
    expect(visitWrites(ctx)).toHaveLength(2);
  });

  it('refuses a key that is not the id shape the server mints', async () => {
    const ctx = buildDbMock({ docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);
    // A bare uuid would become a Firestore document id in a format nothing
    // downstream has ever seen. The key is a retry token, not a free-form field.
    await expect(
      createMultiDateBookingRequestHandler(
        req({ kinfolkId: 'kf1', idempotencyKey: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', visits: visits(1) }),
      ),
    ).rejects.toThrow();
    expect(envelopeWrites(ctx)).toHaveLength(0);
  });

  it('leaves a keyless request exactly as it was: server-minted id, no dedupe', async () => {
    const ctx = buildDbMock({ docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const first = await createMultiDateBookingRequestHandler(req({ kinfolkId: 'kf1', visits: visits(1) }));
    const second = await createMultiDateBookingRequestHandler(req({ kinfolkId: 'kf1', visits: visits(1) }));
    expect(first.batchId).not.toBe(second.batchId);
    expect(first.batchId).toMatch(/^req_\d+_[a-z0-9]+$/);
    // Two envelopes, which is the pre-#644 behaviour and still the honest
    // outcome for a client that has not adopted the key.
    expect(envelopeWrites(ctx)).toHaveLength(2);
  });
});

describe('#644 writeEnvelope — the in-transaction guard', () => {
  /**
   * The handler fast path cannot catch two attempts that are in flight at once:
   * the loser reads "absent" before the winner commits. This guard is what
   * makes that race safe, so it is tested against `writeEnvelope` directly
   * rather than through a handler whose fast path would answer first.
   */
  const envelopeOpts = {
    kinfolkId: 'kf1',
    uid: 'admin1',
    batchId: KEY,
    pattern: 'individual' as const,
    weeklyDays: null,
    kinIds: [],
    notes: null,
    visits: [
      {
        startTimeMs: Date.now() + DAY,
        endTimeMs: null,
        serviceId: 'svc_walk',
        serviceName: 'Dog Walk',
        priceCents: 2500,
        title: 'Dog Walk',
      },
    ],
    assignee: null,
  };

  it('writes nothing and reports deduped when the envelope is already there', async () => {
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('admin1', ['v1']) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await writeEnvelope(envelopeOpts);
    expect(res).toEqual({ batchId: KEY, visitIds: ['v1'], deduped: true });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses to overwrite an envelope another caller owns', async () => {
    const ctx = buildDbMock({ docs: { ...baseDocs(), ...storedEnvelope('someone-else', ['v1']) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(writeEnvelope(envelopeOpts)).rejects.toMatchObject({ code: 'already-exists' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('writes normally when nothing is stored under that id', async () => {
    const ctx = buildDbMock({ docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await writeEnvelope(envelopeOpts);
    expect(res.deduped).toBe(false);
    expect(res.visitIds).toHaveLength(1);
    expect(ctx.writes).toHaveLength(2);
  });
});

describe('#644 requestBooking — the portal path, where a duplicate can auto-confirm itself', () => {
  /**
   * The portal is the worse half of #630's problem. Where the operator has
   * `autoConfirmRepeatKinfolk` on, a duplicated request does not merely sit in
   * the Incoming queue looking odd: it is approved on arrival, so the household
   * gets a second set of CONFIRMED sessions and the Aunties get a second set of
   * visits on the calendar.
   */
  function portalDocs(extra: Record<string, Record<string, unknown> | null> = {}) {
    return {
      'clients/u1': { kinfolkIds: ['kf1'] },
      'base_services/svc_walk': { name: 'Dog Walk', priceCents: 2500 },
      'business_settings/business_settings': { autoConfirmRepeatKinfolk: true },
      ...extra,
    };
  }

  function portalVisit() {
    return { startTimeMs: Date.now() + DAY, serviceId: 'svc_walk', serviceName: 'Dog Walk' };
  }

  it('replays the stored envelope without approving anything a second time', async () => {
    const ctx = buildDbMock({
      docs: {
        ...portalDocs(),
        [`families/kf1/bookings/${KEY}`]: {
          familyId: 'kf1',
          requestBatchId: KEY,
          requestedByUid: 'u1',
          envelopeStatus: 'confirmed',
          visitIds: ['v1'],
        },
      },
      queryDocs: {
        // A repeat household: an older envelope exists, so auto-confirm would
        // fire if this request were treated as new.
        'families/kf1/bookings': [{ id: 'req_old', data: { envelopeStatus: 'completed' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res: any = await requestBookingHandler({
      data: { kinfolkId: 'kf1', idempotencyKey: KEY, visits: [portalVisit()] },
      auth: { uid: 'u1' },
    } as any);

    expect(res).toEqual({ batchId: KEY, bookingIds: [KEY], bookingId: KEY });
    expect(ctx.writes).toHaveLength(0);
    // The one that matters: no second approve pass, so no second set of
    // confirmed sessions.
    expect(mocks.approveFn).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('still writes, audits and auto-confirms the FIRST attempt at that key', async () => {
    const ctx = buildDbMock({
      docs: portalDocs(),
      queryDocs: {
        'families/kf1/bookings': [{ id: 'req_old', data: { envelopeStatus: 'completed' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res: any = await requestBookingHandler({
      data: { kinfolkId: 'kf1', idempotencyKey: KEY, visits: [portalVisit()] },
      auth: { uid: 'u1' },
    } as any);

    expect(res.batchId).toBe(KEY);
    expect(ctx.writes.filter((w) => w.path === `families/kf1/bookings/${KEY}`)).toHaveLength(1);
    expect(mocks.approveFn).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a key belonging to another household member', async () => {
    const ctx = buildDbMock({
      docs: {
        ...portalDocs(),
        [`families/kf1/bookings/${KEY}`]: { requestedByUid: 'someone-else', visitIds: ['v1'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      requestBookingHandler({
        data: { kinfolkId: 'kf1', idempotencyKey: KEY, visits: [portalVisit()] },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'already-exists' });
  });
});
