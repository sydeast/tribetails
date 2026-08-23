import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { manageBookingSeriesHandler } from '../src/admin/manageBookingSeries';
import { onBookingsWrite } from '../src/triggers/onBookingsWrite';

const ts = (ms: number) => ({ toMillis: () => ms });
const SEP4 = Date.UTC(2026, 8, 4, 16, 0);
const SEP5 = Date.UTC(2026, 8, 5, 16, 0);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as never,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const PARENT = 'families/fam1/bookings/req_1';

function dbFor(envelopeStatus: string) {
  return buildDbMock({
    docs: { [PARENT]: { envelopeStatus, serviceName: 'Dog Walk', visitCount: 2 } },
    queryDocs: {
      [`${PARENT}/kinCares`]: [
        { id: 'v1', data: { status: envelopeStatus, startTime: ts(SEP4) } },
        { id: 'v2', data: { status: envelopeStatus, startTime: ts(SEP5) } },
      ],
    },
  });
}

describe('manageBookingSeries CANCEL — declining a request (#533)', () => {
  it('tells the household ONCE, with the dates and the reason', async () => {
    const ctx = dbFor('requested');
    mocks.dbFn.mockReturnValue(ctx.db);

    await manageBookingSeriesHandler(
      req({ action: 'CANCEL', kinfolkId: 'fam1', batchId: 'req_1', note: 'Fully booked that weekend.' }),
    );

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.key).toBe('kincare.request.declined');
    expect(arg.targetId).toBe('req_1');
    expect(arg.data.note).toBe('Fully booked that weekend.');
    expect(arg.data.startTimeMsList).toEqual([SEP4, SEP5]);
    expect(arg.data.visitCount).toBe(2);
  });

  it('stamps every visit as declined, so the trigger can tell why it was cancelled', async () => {
    const ctx = dbFor('requested');
    mocks.dbFn.mockReturnValue(ctx.db);

    await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'fam1', batchId: 'req_1' }));

    const visitWrites = ctx.writes.filter((w) => w.path.includes('/kinCares/'));
    expect(visitWrites).toHaveLength(2);
    for (const w of visitWrites) {
      expect(w.data.status).toBe('cancelled');
      expect(w.data.requestDeclinedAt).toBe('__TS__');
    }
  });

  it('cancelling an ALREADY CONFIRMED series is a different event: no decline key, no stamp', async () => {
    // CANCEL is dual-use. Those visits really were on the household's schedule,
    // so `kincare.booking.cancel` from onBookingsWrite is the correct message
    // and a decline would be a lie.
    const ctx = dbFor('confirmed');
    mocks.dbFn.mockReturnValue(ctx.db);

    await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'fam1', batchId: 'req_1' }));

    expect(mocks.enqueue).not.toHaveBeenCalled();
    const visitWrites = ctx.writes.filter((w) => w.path.includes('/kinCares/'));
    expect(visitWrites).toHaveLength(2);
    for (const w of visitWrites) {
      expect(w.data.requestDeclinedAt).toBeUndefined();
    }
  });
});

describe('onBookingsWrite — a declined request is not a cancelled visit (#533)', () => {
  async function run(before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
    await onBookingsWrite.run({
      params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
      data: {
        before: { data: () => before, exists: before !== undefined },
        after: { data: () => after, exists: true },
      },
    } as never);
  }

  it('stays silent when the cancel carries the decline stamp', async () => {
    await run({ status: 'requested' }, { status: 'cancelled', requestDeclinedAt: '__TS__' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('still fires booking.cancel when a CONFIRMED visit is cancelled', async () => {
    await run({ status: 'confirmed' }, { status: 'cancelled' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].key).toBe('kincare.booking.cancel');
  });

  it('STILL fires booking.cancel when the office accepts a cancel ask on a REQUESTED visit', async () => {
    // The regression this stamp exists to prevent. The portal lets a household
    // ask to cancel a still-requested visit (CANCELABLE admits `requested`), and
    // accepting makes the identical requested -> cancelled transition while
    // owing them a confirmation. Gating on the transition alone would have
    // silenced it.
    await run(
      { status: 'requested', cancelRequestedAt: '__TS__', cancelRequestStatus: 'pending' },
      { status: 'cancelled', cancelRequestStatus: 'accepted' },
    );
    const keys = mocks.enqueue.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('kincare.booking.cancel');
  });
});
