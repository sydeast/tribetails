import { useSyncExternalStore } from 'react';
import { OfflineSessionError } from './readOnlySession';

/**
 * What the admin does with a WRITE the device cannot send, and what it is
 * allowed to say about one.
 *
 * #807's admin half. The portal's defect is React Query pausing a mutation;
 * this app has no `useMutation` at all (the `QueryClientProvider` in `main.tsx`
 * has no consumers), so the same endless "Saving…" arrives here by two
 * different roads, and they need opposite treatments:
 *
 *   A CALLABLE through `lib/fns.ts#call` FAILS FAST offline. The SDK's fetch
 *   rejects, `postJSON` returns `status: 0`, and it surfaces as
 *   `functions/internal` — in about a second, not at the twenty-second
 *   timeout. So the button does stop spinning. What it stops on is a generic
 *   error that CANNOT distinguish "never left the device" from "committed, and
 *   the reply was lost", which on `recordPayment` is the difference between
 *   re-entering a payment and double-counting one. That ambiguity is handled
 *   in `fns.ts`, which now refuses before dialling and relabels the mid-flight
 *   case; this module holds the two error classes it throws.
 *
 *   A DIRECT FIRESTORE WRITE NEVER SETTLES AT ALL. `setDoc`/`updateDoc`/
 *   `addDoc` resolve on SERVER ACK, so offline their promise simply never
 *   resolves and never rejects (`lib/firebase.ts` says so). Every one of the
 *   fourteen modules that writes this way does `setBusy(true); await …;
 *   setBusy(false)`, so the operator sits on "Saving…" for as long as the tab
 *   is open. THAT is #807's exact shape, and it is the one this module fixes.
 *
 * WHAT `settleWrite` DOES, AND WHY IT IS NOT A CANCELLATION. The write is
 * already in Firestore's own offline queue by the time we look: since
 * 2026-09-12 this app initialises `persistentLocalCache`
 * (`lib/firestoreCache.ts`), so a queued write is held in IndexedDB and
 * replayed on reconnect — through a browser restart, which is more than the
 * portal's in-memory mutation queue can offer. The write is genuinely HELD.
 * The only thing wrong was that the UI waited on an acknowledgement that could
 * not arrive. So `settleWrite` stops waiting and says the write is queued,
 * rather than pretending it landed or pretending it failed.
 *
 * `readOnlySession.ts`'s header named this boundary and chose not to cross it:
 * "Offline those sit on 'Saving…' until the SDK gives up … Routing ten call
 * sites through a new guard is a different change with a different blast
 * radius; it is named here so the next reader knows the boundary was chosen
 * rather than missed." This issue is that change. Two claims in that paragraph
 * have since gone stale and are corrected there.
 *
 * WHAT A CALLER STILL GETS WRONG, AND WHY IT IS LEFT THAT WAY FOR NOW. Every
 * direct-write caller runs its success path when this returns `{queued: true}`,
 * so `settings/sections.tsx` offline shows its "Saved" confirmation while the
 * banner says the change has not reached Tribe Tails. That is a smaller lie
 * than the one it replaces — a spinner that never stops, which told the
 * operator nothing and left them unable to move on — and correcting it means
 * threading `WriteOutcome` through roughly thirty hand-rolled busy handlers,
 * which is a second change with a second blast radius. The banner is the
 * authority in the meantime: it names the change and is on screen for as long
 * as the write is really waiting. `WriteOutcome.queued` is returned, not
 * swallowed, so a caller that wants to say "Queued" instead can, one site at a
 * time.
 *
 * WHY ONE BANNER RATHER THAN THIRTY INLINE SENTENCES. The portal puts its
 * notice beside the control, because a household taps one thing at a time and
 * the thing they tapped is the thing they are looking at. The admin is not
 * that: the operator moves through several screens on a job, and a queue of
 * five writes spread across four screens they have already left cannot be
 * reported next to any of them. So the queue is app-level state and
 * `components/QueuedWritesBanner.tsx` reports the whole of it in one place,
 * which is also the only way an operator can see a write they queued twenty
 * minutes and three screens ago.
 */

/**
 * Does this device have a connection?
 *
 * Tested for a BOOLEAN rather than for truthiness, because `navigator` exists
 * in more places than `navigator.onLine` does — Node 21+ defines a `navigator`
 * global with no `onLine` on it at all, so a bare read is `undefined`, and
 * `undefined` is falsy. A plain `navigator.onLine` check therefore reports
 * "offline" everywhere this runs outside a browser, which would refuse every
 * callable in a node-environment test and say nothing about a real device.
 * Absent means unknown, and unknown has to mean online: the whole point of the
 * refusal below is that it can PROVE nothing was sent.
 */
export function isConnected(): boolean {
  if (typeof navigator === 'undefined') return true;
  return typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
}

/**
 * Thrown by `lib/fns.ts` when a callable was refused BEFORE it was dialled.
 *
 * It is the only thing in the app that can honestly promise nothing was sent,
 * which is why it is a class of its own rather than a message. A subclass of
 * `OfflineSessionError` deliberately: `components/RouteError.tsx` already
 * treats that type as "offline, not broken", and every screen that catches it
 * keeps working without being taught a second name.
 */
export class OfflineCallError extends OfflineSessionError {
  constructor(what: string) {
    super(what);
    this.name = 'OfflineCallError';
    // "Try it again", not the parent's "It works again once there is a
    // signal": the parent describes a whole degraded SESSION, where there is
    // nothing to do but wait. This is one refused call, and the operator can
    // act on it the moment they have a bar, so the sentence says which.
    this.message = `This device is offline, so ${what} was not sent. Nothing has changed. Try it again once there is a signal.`;
  }
}

/**
 * Thrown when the signal went AFTER the request was away.
 *
 * The distinction this draws is the one that matters on money. `fns.ts`'s own
 * header already records that `functions/internal` covers both "the request
 * never arrived" and "the write committed and the reply was lost" — which is
 * why `CallOptions.idempotent` is opt-in per call site. A screen cannot tell
 * those apart from the error, so it must not claim to. This class says the
 * outcome is unknown and names what to check.
 */
export class LostSignalError extends Error {
  constructor(what: string, options?: { cause?: unknown }) {
    super(
      `The signal went while ${what} was sending, so there is no way to tell from here whether it reached ` +
        'Tribe Tails. Check before sending it again.',
      options,
    );
    this.name = 'LostSignalError';
  }
}

/** What a write is doing, as one word. Mirrors the portal's `MutationPhase`. */
export type WritePhase = 'idle' | 'sending' | 'queued' | 'blocked' | 'unknown' | 'failed';

/**
 * Read a settled write's outcome off its error.
 *
 * By CLASS, never by asking whether the device is online right now: the answer
 * has to be latched at the failure. Otherwise "we can't tell whether this
 * reached us" silently becomes "it failed, try again" the moment the signal
 * returns — a re-send invitation about a payment, delivered at the one moment
 * the operator can act on it.
 */
export function phaseOfError(err: unknown): WritePhase {
  if (err instanceof OfflineCallError) return 'blocked';
  if (err instanceof LostSignalError) return 'unknown';
  return 'failed';
}


// ── the queue ───────────────────────────────────────────────────────────────

/** One write Firestore is holding until the connection returns. */
export interface QueuedWrite {
  id: number;
  /** What was written, as it should read in "… is waiting to send". */
  what: string;
  at: number;
}

let queued: QueuedWrite[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: QueuedWrite[]): void {
  queued = next;
  for (const l of listeners) l();
}

/** Everything Firestore is still holding. Empty is the normal case. */
export function queuedWrites(): QueuedWrite[] {
  return queued;
}

/** For specs and for sign-out: forget what is on screen, not what is queued. */
export function resetQueuedWrites(): void {
  publish([]);
}

/** Subscribe to the queue. */
export function subscribeQueuedWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The queue, for a component. */
export function useQueuedWrites(): QueuedWrite[] {
  return useSyncExternalStore(subscribeQueuedWrites, queuedWrites, () => []);
}

// ── the seam ────────────────────────────────────────────────────────────────

export interface WriteOutcome {
  /**
   * True when the device was offline and Firestore is holding the write. The
   * caller has NOT been told the server accepted anything, and must not say
   * "Saved" unqualified when this is set.
   */
  queued: boolean;
}

/**
 * Wait for a direct Firestore write, or stop waiting and say it is queued.
 *
 * @param write the promise `setDoc`/`updateDoc`/`addDoc`/`batch.commit()`
 *              returned. It is NOT cancelled when the device is offline; it
 *              stays in Firestore's IndexedDB queue and commits on reconnect.
 *              This only stops the UI waiting on an acknowledgement that
 *              cannot arrive.
 * @param what  what was written, lower-case, as the banner should read it:
 *              "the payment options", "this KinTale".
 *
 * Online it behaves exactly as the bare `await` did, except that a rejection
 * arriving after the connection dropped is relabelled `LostSignalError` rather
 * than surfacing as a bare Firestore code — because a write that failed with no
 * network is not a write that failed.
 */
export async function settleWrite(
  /**
   * Typed `Promise` but normalised with `Promise.resolve` below, because it is
   * not always one. A `bare await` tolerated a mock that returned `undefined`
   * and the racing below does not, and several of the fourteen modules' own
   * specs stub `updateDoc` exactly that way. Normalising is a line; making
   * every one of those specs return a promise would be a migration nobody
   * asked for, over a detail none of them is about.
   */
  writeOrValue: Promise<unknown> | unknown,
  what: string,
  /**
   * `silent` keeps the write off the banner. For a BACKGROUND write nobody
   * tapped and nobody is waiting on — `lib/visitTracking.ts` drops a location
   * breadcrumb every fix, and a list of forty of those would bury the one
   * queued KinTale the operator actually needs to see. The write is still
   * queued by Firestore either way; only the reporting differs.
   */
  options: { silent?: boolean } = {},
): Promise<WriteOutcome> {
  const write = Promise.resolve(writeOrValue);
  if (!isConnected()) return queue(write, what, options);
  try {
    // ONLINE AT THE TAP IS NOT ONLINE FOR THE WHOLE WRITE, and on a job site
    // that is the common case rather than the exotic one: one bar when the
    // button is pressed, none a second later. A bare `await` here would hang
    // exactly as before, because the promise that never settles is the same
    // promise — the check above just happened to miss it by a moment.
    //
    // So the wait is raced against the browser saying it went offline. The
    // write itself is untouched: Firestore already has it, in the same
    // IndexedDB queue, and it commits on reconnect. Only the waiting stops.
    const settled = await Promise.race([write.then(() => 'acked' as const), offlineSignal()]);
    if (settled === 'acked') return { queued: false };
    return queue(write, what, options);
  } catch (err) {
    if (!isConnected()) throw new LostSignalError(what, { cause: err });
    throw err;
  }
}

/**
 * Stop waiting on a write Firestore is holding, and put it on the banner.
 *
 * Not an await, and not a cancellation. Firestore has the write; the
 * ACKNOWLEDGEMENT is the unreachable part. The `catch` is there so a rejection
 * on reconnect (a rules refusal, most likely) does not surface as an unhandled
 * rejection, and the `finally` takes the row off the banner either way: the
 * operator is told it is no longer waiting, which is true whichever way it went.
 */
function queue(write: Promise<unknown>, what: string, options: { silent?: boolean }): WriteOutcome {
  if (options.silent === true) {
    void write.catch(() => undefined);
    return { queued: true };
  }
  const entry: QueuedWrite = { id: nextId++, what, at: Date.now() };
  publish([...queued, entry]);
  void write
    .catch(() => undefined)
    .finally(() => {
      publish(queued.filter((q) => q.id !== entry.id));
    });
  return { queued: true };
}

/**
 * Resolves when the browser says the connection went, and never otherwise.
 *
 * The listener is removed by the `Promise.race` losing only in the sense that
 * nothing holds it after the caller returns; it is attached once per write and
 * detached on the first event either way, so a long session of successful
 * writes does not accumulate them.
 */
function offlineSignal(): Promise<'offline'> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return;
    const onOffline = (): void => {
      window.removeEventListener('offline', onOffline);
      resolve('offline');
    };
    window.addEventListener('offline', onOffline);
  });
}
