import { BusyLabel } from './Loading';
import { isOfflinePhase, type MutationPhase, type PortalMutationExtras } from '../lib/mutationState';

/**
 * What a control says about a write the phone could not send.
 *
 * The read side's twin is `OfflineNotice.tsx`, and the rule it was built on
 * carries over: never let an unknown read as a settled fact. There it was an
 * empty list standing in for a list nobody fetched. Here it is "Saving…"
 * standing in for a request that never left the building — and the second tap
 * that invites, which on an invoice is a second charge.
 *
 * THREE SENTENCES, BECAUSE THERE ARE THREE THINGS THAT CAN HAVE HAPPENED, and
 * a household acts differently on each:
 *
 *   queued   held, and will send itself. Do nothing. (`policy: 'hold'`)
 *   blocked  refused on this phone. Nothing was sent. Re-tap when you have
 *            signal. (`policy: 'abandon'`, caught by the preflight)
 *   unknown  it was already away when the signal went. We cannot say whether
 *            it landed, so we say that, and tell them what to check. This is
 *            the one that must never be collapsed into either of the others.
 *
 * NO RETRY BUTTON HERE, and for the same finding `OfflineNotice` records: a
 * retry while the phone is still offline reaches `retryer.js`'s `start()`,
 * where `canStart()` is false, and goes straight back to a pause. A dead button
 * is a worse answer than no button. #819's "Tap to sync" escalation is for a
 * SLOW SERVER, which is a different state and already refuses to fire while
 * `navigator.onLine` is false (`lib/slowWait.ts`).
 *
 * Visual vocabulary is `.offline-line` (base.css) — the compact form the read
 * side already uses under a heading — because this sits under a button rather
 * than replacing a panel, and a filled card between a control and its form
 * would read as an error the household caused.
 */
export function OfflineMutationNotice({
  phase,
  what,
  check,
}: {
  phase: MutationPhase;
  /** The action, as a noun: "your payment", "your changes", "your message". */
  what: string;
  /**
   * Where to look when the outcome is unknown: "your invoices", "your
   * bookings". Omitted only where the screen the household is already on shows
   * the answer.
   */
  check?: string;
}) {
  if (!isOfflinePhase(phase)) return null;

  if (phase === 'queued') {
    return (
      <p className="offline-line" role="status">
        <span aria-hidden="true">{'\u{1F4F5}'}</span>
        <span>
          You are offline, so {what} is waiting on this phone. It sends itself when your signal returns. Leave this page
          open.
        </span>
      </p>
    );
  }

  if (phase === 'blocked') {
    return (
      <p className="offline-line" role="status">
        <span aria-hidden="true">{'\u{1F4F5}'}</span>
        <span>
          Your phone is offline, so {what} was not sent. Nothing has changed. Try again once your signal is back.
        </span>
      </p>
    );
  }

  return (
    <p className="offline-line" role="status">
      <span aria-hidden="true">{'\u{1F4F5}'}</span>
      <span>
        Your signal went while {what} was sending, so we can&rsquo;t tell from here whether it reached us.
        {check === undefined ? ' ' : ` Check ${check} before trying again.`}
      </span>
    </p>
  );
}

/**
 * A button's label, which is now three labels rather than two.
 *
 * Every one of these buttons used to read `isPending ? 'Saving…' : 'Save'`,
 * and `isPending` is true for a paused mutation, so a write that never left
 * the phone wore the word for a write the server is working on. The spinner
 * goes with it: a ring that turns says the far end is thinking about it, which
 * for a queued write is not true of anything.
 *
 * The queued label says who is holding it, not what it is doing, because a
 * household's next move depends on that and on nothing else.
 */
export function MutationLabel({
  mutation,
  busy,
  children,
}: {
  mutation: Pick<PortalMutationExtras, 'phase'>;
  /** The in-flight word this button already used: "Saving…", "Sending…". */
  busy: string;
  /** The button's resting label. */
  children: React.ReactNode;
}) {
  if (mutation.phase === 'queued') {
    return (
      <>
        <span aria-hidden="true">{'\u{1F4F5}'}</span> Waiting for signal
      </>
    );
  }
  if (mutation.phase === 'sending') return <BusyLabel>{busy}</BusyLabel>;
  return <>{children}</>;
}
