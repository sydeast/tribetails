import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * The `sentVia` marker a client stamps, in the same write as the DRAFT → SENT
 * flip, when it has ALREADY announced the send itself through the notification
 * catalog (the `dispatchVisitNotification` callable, event `report_sent`).
 *
 * Two clients do this: Android (`KinTaleReportViewModel` → `VisitNotifier` →
 * `markReportSent(sentVia = "catalog")`) and the wasm admin
 * (`FirestoreClient.sendReport` → `markKinTaleReportSent(sentVia = "catalog")`).
 * Both call the callable first and stamp the receipt second, so by the time a
 * trigger sees the flip the household has already been told.
 *
 * Clients that do NOT dispatch — the React admin's `sendKinTale`, the wasm
 * compose screen — stamp `'pending'`, and the trigger is the only thing that
 * will announce their send.
 *
 * Because the marker rides the same write as the status flip, this is a
 * decision the trigger can make from the event alone: no extra read, no race,
 * and no client release needed to make already-installed apps behave.
 */
const CLIENT_DISPATCHED_SENT_VIA = 'catalog';

/**
 * True when the client that published this KinTale already announced it, so a
 * trigger announcing it again would be the household's second alert for one send.
 */
export function clientAlreadyAnnouncedSend(sentVia: unknown): boolean {
  return sentVia === CLIENT_DISPATCHED_SENT_VIA;
}

/**
 * "Has this KinTale already been announced to the household?"
 *
 * A KinTale becomes visible to the household exactly once, but two triggers can
 * observe that moment: `onKinTaleCreate` (a report written straight to SENT)
 * and `onKinTaleUpdate` (the ordinary DRAFT → SENT flip). Firestore triggers
 * are at-least-once, so either can also be replayed. This is the single claim
 * both consult, so `kintale.published` is enqueued once per report.
 *
 * It reuses the tracker `onKinTaleUpdate` already keeps for post-publish notes,
 * `kinTaleNotifications/{reportId}` — keyed on the taleId, and deliberately in
 * a parallel collection so stamping it does NOT re-fire the very
 * onDocumentUpdated trigger that stamped it. The write merges, so the note
 * high-water marks (`lastDigest`, `lastNotifiedAtMs`) are untouched.
 *
 * Fails OPEN: if Firestore is unreachable the claim is granted and the
 * notification goes out. A household hearing twice about a real send is a far
 * smaller harm than a send that is never announced at all.
 */
export async function claimKinTalePublish(reportId: string): Promise<boolean> {
  const ref = db().doc(`kinTaleNotifications/${reportId}`);
  try {
    return await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.data() as { publishedNotifiedAtMs?: number } | undefined;
      if (typeof existing?.publishedNotifiedAtMs === 'number') return false;
      tx.set(
        ref,
        { publishedNotifiedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'claimKinTalePublish',
      event: 'kintale.publish.claim.failed',
      extra: { reportId, err: (err as Error)?.message, decision: 'fail-open' },
    });
    return true;
  }
}
