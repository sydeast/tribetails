import { useEffect, useRef, useState } from 'react';

/**
 * When a wait has gone on long enough to stop being a wait and start being a
 * question, and what the operator is offered at that point.
 *
 * THE RULING THIS IMPLEMENTS (operator, 2026-09-12), on whether a status tap
 * should paint the new state before the server confirms it:
 *
 *   "nah wait for servers or a tap to sync option if server access is taking
 *    too long and any waits/delays/etc need to have some sort of loading icon"
 *
 * Three parts, and this module is the second one. The first -- stay pessimistic,
 * never paint a status optimistically -- is a thing we DON'T build, and the
 * existing write paths (`lib/useVisitLifecycle.ts`, `api/sessionsWrite.ts`)
 * already have it right: the button disables, the write goes, the sentence
 * lands afterwards. The third -- every wait shows a loading icon -- is
 * `components/Spinner.tsx` reaching the rest of the app, which #714 started and
 * stopped after Settings. What was missing entirely is the middle: a wait that
 * runs long has, today, no way forward at all. It spins until the operator
 * reloads the tab.
 *
 * WHERE 10 SECONDS COMES FROM. Two measurements on this project, not taste:
 *
 *   7.9s - 9.4s   the measured cold start of a callable on this project, the
 *                 number #714 was filed about. A wait shorter than this is a
 *                 NORMAL cold start and must not be dressed up as a fault;
 *                 offering "tap to sync" at 5s would fire on almost every first
 *                 call of a session and train the operator to tap through a
 *                 healthy wait.
 *   20_000ms      `lib/fns.ts#CALLABLE_TIMEOUT_MS`, the hard client budget. Past
 *                 it a callable rejects with `CallableTimeoutError` and the
 *                 error path takes over, so an escalation offered later than
 *                 this would never be seen.
 *
 * 10s sits above the worst measured healthy cold start (9.4s) by a margin, and
 * leaves the other 10s of the callable budget for the operator to actually read
 * the affordance and use it. One tier, deliberately: a second, later tier would
 * be a third thing on screen for a wait that already has a way out.
 *
 * A FIRESTORE LISTEN HAS NO 20s BUDGET, and that is the case this exists for
 * most. `CALLABLE_TIMEOUT_MS` bounds `lib/fns.ts`; it bounds nothing about
 * `onSnapshot`. A subscription that never delivers a first snapshot -- a wedged
 * connection, a permission change mid-session, a laptop resumed from sleep --
 * spins forever with no error to render, which is precisely the "indefinite
 * spinner with no way forward" the ruling refuses.
 *
 * OFFLINE IS NOT A SLOW SERVER, and the phase machine below will not confuse
 * them. A device with no signal reaching 10s is not waiting on a slow backend
 * and must not be handed a Sync button that cannot work; it gets the offline
 * treatment that already exists (`components/RouteError.tsx` here,
 * `lib/queryState.ts` + `components/OfflineNotice.tsx` in the portal, PR #805).
 * `navigator.onLine` is the discriminator both apps already use for exactly
 * this split, so this uses it too rather than inventing a second signal.
 */
export const SLOW_WAIT_MS = 10_000;

/**
 * What a region that is waiting should show. Exactly one at a time.
 *
 * Note there is no 'offline' member. That is not this module's decision to
 * make: a caller that is offline already has a state for it, and the only thing
 * this module owes that caller is a promise never to escalate underneath it.
 */
export type WaitPhase =
  /** Nothing in flight. */
  | 'idle'
  /** In flight, and not yet long enough to be worth remarking on. */
  | 'waiting'
  /** In flight past [SLOW_WAIT_MS] on a device that has signal. Offer the sync. */
  | 'slow';

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
 * The whole decision, as a pure function of four numbers.
 *
 * Pure and injected-clock on purpose: this is the rule the operator's ruling
 * turns into, and a rule that can only be exercised by rendering a component
 * and pushing fake timers is a rule that gets tested once and then trusted. Every
 * surface in all four clients -- two React apps, two Compose apps -- resolves to
 * this same three-way answer, and the Kotlin twin
 * (`SlowWait.kt`, both trees) is a line-for-line port for the same reason.
 */
export function waitPhase({ startedAt, now, online, thresholdMs = SLOW_WAIT_MS }: WaitInput): WaitPhase {
  if (startedAt === null) return 'idle';
  // Offline never escalates. A Sync button on a phone with no bars is a button
  // that fails the moment it is pressed, and the offline states in both apps
  // already say the true thing.
  if (!online) return 'waiting';
  return now - startedAt >= thresholdMs ? 'slow' : 'waiting';
}

export interface SlowWait {
  phase: WaitPhase;
  /**
   * How many times the operator has asked for a re-attempt during THIS wait.
   * 0 while the app is still on its own first try. The label changes at 1 --
   * "Syncing…" rather than "Loading…" -- because a tap that produces no visible
   * difference reads as a dead button, which is the failure mode a manual sync
   * is supposed to cure.
   */
  attempt: number;
  /**
   * Ask again. Re-runs the caller's [retry], resets the clock, and bumps
   * [attempt] so the caller can say what it is doing. Safe to call when there
   * is no retry: it still restarts the wait rather than doing nothing visible.
   */
  sync: () => void;
  /** True when a [retry] was supplied, i.e. the affordance can be offered. */
  canSync: boolean;
}

/**
 * Track one in-flight wait and escalate it when it runs long.
 *
 * @param active true while the thing is in flight. Going false ends the wait and
 *               resets everything; going true again starts a fresh one.
 * @param retry  what "tap to sync" does. For a Firestore subscription this is a
 *               re-subscribe (bump the nonce in the hook's effect deps); for a
 *               callable it is the call again. See the idempotency note on
 *               `components/SlowWaitNotice.tsx` before wiring this to a WRITE.
 *
 * The timer is a single `setTimeout` rather than an interval: nothing between
 * "started" and "slow" changes on screen, so there is nothing to re-render for,
 * and a per-second tick on every waiting region in the app would be real work
 * for no pixels. `online` is read from the two window events both apps already
 * treat as the truth, so a wait that starts offline and regains signal
 * escalates on the remaining time rather than being stuck at 'waiting'.
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

  // Start and stop the wait. Keyed on `active` alone: a wait that is still the
  // same wait must not have its clock reset by an unrelated re-render, which is
  // what would happen if this depended on the caller's retry identity.
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
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // One shot, re-armed whenever the clock restarts. `tick` exists only to force
  // the re-render that makes `waitPhase` recompute; the phase itself is never
  // stored, so there is exactly one place the threshold is applied.
  useEffect(() => {
    if (startedAt === null) return;
    const remaining = startedAt + thresholdMs - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(id);
  }, [startedAt, thresholdMs, tick]);

  const phase = waitPhase({ startedAt, now: Date.now(), online, thresholdMs });

  return {
    phase,
    attempt,
    canSync: retry !== undefined,
    sync: () => {
      setAttempt((n) => n + 1);
      setStartedAt(Date.now());
      retryRef.current?.();
    },
  };
}
