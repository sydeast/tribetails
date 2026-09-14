import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #536, the assignment half: the Auntie hears about an approved request ONCE.
 *
 * The defect is #532's, one audience over. `writeEnvelope` stamps the SAME
 * default assignee on every child of a booking request, and `onBookingsWrite` is
 * registered per VISIT, so a four-day request put four "a visit is yours"
 * messages in her hands the moment it was SUBMITTED -- for work nobody had
 * approved yet, and which the household might never get.
 *
 * Two changes, asserted below:
 *
 *   1. `onBookingsWrite` returns on a request create BEFORE the assignment loop,
 *      not after it, so a create now genuinely dispatches nothing at all. That
 *      is what the #532 comment always claimed and, until this, was not true of.
 *   2. `approveBookingSeriesCore` dispatches ONE `assignment.assigned` per
 *      Auntie the approved envelope belongs to, naming HER days, when the work
 *      is real.
 *
 * Her per-visit SCHEDULE records are untouched throughout: every visit still
 * gets its own `kin_care_sessions/vis_{visitId}` doc, so every day still lands
 * separately on her schedule surface. Message noise went down; schedule fidelity
 * did not.
 *
 * Dates are enumerated, never summarised, per the operator ruling of 2026-08-23
 * recorded in the visit-date rendering spec. That spec listed the Auntie's
 * `assignment.*` copy as step 6, needing an operator answer first; the operator
 * gave it on 2026-08-29.
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
import { onBookingsWrite } from '../src/triggers/onBookingsWrite';

const PARENT = 'families/fam1/bookings/req_1';

// Noon Eastern, so the rendered day never depends on which side of midnight UTC
// the fixture lands.
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
 * A three-visit request with the given assignees, plus a LIVE envelope document.
 *
 * `buildDbMock` records writes without applying them, which would make the claim
 * unobservable: the thing that stops a double-approve is a write the SECOND call
 * has to be able to read. So envelope writes are merged back into the fixture.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function envelopeAssignedTo(
  assignees: Array<string | null>,
  overrides: Record<string, unknown> = {},
  statuses: string[] = ['requested', 'requested', 'requested'],
) {
  const envelope: Record<string, unknown> = {
    envelopeStatus: 'requested',
    kinfolkName: 'The Rivera Home',
    serviceName: 'Dog Walk',
    visitCount: 3,
    ...overrides,
  };
  const starts = [SEP4, SEP5, SEP6];
  const ends = ['2026-09-04T17:00:00Z', '2026-09-05T17:00:00Z', '2026-09-06T17:00:00Z'];
  const ctx = buildDbMock({
    docs: {
      [PARENT]: envelope,
      'business_settings/business_settings': { timeZone: 'America/New_York' },
    },
    queryDocs: {
      [`${PARENT}/kinCares`]: assignees.map((auntie, i) => ({
        id: `v${i + 1}`,
        data: {
          status: statuses[i],
          startTime: starts[i],
          endTime: ends[i],
          serviceType: 'Dog Walk',
          kinIds: ['k1'],
          ...(auntie ? { assignedAuntieUid: auntie } : {}),
        },
      })),
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

/** Every dispatch of `key`, in the order they were enqueued. */
function sent(key: string) {
  return mocks.enqueue.mock.calls
    .map((c) => c[0])
    .filter((a: { key: string }) => a.key === key);
}

describe('approveBookingSeriesCore: the Auntie hears once, about her own days (#536)', () => {
  it('one Auntie on a 3-visit request gets ONE message naming all three days', async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const hers = sent('assignment.assigned');
    expect(hers).toHaveLength(1);
    expect(hers[0].recipientUid).toBe('auntie-a');
    expect(hers[0].data.assignedAuntieUid).toBe('auntie-a');

    // The ENVELOPE, not a visit: this answers a whole request, so there is no
    // one visit it is about.
    expect(hers[0].targetId).toBe('req_1');
    expect(hers[0].data.bookingId).toBe('req_1');
    expect(hers[0].data.visitId).toBeUndefined();

    // Enumerated, never summarised.
    expect(hers[0].data.visitCount).toBe(3);
    expect(hers[0].data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 5', 'Sep 6']);
    expect(hers[0].data.nextVisit).toEqual({ weekday: 'Fri', date: 'Sep 4', time: '12:00 PM' });
    expect(hers[0].data.bookingDates).toBeUndefined();
  });

  it('sends her to AuntieOS, not to the kinfolk portal she has no account on', async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    expect(sent('assignment.assigned')[0].data.portalUrl).toBe('https://auntie.tribetails.com');
    // And the household still goes to theirs.
    expect(sent('kincare.booking.confirm')[0].data.portalUrl).toBe('https://kinfolk.tribetails.com');
  });

  it('the household hears once and the Auntie hears once, not four times between them', async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(sent('kincare.booking.confirm')).toHaveLength(1);
    expect(sent('assignment.assigned')).toHaveLength(1);
  });

  it("#832: her copy carries the same approval identity as the household's, so a re-approval reaches her too", async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const claim = ctx.writes.find((w) => w.path === PARENT && 'confirmNotifiedAtMs' in w.data);
    const expected = `booking:req_1:approve:${claim!.data.confirmNotifiedAtMs as number}`;
    expect(sent('kincare.booking.confirm')[0].dedupeKey).toBe(expected);
    expect(sent('assignment.assigned')[0].dedupeKey).toBe(expected);
  });

  it('two Aunties splitting one envelope each hear once, about their own dates', async () => {
    // `admin/assignAuntie` is per visit, so a half-reassigned envelope really
    // does owe two people two different lists.
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-b', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const hers = sent('assignment.assigned');
    expect(hers).toHaveLength(2);

    const a = hers.find((d: { recipientUid: string }) => d.recipientUid === 'auntie-a');
    const b = hers.find((d: { recipientUid: string }) => d.recipientUid === 'auntie-b');
    expect(a.data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 6']);
    expect(a.data.visitCount).toBe(2);
    expect(b.data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 5']);
    expect(b.data.visitCount).toBe(1);
    // Each is told about the day SHE starts, not the day the booking starts.
    expect(b.data.nextVisit).toEqual({ weekday: 'Sat', date: 'Sep 5', time: '12:00 PM' });
  });

  it('an UNASSIGNED envelope tells the household and nobody else', async () => {
    const ctx = envelopeAssignedTo([null, null, null]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    expect(sent('kincare.booking.confirm')).toHaveLength(1);
    expect(sent('assignment.assigned')).toHaveLength(0);
  });

  it('does not put a visit cancelled before the approval on her list', async () => {
    const ctx = envelopeAssignedTo(
      ['auntie-a', 'auntie-a', 'auntie-a'],
      {},
      ['requested', 'cancelled', 'requested'],
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const hers = sent('assignment.assigned');
    expect(hers).toHaveLength(1);
    expect(hers[0].data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 6']);
    // The same days the household was told about: one read, one answer.
    expect(sent('kincare.booking.confirm')[0].data.visits.map((v: { date: string }) => v.date)).toEqual([
      'Sep 4',
      'Sep 6',
    ]);
  });

  it('carries bookingDate/bookingTime so the not-yet-reimported template still renders', async () => {
    // Production still holds the single-visit Firestore template until the
    // operator re-imports `assignment.assigned`. Emitter-supplied values win in
    // enrichTemplateData, so the old wording names her first day rather than
    // rendering blanks in the gap between deploy and re-import.
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    const { data } = sent('assignment.assigned')[0];
    expect(data.bookingDate).toBe('Fri, Sep 4');
    expect(data.bookingTime).toBe('12:00 PM');
  });

  it('a double-clicked approve does not send her a second copy either', async () => {
    // Her dispatch rides the household's claim, which is a transaction on the
    // envelope. Firestore serialises those on one document.
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();
    expect(sent('assignment.assigned')).toHaveLength(1);

    await approve();
    expect(sent('assignment.assigned')).toHaveLength(1);
  });

  it('re-approving an already confirmed envelope tells her nothing', async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a'], { envelopeStatus: 'confirmed' });
    mocks.dbFn.mockReturnValue(ctx.db);

    await approve();

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a PARTIAL failure sends her nothing, so the retry is not a second message', async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(wrapThrowingSet(ctx.db, [`${PARENT}/kinCares/v3`]));

    const failed = await approve();
    expect(failed.failedVisits).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    // The retry tells her once, about the WHOLE booking she is about to work,
    // not just the one visit that had failed.
    mocks.dbFn.mockReturnValue(ctx.db);
    await approve();
    const hers = sent('assignment.assigned');
    expect(hers).toHaveLength(1);
    expect(hers[0].data.visits.map((v: { date: string }) => v.date)).toEqual(['Sep 4', 'Sep 5', 'Sep 6']);
  });

  it('a household dispatch that throws does not cost the Auntie her copy', async () => {
    // Her message is about her schedule, not about whether the household heard.
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-a', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockImplementation(async (arg: { key: string }) => {
      if (arg.key === 'kincare.booking.confirm') throw new Error('dispatch exploded');
    });

    const res = await approve();

    expect(res.householdNotified).toBe(false);
    expect(res.envelopeStatus).toBe('confirmed');
    expect(sent('assignment.assigned')).toHaveLength(1);
  });

  it("one Auntie's failed dispatch does not cost the other hers", async () => {
    const ctx = envelopeAssignedTo(['auntie-a', 'auntie-b', 'auntie-a']);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockImplementation(async (arg: { key: string; recipientUid: string }) => {
      if (arg.recipientUid === 'auntie-a') throw new Error('dispatch exploded');
    });

    const res = await approve();

    expect(res.householdNotified).toBe(true);
    expect(sent('assignment.assigned').map((d: { recipientUid: string }) => d.recipientUid)).toEqual([
      'auntie-a',
      'auntie-b',
    ]);
  });
});

describe('onBookingsWrite: a request create is not four assignments (#536)', () => {
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

  it('a visit CREATE dispatches nothing at all, the default assignee included', async () => {
    // The regression this closes: `writeEnvelope` stamps the same assignee on
    // every child, and the create-return used to sit BELOW the assignment loop,
    // so a four-day request sent her four messages before anyone approved it.
    await run(undefined, {
      status: 'requested',
      assignedAuntieUid: 'auntie-a',
      startTime: { toMillis: () => Date.parse(SEP4) },
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a genuine single-visit assignment still reaches the Auntie', async () => {
    // Somebody was put on ONE existing visit. That is one piece of news and it
    // is not this issue's fan-out, so it still sends from here.
    await run(
      { status: 'confirmed', startTime: { toMillis: () => Date.parse(SEP4) } },
      {
        status: 'confirmed',
        assignedAuntieUid: 'auntie-a',
        startTime: { toMillis: () => Date.parse(SEP4) },
      },
    );

    const hers = sent('assignment.assigned');
    expect(hers).toHaveLength(1);
    expect(hers[0].data.assignedAuntieUid).toBe('auntie-a');
    // Same structured shape as the envelope-level copy, with one entry, so the
    // seed that enumerates three days enumerates one day here.
    expect(hers[0].data.visitCount).toBe(1);
    expect(hers[0].data.visits).toEqual([
      { dateIso: '2026-09-04', weekday: 'Fri', date: 'Sep 4', time: '12:00 PM', visitId: 'v1' },
    ]);
    expect(hers[0].data.bookingDate).toBe('Fri, Sep 4');
  });

  it('assignment.changed stays per visit and keeps its single date', async () => {
    // Reassigned, unassigned, cancelled and edited are genuinely one-visit news,
    // so nothing about them moved.
    await run(
      { status: 'confirmed', assignedAuntieUid: 'auntie-a', startTime: { toMillis: () => Date.parse(SEP4) } },
      { status: 'confirmed', assignedAuntieUid: 'auntie-b', startTime: { toMillis: () => Date.parse(SEP4) } },
    );

    const changed = sent('assignment.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].recipientUid).toBe('uid-kinfolk');
    expect(changed[0].data.assignedAuntieUid).toBe('auntie-a');
    expect(changed[0].data.changeKind).toBe('reassigned');
    expect(changed[0].data.visits).toBeUndefined();
  });
});
