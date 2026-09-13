import { describe, expect, it } from 'vitest';
import { SLOW_WAIT_MS, isWaiting, waitPhase } from './slowWait';
import { viewOfQuery } from './queryState';

/**
 * The threshold decision as a decision table -- no React, no jsdom, no
 * QueryClient -- which is the same property `queryState.test.ts` was built for
 * and for the same reason: this is the rule the operator's ruling turns into,
 * and a rule reachable only by rendering a component and pushing fake timers
 * gets tested once and then trusted.
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
   * The measured cold start here is 7.9s to 9.4s. A healthy cold start must not
   * be dressed up as a fault, or a household learns to tap through a wait that
   * was always going to land on its own.
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

  it('escalates with the 20s callable budget still running', () => {
    expect(SLOW_WAIT_MS).toBeLessThan(20_000);
    expect(waitPhase({ startedAt: 0, now: 19_999, online })).toBe('slow');
  });

  /**
   * THE DISCRIMINATING CASE, and the reason PR #805 is cited all over this
   * module. A paused read is not a slow server. `OfflineNotice` deliberately
   * has no retry button because `refetch()` on a paused query goes straight
   * back to `pause()`; a "Tap to sync" button there would be the same dead
   * button wearing a different label.
   */
  it('never escalates while offline, however long the wait', () => {
    expect(waitPhase({ startedAt: 0, now: 60_000, online: false })).toBe('waiting');
    expect(waitPhase({ startedAt: 0, now: 600_000, online: false })).toBe('waiting');
  });

  it('escalates on the remaining time when signal returns mid-wait', () => {
    expect(waitPhase({ startedAt: 0, now: 30_000, online: true })).toBe('slow');
  });
});

/**
 * The other half of the offline guard, one layer up: a paused query never
 * reaches the escalation at all, because `viewOfQuery` has already sorted it
 * into 'offline' and `isWaiting` refuses it.
 */
describe('isWaiting composes with viewOfQuery', () => {
  const paused = { status: 'pending', fetchStatus: 'paused', data: undefined } as const;
  const fetching = { status: 'pending', fetchStatus: 'fetching', data: undefined } as const;
  const idle = { status: 'pending', fetchStatus: 'idle', data: undefined } as const;
  const failed = { status: 'error', fetchStatus: 'idle', data: undefined } as const;
  const done = { status: 'success', fetchStatus: 'idle', data: [1] } as const;

  it('treats an offline pause as NOT a slow-server wait', () => {
    const view = viewOfQuery(paused);
    expect(view.kind).toBe('offline');
    expect(isWaiting(view)).toBe(false);
  });

  it('treats an in-flight read as a wait', () => {
    expect(viewOfQuery(fetching).kind).toBe('loading');
    expect(isWaiting(viewOfQuery(fetching))).toBe(true);
  });

  /**
   * 'idle' counts. A query held behind `enabled:` whose gate never landed looks
   * exactly like a slow read from the sofa, and it is the one case with no
   * other way forward at all -- so it must be allowed to escalate.
   */
  it('treats a never-asked query as a wait', () => {
    expect(viewOfQuery(idle).kind).toBe('idle');
    expect(isWaiting(viewOfQuery(idle))).toBe(true);
  });

  it('is not a wait once the read has failed or landed', () => {
    expect(isWaiting(viewOfQuery(failed))).toBe(false);
    expect(isWaiting(viewOfQuery(done))).toBe(false);
  });
});
