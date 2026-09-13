import './SlowWaitNotice.css';

interface Props {
  /** What is being waited on, lower-case, as in "Couldn't load ___". */
  what: string;
  /** How many times Sync has already been pressed during this wait. */
  attempt: number;
  /** Re-attempt. When absent, the notice offers a reload instead. */
  onSync?: (() => void) | undefined;
}

/**
 * What a wait offers once it has run past `lib/slowWait.ts#SLOW_WAIT_MS`.
 *
 * The operator's 2026-09-12 ruling asks for "a tap to sync option if server
 * access is taking too long". This is that option. It appears UNDER the spinner
 * rather than replacing it, because the wait has not ended: the read is still in
 * flight, the server is still the thing that decides, and a screen that swapped
 * the spinner for a button would be claiming the attempt was abandoned.
 *
 * IT IS NOT AN ERROR AND IS NOT SHAPED LIKE ONE. `role="group"`, not
 * `role="alert"`: nothing has failed, and an alert would interrupt a screen
 * reader mid-sentence to say so. The live region announcing the wait is the
 * caller's (`AsyncRegion`'s `div[role=status]`), which this sits inside, so the
 * new sentence is announced politely by the region that was already talking.
 *
 * WHY THE LABEL IS "Sync now" RATHER THAN THE RULING'S LITERAL "tap to sync".
 * The ruling names the AFFORDANCE, not the copy, and this admin is driven with
 * a cursor as often as a finger (it is a desktop screen first, a PWA second).
 * "Tap" would be wrong half the time it is read. The portal's twin, which is
 * only ever held in a hand, does say "Tap to sync".
 *
 * WHAT "SYNC" MEANS DEPENDS ON WHAT IS WAITING, and the caller decides:
 *   a Firestore subscription   re-subscribe (bump the nonce in the effect deps).
 *                              A listener that never delivered a first snapshot
 *                              has nothing to retry except the listen itself.
 *   a callable                 call it again.
 *   a lazily-loaded route      reload the document; there is no smaller unit.
 *
 * IDEMPOTENCY IS THE CALLER'S PROBLEM AND MUST BE CHECKED. `onSync` is safe to
 * point at any READ. Pointing it at a WRITE is only safe when re-issuing the
 * write is a no-op the second time -- `api/sessionsWrite.ts#patchVisitLifecycle`
 * is, because it re-reads the row's status and returns `changed: false` rather
 * than writing again, which is the same guard that already stops a double
 * clock-in from moving the arrival time. A write that CREATES (an invoice, a
 * booking, a KinTale) is not, and `lib/fns.ts`'s timeout cannot abort the call
 * that is already in flight, so a second one can land as a duplicate. For those,
 * point `onSync` at a re-READ of the thing the write would have produced.
 */
export function SlowWaitNotice({ what, attempt, onSync }: Props) {
  const syncing = attempt > 0;
  return (
    <div className="slowWait" role="group" aria-label={`${what} is taking a while`}>
      <p className="slowWait__line">
        {syncing
          ? `Asked again. Still waiting on the server for ${what}.`
          : `The server has not answered yet.`}
      </p>
      {onSync ? (
        <button type="button" className="slowWait__sync" onClick={onSync}>
          {syncing ? 'Ask again' : 'Sync now'}
        </button>
      ) : (
        // Never an indefinite spinner with no way forward. Where the caller has
        // no smaller unit to retry -- a route chunk that never arrived -- the
        // document reload IS the retry, and saying so is better than a button
        // that quietly does nothing.
        <button type="button" className="slowWait__sync" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      )}
    </div>
  );
}
