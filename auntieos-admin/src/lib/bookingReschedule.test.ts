import { describe, it, expect } from 'vitest';
import { type BookingEntry } from '../api/bookings';
import {
  bulkRescheduleSummary,
  mergeRescheduleResults,
  planBulkReschedule,
  planRescheduleWrites,
  rescheduleApplies,
  rescheduleOverrideLabel,
  type RescheduleDraft,
  type RescheduleTarget,
} from './bookingReschedule';

/**
 * The bulk reschedule's decisions (#397 M16), at the layer that makes them.
 *
 * Every case here is one the operator can reach from the sheet: a selection
 * holding a row that cannot be moved, a row left exactly where it was, a row
 * typed into nonsense, and a run where some visits land and others are refused.
 */

function entry(over: Partial<BookingEntry>): BookingEntry {
  return {
    _id: 'ses1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Wrens',
    status: 'SCHEDULED',
    startTime: '2026-07-16T09:00:00',
    endTime: '2026-07-16T10:00:00',
    ...over,
  } as BookingEntry;
}

function target(over: Partial<RescheduleTarget> = {}): RescheduleTarget {
  return {
    id: 'ses1',
    name: 'The Wrens',
    date: '2026-07-16',
    time: '09:00',
    durationMinutes: 60,
    currentStart: '2026-07-16T09:00:00',
    ...over,
  };
}

function drafts(pairs: Record<string, RescheduleDraft>): Map<string, RescheduleDraft> {
  return new Map(Object.entries(pairs));
}

describe('rescheduleApplies', () => {
  it('offers a new time only for a visit that is on the books', () => {
    expect(rescheduleApplies('scheduled')).toBe(true);
    for (const state of ['draft', 'pending', 'completed', 'cancelled', 'unknown'] as const) {
      expect(rescheduleApplies(state)).toBe(false);
    }
  });
});

describe('planBulkReschedule', () => {
  it('prefills an eligible visit from the window it holds now', () => {
    const rows = [entry({ _id: 'ses1', startTime: '2026-07-16T09:00:00' })];
    const plan = planBulkReschedule(rows, new Set(['ses1']));

    expect(plan.skipped).toEqual([]);
    expect(plan.eligible).toHaveLength(1);
    const only = plan.eligible[0]!;
    expect(only.name).toBe('The Wrens');
    expect(only.date).toBe('2026-07-16');
    expect(only.time).toBe('09:00');
    // 09:00 to 10:00 on the doc, so the move keeps an hour.
    expect(only.durationMinutes).toBe(60);
  });

  it('names a pending booking as skipped rather than offering it a field', () => {
    const rows = [
      entry({ _id: 'ses1' }),
      entry({ _id: 'ses2', kinfolkName: 'The Devlins', status: 'PENDING' }),
    ];
    const plan = planBulkReschedule(rows, new Set(['ses1', 'ses2']));

    expect(plan.eligible.map((t) => t.id)).toEqual(['ses1']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.name).toBe('The Devlins');
    expect(plan.skipped[0]!.reason).toContain('awaiting a reply');
  });

  it('names a selected id that has left the list', () => {
    const plan = planBulkReschedule([], new Set(['gone']));
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain('no longer in the list');
  });

  it('leaves the prefill blank when the stored start does not parse', () => {
    const plan = planBulkReschedule([entry({ startTime: 'sometime Tuesday' })], new Set(['ses1']));
    expect(plan.eligible[0]!.date).toBe('');
    expect(plan.eligible[0]!.time).toBe('');
  });
});

describe('planRescheduleWrites', () => {
  it('writes only the rows whose time the operator actually changed', () => {
    const moved = target({ id: 'ses1' });
    const untouched = target({ id: 'ses2', name: 'The Sparrows' });
    const planned = planRescheduleWrites(
      [moved, untouched],
      drafts({
        ses1: { date: '2026-07-17', time: '11:30' },
        ses2: { date: '2026-07-16', time: '09:00' },
      }),
    );

    expect(planned.writes).toHaveLength(1);
    expect(planned.writes[0]!.target.id).toBe('ses1');
    // The end comes from the visit's own length, not from a second field.
    const start = new Date(planned.writes[0]!.times.startTime);
    const end = new Date(planned.writes[0]!.times.endTime);
    expect(end.getTime() - start.getTime()).toBe(60 * 60_000);
    expect(start.getHours()).toBe(11);
    expect(start.getMinutes()).toBe(30);

    expect(planned.skipped).toHaveLength(1);
    expect(planned.skipped[0]!.name).toBe('The Sparrows');
    expect(planned.skipped[0]!.reason).toContain('unchanged');
  });

  it('skips a blank row and an impossible date, naming both', () => {
    const blank = target({ id: 'ses1', name: 'The Rowans', date: '', time: '' });
    const bogus = target({ id: 'ses2', name: 'The Mallorys' });
    const planned = planRescheduleWrites(
      [blank, bogus],
      drafts({
        ses1: { date: '', time: '' },
        ses2: { date: '2026-02-30', time: '09:15' },
      }),
    );

    expect(planned.writes).toEqual([]);
    expect(planned.skipped.map((s) => s.name)).toEqual(['The Rowans', 'The Mallorys']);
    expect(planned.skipped[0]!.reason).toContain('No new date and time');
    expect(planned.skipped[1]!.reason).toContain('not a real date and time');
  });
});

describe('mergeRescheduleResults', () => {
  it('splits a partial run into what landed and what was refused, by name', () => {
    const one = target({ id: 'ses1', name: 'The Wrens' });
    const two = target({ id: 'ses2', name: 'The Devlins' });
    const planned = planRescheduleWrites(
      [one, two],
      drafts({
        ses1: { date: '2026-07-17', time: '09:00' },
        ses2: { date: '2026-07-17', time: '13:00' },
      }),
    );

    const outcome = mergeRescheduleResults(
      planned.writes,
      new Map([['ses2', { reason: 'That window is already taken.', override: 'visit' as const }]]),
      [{ id: 'ses3', name: 'The Sparrows', reason: 'It has already been completed.' }],
    );

    expect(outcome.applied.map((a) => a.name)).toEqual(['The Wrens']);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.name).toBe('The Devlins');
    expect(outcome.failures[0]!.override).toBe('visit');
    expect(outcome.skipped.map((s) => s.name)).toEqual(['The Sparrows']);
    expect(bulkRescheduleSummary(outcome)).toBe('Moved 1 of 3 selected visits.');
  });

  it('summarises a clean run over one visit in the singular', () => {
    const planned = planRescheduleWrites(
      [target()],
      drafts({ ses1: { date: '2026-07-17', time: '09:00' } }),
    );
    const outcome = mergeRescheduleResults(planned.writes, new Map(), []);
    expect(bulkRescheduleSummary(outcome)).toBe('Moved 1 of 1 selected visit.');
    expect(outcome.failures).toEqual([]);
  });
});

describe('rescheduleOverrideLabel', () => {
  it('says which kind of clash the operator would be moving over', () => {
    expect(rescheduleOverrideLabel('visit')).toContain('booked visit');
    expect(rescheduleOverrideLabel('busy')).toContain('busy block');
  });
});
