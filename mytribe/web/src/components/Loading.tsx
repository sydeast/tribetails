import { isWaiting, useSlowWait } from '../lib/slowWait';
import type { PortalView } from '../lib/queryState';

/**
 * The portal's in-flight vocabulary: a ring that turns, the sentence that was
 * already there, and a way forward once the wait runs long.
 *
 * WHY THIS EXISTS. Before it, the portal had exactly one spinner in the whole
 * app -- `.siu-spinner`, inside the image-upload control -- and every other
 * wait was a bare `<p className="sub">Loading your schedule…</p>` with nothing
 * moving. Thirty of them. The 2026-09-12 ruling ("any waits/delays/etc need to
 * have some sort of loading icon") is about those, and the reason there is a
 * component rather than thirty edits is that the escalation has to come with
 * the icon: a cue that spins forever is the thing the ruling's second half
 * refuses.
 *
 * THE WORDS STAY. Every call site keeps the sentence it already had, because
 * "Loading your schedule…" says WHICH of four regions on the Home screen is
 * the one still waiting, and a bare ring says only that something is. The ring
 * is added beside the words, never in their place. That is also what keeps this
 * honest under `prefers-reduced-motion`, where the ring is slowed right down
 * and the sentence carries the meaning (see styles/loading.css).
 *
 * THE VISUAL LANGUAGE IS BORROWED, NOT INVENTED. Ring geometry and stroke come
 * from `.siu-spinner`, the portal's only existing spinner; the text role is
 * `.sub`, which is what every one of these lines already used. Nothing new was
 * drawn for this.
 */

interface LineProps {
  /**
   * The sentence to show. Pass the one that was already at this call site --
   * this component is meant to wrap existing copy, not to replace it with
   * something generic.
   */
  children: React.ReactNode;
  /**
   * What "Tap to sync" re-runs once the wait passes `SLOW_WAIT_MS`. Normally
   * `query.refetch`. Omit it and the wait still escalates, offering a reload;
   * the floor is that no wait is ever a dead end.
   */
  retry?: (() => void) | undefined;
  /**
   * What is being waited on, lower-case, for the escalation's accessible name:
   * "your schedule is taking a while". Defaults to a neutral phrase.
   */
  what?: string | undefined;
  /** `block` draws a panel-sized wait; `line` (default) an inline row. */
  variant?: 'line' | 'block' | undefined;
}

/**
 * One waiting region: spinner + the caller's sentence, escalating at 10s.
 *
 * `role="status"` with `aria-live="polite"` is on the wrapper, so the sentence
 * and later the escalation are announced by the same region rather than two.
 * Before this, exactly one loading line in the portal (Schedule's) was
 * announced to anybody at all; the other twenty-nine were silent.
 */
export function LoadingLine({ children, retry, what, variant = 'line' }: LineProps) {
  const wait = useSlowWait(true, retry);
  const subject = what ?? 'this';
  return (
    <div
      className={variant === 'block' ? 'loading-block' : 'loading-line'}
      role="status"
      aria-live="polite"
      data-phase={wait.phase}
    >
      <p className="loading-line__row">
        <span className="loading-spinner" aria-hidden="true" />
        <span className="sub">{children}</span>
      </p>
      {wait.phase === 'slow' && (
        <SlowWaitNotice
          what={subject}
          attempt={wait.attempt}
          onSync={wait.canSync ? wait.sync : undefined}
        />
      )}
    </div>
  );
}

/**
 * The in-flight label on a button that is mid-mutation.
 *
 * The portal's buttons swapped their text and nothing else: "Save Changes"
 * became "Saving…" on a control that looked otherwise identical, so on a slow
 * connection the only evidence anything was happening was one word. (The
 * admin's buttons already grow a ring through `busy=` on its kit button; this
 * is the portal catching up.) The ruling asks for a cue on any wait, and a
 * mutation in flight is a wait.
 *
 * NO ESCALATION HERE, deliberately, and that is the idempotency rule showing up
 * in the design rather than only in a comment. Most of these buttons submit
 * something that CREATES: a booking, a payment, a KinTale, an invite. Nothing
 * client-side can abort a request already away, so a "send it again" button
 * beside one of them invites exactly the duplicate it appears to prevent. A
 * wait on a READ gets the offer; a wait on a CREATE gets the cue and the
 * disabled button, and the screen's own refetch is what reconciles it.
 */
export function BusyLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span
        className="loading-spinner loading-spinner--inline loading-spinner--oncolor"
        aria-hidden="true"
      />
      {children}
    </>
  );
}

interface NoticeProps {
  what: string;
  attempt: number;
  onSync?: (() => void) | undefined;
}

/**
 * What a wait offers once it has run past `lib/slowWait.ts#SLOW_WAIT_MS`.
 *
 * It appears UNDER the spinner rather than replacing it: the read is still in
 * flight, the server still decides, and swapping the cue for a button would
 * claim the attempt had been abandoned. The ruling is explicit that we stay
 * pessimistic -- nothing here paints a result, it only asks again.
 *
 * IT IS NOT AN ERROR AND IS NOT SHAPED LIKE ONE. `role="group"`, not
 * `role="alert"`: nothing has failed, and an alert would cut across a screen
 * reader to say it had. The live region is the caller's, which this sits
 * inside.
 *
 * THIS ONE SAYS "Tap to sync", the ruling's own words, because the portal is
 * only ever held in a hand. The admin's twin says "Sync now" instead: that
 * screen is driven with a cursor as often as a finger, and "tap" would be
 * wrong half the times it was read.
 *
 * IDEMPOTENCY IS THE CALLER'S PROBLEM. `retry` is safe to point at any READ --
 * `query.refetch` is what nearly every call site passes. Pointing it at a
 * MUTATION is only safe when re-issuing is a no-op: a `Promise.race` timeout
 * cannot abort the request already in flight, so a second submit of a booking,
 * an invoice payment or a KinTale can land as a duplicate. For those, point it
 * at a re-READ of what the write would have produced.
 */
export function SlowWaitNotice({ what, attempt, onSync }: NoticeProps) {
  const asked = attempt > 0;
  return (
    <div className="slow-wait" role="group" aria-label={`${what} is taking a while`}>
      <p className="slow-wait__line sub">
        {asked
          ? 'Asked again. Still waiting on Tribe Tails.'
          : 'Tribe Tails has not answered yet.'}
      </p>
      {onSync ? (
        <button type="button" className="slow-wait__sync" onClick={onSync}>
          {asked ? 'Ask again' : 'Tap to sync'}
        </button>
      ) : (
        // Never a spinner with no way forward. Where the caller has nothing
        // smaller to retry, reloading IS the retry, and saying so beats a
        // button that quietly does nothing.
        <button type="button" className="slow-wait__sync" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}

/**
 * The same thing, driven straight off a `PortalView`.
 *
 * Convenience for the common site: `{isWaiting(v) && <LoadingFor view={v} …/>}`
 * reads better than repeating the two-kind test, and keeps 'idle' -- a query
 * whose gate never landed -- inside the set that escalates rather than
 * silently exempt.
 */
export function LoadingFor({
  view,
  children,
  retry,
  what,
  variant,
}: LineProps & { view: Pick<PortalView<unknown>, 'kind'> }) {
  if (!isWaiting(view)) return null;
  return (
    <LoadingLine retry={retry} what={what} variant={variant}>
      {children}
    </LoadingLine>
  );
}
