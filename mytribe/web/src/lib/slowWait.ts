import { useEffect, useRef, useState } from 'react';
import type { PortalView } from './queryState';

/**
 * When a wait has gone on long enough to stop being a wait and start being a
 * question. The portal's half of the 2026-09-12 ruling.
 *
 *   "nah wait for servers or a tap to sync option if server access is taking
 *    too long and any waits/delays/etc need to have some sort of loading icon"
 *
 * This is the twin of `auntieos-admin/src/lib/slowWait.ts`, deliberately
 * duplicated rather than shared, exactly as `queryState.ts` is the twin of that
 * app's `lib/async.ts`. The two trees ship separately, their loading vocabulary
 * is each app's own, and a shared package for thirty lines of arithmetic would
 * buy less than it costs. What must not drift is the NUMBER and the offline
 * rule, so both are restated here in full rather than referred to.
 *
 * WHERE 10 SECONDS COMES FROM. Two measurements on this project, not taste:
 *
 *   7.9s - 9.4s   the measured cold start of a callable here. A wait shorter
 *                 than this is a NORMAL cold start; offering a sync at 5s would
 *                 fire on nearly every first read of a session and teach a
 *                 household to tap through a healthy wait.
 *   20_000ms      `auntieos-admin/src/lib/fns.ts#CALLABLE_TIMEOUT_MS`, the hard
 *                 client budget on the shared callables. Past it the call
 *                 rejects and the error path takes over, so an escalation
 *                 offered later than that would never be seen.
 *
 * 10s clears the worst measured healthy cold start with margin and still leaves
 * half the budget for somebody to read the offer and use it.
 *
 * OFFLINE IS NOT A SLOW SERVER, AND THIS MODULE WILL NOT LET THEM BE CONFUSED.
 * That distinction is the whole subject of `lib/queryState.ts` and PR #805: a
 * paused read is not a failed one, and a household with no signal gets
 * `components/OfflineNotice.tsx`, which deliberately has NO retry button
 * because `refetch()` on a paused query goes straight back to `pause()`. A
 * "Tap to sync" button in that state would be the same dead button wearing a
 * different label. So the escalation is gated twice over: `viewOfQuery` has
 * already separated 'offline' from 'loading' before this module sees anything,
 * and [waitPhase] refuses to escalate while `navigator.onLine` is false even if
 * a caller gets that wiring wrong.
 */
export const SLOW_WAIT_MS = 10_000;

/**
 * What a waiting region should show. No 'offline' member on purpose: that
 * decision belongs to `viewOfQuery`, which made it before this ran.
 */
export type WaitPhase = 'idle' | 'waiting' | 'slow';

export interface WaitInput {
  /** When the current wait began, or `null` when nothing is in flight. */
  startedAt: number | null;
  /** `Date.now()` at evaluation. Injected so the decision is testable. */
  now: number;
  /** `navigator.onLine`. False pins the phase at 'waiting'; see the header. */
  online: boolean;
  thresholdMs?: number;
}

/**
 * The whole decision, as a pure function of four numbers, testable from a plain
 * node spec with object literals -- the same property `queryState.ts` was built
 * for, for the same reason.
 */
export function waitPhase({ startedAt, now, online, thresholdMs = SLOW_WAIT_MS }: WaitInput): WaitPhase {
  if (startedAt === null) return 'idle';
  if (!online) return 'waiting';
  return now - startedAt >= thresholdMs ? 'slow' : 'waiting';
}

/**
 * True when this view is the kind of wait that may escalate.
 *
 * 'idle' counts. A query held behind `enabled:` whose gate never lands looks
 * exactly like a slow read from the sofa, and leaving it out would exempt the
 * one case with no other way forward at all.
 */
export function isWaiting(view: Pick<PortalView<unknown>, 'kind'>): boolean {
  return view.kind === 'loading' || view.kind === 'idle';
}

export interface SlowWait {
  phase: WaitPhase;
  /**
   * How many times "Tap to sync" has been pressed during THIS wait. 0 while the
   * app is still on its own first try. The copy changes at 1, because a tap
   * that produces no visible difference reads as a dead button -- which is the
   * failure the affordance exists to cure.
   */
  attempt: number;
  /** Ask again: re-runs the caller's retry, restarts the clock, bumps [attempt]. */
  sync: () => void;
  /** True when a retry was supplied, i.e. the affordance can be offered. */
  canSync: boolean;
}

/**
 * Track one in-flight wait and escalate it when it runs long.
 *
 * @param active true while the read is in flight. Pass `isWaiting(view)`; going
 *               false ends the wait and resets, going true starts a fresh one.
 * @param retry  what "Tap to sync" does. For a React Query read this is
 *               `query.refetch`. Safe for any READ. Before pointing it at a
 *               mutation, see the idempotency note on `SlowWaitNotice.tsx`.
 *
 * One `setTimeout`, not an interval: nothing on screen changes between "started"
 * and "slow", so there is nothing to re-render for, and a per-second tick on
 * every waiting region of a screen would be real work for no pixels.
 */
export function useSlowWait(
  active: boolean,
  retry?: () => void,
  thresholdMs: number = SLOW_WAIT_MS,
): SlowWait {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const retryRef = useRef(retry);
  retryRef.current = retry;

  // Keyed on `active` alone: a wait that is still the same wait must not have
  // its clock reset by an unrelated re-render, which is what would happen if
  // this depended on the caller's retry identity.
  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      setAttempt(0);
      return;
    }
    setStartedAt(Date.now());
  }, [active]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => setOnline(navigator.onLine);
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    return () => {
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
    };
  }, []);

  // One shot, re-armed whenever the clock restarts. `tick` exists only to force
  // the re-render that makes `waitPhase` recompute; the phase is never stored,
  // so there is exactly one place the threshold is applied.
  useEffect(() => {
    if (startedAt === null) return;
    const remaining = startedAt + thresholdMs - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(id);
  }, [startedAt, thresholdMs, tick]);

  return {
    phase: waitPhase({ startedAt, now: Date.now(), online, thresholdMs }),
    attempt,
    canSync: retry !== undefined,
    sync: () => {
      setAttempt((n) => n + 1);
      setStartedAt(Date.now());
      retryRef.current?.();
    },
  };
}
