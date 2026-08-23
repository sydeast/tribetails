import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type EnvelopeDoc = {
  envelopeStatus?: string;
  serviceName?: string;
  kinIds?: string[];
  kinNames?: string[];
  visitCount?: number;
  notes?: string | null;
};

type VisitDoc = {
  startTime?: { toMillis?: () => number } | null;
  serviceName?: string;
  serviceType?: string;
  title?: string;
};

/**
 * The visit start times of a whole envelope, oldest first, as epoch millis.
 *
 * Reads EVERY child, never `where('status','==','requested')`. `requestBooking`'s
 * `maybeAutoConfirm` can run `approveBookingSeriesCore` the moment `writeEnvelope`
 * returns, so by the time this trigger executes the children may already be
 * `confirmed` even though the envelope snapshot that woke it says `requested`.
 * Filtering on status would hand an auto-confirmed envelope an empty date list.
 *
 * Exported for unit tests.
 */
export function visitStartMillis(visits: VisitDoc[]): number[] {
  return visits
    .map((v) => v.startTime?.toMillis?.() ?? null)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
    .sort((a, b) => a - b);
}

/**
 * Watches the booking ENVELOPE `families/{kinfolkId}/bookings/{batchId}` and
 * fires `kincare.requested` ONCE per request (#532).
 *
 * WHY THIS TRIGGER EXISTS. The notification used to come from `onBookingsWrite`,
 * which is registered one level down on `.../kinCares/{visitId}` -- one document
 * per visit. A kinfolk asking for a long weekend writes four visits, so the
 * office got four "new care request" messages per channel for one request. The
 * delivery was never wrong; the signal was attached to the wrong grain.
 *
 * WHY THE PARENT IS SAFE TO TRIGGER ON. `writeEnvelope` (portal/requestBooking.ts)
 * writes the parent doc and every `kinCares` child inside ONE
 * `firestore.runTransaction`, so this trigger cannot observe a half-written
 * envelope: when the parent create is visible, so are all of its visits. That is
 * also why no `requestNotifiedAt` idempotency flag is needed -- a create fires
 * once. `writeEnvelope` is the only code path in the repo that creates `kinCares`
 * documents, and `admin/createMultiDateBookingRequest` calls it too, so no write
 * path loses its notification by moving the dispatch up here.
 *
 * Envelope counter/status rollup stays in `onKinCareRollup`, and the remaining
 * per-visit lifecycle notifications stay in `onBookingsWrite`. This handler emits
 * exactly one key.
 */
export const onBookingEnvelopeCreate = onDocumentCreated(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}',
    region: 'us-central1',
    // Same binding as onBookingsWrite carried for the same reason: lib/businessAdmins
    // self-heals an empty businessSettings/admins roster from AUNTIE_OPERATOR_UIDS on
    // the first booking request, and this is now the trigger that dispatches
    // kincare.requested, the highest-traffic businessAdmins notification.
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapTrigger('onBookingEnvelopeCreate', async (event) => {
    const envelope = event.data?.data() as EnvelopeDoc | undefined;
    if (!envelope) return;

    // An envelope created already confirmed (admin-side flows) is not a request
    // anyone has to rule on, so it gets no "new care request".
    if (envelope.envelopeStatus !== 'requested') return;

    const kinfolkId = event.params.kinfolkId as string;
    const batchId = event.params.batchId as string;

    let startTimeMsList: number[] = [];
    let firstVisit: VisitDoc | undefined;
    try {
      const visitsSnap = await event.data!.ref.collection('kinCares').get();
      const visits = visitsSnap.docs.map((d) => d.data() as VisitDoc);
      startTimeMsList = visitStartMillis(visits);
      firstVisit = visits[0];
    } catch (err) {
      // Fail-loud in the log, but still send. An office that hears "a request came
      // in" without its dates can open the request; an office that hears nothing
      // cannot, and a kinfolk request reaching nobody is the worse bug (#533).
      logEvent({
        severity: 'warn',
        function: 'onBookingEnvelopeCreate',
        event: 'envelope.visits.read.failed',
        extra: { kinfolkId, batchId, err: (err as Error)?.message },
      });
    }

    const recipientUid = await resolveKinfolkUid(kinfolkId);

    try {
      await enqueueNotification({
        key: 'kincare.requested',
        recipientUid: recipientUid ?? '',
        data: {
          kinfolkId,
          batchId,
          // `bookingId` is the envelope here, not a visit. The office's copy is
          // about the whole request, and `manageBookingSeries` rules on a batchId.
          bookingId: batchId,
          serviceName:
            envelope.serviceName ??
            firstVisit?.serviceName ??
            firstVisit?.serviceType ??
            firstVisit?.title ??
            null,
          // The enricher formats both from these, so business-settings timezone
          // handling stays in the one place that already owns it.
          startTimeMs: startTimeMsList[0] ?? null,
          startTimeMsList,
          visitCount: envelope.visitCount ?? startTimeMsList.length,
        },
        targetType: 'booking',
        targetId: batchId,
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'onBookingEnvelopeCreate',
        event: 'notification.dispatch.failed',
        extra: { kinfolkId, batchId, key: 'kincare.requested', err: (err as Error)?.message },
      });
    }
  }),
);
