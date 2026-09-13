import { describe, expect, it } from 'vitest';
import { SLOW_WAIT_MS, waitPhase } from './slowWait';

/**
 * The threshold decision, exercised as a decision table with no React, no
 * jsdom and no fake timers -- the same way `lib/async.ts` and the portal's
 * `lib/queryState.ts` are tested, and for the same reason: this is the rule the
 * operator's ruling turns into, and a rule that can only be reached by
 * rendering a component and pushing timers gets tested once and then trusted.
 */
describe('waitPhase', () => {
  const online = true;

  it('is idle when nothing is in flight', () => {
    expect(waitPhase({ startedAt: null, now: 1_000_000, online })).toBe('idle');
  });

  it('is waiting the instant a wait starts', () => {
    expect(waitPhase({ startedAt: 1_000_000, now: 1_000_000, online })).toBe('waiting');
  });

  /**
   * The measured cold start on this project is 7.9s to 9.4s. A healthy cold
   * start must NOT be dressed up as a fault, or the operator learns to tap
   * through a wait that was always going to land on its own.
   */
  it('stays waiting across the whole measured cold-start range', () => {
    for (const elapsed of [7_900, 8_500, 9_400, 9_999]) {
      expect(waitPhase({ startedAt: 0, now: elapsed, online })).toBe('waiting');
    }
  });

  it('escalates exactly at the threshold', () => {
    expect(waitPhase({ startedAt: 0, now: SLOW_WAIT_MS - 1, online })).toBe('waiting');
    expect(waitPhase({ startedAt: 0, now: SLOW_WAIT_MS, online })).toBe('slow');
  });

  /**
   * 10s leaves the other half of `lib/fns.ts#CALLABLE_TIMEOUT_MS` (20s) for the
   * operator to read the affordance and use it. An escalation offered later
   * than the budget would never be seen, because the callable would already
   * have rejected into the error path.
   */
  it('escalates with the callable budget still running', () => {
    const CALLABLE_TIMEOUT_MS = 20_000;
    expect(SLOW_WAIT_MS).toBeLessThan(CALLABLE_TIMEOUT_MS);
    expect(waitPhase({ startedAt: 0, now: CALLABLE_TIMEOUT_MS - 1, online })).toBe('slow');
  });

  /**
   * THE DISCRIMINATING CASE. A device with no signal is not waiting on a slow
   * server, and must never be handed a Sync button that cannot work. Offline
   * keeps its own treatment (PR #805 in the portal, RouteError here).
   */
  it('never escalates while offline, however long the wait', () => {
    expect(waitPhase({ startedAt: 0, now: 60_000, online: false })).toBe('waiting');
    expect(waitPhase({ startedAt: 0, now: 600_000, online: false })).toBe('waiting');
  });

  it('escalates on the remaining time when signal returns mid-wait', () => {
    // Started offline, 30s ago; the connection is back, so the wait is now a
    // slow server and is allowed to say so.
    expect(waitPhase({ startedAt: 0, now: 30_000, online: true })).toBe('slow');
  });

  it('honours a caller-supplied threshold', () => {
    expect(waitPhase({ startedAt: 0, now: 2_000, online, thresholdMs: 3_000 })).toBe('waiting');
    expect(waitPhase({ startedAt: 0, now: 3_000, online, thresholdMs: 3_000 })).toBe('slow');
  });
});
