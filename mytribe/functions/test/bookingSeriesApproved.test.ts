import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #536: approving a multi-visit booking request answers ONE request, so it owes
 * ONE confirmation. `onBookingsWrite` is registered per visit at
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, and
 * `approveBookingSeriesCore` flips every child to `confirmed`, so a four-day
 * request used to send:
 *
 *   - kincare.booking.confirm x4 to the household, and x4 to the office through
 *     its `secondaryResolver: 'businessAdmins'`
 *   - assignment.assigned x4 to the Auntie writeEnvelope defaulted every child
 *     to (that half fired at CREATE, before anyone had approved anything)
 *
 * Same defect #532 fixed on the request side and #533 on the decline side. Every
 * test below fails on the old behaviour.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  writeAuditEntryFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { approveBookingSeriesCore } from '../src/admin/approveBookingSeriesCore';
import { onBookingsWrite, approveStampedByThisWrite } from '../src/triggers/onBookingsWrite';

const PARENT = 'families/fam1/bookings/req_1';
/** Sep 4 to Sep 7 2026, one visit a day: the long weekend from the issue. */
const DAYS = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'];
const MS = DAYS.map((d) => Date.parse(`${d}T14:00:00Z`));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

/**
 * A four-visit `requested` envelope, every visit on the same default Auntie the
 * way `writeEnvelope` stamps them.
 */
function dbFor(
  opts: {
    status?: string;
    /** Per-visit status, for the retry fixture where some children committed. */
    statuses?: string[];
    auntieUids?: Array<string | null>;
  } = {},
) {
  const aunties = opts.auntieUids ?? DAYS.map(() => 'auntie-1');
  const statuses = opts.statuses ?? DAYS.map(() => opts.status ?? 'requested');
  return buildDbMock({
    docs: { [PARENT]: { kinfolkName: 'The Rivera Home', serviceName: 'Dog Walk', visitCount: 4 } },
    queryDocs: {
      [`${PARENT}/kinCares`]: DAYS.map((d, i) => ({
        id: `v${String(i + 1)}`,
        data: {
          status: statuses[i],
          startTime: `${d}T14:00:00Z`,
          endTime: `${d}T15:00:00Z`,
          kinIds: ['k1'],
          serviceType: 'Dog Walk',
          assignedAuntieUid: aunties[i],
        },
      })),
    },
  });
}

/**
 * Wraps a buildDbMock() db so a write to one of `targetPaths` throws,
 * simulating a per-visit failure inside the approve loop's try/catch. Lifted
 * from bookingRequestDeclined.test.ts: refs are created fresh on every
 * `.collection(x).doc(y)`, so this has to intercept at the factory level.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function withThrowingSet(db: Record<string, any>, targetPaths: string[]): Record<string, any> {
  function wrapRef(ref: any): any {
    if (targetPaths.includes(ref.path)) {
      return {
        ...ref,
        set: vi.fn(async () => {
          throw new Error('simulated write failure');
        }),
      };
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
  approveBookingSeriesCore({
    kinfolkId: 'fam1',
    batchId: 'req_1',
    actorUid: 'admin1',
    actorRole: 'AUNTIE',
  });

const keysOf = () => mocks.enqueue.mock.calls.map((c) => c[0].key as string);
const callFor = (key: string) => mocks.enqueue.mock.calls.find((c) => c[0].key === key)?.[0];

describe('approveBookingSeriesCore — one confirmation per envelope (#536)', () => {
  it('a FOUR-visit approval produces exactly one household confirmation and one Auntie summary', async () => {
    const ctx = dbFor();
    mocks.dbFn.mockReturnValue(ctx.db);

    const r = await approve();

    expect(r.failedVisits).toBe(0);
    expect(r.newlyConfirmed).toBe(4);
    // Four visits, two messages. Before this change it was eight.
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(keysOf().sort()).toEqual(['assignment.assigned', 'kincare.booking.confirm']);
  });

  it("the household's one message names the ENVELOPE and every date", async () => {
    mocks.dbFn.mockReturnValue(dbFor().db);
    await approve();

    const call = callFor('kincare.booking.confirm')!;
    // The envelope, not a visit: manageBookingSeries rules on a batchId, and
    // this message is the answer to the whole request.
    expect(call.data.bookingId).toBe('req_1');
    expect(call.targetId).toBe('req_1');
    expect(call.recipientUid).toBe('uid-kinfolk');
    expect(call.data.startTimeMsList).toEqual(MS);
    expect(call.data.visitCount).toBe(4);
    expect(call.data.serviceName).toBe('Dog Walk');
  });

  it("the Auntie's one summary carries her dates and names her, so the resolver can reach her", async () => {
    mocks.dbFn.mockReturnValue(dbFor().db);
    await approve();

    const call = callFor('assignment.assigned')!;
    expect(call.recipientUid).toBe('auntie-1');
    // `auntieAssignedToKincare` reads this off the dispatch data.
    expect(call.data.assignedAuntieUid).toBe('auntie-1');
    expect(call.data.startTimeMsList).toEqual(MS);
    expect(call.data.visitCount).toBe(4);
  });

  it('leaves the per-visit schedule records individual: four sessions, four confirmed visits', async () => {
    // Operator ruling 2026-08-23: the MESSAGE collapses, the schedule does not.
    // Each visit still lands separately on her schedule surface.
    const ctx = dbFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await approve();

    const sessions = ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'));
    expect(sessions.map((w) => w.path).sort()).toEqual([
      'kin_care_sessions/vis_v1',
      'kin_care_sessions/vis_v2',
      'kin_care_sessions/vis_v3',
      'kin_care_sessions/vis_v4',
    ]);
    const visitWrites = ctx.writes.filter((w) => w.path.includes('/kinCares/'));
    expect(visitWrites).toHaveLength(4);
    for (const w of visitWrites) expect(w.data.status).toBe('confirmed');
  });

  it('stamps requestApprovedAt on every visit it confirms, so the trigger can stay quiet', async () => {
    const ctx = dbFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await approve();

    const visitWrites = ctx.writes.filter((w) => w.path.includes('/kinCares/'));
    expect(visitWrites).toHaveLength(4);
    for (const w of visitWrites) expect(w.data.requestApprovedAt).toBe('__TS__');
  });

  it('two Aunties splitting one envelope each hear once, about their own dates', async () => {
    // admin/assignAuntie is per-visit, so a half-reassigned envelope really does
    // owe two people news. One message each, not one message total and not four.
    mocks.dbFn.mockReturnValue(
      dbFor({ auntieUids: ['auntie-1', 'auntie-1', 'auntie-2', 'auntie-2'] }).db,
    );
    await approve();

    const assignments = mocks.enqueue.mock.calls
      .map((c) => c[0])
      .filter((a) => a.key === 'assignment.assigned');
    expect(assignments).toHaveLength(2);
    const byUid = new Map(assignments.map((a) => [a.recipientUid as string, a]));
    expect(byUid.get('auntie-1')!.data.startTimeMsList).toEqual([MS[0], MS[1]]);
    expect(byUid.get('auntie-2')!.data.startTimeMsList).toEqual([MS[2], MS[3]]);
  });

  it('an UNASSIGNED envelope tells the household and nobody else', async () => {
    mocks.dbFn.mockReturnValue(dbFor({ auntieUids: [null, null, null, null] }).db);
    await approve();
    expect(keysOf()).toEqual(['kincare.booking.confirm']);
  });

  it('a PARTIAL failure sends nothing, so the retry does not confirm them twice', async () => {
    // The envelope deliberately stays `requested` after a partial failure so the
    // operator retries. Without the failedVisits gate the retry reads as a
    // second approval and the household hears the same yes twice: #532's defect
    // on the approve path, and #533's own reasoning on the deny path.
    const ctx = dbFor();
    mocks.dbFn.mockReturnValue(withThrowingSet(ctx.db, [`${PARENT}/kinCares/v3`]));

    const first = await approve();
    expect(first.failedVisits).toBe(1);
    expect(first.envelopeStatus).toBe('requested');
    expect(first.householdNotified).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    // The retry succeeds, and THAT is the one that tells them.
    //
    // THE FIXTURE MATTERS. The three visits that went through on the first
    // attempt COMMITTED, so the operator retries from an envelope that is three
    // `confirmed` and one `requested`. Only v3 is new on this pass, which is
    // what makes the whole booking, and not the delta, the right thing to name:
    // a household whose long weekend finally went through must not get a single
    // confirmation reading "Sep 6".
    mocks.dbFn.mockReturnValue(
      dbFor({ statuses: ['confirmed', 'confirmed', 'requested', 'confirmed'] }).db,
    );
    const retry = await approve();

    expect(retry.failedVisits).toBe(0);
    expect(retry.newlyConfirmed).toBe(1);
    expect(retry.householdNotified).toBe(true);
    expect(keysOf().filter((k) => k === 'kincare.booking.confirm')).toHaveLength(1);

    const call = callFor('kincare.booking.confirm')!;
    expect(call.data.startTimeMsList).toEqual(MS);
    expect(call.data.visitCount).toBe(4);
    // The Auntie's summary covers the whole booking she is about to work too.
    expect(callFor('assignment.assigned')!.data.startTimeMsList).toEqual(MS);
  });

  it('re-approving an ALREADY CONFIRMED envelope changes nothing and tells nobody', async () => {
    mocks.dbFn.mockReturnValue(dbFor({ status: 'confirmed' }).db);

    const r = await approve();

    expect(r.affectedVisits).toBe(4);
    expect(r.newlyConfirmed).toBe(0);
    expect(r.householdNotified).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('reports householdNotified=false when the dispatch itself fails', async () => {
    // The approval succeeded and is audited; the notification did not. An admin
    // toast that says "the household has been told" on the back of a swallowed
    // error is the claim this issue is about.
    mocks.dbFn.mockReturnValue(dbFor().db);
    mocks.enqueue.mockRejectedValue(new Error('no recipients resolved'));

    const r = await approve();

    expect(r.affectedVisits).toBe(4);
    expect(r.newlyConfirmed).toBe(4);
    expect(r.householdNotified).toBe(false);
  });
});

describe('onBookingsWrite — the envelope approval is not four visit confirmations (#536)', () => {
  async function run(
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ) {
    await onBookingsWrite.run({
      params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
      data: {
        before: { data: () => before, exists: before !== undefined },
        after: { data: () => after, exists: true },
      },
    } as never);
  }

  it('stays silent when the confirm carries the envelope-approval stamp', async () => {
    await run({ status: 'requested' }, { status: 'confirmed', requestApprovedAt: '__TS__' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('STILL fires booking.confirm on a stamp-less requested -> confirmed write', async () => {
    // The regression this stamp exists to prevent, and the answer to "does
    // `requested -> confirmed` have two meanings". It does:
    // `admin/batchUpdateBookings` APPROVE writes `status: 'confirmed'` straight
    // onto individual kinCares docs (the React admin's Bookings bulk bar and
    // Android's Notifications quick-approve) with no envelope dispatch behind
    // it. Gating on the bare transition would silence every one of those.
    await run({ status: 'requested' }, { status: 'confirmed', updatedBy: 'admin1' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].key).toBe('kincare.booking.confirm');
  });

  it('stays silent when a cancelled envelope is APPROVED AGAIN, carrying a fresh stamp', async () => {
    // `before` still holds the stamp from the FIRST approval, so a
    // presence test would read this as "already told" the wrong way round.
    // The value changed, which is what identifies a new envelope approval.
    await run(
      { status: 'cancelled', requestApprovedAt: { _seconds: 100, _nanoseconds: 0 } },
      { status: 'confirmed', requestApprovedAt: { _seconds: 900, _nanoseconds: 0 } },
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a visit CREATE dispatches nothing at all, default assignee included', async () => {
    // writeEnvelope stamps the SAME default assignee on every child, so this arm
    // handed the Auntie one "a visit is yours" per visit for a request nobody
    // had approved. Operator ruling 2026-08-23: one summary, at approval.
    await run(undefined, {
      status: 'requested',
      assignedAuntieUid: 'auntie-1',
      startTime: { toMillis: () => MS[0] },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a genuine single-visit assignment still reaches the Auntie', async () => {
    // admin/assignAuntie puts somebody on an EXISTING visit. That is real
    // per-visit news and is untouched by this change.
    await run(
      { status: 'confirmed', assignedAuntieUid: null },
      { status: 'confirmed', assignedAuntieUid: 'auntie-9' },
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].key).toBe('assignment.assigned');
  });
});

describe('approveStampedByThisWrite', () => {
  it('is false when there is no stamp at all', () => {
    expect(approveStampedByThisWrite({ status: 'requested' }, { status: 'confirmed' })).toBe(false);
  });

  it('is true when the stamp appears on this write', () => {
    expect(
      approveStampedByThisWrite({ status: 'requested' }, { requestApprovedAt: '__TS__' }),
    ).toBe(true);
  });

  it('is false when an unchanged stamp is carried through an unrelated edit', () => {
    // A later edit to an approved visit must not be mistaken for the approval.
    expect(
      approveStampedByThisWrite(
        { status: 'confirmed', requestApprovedAt: '__TS__' },
        { status: 'confirmed', requestApprovedAt: '__TS__', notes: 'gate code changed' },
      ),
    ).toBe(false);
  });

  it('is true when the stamp is rewritten with a new value', () => {
    expect(
      approveStampedByThisWrite(
        { requestApprovedAt: { _seconds: 1, _nanoseconds: 0 } },
        { requestApprovedAt: { _seconds: 2, _nanoseconds: 0 } },
      ),
    ).toBe(true);
  });
});
