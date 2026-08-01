import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import { type BookingEntry } from '../api/bookings';
import { type BatchUpdateBookingsResult } from '../contracts/bookingContracts.generated';
import {
  planBulkAction,
  mergeBulkResults,
  bulkActionApplies,
  bulkTargetName,
  bulkOutcomeSummary,
  chunkEnvelopeIds,
  ENVELOPE_BATCH_LIMIT,
} from './bookingBulk';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function row(over: Partial<BookingEntry>): BookingEntry {
  return {
    _id: 'ses1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    serviceType: 'Dog Walking',
    status: 'PENDING',
    startTime: '2026-07-16T09:00:00',
    completedAt: '',
    departedAt: '',
    notes: '',
    kinfolkNotes: '',
    createdAt: fakeTs('2026-07-15T00:00:00Z'),
    ...over,
  };
}

function envelopeResult(over: Partial<BatchUpdateBookingsResult> = {}): BatchUpdateBookingsResult {
  return { ok: true, action: 'APPROVE', updated: 0, failed: [], ...over };
}

describe('bulkActionApplies (the lifecycle guard, positively enumerated)', () => {
  it('lets a pre-visit request be approved or rejected, and nothing else', () => {
    for (const state of ['draft', 'pending'] as const) {
      expect(bulkActionApplies(state, 'APPROVE')).toBe(true);
      expect(bulkActionApplies(state, 'REJECT')).toBe(true);
      expect(bulkActionApplies(state, 'CANCEL')).toBe(false);
    }
  });

  it('lets a scheduled visit be cancelled, and refuses to re-approve it', () => {
    expect(bulkActionApplies('scheduled', 'CANCEL')).toBe(true);
    expect(bulkActionApplies('scheduled', 'APPROVE')).toBe(false);
    expect(bulkActionApplies('scheduled', 'REJECT')).toBe(false);
  });

  it('refuses every action on a terminal or unrecognized booking', () => {
    for (const state of ['completed', 'cancelled', 'unknown'] as const) {
      expect(bulkActionApplies(state, 'APPROVE')).toBe(false);
      expect(bulkActionApplies(state, 'REJECT')).toBe(false);
      expect(bulkActionApplies(state, 'CANCEL')).toBe(false);
    }
  });
});

describe('planBulkAction', () => {
  it('carries the envelope visit id when the session came from an approved request', () => {
    const plan = planBulkAction(
      [row({ _id: 'vis_v1', kinCareVisitId: 'v1', status: 'SCHEDULED' })],
      new Set(['vis_v1']),
      'CANCEL',
    );
    expect(plan.eligible).toEqual([
      { id: 'vis_v1', name: 'The Whitfields', envelopeVisitId: 'v1' },
    ]);
  });

  it('carries a NULL envelope id for a legacy session, rather than inventing one from the doc id', () => {
    // `vis_{visitId}` is the id shape approveBookingSeriesCore writes, and it
    // would be tempting to strip the prefix. A legacy session's id is not that
    // shape at all, and guessing would send an id to the callable that resolves
    // to a DIFFERENT family's visit or, more likely, to nothing.
    const plan = planBulkAction(
      [row({ _id: 'legacy-1', status: 'SCHEDULED' })],
      new Set(['legacy-1']),
      'CANCEL',
    );
    expect(plan.eligible[0]?.envelopeVisitId).toBeNull();
  });

  it('treats a blank kinCareVisitId as absent, not as an empty id worth sending', () => {
    const plan = planBulkAction(
      [row({ _id: 's1', kinCareVisitId: '   ', status: 'SCHEDULED' })],
      new Set(['s1']),
      'CANCEL',
    );
    expect(plan.eligible[0]?.envelopeVisitId).toBeNull();
  });

  it('SKIPS a cancelled booking from a bulk approve instead of resurrecting it', () => {
    const plan = planBulkAction(
      [
        row({ _id: 'a', status: 'PENDING', kinfolkName: 'Pending Household' }),
        row({ _id: 'b', status: 'CANCELLED', kinfolkName: 'Cancelled Household' }),
      ],
      new Set(['a', 'b']),
      'APPROVE',
    );
    expect(plan.eligible.map((t) => t.id)).toEqual(['a']);
    expect(plan.skipped).toEqual([
      { id: 'b', name: 'Cancelled Household', reason: 'Already cancelled.' },
    ]);
  });

  it('skips a scheduled visit from a bulk approve and names the action that does apply', () => {
    const plan = planBulkAction(
      [row({ _id: 'a', status: 'SCHEDULED' })],
      new Set(['a']),
      'APPROVE',
    );
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/Cancel it instead/);
  });

  it('names an unrecognized status as its own skip reason rather than guessing an action', () => {
    const plan = planBulkAction([row({ _id: 'a', status: 'WEIRD' })], new Set(['a']), 'CANCEL');
    expect(plan.skipped[0]?.reason).toMatch(/not one this app recognizes/i);
  });

  it('skips an id that left the stream between the click and the press', () => {
    const plan = planBulkAction([row({ _id: 'a' })], new Set(['a', 'gone']), 'APPROVE');
    expect(plan.eligible.map((t) => t.id)).toEqual(['a']);
    expect(plan.skipped).toEqual([
      { id: 'gone', name: 'gone', reason: 'It is no longer in the list, so nothing was written.' },
    ]);
  });

  it('names a blank household "Unnamed Kinfolk", the same label the row shows', () => {
    expect(bulkTargetName(row({ kinfolkName: '' }))).toBe('Unnamed Kinfolk');
    expect(bulkTargetName(row({ kinfolkName: '  ' }))).toBe('Unnamed Kinfolk');
    expect(bulkTargetName(row({ kinfolkName: 'The Whitfields' }))).toBe('The Whitfields');
  });
});

describe('chunkEnvelopeIds (the callable caps ids at 100)', () => {
  it('sends one call for a selection that fits', () => {
    expect(chunkEnvelopeIds(['a', 'b'])).toEqual([['a', 'b']]);
  });

  it('splits a selection larger than the cap rather than letting the callable reject it whole', () => {
    const ids = Array.from({ length: ENVELOPE_BATCH_LIMIT + 5 }, (_, i) => `v${i}`);
    const chunks = chunkEnvelopeIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(ENVELOPE_BATCH_LIMIT);
    expect(chunks[1]).toHaveLength(5);
    expect(chunks.flat()).toEqual(ids);
  });

  it('makes no call at all for an empty set (the callable rejects `ids: []`)', () => {
    expect(chunkEnvelopeIds([])).toEqual([]);
  });
});

describe('mergeBulkResults', () => {
  const plan = {
    eligible: [
      { id: 'a', name: 'Household A', envelopeVisitId: 'va' },
      { id: 'b', name: 'Household B', envelopeVisitId: null },
      { id: 'c', name: 'Household C', envelopeVisitId: 'vc' },
    ],
    skipped: [{ id: 'd', name: 'Household D', reason: 'Already cancelled.' }],
  };

  it('counts a row applied only when every write that applied to it landed', () => {
    const out = mergeBulkResults('APPROVE', plan, new Map(), [envelopeResult({ updated: 2 })]);
    expect(out.applied.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(out.failures).toEqual([]);
    expect(out.skipped).toEqual(plan.skipped);
  });

  it('reports a failed flat write by household name, never by session id alone', () => {
    const out = mergeBulkResults(
      'APPROVE',
      plan,
      new Map([['b', 'permission-denied']]),
      [envelopeResult()],
    );
    expect(out.failures).toEqual([
      { id: 'b', name: 'Household B', reason: 'permission-denied' },
    ]);
    expect(out.applied.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('maps a per-id envelope failure back onto the row that named it', () => {
    // The callable keys `failed` by ENVELOPE visit id ('vc'), which is an id the
    // operator has never seen. Reported against 'Household C' or it is useless.
    const out = mergeBulkResults('CANCEL', plan, new Map(), [
      envelopeResult({ action: 'CANCEL', updated: 1, failed: [{ id: 'vc', error: 'not-found' }] }),
    ]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.name).toBe('Household C');
    expect(out.failures[0]?.reason).toMatch(/not-found/);
  });

  it('calls a half-landed booking a FAILURE, because the admin list and the household now disagree', () => {
    const out = mergeBulkResults('CANCEL', plan, new Map(), [
      envelopeResult({ action: 'CANCEL', failed: [{ id: 'va', error: 'not-found' }] }),
    ]);
    expect(out.applied.map((t) => t.id)).not.toContain('a');
    expect(out.failures[0]?.reason).toMatch(/updated here, but the household's copy of it was not/);
  });

  it('folds the failures of every chunk, not just the first', () => {
    const out = mergeBulkResults('APPROVE', plan, new Map(), [
      envelopeResult({ failed: [{ id: 'va', error: 'not-found' }] }),
      envelopeResult({ failed: [{ id: 'vc', error: 'write-failed' }] }),
    ]);
    expect(out.failures.map((f) => f.name)).toEqual(['Household A', 'Household C']);
  });

  it('does not blame the envelope for a row that has none', () => {
    const out = mergeBulkResults('APPROVE', plan, new Map(), [
      envelopeResult({ failed: [{ id: 'b', error: 'not-found' }] }),
    ]);
    // 'b' has no envelope counterpart, so an envelope failure keyed 'b' cannot
    // be about it: the ids live in different namespaces.
    expect(out.applied.map((t) => t.id)).toContain('b');
  });
});

describe('bulkOutcomeSummary', () => {
  it('states both numbers, so "Approved 3" can never read as "all of them"', () => {
    const out = mergeBulkResults(
      'APPROVE',
      {
        eligible: [
          { id: 'a', name: 'A', envelopeVisitId: null },
          { id: 'b', name: 'B', envelopeVisitId: null },
        ],
        skipped: [{ id: 'c', name: 'C', reason: 'Already cancelled.' }],
      },
      new Map([['b', 'permission-denied']]),
      [],
    );
    expect(bulkOutcomeSummary(out)).toBe('Approved 1 of 3 selected bookings.');
  });

  it('says booking, singular, for a selection of one', () => {
    const out = mergeBulkResults(
      'CANCEL',
      { eligible: [{ id: 'a', name: 'A', envelopeVisitId: null }], skipped: [] },
      new Map(),
      [],
    );
    expect(bulkOutcomeSummary(out)).toBe('Cancelled 1 of 1 selected booking.');
  });
});
