import { useEffect, useState } from 'react';
import {
  patchVisitLifecycle,
  startVisitWithRangeCheck,
  undoArrivalThroughServer,
  verifyVisitArrival,
  type StartFix,
  type VisitLifecycleAction,
} from '../api/sessionsWrite';
import { useArrivalRule } from './useArrivalRule';
import {
  START_NEEDS_PROPERTY_MESSAGE,
  isRulesRefusal,
  ownerOutsideRangeSentence,
  requestStartFix,
  startsVisit,
} from './visitStartRange';
import {
  UNDO_ARRIVAL_CHECKING,
  undoArrivalDoneSentence,
  lifecycleNowIso,
  type LifecycleActionDef,
  type UndoneArrivalNotices,
} from './sessionLifecycle';
import {
  announceVisitClock,
  beginVisitClockWrite,
  clearVisitClockWrite,
  visitClockInFlight,
  settleVisitClockWrite,
  useVisitClockState,
  visitClockState,
  type LifecycleWriteState,
} from './visitClockOutcome';
import {
  actionNotifiesHousehold,
  visitAlreadySentence,
  visitMovedSentence,
  visitNoticeOutcomeSentence,
} from './visitNotice';
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

export type { LifecycleWriteState };

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
   * reports "Already arrived. Nothing was changed", never a second arrival.
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
 * @param auntie    an Auntie is signed in (#2185), so the result sentence names
 *                  the owner rather than Settings. The screen asks once.
 *
 * #2279, operator ruling 2026-11-14: AN AUNTIE CANNOT START A VISIT OUTSIDE THE
 * RANGE OF THE HOUSEHOLD; ONLY THE OWNER CAN. With "Verify arrival and
 * departure" on, her On my way and Arrived go to the server with her position
 * (`startVisitWithRangeCheck`) instead of being written from the browser, and
 * the server refuses them outside the range in a sentence this hook shows as
 * it is. The rule being unknown (still loading, or the read failed) counts as
 * on: the server then decides, and with the rule off it lets her through.
 * Departed is untouched. Her Undo arrival goes to the server under the same
 * switch (#2038), which also takes the arrival's notice off the household's
 * notifications list. The owner keeps the direct write on
 * every step; an owner's arrival is measured afterwards, so one outside the
 * range is recorded on the visit and in the Activity Log.
 */
export function useVisitLifecycle(
  session: VisitLifecycleSession | null,
  household: string,
  onWritten?: () => void,
  auntie = false,
): VisitLifecycleController {
  const [pending, setPending] = useState<LifecycleActionDef | null>(null);
  const sessionId = session?._id ?? null;
  const arrivalRule = useArrivalRule();
  /**
   * #2279: the rules refused her own start write, so the rule is on whatever
   * this screen's minute-old read says. Every start after that goes through
   * the server.
   */
  const [rulesRefusedStart, setRulesRefusedStart] = useState(false);
  /** Does this Auntie's start go to the server to be measured? */
  const startIsMeasured = (action: VisitLifecycleAction): boolean =>
    auntie && startsVisit(action) && (arrivalRule !== false || rulesRefusedStart);
  /**
   * #2038: does this Auntie's Undo arrival go to the server? The same switch:
   * with the rule on the rules refuse her that write from the browser, and the
   * server rewinds the visit and withdraws the arrival's notice in one call.
   */
  const undoGoesToServer = (action: VisitLifecycleAction): boolean =>
    auntie && action === 'UNDO_ARRIVAL' && (arrivalRule !== false || rulesRefusedStart);
  /**
   * The last write's outcome, held in `lib/visitClockOutcome.ts` keyed by the
   * session id rather than in this component (#1794). The board unmounts a card
   * between its write and its notification settling (a reload, and a move to
   * another phase), so a sentence kept here was lost. The remounted card reads
   * the same entry.
   */
  const write = useVisitClockState(sessionId);
  /**
   * The action whose write is currently in flight, so "Sync now" knows what to
   * re-send. Read from the same store as `write` (#1794), so a card that
   * remounts mid-write still has its sync offer rather than a dead saving row.
   */
  const inFlight = visitClockInFlight(sessionId) as VisitLifecycleAction | null;

  // A different visit inherits no half-open confirm. Its sentence is keyed by
  // its own id in the store, so it inherits none of that either, and the store
  // stamps each write so a stale dispatch cannot overwrite a newer sentence.
  useEffect(() => {
    setPending(null);
  }, [sessionId]);

  /**
   * Resolves true once the row is where the action put it.
   *
   * @param fix the position asked for inside the confirm click (#2279), when
   *            this step wants one. A "Sync now" re-send has none and asks
   *            again; the permission is already in hand by then.
   */
  async function run(action: VisitLifecycleAction, fix?: Promise<StartFix | null>): Promise<boolean> {
    if (session === null) return false;
    const id = session._id;
    const seq = beginVisitClockWrite(id, action);
    const measured = startIsMeasured(action);
    try {
      const res =
        measured && startsVisit(action)
          ? await startVisitWithRangeCheck(session, action, {
              nowIso: lifecycleNowIso(),
              fix: await (fix ?? requestStartFix()),
            })
          : undoGoesToServer(action)
            ? await undoArrivalThroughServer(session)
            : await patchVisitLifecycle(session, action, { nowIso: lifecycleNowIso() }).catch((err: unknown) => {
                // #2038: the rules refused her own undo, so the rule was
                // switched on after this screen last read it. An undo needs
                // no position, so it goes straight to the server.
                if (auntie && action === 'UNDO_ARRIVAL' && isRulesRefusal(err)) {
                  setRulesRefusedStart(true);
                  return undoArrivalThroughServer(session);
                }
                throw err;
              });

      // `changed: false` is a real outcome, not a failure: the action was
      // already true and NOTHING was written, which is what stops a double
      // clock-in from moving the arrival time. Saying "clocked in" there would
      // claim a write that did not happen.
      if (!res.changed) {
        settleVisitClockWrite(id, seq, {
          status: 'done',
          message: visitAlreadySentence(res.status),
        });
        return true;
      }

      // THE STATUS SENTENCE LANDS THE MOMENT THE WRITE DOES, and says nothing
      // about the household yet. The push is still in flight; claiming it here
      // would be exactly the lie this hook exists to prevent.
      // #1814: in words, never the stored keys.
      const moved = visitMovedSentence(res.from, res.status);
      // #2037: while the server's answer about the household is on its way,
      // the card says it is checking, so the wait is never a silent one.
      const checking = actionNotifiesHousehold(action)
        ? ` ${household === '' ? 'Checking who was told.' : `Checking whether ${household} was told.`}`
        : '';
      // #2357: what an undo took off the household's notifications list is
      // the server's to say. `undefined` is "still checking", `null` is "no
      // record came", and the sentence claims an entry came off only when the
      // record names one.
      let undone: UndoneArrivalNotices | null | undefined = res.undone === undefined ? null : undefined;
      const undoNotice = (): string =>
        undone === undefined ? UNDO_ARRIVAL_CHECKING : undoArrivalDoneSentence(undone, res.from === 'DEPARTED');
      settleVisitClockWrite(id, seq, {
        status: 'done',
        message: action === 'UNDO_ARRIVAL' ? `${moved} ${undoNotice()}` : `${moved}${checking}`,
      });
      if (onWritten) onWritten();

      // The sentence has up to three parts that land at different times: the
      // move (now), what the household was told, and (#2279) an owner's arrival
      // outside the range. Each one re-says the whole sentence from what is
      // known so far, so neither late part can erase the other.
      let said: string | null = null;
      let rangeNote = '';
      const resay = (): void => {
        // #2038: an undo tells the household nothing, and the card says so.
        const notice = action === 'UNDO_ARRIVAL' ? undoNotice() : said === null ? checking.trim() : said;
        const message = [moved, notice, rangeNote].filter((part) => part !== '').join(' ');
        settleVisitClockWrite(id, seq, { status: 'done', message });
      };

      // The second half, once the server has recorded what the household was
      // told (#2037: the server sends the notice from the saved step). It never
      // rejects, so there is no catch.
      // Written to the STORE, not to this component, which may have unmounted.
      void res.notification.then((outcome) => {
        said = visitNoticeOutcomeSentence(outcome, household, auntie);
        resay();
        // #1815: and once more where the operator is looking, unless a newer
        // write on this visit has already replaced the sentence.
        const now = visitClockState(id);
        if (now.status === 'done' && now.message.includes(said)) announceVisitClock(id, now.message);
      });

      // #2357: and, for an undo, what came off their notifications list.
      if (action === 'UNDO_ARRIVAL' && res.undone !== undefined) {
        void res.undone.then((off) => {
          undone = off;
          resay();
        });
      }

      // #2279: the owner's arrival is measured AFTER it lands, best effort, as
      // Android Home does. It cannot fail or undo the arrival. An Auntie's
      // measured start was already checked by the server on the way in.
      if (!auntie && action === 'ARRIVED' && fix !== undefined) {
        void fix
          .then((position) => (position === null ? null : verifyVisitArrival(id, position)))
          .then((check) => {
            if (check === null) return;
            rangeNote = ownerOutsideRangeSentence(check);
            if (rangeNote !== '') resay();
          })
          .catch(() => {
            // No measurement. The arrival stands and completes as unverified.
          });
      }
      return true;
    } catch (err) {
      // #2279: the rules refused an Auntie's own start write. The rule was
      // switched on after this screen last read it; say what it means, and
      // send her next tap through the server.
      if (auntie && startsVisit(action) && !measured && isRulesRefusal(err)) {
        setRulesRefusedStart(true);
        settleVisitClockWrite(id, seq, { status: 'error', message: START_NEEDS_PROPERTY_MESSAGE });
        return false;
      }
      settleVisitClockWrite(id, seq, { status: 'error', message: messageOf(err) });
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
      write.status === 'saving' && inFlight !== null
        ? () => {
            void run(inFlight);
          }
        : null,
    ask: (action) => {
      if (sessionId !== null) clearVisitClockWrite(sessionId);
      setPending(action);
    },
    dismiss: () => setPending(null),
    confirm: () => {
      if (pending === null) return;
      const action = pending.action;
      setPending(null);
      // #2279: asked for HERE, synchronously, for the same reason the tracker
      // below is: the browser ties its location prompt to this click. An
      // Auntie's measured start sends it to the server; the owner's arrival is
      // measured with it afterwards. No other step asks.
      const wantsFix =
        startIsMeasured(action) || (!auntie && action === 'ARRIVED' && arrivalRule !== false);
      const accepted = run(action, wantsFix ? requestStartFix() : undefined);
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
