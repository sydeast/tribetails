import { useEffect, useRef, useState } from 'react';
import { patchVisitLifecycle, type VisitLifecycleAction } from '../api/sessionsWrite';
import { lifecycleNowIso, type LifecycleActionDef } from './sessionLifecycle';
import { type VisitLifecycleSession } from './visitLifecyclePatch';
import { beginVisitTracking, endVisitTracking, stopVisitTracking } from './visitTracking';

/**
 * The visit clock, as one hook, shared by the two surfaces that drive it.
 *
 * IT LIVES HERE RATHER THAN INSIDE `SessionDetail.tsx` BECAUSE THE BOARD DRIVES
 * IT TOO. Issue #703 put the lifecycle buttons back on the Auntie Time card,
 * where the mock has always had them, and the one thing that must NOT happen is
 * a second implementation of the same four writes: two copies of "is this a
 * no-op?" would drift, and the copy that drifts is the one that tells an
 * operator a household was notified when it was not.
 *
 * WHAT IT OWNS, and what it deliberately does not:
 *   owns   the confirm gate (`ask` / `dismiss` / `confirm`), the write, and the
 *          sentence the operator reads afterwards.
 *   not    the dialog markup or the buttons. Both callers render their own,
 *          because a sheet's action row and a card's inline row are not the
 *          same layout, and a hook that returned JSX would decide that for them.
 *
 * IT TAKES THE SESSION, NOT AN ID, and that is the change that removed the cold
 * start. `api/sessionsWrite.ts#patchVisitLifecycle` writes the status straight
 * to Firestore, so the decision -- is this legal, is it a no-op, where does an
 * undo rewind to, who gets the push -- is made against the row the screen is
 * already holding. Handing the hook a bare id would have meant reading the
 * document back first, and a `getDoc` in a dead zone waits out the SDK's own
 * "is the backend reachable" timeout before it falls back to cache: a different
 * stall, in exactly the conditions this change exists for. Android does not
 * read either; `runOnSession(sessionId) { card -> }` decides from the card.
 *
 * THE BUTTONS ARE A COURTESY. THE RULES ARE THE GUARD.
 * `lib/sessionLifecycle.ts#lifecycleActionsFor` only OFFERS what applies to the
 * state being rendered, `lib/visitLifecyclePatch.ts` refuses the rest before a
 * write leaves the browser, and `mytribe/firestore.rules:487` is what actually
 * stops a client writing anything terminal. COMPLETE and CANCEL never come
 * through here at all: `transitionBookingStatus` owns them, server-side, and
 * the screens call it directly.
 */

export type LifecycleWriteState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string };

export interface VisitLifecycleController {
  /** The action awaiting confirmation, or `null`. The caller renders the dialog. */
  pending: LifecycleActionDef | null;
  /** The last write's outcome. Reset by `ask`, and whenever the session changes. */
  write: LifecycleWriteState;
  /** True while a write is in flight; every clock control should be disabled. */
  saving: boolean;
  /**
   * Re-run the write that is in flight, for the "Sync now" offer a clock
   * control shows once the wait passes `lib/slowWait.ts#SLOW_WAIT_MS` (operator
   * ruling, 2026-09-12). `null` when nothing is in flight.
   *
   * SAFE TO PRESS TWICE, and that is a property of the write rather than a
   * hope. `patchVisitLifecycle` decides against the row the screen is already
   * holding and returns `changed: false` WITHOUT writing when the action is
   * already true -- the same guard that stops a double clock-in from moving the
   * arrival time. So a re-attempt that races a first attempt which did land
   * reports "Already ARRIVED. Nothing was changed", never a second arrival.
   *
   * This is the only WRITE in either app that a sync offer is pointed at.
   * Writes that CREATE are not idempotent, because nothing client-side can
   * abort a request already away, so those offer a re-READ instead. See the
   * rule on `components/SlowWaitNotice.tsx`.
   *
   * It deliberately does NOT re-run the location side effects that `confirm`
   * fires (`beginVisitTracking` and friends). Those are tied to the browser's
   * gesture-scoped location prompt and to a watch that is already running; a
   * sync is a re-send of the Firestore write, not a second clock-in.
   */
  retry: (() => void) | null;
  /** Open the confirm gate on one action, clearing whatever the last one said. */
  ask: (action: LifecycleActionDef) => void;
  /** Close the confirm gate without writing. */
  dismiss: () => void;
  /** Close the gate and run the pending action. No-op when nothing is pending. */
  confirm: () => void;
}

/** `err.message` when there is one, else a plain sentence. Never an empty string. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'Unknown error.';
}

/**
 * @param session   the visit being clocked, or `null` when none is resolved yet
 *                  (a deep link whose read has not landed). Every call is a
 *                  no-op while it is null rather than a write to a guessed id.
 * @param household the name the confirm copy and the result sentence use.
 * @param onWritten runs after a write that CHANGED something. Both callers pass
 *                  a refresh here: `usePagedCollection` is a one-shot `getDocs`
 *                  and `useDocById` is a live subscription, so the board would
 *                  otherwise keep painting the status the row was fetched with
 *                  while its buttons offered the transitions of that old state.
 */
export function useVisitLifecycle(
  session: VisitLifecycleSession | null,
  household: string,
  onWritten?: () => void,
): VisitLifecycleController {
  const [pending, setPending] = useState<LifecycleActionDef | null>(null);
  const [write, setWrite] = useState<LifecycleWriteState>({ status: 'idle' });
  const sessionId = session?._id ?? null;
  /**
   * The action whose write is currently in flight, so "Sync now" knows what to
   * re-send. A ref rather than state: it is read inside an event handler, never
   * rendered, and putting it in state would re-render every clock control on
   * the board for a value none of them draw.
   */
  const inFlight = useRef<VisitLifecycleAction | null>(null);

  /**
   * Which write the notification sentence is still allowed to finish.
   *
   * The push settles AFTER the write does, by design, so by the time it lands
   * the operator may have pressed something else or opened another visit.
   * Stamping each write and checking the stamp is what stops a stale dispatch
   * from overwriting a newer sentence -- or from appending "the Wrens were
   * notified" underneath a visit that is not theirs.
   */
  const writeSeq = useRef(0);

  // A different visit inherits nothing: neither a half-open confirm nor the
  // sentence the LAST visit's clock-in produced. Keyed on the id alone, which
  // is the same rule SessionDetail's own form re-seed already follows.
  useEffect(() => {
    writeSeq.current += 1;
    setPending(null);
    setWrite({ status: 'idle' });
  }, [sessionId]);

  /** Resolves true once the row is where the action put it. */
  async function run(action: VisitLifecycleAction): Promise<boolean> {
    if (session === null) return false;
    const seq = (writeSeq.current += 1);
    inFlight.current = action;
    setWrite({ status: 'saving' });
    try {
      const res = await patchVisitLifecycle(session, action, { nowIso: lifecycleNowIso() });

      // `changed: false` is a real outcome, not a failure: the action was
      // already true and NOTHING was written, which is what stops a double
      // clock-in from moving the arrival time. Saying "clocked in" there would
      // claim a write that did not happen.
      if (!res.changed) {
        setWrite({
          status: 'done',
          message: `Already ${res.status}. Nothing was changed, and the time already on file is unchanged.`,
        });
        return true;
      }

      // THE STATUS SENTENCE LANDS THE MOMENT THE WRITE DOES, and says nothing
      // about the household yet. The push is still in flight; claiming it here
      // would be exactly the lie this hook exists to prevent.
      setWrite({ status: 'done', message: `${res.from} → ${res.status}.` });
      if (onWritten) onWritten();

      // The second half, once the dispatch actually settles. It never rejects,
      // so there is no catch: a failed push comes back as `notified: false`.
      void res.notification.then((outcome) => {
        if (writeSeq.current !== seq) return;
        setWrite({
          status: 'done',
          message: `${res.from} → ${res.status}.${
            outcome.notified ? ` ${household} was notified.` : ' The household was not notified.'
          }`,
        });
      });
      return true;
    } catch (err) {
      if (writeSeq.current === seq) setWrite({ status: 'error', message: messageOf(err) });
      return false;
    }
  }

  return {
    pending,
    write,
    saving: write.status === 'saving',
    // Offered only while a write is actually in flight: a sync button on a
    // settled clock would re-send a transition the operator did not ask for.
    retry:
      write.status === 'saving' && inFlight.current !== null
        ? () => {
            const action = inFlight.current;
            if (action !== null) void run(action);
          }
        : null,
    ask: (action) => {
      setWrite({ status: 'idle' });
      setPending(action);
    },
    dismiss: () => setPending(null),
    confirm: () => {
      if (pending === null) return;
      const action = pending.action;
      setPending(null);
      const accepted = run(action);
      // Still inside the confirm click, on purpose (#772): the browser ties
      // its location prompt to a user gesture, and `beginVisitTracking` asks
      // for the first fix synchronously. The write above runs alongside;
      // a denied location still arrives the visit, untracked. Departing writes
      // the last fix and stops the watch; an undo stops it with no fix.
      if (sessionId === null) return;
      if (action === 'ARRIVED') beginVisitTracking(sessionId, accepted);
      else if (action === 'DEPARTED') endVisitTracking(sessionId, accepted);
      else if (action === 'UNDO_ARRIVAL') {
        void accepted.then((ok) => {
          if (ok) stopVisitTracking(sessionId);
        });
      }
    },
  };
}
