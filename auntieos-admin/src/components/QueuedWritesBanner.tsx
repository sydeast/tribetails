import { Banner } from './Banner';
import { useQueuedWrites } from '../lib/offlineWrite';
import './QueuedWritesBanner.css';

/**
 * What the admin says about writes Firestore is holding until the signal comes
 * back.
 *
 * #807, and the reason it is ONE banner rather than a sentence beside each
 * control. The portal puts its offline notice next to the button, because a
 * household taps one thing at a time and is looking at the thing they tapped.
 * The operator is not: they move through several screens on a job, and a queue
 * of four writes spread across three screens they have already left cannot be
 * reported next to any of them. App-level state, reported in one place, is the
 * only shape that lets somebody see a change they queued twenty minutes and
 * three screens ago.
 *
 * IT IS NOT AN ERROR AND IS NOT SHAPED LIKE ONE. `tone="info"` rather than
 * warning, so it does not take `role="alert"` and interrupt a screen reader:
 * nothing has failed, and nothing is lost. Firestore's IndexedDB queue holds
 * these across a browser restart (`lib/firestoreCache.ts`), which is stronger
 * than the portal's in-memory equivalent — so the copy says the work is safe
 * and does not ask the operator to do anything.
 *
 * NO RETRY BUTTON, for the reason `OfflineNotice` records on the read side: a
 * retry while the device is still offline goes straight back into the same
 * queue, so the button would be dead every time. And a retry on a WRITE would
 * be worse than dead here — nothing in this app dedupes a second
 * `recordPayment` or a second `createInvoice`, so a "send again" beside a
 * queued money write is a second row waiting to happen.
 *
 * It renders nothing when the queue is empty, which is almost always.
 */
export function QueuedWritesBanner() {
  const queued = useQueuedWrites();
  if (queued.length === 0) return null;

  // Duplicates collapse: saving a KinTale twice while offline is two queued
  // writes and one thing the operator cares about.
  const subjects = [...new Set(queued.map((q) => q.what))];

  return (
    <div className="queuedWrites">
      <Banner tone="info" title="Waiting for a signal" icon={<span aria-hidden="true">{'\u{1F4F6}'}</span>}>
        {/* The singular and the plural carry their own second sentence rather
            than sharing one. A shared "They send themselves" over "Your change
            to your settings" is a number disagreement in the copy an operator
            reads while something of theirs is unsent, which is the worst
            moment to look careless. */}
        {subjects.length === 1 ? (
          <p>
            Your change to {subjects[0]} is saved on this device and has not reached Tribe Tails yet. It sends itself
            when the signal returns. You can keep working.
          </p>
        ) : (
          <p>
            {queued.length} changes are saved on this device and have not reached Tribe Tails yet: {subjects.join(', ')}
            . They send themselves when the signal returns. You can keep working.
          </p>
        )}
      </Banner>
    </div>
  );
}
