import { useEffect, useState } from 'react';
import { setVisitLifecycle, type VisitLifecycleAction } from '../api/sessionsWrite';
import { lifecycleNowIso, type LifecycleActionDef } from './sessionLifecycle';

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
 *   owns   the confirm gate (`ask` / `dismiss` / `confirm`), the callable, and
 *          the sentence the operator reads afterwards.
 *   not    the dialog markup or the buttons. Both callers render their own,
 *          because a sheet's action row and a card's inline row are not the
 *          same layout, and a hook that returned JSX would decide that for them.
 *
 * THE BUTTONS ARE A COURTESY, THE SERVER IS THE GUARD, unchanged and worth
 * repeating here since this is now the shared seam:
 * `lib/sessionLifecycle.ts#lifecycleActionsFor` only OFFERS what applies to the
 * state being rendered, and `functions/src/lib/visitLifecycle.ts` is what
 * refuses an illegal action from a stale row or a second operator, and audits
 * the attempt.
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
 * @param sessionId the visit being clocked, or `null` when none is resolved yet
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
  sessionId: string | null,
  household: string,
  onWritten?: () => void,
): VisitLifecycleController {
  const [pending, setPending] = useState<LifecycleActionDef | null>(null);
  const [write, setWrite] = useState<LifecycleWriteState>({ status: 'idle' });

  // A different visit inherits nothing: neither a half-open confirm nor the
  // sentence the LAST visit's clock-in produced. Keyed on the id alone, which
  // is the same rule SessionDetail's own form re-seed already follows.
  useEffect(() => {
    setPending(null);
    setWrite({ status: 'idle' });
  }, [sessionId]);

  async function run(action: VisitLifecycleAction) {
    if (sessionId === null) return;
    setWrite({ status: 'saving' });
    try {
      const res = await setVisitLifecycle(sessionId, action, { atIso: lifecycleNowIso() });
      // `changed: false` is a real outcome, not a failure: the server found the
      // action already true and wrote NOTHING, which is what stops a double
      // clock-in from moving the arrival time. Saying "clocked in" there would
      // claim a write that did not happen.
      setWrite({
        status: 'done',
        message: res.changed
          ? `${res.from} → ${res.status}.${
              res.notified ? ` ${household} was notified.` : ' The household was not notified.'
            }`
          : `Already ${res.status}. Nothing was changed, and the time already on file is unchanged.`,
      });
      if (res.changed && onWritten) onWritten();
    } catch (err) {
      setWrite({ status: 'error', message: messageOf(err) });
    }
  }

  return {
    pending,
    write,
    saving: write.status === 'saving',
    ask: (action) => {
      setWrite({ status: 'idle' });
      setPending(action);
    },
    dismiss: () => setPending(null),
    confirm: () => {
      if (pending === null) return;
      const action = pending.action;
      setPending(null);
      void run(action);
    },
  };
}
