import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));

import { onBookingEnvelopeCreate, visitStartMillis } from '../src/triggers/onBookingEnvelopeCreate';
import { onBookingsWrite } from '../src/triggers/onBookingsWrite';

const ts = (ms: number) => ({ toMillis: () => ms });

/** Sept 4-7 2026, one visit per day, in the order Firestore happens to return them. */
const SEP4 = Date.UTC(2026, 8, 4, 15, 0);
const SEP5 = Date.UTC(2026, 8, 5, 15, 0);
const SEP6 = Date.UTC(2026, 8, 6, 15, 0);
const SEP7 = Date.UTC(2026, 8, 7, 15, 0);

/**
 * A created-envelope event. `visits` become the `kinCares` children the handler
 * reads back, so a test can hand it an envelope whose children have already been
 * auto-confirmed.
 */
function envelopeEvent(envelope: Record<string, unknown>, visits: Array<Record<string, unknown>>) {
  return {
    params: { kinfolkId: 'fam1', batchId: 'req_1' },
    data: {
      data: () => envelope,
      ref: {
        collection: (name: string) => {
          if (name !== 'kinCares') throw new Error(`unexpected subcollection ${name}`);
          return { get: async () => ({ docs: visits.map((v) => ({ data: () => v })) }) };
        },
      },
    },
  } as never;
}

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
});

describe('visitStartMillis', () => {
  it('sorts oldest-first regardless of the order the children come back in', () => {
    expect(
      visitStartMillis([{ startTime: ts(SEP7) }, { startTime: ts(SEP4) }, { startTime: ts(SEP6) }]),
    ).toEqual([SEP4, SEP6, SEP7]);
  });

  it('drops a visit with no usable startTime rather than emitting NaN', () => {
    expect(
      visitStartMillis([{ startTime: ts(SEP4) }, { startTime: null }, {}, { startTime: ts(SEP5) }]),
    ).toEqual([SEP4, SEP5]);
  });

  it('is empty for no visits', () => {
    expect(visitStartMillis([])).toEqual([]);
  });
});

describe('onBookingEnvelopeCreate — #532, ONE notification per request', () => {
  it('a 4-visit long-weekend request dispatches kincare.requested EXACTLY once', async () => {
    await onBookingEnvelopeCreate.run(
      envelopeEvent({ envelopeStatus: 'requested', visitCount: 4, serviceName: 'Dog Walk' }, [
        { startTime: ts(SEP4) },
        { startTime: ts(SEP5) },
        { startTime: ts(SEP6) },
        { startTime: ts(SEP7) },
      ]),
    );

    // The whole defect in one assertion: four visits, one notification.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.key).toBe('kincare.requested');
    expect(arg.targetId).toBe('req_1');
    expect(arg.data.batchId).toBe('req_1');
    // Carries all four dates, so the template can name the span.
    expect(arg.data.startTimeMsList).toEqual([SEP4, SEP5, SEP6, SEP7]);
    expect(arg.data.visitCount).toBe(4);
    expect(arg.data.startTimeMs).toBe(SEP4);
  });

  it('a single-visit request still dispatches once', async () => {
    await onBookingEnvelopeCreate.run(
      envelopeEvent({ envelopeStatus: 'requested', visitCount: 1 }, [{ startTime: ts(SEP4) }]),
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].data.startTimeMsList).toEqual([SEP4]);
  });

  it('still names every date when maybeAutoConfirm already flipped the children', async () => {
    // The envelope snapshot says `requested`, but approveBookingSeriesCore has
    // run in between and the live children are `confirmed`. Reading only
    // `status == 'requested'` children would send a dateless notification.
    await onBookingEnvelopeCreate.run(
      envelopeEvent({ envelopeStatus: 'requested', visitCount: 2 }, [
        { startTime: ts(SEP4), status: 'confirmed' },
        { startTime: ts(SEP5), status: 'confirmed' },
      ]),
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].data.startTimeMsList).toEqual([SEP4, SEP5]);
  });

  it('an envelope created already confirmed is not a request and notifies nobody', async () => {
    await onBookingEnvelopeCreate.run(
      envelopeEvent({ envelopeStatus: 'confirmed', visitCount: 1 }, [{ startTime: ts(SEP4) }]),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('still sends when the children cannot be read, rather than going silent', async () => {
    // Fail-loud: an office that hears "a request came in" without dates can open
    // it; an office that hears nothing cannot.
    const event = {
      params: { kinfolkId: 'fam1', batchId: 'req_1' },
      data: {
        data: () => ({ envelopeStatus: 'requested', visitCount: 3 }),
        ref: {
          collection: () => ({
            get: async () => {
              throw new Error('permission denied');
            },
          }),
        },
      },
    } as never;

    await onBookingEnvelopeCreate.run(event);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueue.mock.calls[0]![0];
    expect(arg.data.startTimeMsList).toEqual([]);
    expect(arg.data.visitCount).toBe(3);
  });
});

describe('onBookingsWrite — no longer emits kincare.requested (#532)', () => {
  it('a requested visit CREATE dispatches nothing at all', async () => {
    // This is the invariant that keeps the duplicate from coming back: the
    // per-visit trigger is silent on create, because the envelope trigger owns
    // that signal now.
    await onBookingsWrite.run({
      params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
      data: {
        before: { data: () => undefined, exists: false },
        after: { data: () => ({ status: 'requested', serviceName: 'Dog Walk' }), exists: true },
      },
    } as never);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('still dispatches on a later confirm, so the rest of the trigger is intact', async () => {
    await onBookingsWrite.run({
      params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
      data: {
        before: { data: () => ({ status: 'requested' }), exists: true },
        after: { data: () => ({ status: 'confirmed' }), exists: true },
      },
    } as never);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0].key).toBe('kincare.booking.confirm');
  });
});
