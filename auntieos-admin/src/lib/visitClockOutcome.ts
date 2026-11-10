import { useCallback, useSyncExternalStore } from 'react';

/**
 * #1794: the visit clock's last sentence, held OUTSIDE the card that showed it.
 *
 * WHY IT CANNOT LIVE IN THE CARD. On the Nov 10 walk the Auntie Time card never
 * said "the household was not notified", and two things unmount it between the
 * write and the notification settling:
 *
 *   1. `onWritten` reloads the board's paged read, and `usePagedCollection`
 *      sets its state to `loading` on a reload, so `AsyncRegion` swaps the whole
 *      board for its loading row. Every card unmounts.
 *   2. The card moves phase (Upcoming to Active on OMW), so it renders under a
 *      different `<li>`. React keys are per parent, so even without the reload
 *      it would be a new component with fresh state.
 *
 * The push settles after both, so its sentence was written into a component
 * that no longer existed. Keyed by session id here, the remounted card reads
 * the same entry, and the notification's continuation writes to this store
 * instead of to a `setState` that may belong to an unmounted card.
 *
 * THE SEQUENCE GUARD MOVED HERE TOO, for the same reason: the guard is what
 * stops an older dispatch overwriting a newer sentence, and a per-component ref
 * resets on remount.
 *
 * Lives for the page's lifetime. A different visit inherits nothing, because
 * the key is the session id; the same visit shows its last outcome until the
 * operator opens a new confirm on it (`ask` clears it).
 */

export type LifecycleWriteState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string };

interface Entry {
  seq: number;
  state: LifecycleWriteState;
}

const IDLE: LifecycleWriteState = { status: 'idle' };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state for one visit. `idle` for a visit nothing has been written for. */
export function visitClockState(sessionId: string | null): LifecycleWriteState {
  if (sessionId === null) return IDLE;
  return entries.get(sessionId)?.state ?? IDLE;
}

/** Start a new write on one visit. Returns the stamp its later updates must carry. */
export function beginVisitClockWrite(sessionId: string): number {
  const seq = (entries.get(sessionId)?.seq ?? 0) + 1;
  entries.set(sessionId, { seq, state: { status: 'saving' } });
  emit();
  return seq;
}

/**
 * Settle the write stamped `seq`. Ignored when a newer write (or an `ask`) has
 * started on the same visit since, so a late dispatch cannot overwrite it.
 */
export function settleVisitClockWrite(sessionId: string, seq: number, state: LifecycleWriteState): void {
  const entry = entries.get(sessionId);
  if (entry === undefined || entry.seq !== seq) return;
  entries.set(sessionId, { seq, state });
  emit();
}

/** Clear one visit's sentence and invalidate any write still settling. */
export function clearVisitClockWrite(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (entry === undefined) return;
  entries.set(sessionId, { seq: entry.seq + 1, state: IDLE });
  emit();
}

/** Forget every visit. For tests; a page reload does the same in the app. */
export function resetVisitClockOutcomes(): void {
  entries.clear();
  emit();
}

/** The live state for one visit, re-rendering when it changes. */
export function useVisitClockState(sessionId: string | null): LifecycleWriteState {
  const get = useCallback(() => visitClockState(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, get, get);
}
