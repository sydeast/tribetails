import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  anyVisitDeclined,
  requestResolutionForTransition,
  stampRequestNotifications,
} from '../notifications/requestResolution';

type EnvelopeDoc = { envelopeStatus?: string };

/**
 * #1647: when a booking request is answered, its office notification says so.
 *
 * Watches the ENVELOPE `families/{kinfolkId}/bookings/{batchId}`, the same
 * document `onBookingEnvelopeCreate` fires `kincare.requested` from, and stamps
 * that notification's rows with how the request ended (see
 * notifications/requestResolution.ts).
 *
 * WHY ONE TRIGGER ON THE ENVELOPE, NOT A CALL IN EACH CALLABLE. Every way a
 * request is answered ends in the same write, `envelopeStatus` leaving
 * `requested`:
 *
 *   approveBookingSeriesCore   writes it (manageBookingSeries APPROVE, the
 *                              visit-requests Accept, batchUpdateBookings
 *                              APPROVE, the portal's auto-confirm)
 *   manageBookingSeries CANCEL writes it (the decline)
 *   batchUpdateBookings REJECT/CANCEL, cancelRequests, a household cancelling
 *                              only touch visits; onKinCareRollup then moves
 *                              the envelope
 *
 * A visit-level REJECT on one visit of three cannot tell from inside the
 * callable whether the request is now answered; the envelope can. And a path
 * added later is covered without anyone remembering this stamp.
 *
 * manageBookingSeries explains why the household's decline message is NOT sent
 * from a trigger: envelope writes come from both that callable and the rollup,
 * so a sender here would fire twice. That does not apply to this one. A stamp
 * is idempotent (`stampRequestNotifications` skips rows already carrying the
 * answer), and nothing here sends anything.
 */
export const onBookingEnvelopeResolve = onDocumentUpdated(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBookingEnvelopeResolve', async (event) => {
    const before = event.data?.before.data() as EnvelopeDoc | undefined;
    const after = event.data?.after.data() as EnvelopeDoc | undefined;
    const beforeStatus = before?.envelopeStatus;
    const afterStatus = after?.envelopeStatus;
    // Most envelope writes are counters and `updatedAt`; only a status change
    // can answer a request.
    if (beforeStatus === afterStatus) return;

    const kinfolkId = event.params.kinfolkId as string;
    const batchId = event.params.batchId as string;

    // Only `requested -> cancelled` needs the visits, to tell an office decline
    // from a withdrawal; every other change is answered by the status alone.
    let declined = false;
    if (afterStatus === 'cancelled' && beforeStatus === 'requested') {
      try {
        const visits = await event.data!.after.ref.collection('kinCares').get();
        declined = anyVisitDeclined(visits.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>));
      } catch (err) {
        // Still stamp: "Cancelled" on a declined request is a smaller error than
        // a row that keeps offering Approve on a request nobody can approve.
        logEvent({
          severity: 'warn',
          function: 'onBookingEnvelopeResolve',
          event: 'envelope.visits.read.failed',
          extra: { kinfolkId, batchId, err: (err as Error)?.message },
        });
      }
    }

    const resolution = requestResolutionForTransition(beforeStatus, afterStatus, declined);
    if (resolution === null) return;
    await stampRequestNotifications({ kinfolkId, batchId, resolution, source: 'onBookingEnvelopeResolve' });
  }),
);
