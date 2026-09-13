import { describe, expect, it } from 'vitest';
import {
  LostSignalError,
  OfflineMutationError,
  errorLine,
  isOfflinePhase,
  phaseOfMutation,
  type MutationSnapshot,
} from './mutationState';

/**
 * The write-side decision table, tested the way `queryState.test.ts` tests the
 * read side: object literals, no React, no jsdom, no QueryClient. The rule this
 * file pins is the whole of #807, so it must be reachable without rendering
 * anything.
 */

function snap(over: Partial<MutationSnapshot> = {}): MutationSnapshot {
  return { isPending: false, isPaused: false, isError: false, error: null, ...over };
}

describe('phaseOfMutation', () => {
  it('is idle before anything is tapped', () => {
    expect(phaseOfMutation(snap())).toBe('idle');
  });

  it('is sending while the server really has it', () => {
    expect(phaseOfMutation(snap({ isPending: true }))).toBe('sending');
  });

  /**
   * THE DEFECT, as one assertion. React Query's default `networkMode: 'online'`
   * pauses a mutation started with no connection: `isPending` stays true and
   * `isError` stays false, forever. Every portal button read that `isPending`
   * and printed "Saving…".
   */
  it('is queued, NOT sending, for a mutation paused offline', () => {
    expect(phaseOfMutation(snap({ isPending: true, isPaused: true }))).toBe('queued');
  });

  it('is blocked when the preflight refused to dial', () => {
    const phase = phaseOfMutation(snap({ isError: true, error: new OfflineMutationError('your payment') }));
    expect(phase).toBe('blocked');
  });

  it('is unknown when the signal went after the request was away', () => {
    const phase = phaseOfMutation(snap({ isError: true, error: new LostSignalError('your payment') }));
    expect(phase).toBe('unknown');
  });

  it('is failed for a server error, which is a real answer', () => {
    expect(phaseOfMutation(snap({ isError: true, error: new Error('invoice not found') }))).toBe('failed');
  });

  /**
   * The latch, which is why `LostSignalError` is a class rather than a question
   * asked at render time. A phase computed from a live `isOnline()` would turn
   * "we can't tell whether this reached us" into "Couldn't open checkout. Try
   * again." the moment the signal returned -- a re-tap invitation about a
   * payment that may already have gone through, delivered at the one moment
   * they can act on it.
   */
  it('stays unknown after the connection comes back', () => {
    const failed = snap({ isError: true, error: new LostSignalError('your payment') });
    expect(phaseOfMutation(failed)).toBe('unknown');
    // Nothing about the world changed except the network, and the verdict does
    // not move: it is read off the error, not off `navigator`.
    expect(phaseOfMutation(failed)).toBe('unknown');
    expect(isOfflinePhase(phaseOfMutation(failed))).toBe(true);
  });
});

describe('errorLine', () => {
  it('gives the server its own sentence back', () => {
    const line = errorLine(snap({ isError: true, error: new Error('Credit already redeemed.') }), 'fallback');
    expect(line).toBe('Credit already redeemed.');
  });

  it('falls back when the error carries no message', () => {
    expect(errorLine(snap({ isError: true, error: new Error('') }), 'Try again.')).toBe('Try again.');
  });

  /**
   * The rule that keeps two contradictory sentences off one button. Every
   * offline phase already renders `OfflineMutationNotice`, which says something
   * truer than a generic retry prompt.
   */
  it('says nothing for the offline phases, which have their own notice', () => {
    expect(errorLine(snap({ isError: true, error: new OfflineMutationError('x') }), 'Try again.')).toBeNull();
    expect(errorLine(snap({ isError: true, error: new LostSignalError('x') }), 'Try again.')).toBeNull();
  });

  it('says nothing while the write is merely queued', () => {
    expect(errorLine(snap({ isPending: true, isPaused: true }), 'Try again.')).toBeNull();
  });
});
