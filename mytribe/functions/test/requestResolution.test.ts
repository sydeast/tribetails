import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1647: a booked or declined request's office notification stops offering
 * Approve/Deny. The server half: the `kincare.requested` rows are stamped with
 * how the request ended, from the envelope's status change.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

import {
  anyVisitDeclined,
  requestResolutionForTransition,
  stampRequestNotifications,
} from '../src/notifications/requestResolution';
import { onBookingEnvelopeResolve } from '../src/triggers/onBookingEnvelopeResolve';
import { onBookingEnvelopeCreate } from '../src/triggers/onBookingEnvelopeCreate';

const ENVELOPE = 'families/fam1/bookings/req_1';

/** The two admins' copies of the request, plus rows that must never be touched. */
function notificationRows(over: Record<string, Record<string, unknown>> = {}) {
  return [
    { id: 'n-admin-a', data: { key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', ...over['n-admin-a'] } },
    { id: 'n-admin-b', data: { key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', ...over['n-admin-b'] } },
    // Same envelope, different event: the household's decline copy.
    { id: 'n-declined', data: { key: 'kincare.request.declined', targetType: 'booking', targetId: 'req_1' } },
    // Same key, a different request.
    { id: 'n-other', data: { key: 'kincare.requested', targetType: 'booking', targetId: 'req_2' } },
  ];
}

function dbWith(opts: {
  rows?: ReturnType<typeof notificationRows>;
  visits?: Array<Record<string, unknown>>;
  envelope?: Record<string, unknown>;
}) {
  return buildDbMock({
    docs: { [ENVELOPE]: opts.envelope ?? null },
    queryDocs: {
      notifications: opts.rows ?? notificationRows(),
      [`${ENVELOPE}/kinCares`]: (opts.visits ?? []).map((data, i) => ({ id: `v${i + 1}`, data })),
    },
  });
}

/** Paths written to `notifications`, and anything written anywhere else. */
function writeSummary(ctx: ReturnType<typeof buildDbMock>) {
  return {
    stamped: ctx.writes.filter((w) => w.path.startsWith('notifications/')),
    elsewhere: ctx.writes.filter((w) => !w.path.startsWith('notifications/')),
  };
}

function updateEvent(
  ctx: ReturnType<typeof buildDbMock>,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
) {
  const ref = ctx.db.doc(ENVELOPE);
  return {
    params: { kinfolkId: 'fam1', batchId: 'req_1' },
    data: {
      before: { data: () => before },
      after: { data: () => after, ref },
    },
  } as never;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
});

describe('requestResolutionForTransition', () => {
  it.each([
    ['requested', 'confirmed', false, 'booked'],
    ['requested', 'partiallyConfirmed', false, 'booked'],
    ['requested', 'inProgress', false, 'booked'],
    ['requested', 'completed', false, 'booked'],
    ['requested', 'cancelled', true, 'declined'],
    ['requested', 'cancelled', false, 'cancelled'],
    // A declined request approved again is a new answer.
    ['cancelled', 'confirmed', false, 'booked'],
    // Booked, then cancelled later: the request WAS booked; leave the stamp.
    ['confirmed', 'cancelled', false, null],
    ['confirmed', 'cancelled', true, null],
    // Moves between booked statuses carry no new answer.
    ['confirmed', 'completed', false, null],
    ['partiallyConfirmed', 'confirmed', false, null],
    // Still waiting, or no change at all.
    ['requested', 'requested', false, null],
    ['confirmed', 'requested', false, null],
    ['requested', undefined, false, null],
  ] as const)('%s -> %s (declined marker %s) is %s', (before, after, declined, want) => {
    expect(requestResolutionForTransition(before, after, declined)).toBe(want);
  });
});

describe('anyVisitDeclined', () => {
  it('reads the decline marker manageBookingSeries writes', () => {
    expect(anyVisitDeclined([{ status: 'cancelled', requestDeclinedAt: '__TS__' }])).toBe(true);
    expect(anyVisitDeclined([{ status: 'cancelled' }, { status: 'cancelled', requestDeclinedAt: null }])).toBe(false);
    expect(anyVisitDeclined([])).toBe(false);
  });
});

describe('stampRequestNotifications', () => {
  it("stamps only this request's kincare.requested rows, and nothing else anywhere", async () => {
    const ctx = dbWith({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const n = await stampRequestNotifications({
      kinfolkId: 'fam1',
      batchId: 'req_1',
      resolution: 'booked',
      source: 'test',
    });

    expect(n).toBe(2);
    const { stamped, elsewhere } = writeSummary(ctx);
    expect(stamped.map((w) => w.path).sort()).toEqual(['notifications/n-admin-a', 'notifications/n-admin-b']);
    for (const w of stamped) {
      expect(w.data).toEqual({ requestResolution: 'booked', requestResolvedAt: '__SERVER_TS__' });
    }
    // The send gate is never in play: no work order, no queue row, no dedupe
    // ledger, no new notification. Only the two existing rows changed.
    expect(elsewhere).toEqual([]);
    expect(ctx.adds).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('skips a row that already carries the answer', async () => {
    const ctx = dbWith({ rows: notificationRows({ 'n-admin-a': { requestResolution: 'declined' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const n = await stampRequestNotifications({ kinfolkId: 'fam1', batchId: 'req_1', resolution: 'declined', source: 'test' });

    expect(n).toBe(1);
    expect(writeSummary(ctx).stamped.map((w) => w.path)).toEqual(['notifications/n-admin-b']);
  });

  it('never throws: a failed stamp is logged, not raised into the approval', async () => {
    mocks.dbFn.mockImplementation(() => {
      throw new Error('firestore down');
    });

    await expect(
      stampRequestNotifications({ kinfolkId: 'fam1', batchId: 'req_1', resolution: 'booked', source: 'test' }),
    ).resolves.toBe(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'notification.request.resolve.failed' }),
    );
  });
});

describe('onBookingEnvelopeResolve', () => {
  it('Book it (requested -> confirmed) stamps the request rows booked', async () => {
    const ctx = dbWith({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeResolve.run(
      updateEvent(ctx, { envelopeStatus: 'requested' }, { envelopeStatus: 'confirmed' }),
    );

    const { stamped } = writeSummary(ctx);
    expect(stamped).toHaveLength(2);
    expect(stamped.every((w) => w.data['requestResolution'] === 'booked')).toBe(true);
  });

  it('an office decline (requested -> cancelled, visits marked) stamps declined', async () => {
    const ctx = dbWith({
      visits: [
        { status: 'cancelled', requestDeclinedAt: '__TS__' },
        { status: 'cancelled', requestDeclinedAt: '__TS__' },
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeResolve.run(
      updateEvent(ctx, { envelopeStatus: 'requested' }, { envelopeStatus: 'cancelled' }),
    );

    const { stamped } = writeSummary(ctx);
    expect(stamped).toHaveLength(2);
    expect(stamped.every((w) => w.data['requestResolution'] === 'declined')).toBe(true);
  });

  it('a withdrawal (requested -> cancelled, no decline marker) stamps cancelled', async () => {
    const ctx = dbWith({ visits: [{ status: 'cancelled' }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeResolve.run(
      updateEvent(ctx, { envelopeStatus: 'requested' }, { envelopeStatus: 'cancelled' }),
    );

    expect(writeSummary(ctx).stamped.every((w) => w.data['requestResolution'] === 'cancelled')).toBe(true);
  });

  it('a counters-only envelope write does not even query', async () => {
    const ctx = dbWith({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeResolve.run(
      updateEvent(
        ctx,
        { envelopeStatus: 'requested', visitCount: 2 },
        { envelopeStatus: 'requested', visitCount: 3 },
      ),
    );

    expect(ctx.writes).toEqual([]);
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('a booked series cancelled later keeps its Booked stamp', async () => {
    const ctx = dbWith({ rows: notificationRows({ 'n-admin-a': { requestResolution: 'booked' } }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeResolve.run(
      updateEvent(ctx, { envelopeStatus: 'confirmed' }, { envelopeStatus: 'cancelled' }),
    );

    expect(ctx.writes).toEqual([]);
  });
});

describe('onBookingEnvelopeCreate: the auto-confirm race', () => {
  function createEvent(ctx: ReturnType<typeof buildDbMock>) {
    const ref = ctx.db.doc(ENVELOPE);
    return {
      params: { kinfolkId: 'fam1', batchId: 'req_1' },
      data: { data: () => ({ envelopeStatus: 'requested', visitCount: 1 }), ref },
    } as never;
  }

  it('a request already confirmed when its notification is written is stamped booked', async () => {
    // The envelope as it stands once the row is written: auto-confirm got there first.
    const ctx = dbWith({ envelope: { envelopeStatus: 'confirmed' }, visits: [{ status: 'confirmed' }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeCreate.run(createEvent(ctx));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const { stamped } = writeSummary(ctx);
    expect(stamped).toHaveLength(2);
    expect(stamped.every((w) => w.data['requestResolution'] === 'booked')).toBe(true);
  });

  it('a request still waiting is left alone', async () => {
    const ctx = dbWith({ envelope: { envelopeStatus: 'requested' }, visits: [{ status: 'requested' }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onBookingEnvelopeCreate.run(createEvent(ctx));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(writeSummary(ctx).stamped).toEqual([]);
  });
});
