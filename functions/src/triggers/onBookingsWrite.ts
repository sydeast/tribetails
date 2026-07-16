import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type BookingDoc = {
  status?: string;
  serviceType?: string;
  serviceName?: string;
  title?: string;
  startTime?: { toMillis?: () => number } | null;
  kinIds?: string[];
  kinNames?: string[];
  auntieDisplayName?: string;
  /** Staff uid the visit is assigned to; drives assignment.* notifications. */
  assignedAuntieUid?: string;
  /** Set by requestBookingCancellation; first appearance fires kincare.cancel.requested. */
  cancelRequestedAt?: unknown;
  cancelRequestReason?: string | null;
  notes?: string;
  endTime?: { toMillis?: () => number } | null;
  batchId?: string;
};

const CHANGE_WATCH_FIELDS: Array<keyof BookingDoc> = [
  'serviceType',
  'serviceName',
  'title',
  'startTime',
  'endTime',
  'kinIds',
  'kinNames',
  'auntieDisplayName',
  'notes',
];

function fieldChanged(
  before: BookingDoc | undefined,
  after: BookingDoc,
  field: keyof BookingDoc,
): boolean {
  const a = before?.[field];
  const b = after[field];
  if (a === b) return false;
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/**
 * Pure decision table for staff assignment notifications (vendor-parity
 * 2026-07-02). Returns the assignment.* dispatches a bookings write implies:
 *   - assignedAuntieUid set/changed  -> assignment.assigned to the new auntie
 *                                       (+ assignment.changed to the old one)
 *   - status -> cancelled            -> assignment.changed to the current auntie
 *   - watched-field edit, assigned   -> assignment.changed to the current auntie
 * Exported for unit tests; the trigger below is a thin shell around it.
 */
export function assignmentDispatches(
  before: BookingDoc | undefined,
  after: BookingDoc,
  changedFields: string[],
): Array<{ key: 'assignment.assigned' | 'assignment.changed'; auntieUid: string; extra: Record<string, unknown> }> {
  const beforeAuntie = before?.assignedAuntieUid ?? null;
  const afterAuntie = after.assignedAuntieUid ?? null;
  const beforeStatus = before?.status ?? null;
  const afterStatus = after.status ?? null;
  const out: Array<{ key: 'assignment.assigned' | 'assignment.changed'; auntieUid: string; extra: Record<string, unknown> }> = [];

  if (beforeAuntie !== afterAuntie) {
    if (afterAuntie) out.push({ key: 'assignment.assigned', auntieUid: afterAuntie, extra: {} });
    if (beforeAuntie) {
      out.push({
        key: 'assignment.changed',
        auntieUid: beforeAuntie,
        extra: { changeKind: afterAuntie ? 'reassigned' : 'unassigned' },
      });
    }
    return out;
  }

  if (!afterAuntie) return out;

  if (beforeStatus !== afterStatus && afterStatus === 'cancelled') {
    out.push({ key: 'assignment.changed', auntieUid: afterAuntie, extra: { changeKind: 'cancelled' } });
    return out;
  }

  if (
    beforeStatus === afterStatus &&
    (afterStatus === 'confirmed' || afterStatus === 'approved') &&
    changedFields.length > 0
  ) {
    out.push({
      key: 'assignment.changed',
      auntieUid: afterAuntie,
      extra: { changeKind: 'updated', changedFields },
    });
  }
  return out;
}

/**
 * Watches every per-visit write under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`. Notifications
 * are keyed on the per-visit `status` (BookingStatus), unchanged from before:
 *   - create with status=requested              -> kincare.requested (business)
 *   - any -> confirmed/approved                 -> kincare.booking.confirm (both)
 *   - any -> cancelled                          -> kincare.booking.cancel (both)
 *   - any -> unavailable                        -> kincare.unavailable (business)
 *   - non-status edit on confirmed/approved     -> kincare.changed (business)
 *
 * Envelope counter/status rollup lives in the SEPARATE onKinCareRollup trigger
 * on this same path; this handler only emits notifications.
 */
export const onBookingsWrite = onDocumentWritten(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBookingsWrite', async (event) => {
    const before = event.data?.before.data() as BookingDoc | undefined;
    const after = event.data?.after.data() as BookingDoc | undefined;
    if (!after) return;

    const kinfolkId = event.params.kinfolkId;
    const batchId = event.params.batchId;
    const visitId = event.params.visitId;
    const beforeStatus = before?.status ?? null;
    const afterStatus = after.status ?? null;
    const isCreate = !before;

    const recipientUid = await resolveKinfolkUid(kinfolkId);
    const baseData = {
      kinfolkId,
      batchId,
      // `bookingId` retained for notification-template back-compat; now the visit id.
      bookingId: visitId,
      visitId,
      serviceName: after.serviceName ?? after.serviceType ?? after.title ?? null,
      startTimeMs: after.startTime?.toMillis?.() ?? null,
    };

    const dispatch = async (key: string, extra: Record<string, unknown> = {}) => {
      try {
        await enqueueNotification({
          key: key as never,
          recipientUid: recipientUid ?? '',
          data: { ...baseData, ...extra },
          targetType: 'booking',
          targetId: visitId,
        });
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'onBookingsWrite',
          event: 'notification.dispatch.failed',
          extra: { kinfolkId, batchId, visitId, key, err: (err as Error)?.message },
        });
      }
    };

    // Vendor-parity (2026-07-02): staff assignment notifications, decided by the
    // pure table above; independent of the kinfolk/business status flow below.
    // The resolver reads assignedAuntieUid from the dispatch data, so each
    // dispatch names the auntie whose copy it is.
    const changedFieldsAll = CHANGE_WATCH_FIELDS.filter((f) => fieldChanged(before, after, f));
    for (const d of assignmentDispatches(before, after, changedFieldsAll)) {
      await dispatch(d.key, { ...d.extra, assignedAuntieUid: d.auntieUid });
    }

    // Vendor-parity (2026-07-02): first appearance of cancelRequestedAt = the
    // kinfolk asked to cancel this visit; tell the office. Not a status change.
    if (!before?.cancelRequestedAt && after.cancelRequestedAt) {
      await dispatch('kincare.cancel.requested', {
        reason: after.cancelRequestReason ?? null,
      });
    }

    if (isCreate && afterStatus === 'requested') {
      await dispatch('kincare.requested');
      return;
    }

    if (beforeStatus !== afterStatus) {
      if (afterStatus === 'confirmed' || afterStatus === 'approved') {
        await dispatch('kincare.booking.confirm');
      } else if (afterStatus === 'cancelled') {
        await dispatch('kincare.booking.cancel');
      } else if (afterStatus === 'unavailable') {
        await dispatch('kincare.unavailable');
      }
      return;
    }

    if (afterStatus === 'confirmed' || afterStatus === 'approved') {
      if (changedFieldsAll.length > 0) {
        await dispatch('kincare.changed', { changedFields: changedFieldsAll });
      }
    }
  }),
);
