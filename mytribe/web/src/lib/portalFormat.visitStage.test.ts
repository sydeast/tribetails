import { describe, expect, it } from 'vitest';
import {
  BOOKINGS_POLL_MS,
  BOOKING_TIMELINE_STEPS,
  bookingChip,
  bookingStatusChip,
  bookingStatusIcon,
  bookingTimelineIndex,
  bookingsPollMs,
  findBookingById,
  isTimelineStepDone,
  isUnderWay,
  liveVisitOf,
  visitStageOf,
  type VisitStage,
} from './portalFormat';
import type { GetMyBookingsResult, GetMyBookingsResultLiveVisit } from '../contracts/bookingContracts.generated';

/**
 * #1830 / #1832 / #1823: one reading of where a visit stands, at every status
 * of its life, feeding the list chip, the detail chip, the timeline, the
 * status tile's glyph and the live card.
 *
 * #2123 (operator ruling 2026-11-12): a visit is Completed at departure. The
 * server sends a departed visit as completed; an older answer that still
 * pairs `active` with `ended` reads Completed too. There is no Departed stage.
 */

type Visit = GetMyBookingsResultLiveVisit;

function visit(overrides: Partial<Visit> = {}): Visit {
  return {
    id: 'v1',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status: 'confirmed',
    visitProgress: null,
    startTimeMs: null,
    kinNames: [],
    sessionId: null,
    ...overrides,
  } as Visit;
}

function result(overrides: Partial<GetMyBookingsResult> = {}): GetMyBookingsResult {
  return { liveVisit: null, upcoming: [], recent: [], envelopes: [], ...overrides };
}

function envelopeOf(...kinCares: Visit[]): GetMyBookingsResult['envelopes'][number] {
  return { batchId: 'b1', kinCares } as unknown as GetMyBookingsResult['envelopes'][number];
}

/** Every stage, as the server sends it. */
const WIRE: { stage: VisitStage; status: Visit['status']; visitProgress: Visit['visitProgress'] }[] = [
  { stage: 'requested', status: 'requested', visitProgress: null },
  { stage: 'confirmed', status: 'confirmed', visitProgress: null },
  { stage: 'enRoute', status: 'enRoute', visitProgress: 'enRoute' },
  { stage: 'active', status: 'active', visitProgress: 'active' },
  // #2123: a departed visit in an answer cached before the change.
  { stage: 'completed', status: 'active', visitProgress: 'ended' },
  { stage: 'completed', status: 'completed', visitProgress: 'ended' },
  { stage: 'cancelled', status: 'cancelled', visitProgress: null },
];

describe('visitStageOf', () => {
  it.each(WIRE)('$status + $visitProgress reads as $stage', ({ stage, status, visitProgress }) => {
    expect(visitStageOf({ status, visitProgress })).toBe(stage);
  });

  it('an arrived visit from a server that sends no progress is still in progress', () => {
    expect(visitStageOf({ status: 'active', visitProgress: null })).toBe('active');
  });

  it('under way is on the way or arrived; a departed visit is finished', () => {
    expect(WIRE.filter(isUnderWay).map((w) => w.stage)).toEqual(['enRoute', 'active']);
  });
});

describe('what each stage shows', () => {
  it.each([
    ['requested', 'REQUESTED', 'requested', 'go', 0],
    ['confirmed', 'CONFIRMED', 'confirmed', 'warm', 1],
    ['enRoute', 'EN ROUTE', 'inprogress', 'warm', 2],
    ['active', 'IN PROGRESS', 'inprogress', 'warm', 3],
    ['completed', 'COMPLETED', 'completed', 'done', 4],
    ['cancelled', 'CANCELLED', 'cancelled', 'done', null],
  ] as const)('%s: %s chip, timeline step %s', (stage, label, detailTone, listTone, index) => {
    expect(bookingStatusChip(stage)).toEqual({ label, tone: detailTone });
    // The list chip and the detail chip never disagree on the word.
    expect(bookingChip(stage)).toEqual({ label, tone: listTone });
    expect(bookingTimelineIndex(stage)).toBe(index);
  });

  it.each([
    ['requested', [false, false, false, false, false]],
    ['confirmed', [true, false, false, false, false]],
    ['enRoute', [true, true, false, false, false]],
    ['active', [true, true, true, false, false]],
    ['completed', [true, true, true, true, true]],
    ['cancelled', [false, false, false, false, false]],
  ] as const)('%s ticks the right timeline steps', (stage, ticks) => {
    expect(BOOKING_TIMELINE_STEPS.map((_, i) => isTimelineStepDone(stage, i))).toEqual(ticks);
  });

  it('only a requested or cancelled visit loses the check beside Status', () => {
    const checked = WIRE.map((w) => w.stage).filter((s) => bookingStatusIcon(s) === '✅');
    expect(checked).toEqual(['confirmed', 'enRoute', 'active', 'completed', 'completed']);
  });
  it('#2123: a departed visit shows COMPLETED everywhere, with every step ticked', () => {
    const stage = visitStageOf({ status: 'active', visitProgress: 'ended' });
    expect(bookingStatusChip(stage)).toEqual({ label: 'COMPLETED', tone: 'completed' });
    expect(bookingChip(stage)).toEqual({ label: 'COMPLETED', tone: 'done' });
    expect(bookingTimelineIndex(stage)).toBe(4);
    expect(BOOKING_TIMELINE_STEPS.map((_, i) => isTimelineStepDone(stage, i))).toEqual([true, true, true, true, true]);
    expect(bookingStatusIcon(stage)).toBe('✅');
  });
  it('no stage reads DEPARTED', () => {
    expect(WIRE.map((w) => bookingStatusChip(w.stage).label)).not.toContain('DEPARTED');
  });
});

describe('findBookingById, at every status', () => {
  it.each(WIRE)('finds a $stage visit that is on a list', ({ status, visitProgress }) => {
    const v = visit({ status, visitProgress });
    const listed = status === 'completed' || status === 'cancelled' ? result({ recent: [v] }) : result({ upcoming: [v] });
    expect(findBookingById(listed, 'v1')).toBe(v);
  });

  it.each(WIRE)('finds a $stage visit that is on no list, through its envelope', ({ stage, status, visitProgress }) => {
    const v = visit({ status, visitProgress });
    const found = findBookingById(result({ envelopes: [envelopeOf(visit({ id: 'other' }), v)] }), 'v1');
    expect(found).toBe(v);
    expect(visitStageOf(found!)).toBe(stage);
  });

  it('prefers the listed copy over the envelope copy', () => {
    const listed = visit({ status: 'enRoute', visitProgress: 'enRoute' });
    const inEnvelope = visit({ status: 'confirmed' });
    expect(findBookingById(result({ upcoming: [listed], envelopes: [envelopeOf(inEnvelope)] }), 'v1')).toBe(listed);
  });

  it('a visit of another household is in no answer the server gives, so it is not found', () => {
    const mine = result({ upcoming: [visit({ id: 'mine' })], envelopes: [envelopeOf(visit({ id: 'mine' }))] });
    expect(findBookingById(mine, 'theirs')).toBeNull();
  });

  it('copes with an answer that carries no envelopes', () => {
    const old = { liveVisit: null, upcoming: [], recent: [] } as unknown as GetMyBookingsResult;
    expect(findBookingById(old, 'v1')).toBeNull();
  });
});

describe('liveVisitOf', () => {
  it.each([
    ['enRoute', 'enRoute'],
    ['active', 'active'],
  ] as const)('is the live visit while it is %s', (status, visitProgress) => {
    const v = visit({ status, visitProgress });
    expect(liveVisitOf(result({ liveVisit: v }))).toBe(v);
  });

  it('is nothing once the visit is departed, even if the answer still names it', () => {
    expect(liveVisitOf(result({ liveVisit: visit({ status: 'active', visitProgress: 'ended' }) }))).toBeNull();
  });

  it('is nothing with no live visit, or before the answer arrives', () => {
    expect(liveVisitOf(result())).toBeNull();
    expect(liveVisitOf(undefined)).toBeNull();
  });
});

describe('bookingsPollMs', () => {
  const NOW = new Date(2026, 10, 10, 23, 0).getTime();
  const MIN = 60_000;

  it.each(WIRE.filter(isUnderWay))('keeps reading while a visit is $stage', ({ status, visitProgress }) => {
    expect(bookingsPollMs(result({ upcoming: [visit({ status, visitProgress })] }), NOW)).toBe(BOOKINGS_POLL_MS);
  });

  it('keeps reading for a confirmed visit within the hour before its start, to catch the first tap', () => {
    expect(bookingsPollMs(result({ upcoming: [visit({ startTimeMs: NOW + 59 * MIN })] }), NOW)).toBe(BOOKINGS_POLL_MS);
    expect(bookingsPollMs(result({ upcoming: [visit({ startTimeMs: NOW + 61 * MIN })] }), NOW)).toBe(false);
  });

  it('keeps reading for a confirmed visit that is running late', () => {
    expect(bookingsPollMs(result({ upcoming: [visit({ startTimeMs: NOW - 20 * MIN })] }), NOW)).toBe(BOOKINGS_POLL_MS);
  });

  it('#2123: does not read again for a departed visit, even one an older answer still lists as upcoming', () => {
    expect(bookingsPollMs(result({ upcoming: [visit({ status: 'active', visitProgress: 'ended', startTimeMs: NOW + 2 * 60 * MIN })] }), NOW)).toBe(false);
  });
  it('does not read again for a request, a finished visit, an empty schedule or no answer', () => {
    expect(bookingsPollMs(result({ upcoming: [visit({ status: 'requested', startTimeMs: NOW + MIN })] }), NOW)).toBe(false);
    expect(bookingsPollMs(result({ recent: [visit({ status: 'completed', startTimeMs: NOW - MIN })] }), NOW)).toBe(false);
    expect(bookingsPollMs(result(), NOW)).toBe(false);
    expect(bookingsPollMs(undefined, NOW)).toBe(false);
  });
});
