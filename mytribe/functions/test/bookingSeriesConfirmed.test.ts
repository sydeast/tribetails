import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #536: approving a multi-visit booking request answers it ONCE, and the answer
 * names every day it covers.
 *
 * The defect: `onBookingsWrite` is registered per VISIT, so flipping four
 * children to `confirmed` dispatched `kincare.booking.confirm` four times to the
 * household and four more to every business admin, for what is one answer to one
 * question. Same shape as #532 on the request side and #533 on the decline side.
 *
 * The date rendering asserted here is the committed visit-date spec's: an
 * enumerated `visits` array, never a summarising span.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { approveBookingSeriesCore } from '../src/admin/approveBookingSeriesCore';
import { onBookingsWrite, seriesApproveStampChanged } from '../src/triggers/onBookingsWrite';

const PARENT = 'families/fam1/bookings/req_1';

// Noon Eastern on three consecutive days, so the rendered day never depends on
// which side of midnight UTC the fixture lands.
const SEP4 = '2026-09-04T16:00:00Z';
const SEP5 = '2026-09-05T16:00:00Z';
const SEP6 = '2026-09-06T16:00:00Z';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
});

/**
 * A three-visit request, plus a LIVE envelope document.
 *
 * `buildDbMock` records writes without applying them, which would make a
 * double-approve unobservable: the claim this feature turns on is a write the
 * SECOND call has to be able to read. So writes to the envelope are merged back
 * into the fixture here. Doc refs are memoised by path inside the mock, so the
 * patched ref is the same object `approveBookingSeriesCore` gets.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function threeVisitEnvelope(overrides: Record<string, unknown> = {}) {
  const envelope: Record<string, unknown> = {
    envelopeStatus: 'requested',
    kinfolkName: 'The Rivera Home',
    serviceName: 'Dog Walk',
    visitCount: 3,
    ...overrides,
  };
  const ctx = buildDbMock({
    docs: {
      [PARENT]: envelope,
      'business_settings/business_settings': { timeZone: 'America/New_York' },
    },
    queryDocs: {
      [`${PARENT}/kinCares`]: [
        { id: 'v1', data: { status: 'requested', startTime: SEP4, endTime: '2026-09-04T17:00:00Z', serviceType: 'Dog Walk', kinIds: ['k1'] } },
        { id: 'v2', data: { status: 'requested', startTime: SEP5, endTime: '2026-09-05T17:00:00Z', serviceType: 'Dog Walk', kinIds: ['k1'] } },
        { id: 'v3', data: { status: 'requested', startTime: SEP6, endTime: '2026-09-06T17:00:00Z', serviceType: 'Dog Walk', kinIds: ['k1'] } },
      ],
    },
  });

  const parentRef: any = ctx.db.doc(PARENT);
  const originalSet = parentRef.set;
  parentRef.set = vi.fn(async (data: Record<string, unknown>, options?: unknown) => {
    Object.assign(envelope, data);
    return originalSet(data, options);
  });

  return ctx;
}

function wrapThrowingSet(db: Record<string, any>, targetPaths: string[]): Record<string, any> {
  function wrapRef(ref: any): any {
    if (targetPaths.includes(ref.path)) {
      return { ...ref, set: vi.fn(async () => { throw new Error('simulated write failure'); }) };
    }
    return { ...ref, collection: (sub: string) => wrapCollection(ref.collection(sub)) };
  }
  function wrapCollection(col: any): any {
    return { ...col, doc: (id?: string) => wrapRef(col.doc(id)) };
  }
  return {
    ...db,
    collection: (path: string) => wrapCollection(db.collection(path)),
    doc: (path: string) => wrapRef(db.doc(path)),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const approve = () =>
  approveBookingSeriesCore({ kinfolkId: 'fam1', batchId: 'req_1', actorUid: 'admin1', actorRole: 'AUNTIE' });

describe('approveBookingSeriesCore: one confirmation per REQUEST (#536)', () => {
  it('a 3-visit approval sends exactly ONE confirmation, naming all three days', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await approve();

    expect(res.affectedVisits).toBe(3);
    expect(res.failedVisits).toBe(0);

    // ONE. Not one per visit, which is the whole issue.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.key).toBe('kincare.booking.confirm');
    // The envelope, not a visit: the household is being answered about their
    // request, and manageBookingSeries rules on a batchId.
    expect(arg.targetId).toBe('req_1');
    expect(arg.data.bookingId).toBe('req_1');
    expect(arg.data.batchId).toBe('req_1');

    // Enumerated, never summarised. Operator ruling 2026-08-23.
    expect(arg.data.visitCount).toBe(3);
    expect(arg.data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 5', 'Sep 6']);
    expect(arg.data.visits.map((v: { weekday: string }) => v.weekday)).toEqual(['Fri', 'Sat', 'Sun']);
    expect(arg.data.visits.map((v: { dateIso: string }) => v.dateIso)).toEqual([
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
    expect(arg.data.visits.map((v: { visitId: string }) => v.visitId)).toEqual(['v1', 'v2', 'v3']);
    // Every visit carries its own time, in the business timezone.
    expect(arg.data.visits[0].time).toBe('12:00 PM');

    // SMS and push cannot enumerate, so they get the count and the next day.
    expect(arg.data.nextVisit).toEqual({ weekday: 'Fri', date: 'Sep 4', time: '12:00 PM' });
    expect(arg.data.portalUrl).toBe('https://kinfolk.tribetails.com');

    // No summarising span reaches the template. That token belongs to the
    // wording this replaces.
    expect(arg.data.bookingDates).toBeUndefined();
  });

  it('reports back what the household actually heard, for the admin surfaces', async () => {
    // Both admin clients word their toast off these two rather than assuming a
    // clean result means a clean message.
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await approve();

    expect(res.newlyConfirmed).toBe(3);
    expect(res.householdNotified).toBe(true);
  });

  it('reports householdNotified=false when the dispatch throws, so the operator can phone them', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValue(new Error('dispatch exploded'));

    const res = await approve();

    expect(res.envelopeStatus).toBe('confirmed');
    expect(res.newlyConfirmed).toBe(3);
    expect(res.householdNotified).toBe(false);
  });

  it('reports newlyConfirmed=0 when every visit was already confirmed', async () => {
    const ctx = buildDbMock({
      docs: {
        [PARENT]: { envelopeStatus: 'confirmed', serviceName: 'Dog Walk' },
        'business_settings/business_settings': { timeZone: 'America/New_York' },
      },
      queryDocs: {
        [`${PARENT}/kinCares`]: [
          { id: 'v1', data: { status: 'confirmed', startTime: SEP4, endTime: '2026-09-04T17:00:00Z', kinIds: [] } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await approve();

    expect(res.newlyConfirmed).toBe(0);
    expect(res.householdNotified).toBe(false);
  });

  it('carries bookingDate/bookingTime so the not-yet-reimported template still renders', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const { data } = mocks.enqueue.mock.calls[0]![0];
    expect(data.bookingDate).toBe('Fri, Sep 4');
    expect(data.bookingTime).toBe('12:00 PM');
  });

  it('stamps every visit it approved, so the per-visit trigger knows to stay quiet', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const visitWrites = ctx.writes.filter((w) => w.path.includes('/kinCares/'));
    expect(visitWrites).toHaveLength(3);
    for (const w of visitWrites) {
      expect(w.data.status).toBe('confirmed');
      expect(w.data.seriesApprovedAt).toBe('__TS__');
    }
  });

  it('claims the notification transactionally, so a double-click sends one message', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    // The claim is a transaction on the ENVELOPE. Firestore serialises those on
    // one document, so two concurrent approvals contend and exactly one wins.
    expect(ctx.db.runTransaction).toHaveBeenCalled();
    const claim = ctx.writes.filter((w) => w.path === PARENT && 'confirmNotifiedAtMs' in w.data);
    expect(claim).toHaveLength(1);

    // The second click. Everything is re-run idempotently (the deterministic
    // vis_{visitId} session id makes that safe) and NOTHING is sent again.
    await approve();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('the claim alone stops the second sender, with no help from the envelope status', async () => {
    // The genuine race, isolated. Two approvals in flight both read the envelope
    // as `requested`, so `wasAlreadyConfirmed` lets both through and the claim is
    // the only thing standing between the household and two identical messages.
    // This fixture is the loser's view of the world: still `requested`, already
    // claimed.
    const ctx = threeVisitEnvelope({ confirmNotifiedAtMs: 1_756_000_000_000 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await approve();

    expect(res.envelopeStatus).toBe('confirmed');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // And it did not steal the claim from the winner either.
    expect(ctx.writes.filter((w) => w.path === PARENT && 'confirmNotifiedAtMs' in w.data)).toHaveLength(0);
  });

  it('re-approving an envelope that was already confirmed sends nothing', async () => {
    // Covers envelopes confirmed BEFORE this shipped, which carry no claim field
    // at all. Nothing changed for the household, so there is nothing to say.
    const ctx = threeVisitEnvelope({ envelopeStatus: 'confirmed' });
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a PARTIAL failure sends nothing, and the retry that succeeds sends one', async () => {
    // The envelope is deliberately left `requested` on a partial failure so the
    // operator retries. Without the gate the retry is a second "your visits are
    // confirmed" for one request, which is #532's defect on the approve path.
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(wrapThrowingSet(ctx.db, [`${PARENT}/kinCares/v3`]));

    const failed = await approve();
    expect(failed.failedVisits).toBe(1);
    expect(failed.envelopeStatus).toBe('requested');
    expect(mocks.enqueue).not.toHaveBeenCalled();

    // The retry goes through cleanly, and THAT is the one that tells them.
    mocks.dbFn.mockReturnValue(ctx.db);
    await approve();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].key).toBe('kincare.booking.confirm');
  });

  it('a failed dispatch never rolls back the approval', async () => {
    const ctx = threeVisitEnvelope();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValue(new Error('dispatch exploded'));

    const res = await approve();

    expect(res.failedVisits).toBe(0);
    expect(res.envelopeStatus).toBe('confirmed');
    expect(res.sessionsCreated).toBe(3);
  });

  it('does not name a visit that was cancelled before the approval landed', async () => {
    // The reason `loadEnvelopeVisits` re-reads instead of reusing a list captured
    // when the booking was made: a stored list is stale the moment a visit goes.
    const ctx = buildDbMock({
      docs: {
        [PARENT]: { envelopeStatus: 'requested', serviceName: 'Dog Walk' },
        'business_settings/business_settings': { timeZone: 'America/New_York' },
      },
      queryDocs: {
        [`${PARENT}/kinCares`]: [
          { id: 'v1', data: { status: 'requested', startTime: SEP4, endTime: '2026-09-04T17:00:00Z', kinIds: [] } },
          { id: 'v2', data: { status: 'cancelled', startTime: SEP5, endTime: '2026-09-05T17:00:00Z', kinIds: [] } },
          { id: 'v3', data: { status: 'requested', startTime: SEP6, endTime: '2026-09-06T17:00:00Z', kinIds: [] } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const { data } = mocks.enqueue.mock.calls[0]![0];
    expect(data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 6']);
    expect(data.visitCount).toBe(2);
  });
});

describe('seriesApproveStampChanged: the stamp, not the transition', () => {
  it('true when the stamp arrives', () => {
    expect(seriesApproveStampChanged({ status: 'requested' }, { status: 'confirmed', seriesApprovedAt: '__TS__' })).toBe(true);
  });

  it('true when a later series approval moves it on', () => {
    // Cancel an approved series and approve it again: the stamp is already
    // there, so "does it exist" would answer this one wrong.
    expect(
      seriesApproveStampChanged(
        { status: 'cancelled', seriesApprovedAt: { toMillis: () => 1 } },
        { status: 'confirmed', seriesApprovedAt: { toMillis: () => 2 } },
      ),
    ).toBe(true);
  });

  it('false when the stamp is unchanged', () => {
    expect(
      seriesApproveStampChanged(
        { status: 'confirmed', seriesApprovedAt: { toMillis: () => 1 } },
        { status: 'confirmed', seriesApprovedAt: { toMillis: () => 1 } },
      ),
    ).toBe(false);
  });

  it('false when there is no stamp at all', () => {
    expect(seriesApproveStampChanged({ status: 'requested' }, { status: 'confirmed' })).toBe(false);
  });
});

describe('onBookingsWrite: the per-visit confirm after #536', () => {
  async function run(before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
    await onBookingsWrite.run({
      params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
      data: {
        before: { data: () => before, exists: before !== undefined },
        after: { data: () => after, exists: true },
      },
    } as never);
  }

  beforeEach(() => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'business_settings/business_settings': { timeZone: 'America/New_York' } } }).db,
    );
  });

  it('stays silent when the confirm carries the series-approval stamp', async () => {
    await run({ status: 'requested' }, { status: 'confirmed', seriesApprovedAt: '__TS__' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('STILL fires for a visit confirmed on its own (batchUpdateBookings, Android)', async () => {
    await run({ status: 'requested' }, { status: 'confirmed', startTime: { toMillis: () => Date.parse(SEP4) } });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.key).toBe('kincare.booking.confirm');
    // Same structured shape as the envelope-level copy, with one entry, so the
    // template that enumerates four days enumerates one day here.
    expect(arg.data.visitCount).toBe(1);
    expect(arg.data.visits).toEqual([
      { dateIso: '2026-09-04', weekday: 'Fri', date: 'Sep 4', time: '12:00 PM', visitId: 'v1' },
    ]);
    expect(arg.data.bookingDate).toBe('Fri, Sep 4');
    expect(arg.data.bookingTime).toBe('12:00 PM');
  });

  it('a visit with no readable start still sends, with an empty list rather than a wrong day', async () => {
    await run({ status: 'requested' }, { status: 'confirmed' });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.data.visits).toEqual([]);
    expect(arg.data.nextVisit).toBeNull();
    expect(arg.data.bookingDate).toBeNull();
  });
});
