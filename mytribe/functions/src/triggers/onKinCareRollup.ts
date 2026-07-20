import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';

type KinCareDoc = {
  status?: string;
};

type EnvelopeStatus =
  | 'requested'
  | 'partiallyConfirmed'
  | 'confirmed'
  | 'inProgress'
  | 'completed'
  | 'cancelled';

/**
 * Derives the envelope status + counters from the full set of per-visit statuses.
 * Precedence (matches AuntieOS):
 *   - all cancelled            -> cancelled
 *   - any active/enRoute       -> inProgress
 *   - all completed            -> completed
 *   - all confirmed            -> confirmed
 *   - some confirmed           -> partiallyConfirmed
 *   - else                     -> requested
 *
 * Cancelled visits are excluded from the "all completed / all confirmed"
 * denominators so a single late cancellation does not block a completed roll-up.
 */
export function rollupEnvelope(statuses: string[]): {
  envelopeStatus: EnvelopeStatus;
  visitCount: number;
  confirmedCount: number;
  completedCount: number;
  cancelledCount: number;
} {
  const visitCount = statuses.length;
  const cancelledCount = statuses.filter((s) => s === 'cancelled').length;
  const completedCount = statuses.filter((s) => s === 'completed').length;
  const confirmedCount = statuses.filter((s) => s === 'confirmed').length;
  const activeCount = statuses.filter((s) => s === 'active' || s === 'enRoute').length;
  const nonCancelled = visitCount - cancelledCount;

  let envelopeStatus: EnvelopeStatus;
  if (visitCount > 0 && cancelledCount === visitCount) {
    envelopeStatus = 'cancelled';
  } else if (activeCount > 0) {
    envelopeStatus = 'inProgress';
  } else if (nonCancelled > 0 && completedCount === nonCancelled) {
    envelopeStatus = 'completed';
  } else if (nonCancelled > 0 && confirmedCount === nonCancelled) {
    envelopeStatus = 'confirmed';
  } else if (confirmedCount > 0) {
    envelopeStatus = 'partiallyConfirmed';
  } else {
    envelopeStatus = 'requested';
  }

  return { envelopeStatus, visitCount, confirmedCount, completedCount, cancelledCount };
}

/**
 * Watches the SAME per-visit path as onBookingsWrite
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`) but, unlike
 * that trigger, this one recomputes the PARENT envelope's counters +
 * `envelopeStatus` + `updatedAt`. It writes ONLY the parent doc, so it cannot
 * re-fire onBookingsWrite (which is scoped to the kinCares subcollection).
 *
 * Re-entry guard: the recomputed values are compared against the current parent
 * doc; the parent write is skipped when nothing changed, so a no-op kinCare edit
 * does not churn the envelope.
 */
export const onKinCareRollup = onDocumentWritten(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinCareRollup', async (event) => {
    const before = event.data?.before.data() as KinCareDoc | undefined;
    const after = event.data?.after.data() as KinCareDoc | undefined;
    // Only the status drives the rollup; skip writes that left it unchanged
    // (and exist on both sides) to avoid needless parent churn.
    if (before && after && before.status === after.status) return;

    const kinfolkId = event.params.kinfolkId as string;
    const batchId = event.params.batchId as string;

    const firestore = db();
    const parentRef = firestore.doc(`families/${kinfolkId}/bookings/${batchId}`);
    const visitsSnap = await parentRef.collection('kinCares').get();
    const statuses = visitsSnap.docs.map(
      (d) => (d.data() as KinCareDoc).status ?? 'requested',
    );
    if (statuses.length === 0) return;

    const rolled = rollupEnvelope(statuses);

    const parentSnap = await parentRef.get();
    if (!parentSnap.exists) return;
    const parent = parentSnap.data() as Record<string, unknown>;

    // Re-entry / no-op guard: bail if the parent already reflects this rollup.
    if (
      parent['envelopeStatus'] === rolled.envelopeStatus &&
      parent['visitCount'] === rolled.visitCount &&
      parent['confirmedCount'] === rolled.confirmedCount &&
      parent['completedCount'] === rolled.completedCount &&
      parent['cancelledCount'] === rolled.cancelledCount
    ) {
      return;
    }

    await parentRef.set(
      {
        envelopeStatus: rolled.envelopeStatus,
        visitCount: rolled.visitCount,
        confirmedCount: rolled.confirmedCount,
        completedCount: rolled.completedCount,
        cancelledCount: rolled.cancelledCount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    logEvent({
      severity: 'info',
      function: 'onKinCareRollup',
      event: 'booking.envelope.rolledUp',
      extra: { kinfolkId, batchId, envelopeStatus: rolled.envelopeStatus, visitCount: rolled.visitCount },
    });
  }),
);
