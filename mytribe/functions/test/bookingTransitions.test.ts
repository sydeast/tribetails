import { describe, it, expect } from 'vitest';
import {
  BOOKING_ACTIONS,
  BOOKING_STATUSES,
  allowedFromFor,
  appendCancellationNote,
  evaluateTransition,
  illegalTransitionMessage,
  normalizeBookingStatus,
  targetStatusFor,
  unknownStatusMessage,
  type BookingAction,
  type BookingStatus,
} from '../src/lib/bookingTransitions';

/**
 * The pure half of A3. The handler test next door proves the callable wires
 * this up; this file proves the machine itself, exhaustively, because "which
 * transitions are legal" is the whole product of the change and a table that
 * is only exercised through four happy-path handler calls is a table nobody
 * checked.
 */

describe('normalizeBookingStatus', () => {
  it('accepts every canonical status verbatim', () => {
    for (const s of BOOKING_STATUSES) {
      expect(normalizeBookingStatus(s)).toBe(s);
    }
  });

  it('trims and uppercases', () => {
    expect(normalizeBookingStatus('  scheduled ')).toBe('SCHEDULED');
    expect(normalizeBookingStatus('on_my_way')).toBe('ON_MY_WAY');
  });

  it('folds the CANCELED and REJECTED spellings onto CANCELLED', () => {
    expect(normalizeBookingStatus('CANCELED')).toBe('CANCELLED');
    expect(normalizeBookingStatus('rejected')).toBe('CANCELLED');
  });

  it('returns null (a refusal, never a default) for blank, absent, and junk', () => {
    expect(normalizeBookingStatus('')).toBeNull();
    expect(normalizeBookingStatus('   ')).toBeNull();
    expect(normalizeBookingStatus(undefined)).toBeNull();
    expect(normalizeBookingStatus(null)).toBeNull();
    expect(normalizeBookingStatus(42)).toBeNull();
    expect(normalizeBookingStatus({ status: 'SCHEDULED' })).toBeNull();
    expect(normalizeBookingStatus('SCHEDULED_MAYBE')).toBeNull();
  });
});

describe('the transition table', () => {
  it('lands each action on its documented status', () => {
    expect(targetStatusFor('APPROVE')).toBe('SCHEDULED');
    expect(targetStatusFor('REJECT')).toBe('CANCELLED');
    expect(targetStatusFor('CANCEL')).toBe('CANCELLED');
    expect(targetStatusFor('COMPLETE')).toBe('COMPLETED');
  });

  /**
   * REJECT and CANCEL land on the SAME status and are still different actions.
   * The difference is entirely the source set: REJECT declines something never
   * approved, CANCEL calls off something that was. If these two sets ever
   * become equal the distinction the PR preserves has quietly died, so it is
   * asserted rather than described.
   */
  it('keeps reject and cancel distinct by their source states', () => {
    expect(allowedFromFor('REJECT')).toEqual(['DRAFT', 'PENDING']);
    expect(allowedFromFor('CANCEL')).toEqual(['SCHEDULED', 'ON_MY_WAY', 'ARRIVED', 'DEPARTED']);
    expect(allowedFromFor('REJECT')).not.toEqual(allowedFromFor('CANCEL'));
    expect(targetStatusFor('REJECT')).toBe(targetStatusFor('CANCEL'));
  });

  it('never allows a transition out of a terminal status', () => {
    for (const action of BOOKING_ACTIONS) {
      expect(allowedFromFor(action)).not.toContain('COMPLETED');
      expect(allowedFromFor(action)).not.toContain('CANCELLED');
    }
  });
});

/**
 * The full cross product: 8 statuses x 4 actions = 32 decisions, each asserted
 * against an independently written expectation rather than against the table
 * the implementation reads.
 */
describe('evaluateTransition: the whole grid', () => {
  const EXPECTED: Record<BookingStatus, Record<BookingAction, 'apply' | 'noop' | 'illegal'>> = {
    DRAFT: { APPROVE: 'apply', REJECT: 'apply', CANCEL: 'illegal', COMPLETE: 'illegal' },
    PENDING: { APPROVE: 'apply', REJECT: 'apply', CANCEL: 'illegal', COMPLETE: 'illegal' },
    SCHEDULED: { APPROVE: 'noop', REJECT: 'illegal', CANCEL: 'apply', COMPLETE: 'apply' },
    ON_MY_WAY: { APPROVE: 'illegal', REJECT: 'illegal', CANCEL: 'apply', COMPLETE: 'apply' },
    ARRIVED: { APPROVE: 'illegal', REJECT: 'illegal', CANCEL: 'apply', COMPLETE: 'apply' },
    DEPARTED: { APPROVE: 'illegal', REJECT: 'illegal', CANCEL: 'apply', COMPLETE: 'apply' },
    COMPLETED: { APPROVE: 'illegal', REJECT: 'illegal', CANCEL: 'illegal', COMPLETE: 'noop' },
    CANCELLED: { APPROVE: 'illegal', REJECT: 'noop', CANCEL: 'noop', COMPLETE: 'illegal' },
  };

  for (const status of BOOKING_STATUSES) {
    for (const action of BOOKING_ACTIONS) {
      it(`${action} from ${status} is ${EXPECTED[status][action]}`, () => {
        const d = evaluateTransition({ currentStatus: status, action });
        expect(d.kind).toBe(EXPECTED[status][action]);
      });
    }
  }

  it('reports the real from/to on an applied transition', () => {
    const d = evaluateTransition({ currentStatus: 'PENDING', action: 'APPROVE' });
    expect(d).toEqual({ kind: 'apply', from: 'PENDING', to: 'SCHEDULED' });
  });

  it('reports the allowed sources on an illegal one, so the message can name them', () => {
    const d = evaluateTransition({ currentStatus: 'COMPLETED', action: 'CANCEL' });
    expect(d).toEqual({
      kind: 'illegal',
      from: 'COMPLETED',
      to: 'CANCELLED',
      allowedFrom: ['SCHEDULED', 'ON_MY_WAY', 'ARRIVED', 'DEPARTED'],
    });
  });

  it('treats a re-cancel of an already-CANCELED (one L) row as a no-op, not an error', () => {
    expect(evaluateTransition({ currentStatus: 'CANCELED', action: 'CANCEL' })).toEqual({
      kind: 'noop',
      at: 'CANCELLED',
    });
  });

  it('refuses an unreadable status instead of guessing at one', () => {
    expect(evaluateTransition({ currentStatus: undefined, action: 'APPROVE' })).toEqual({
      kind: 'unknown-status',
      raw: '',
    });
    expect(evaluateTransition({ currentStatus: 'WAT', action: 'CANCEL' })).toEqual({
      kind: 'unknown-status',
      raw: 'WAT',
    });
  });
});

describe('refusal messages', () => {
  it('names the action, the current status and every legal source', () => {
    const msg = illegalTransitionMessage('COMPLETE', 'CANCELLED', allowedFromFor('COMPLETE'));
    expect(msg).toContain('COMPLETE');
    expect(msg).toContain('CANCELLED');
    expect(msg).toContain('SCHEDULED, ON_MY_WAY, ARRIVED, DEPARTED');
  });

  it('spells a blank status "(blank)" rather than rendering an empty quote', () => {
    expect(unknownStatusMessage('   ')).toContain('(blank)');
    expect(unknownStatusMessage('WAT')).toContain('WAT');
  });
});

describe('appendCancellationNote', () => {
  it('appends a tagged line under the existing notes', () => {
    expect(appendCancellationNote('Gate code 1234', 'household away')).toBe(
      'Gate code 1234\n[Booking cancelled] household away',
    );
  });

  it('is the only line when the session had no notes', () => {
    expect(appendCancellationNote('', 'weather')).toBe('[Booking cancelled] weather');
    expect(appendCancellationNote(undefined, 'weather')).toBe('[Booking cancelled] weather');
  });

  it('leaves notes untouched for a blank reason', () => {
    expect(appendCancellationNote('Gate code 1234', '   ')).toBe('Gate code 1234');
    expect(appendCancellationNote(undefined, '')).toBe('');
  });

  it('never drops the prior notes', () => {
    const prior = 'line one\nline two';
    expect(appendCancellationNote(prior, 'x')).toContain(prior);
  });
});
