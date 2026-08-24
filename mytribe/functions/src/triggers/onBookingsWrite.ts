import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import {
  buildVisitDateData,
  formatBookingDate,
  formatBookingTime,
  loadBusinessTimeZone,
  startMillisOf,
} from '../notifications/visitDates';

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
  /** Set by requestBookingCancellation; a NEW pending ask fires kincare.cancel.requested. */
  cancelRequestedAt?: unknown;
  cancelRequestReason?: string | null;
  /** #438: `pending` / `accepted` / `declined`, ruled on by admin/cancelRequests. */
  cancelRequestStatus?: string | null;
  cancelResponseNote?: string | null;
  /** Set by requestBookingReschedule; first appearance fires kincare.reschedule.requested. */
  rescheduleRequestedAt?: unknown;
  rescheduleRequestReason?: string | null;
  rescheduleRequestStatus?: string | null;
  notes?: string;
  endTime?: { toMillis?: () => number } | null;
  batchId?: string;
  /**
   * #533: stamped by admin/manageBookingSeries when a CANCEL is DECLINING a
   * request that was never confirmed. Its presence is what tells this trigger
   * the household is owed `kincare.request.declined` rather than
   * `kincare.booking.cancel`.
   */
  requestDeclinedAt?: unknown;
  /**
   * #536: stamped by `admin/approveBookingSeriesCore` on every visit it confirms
   * as part of a whole-request approval. Its ARRIVAL is what tells this trigger
   * the household is being answered once, at the envelope, rather than owed a
   * message about this one visit.
   */
  seriesApprovedAt?: unknown;
};

/**
 * True when this revision of the visit carries the decline stamp
 * `admin/manageBookingSeries` writes when it turns down a request (#533).
 * Exported for unit tests.
 */
export function declineStampedOn(doc: BookingDoc | undefined): boolean {
  return Boolean(doc?.requestDeclinedAt);
}

/**
 * True when this write is the one that put `seriesApprovedAt` on the visit, or
 * moved it on -- i.e. `approveBookingSeriesCore` just approved the whole request
 * this visit belongs to (#536).
 *
 * Compares the stamp's VALUE rather than merely asking whether `after` has one,
 * because a visit can be approved as part of a series more than once: cancel an
 * approved series and approve it again and the stamp is already there from the
 * first time. Asking "did it change" answers "was this write a series approval"
 * in both cases, where "does it exist" answers it only the first time.
 *
 * The test is deliberately the STAMP and not the `requested -> confirmed`
 * transition. `admin/batchUpdateBookings` and the Android schedule screen both
 * confirm visits one at a time without going through the series core, and each
 * of those still owes the household the per-visit message. #533 hit the mirror
 * image of this on `requested -> cancelled`, which also has two opposite
 * meanings; the stamp is what tells them apart. Exported for unit tests.
 */
export function seriesApproveStampChanged(
  before: BookingDoc | undefined,
  after: BookingDoc | undefined,
): boolean {
  const now = stampValue(after?.seriesApprovedAt);
  if (now === null) return false;
  return stampValue(before?.seriesApprovedAt) !== now;
}

/**
 * A stamp reduced to something comparable across revisions. Firestore hands back
 * a Timestamp; the emulator and the tests can hand back a string or a number.
 */
function stampValue(v: unknown): string | null {
  if (v == null) return null;
  const ms = startMillisOf(v);
  if (ms !== null) return String(ms);
  return typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
}

/**
 * The visit-date block for a confirmation that really is about ONE visit.
 *
 * `kincare.booking.confirm` renders from the structured `visits` array the
 * visit-date rendering spec defines, and its seed no longer references
 * `{{bookingDate}}` / `{{bookingTime}}`. A single-visit confirmation is that
 * same shape with one entry, so the template that enumerates four days
 * enumerates one day here without a second code path or a second wording rule.
 *
 * `bookingDate` / `bookingTime` are still sent, for the same reason
 * `approveBookingSeriesCore` sends them: the template DOCUMENT in production
 * keeps the old wording until the operator re-imports, and emitter-supplied
 * values survive `enrichTemplateData` untouched.
 *
 * Costs one settings read, and only on the arm that needs it.
 */
async function visitDateFieldsFor(
  after: BookingDoc,
  visitId: string,
): Promise<Record<string, unknown>> {
  const ms = startMillisOf(after.startTime);
  const tz = await loadBusinessTimeZone();
  return {
    ...buildVisitDateData(ms == null ? [] : [{ visitId, startTimeMs: ms }], tz),
    bookingDate: ms == null ? null : formatBookingDate(ms, tz),
    bookingTime: ms == null ? null : formatBookingTime(ms, tz),
  };
}

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

/**
 * The cancellation ask's state on one revision of the doc, or null when it has
 * never carried one. A bare `cancelRequestedAt` with no status is a request
 * written before #438 and is still waiting, so it reads as `pending`.
 */
function cancelStatusOf(doc: BookingDoc | undefined): 'pending' | 'accepted' | 'declined' | null {
  if (!doc) return null;
  const status = doc.cancelRequestStatus;
  if (status === 'pending' || status === 'accepted' || status === 'declined') return status;
  return doc.cancelRequestedAt ? 'pending' : null;
}

/**
 * Pure decision table for the cancellation ask and the answer to it. Returns
 * the dispatches a bookings write implies:
 *   - anything -> pending    -> kincare.cancel.requested to the office
 *   - pending -> declined    -> kincare.cancel.declined to the household
 *
 * Vendor-parity (2026-07-02) fired the first of those on the FIRST appearance
 * of `cancelRequestedAt`. #438 widened it to a transition into pending, for the
 * reason the reschedule ask below reads the same way: a household whose ask was
 * declined may ask again, and that second ask is as new as the first. The old
 * test would have gone quiet on it, because the stamp was already there.
 *
 * The ACCEPT half has no key here on purpose. Accepting sets the visit to
 * cancelled, and `kincare.booking.cancel` already reaches the household; a key
 * of its own would send them the same news twice. A DECLINE changes no status
 * at all, so without the second row the answer the portal promised them never
 * arrives.
 *
 * Exported for unit tests; the trigger below is a thin shell around it.
 */
export function cancellationDispatches(
  before: BookingDoc | undefined,
  after: BookingDoc,
): Array<{ key: 'kincare.cancel.requested' | 'kincare.cancel.declined'; extra: Record<string, unknown> }> {
  const wasPending = cancelStatusOf(before) === 'pending';
  const now = cancelStatusOf(after);
  if (now === 'pending' && !wasPending) {
    return [{ key: 'kincare.cancel.requested', extra: { reason: after.cancelRequestReason ?? null } }];
  }
  if (wasPending && now === 'declined') {
    return [
      {
        key: 'kincare.cancel.declined',
        extra: { note: after.cancelResponseNote ?? null, reason: after.cancelRequestReason ?? null },
      },
    ];
  }
  return [];
}

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
 * are keyed on the per-visit `status` (BookingStatus):
 *   - create with status=requested              -> NOTHING; see #532 below
 *   - any -> confirmed/approved                 -> kincare.booking.confirm (both)
 *   - any -> cancelled                          -> kincare.booking.cancel (both)
 *   - any -> unavailable                        -> kincare.unavailable (business)
 *   - non-status edit on confirmed/approved     -> kincare.changed (business)
 *
 * Envelope counter/status rollup lives in the SEPARATE onKinCareRollup trigger
 * on this same path; this handler only emits notifications.
 *
 * #532: `kincare.requested` is NOT one of them any more. This trigger fires once
 * per VISIT, so a four-day request dispatched it four times. It now comes from
 * onBookingEnvelopeCreate, on the parent `bookings/{batchId}` doc, once per
 * request. Do not put a per-visit dispatch of it back here.
 */
export const onBookingsWrite = onDocumentWritten(
  {
    document: 'families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}',
    region: 'us-central1',
    // AUNTIE_OPERATOR_UIDS lets lib/businessAdmins self-heal an empty
    // businessSettings/admins roster on the first booking request rather than
    // throwing. This trigger dispatches kincare.requested, the highest-traffic
    // businessAdmins notification, so it is the one worth binding.
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
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

    // The cancellation ask and the answer to it, decided by the pure table
    // above so both transitions are testable without an event fixture.
    for (const d of cancellationDispatches(before, after)) {
      await dispatch(d.key, d.extra);
    }

    // #399 item 2: a kinfolk proposed a new time. Same shape as the
    // cancellation ask above and for the same reason -- the visit has NOT
    // moved, someone in the office has to rule on it. Fires on the flag's
    // first appearance AND on a re-request after a decline, which is why the
    // condition also admits a status that has gone back to `pending`.
    const rescheduleAskIsNew =
      !before?.rescheduleRequestedAt ||
      (before?.rescheduleRequestStatus !== 'pending' && after.rescheduleRequestStatus === 'pending');
    if (after.rescheduleRequestedAt && after.rescheduleRequestStatus === 'pending' && rescheduleAskIsNew) {
      await dispatch('kincare.reschedule.requested', {
        reason: after.rescheduleRequestReason ?? null,
      });
    }
    // #532: a visit create used to dispatch `kincare.requested` here. It does NOT
    // any more. This trigger is registered per VISIT, so a four-day request sent
    // the office four copies of one request. The key now comes from
    // onBookingEnvelopeCreate, once per envelope. A bare create falls through
    // every arm below (`beforeStatus` is null, so the transition arm matches
    // nothing) and dispatches nothing, which is the invariant its test asserts.
    if (isCreate && afterStatus === 'requested') return;

    if (beforeStatus !== afterStatus) {
      if (afterStatus === 'confirmed' || afterStatus === 'approved') {
        // #536. A whole-request approval is ONE answer to ONE question. This
        // trigger is registered per VISIT, so a four-day request confirmed here
        // sent the household four "your visit is confirmed" messages per
        // channel, and four more to every business admin through the key's
        // secondary resolver. `approveBookingSeriesCore` now dispatches the
        // single envelope-level copy and stamps the visits it approved.
        //
        // This is NOT the fail-loud rule being bent: the message is not
        // silenced, it is sent once, by the code that knows the whole set.
        // Every other way a visit reaches `confirmed` -- batchUpdateBookings,
        // the Android schedule screen -- carries no stamp and still sends here.
        if (!seriesApproveStampChanged(before, after)) {
          await dispatch('kincare.booking.confirm', await visitDateFieldsFor(after, visitId));
        }
      } else if (afterStatus === 'cancelled') {
        // #533. A DECLINED request is not a cancelled visit. Those visits were
        // never on the household's schedule, so "your visit was cancelled"
        // reports an event that did not happen; the true message,
        // `kincare.request.declined`, is dispatched once for the whole envelope
        // by admin/manageBookingSeries.
        //
        // This is not the fail-loud rule being bent. That rule says do not
        // silence a TRUE message to fix a wrong count (#532). Here the message
        // itself is false.
        //
        // The test is the explicit `requestDeclinedAt` stamp, NOT the
        // `requested -> cancelled` transition, because that transition has a
        // second, opposite meaning: the portal lets a household ask to cancel a
        // still-`requested` visit, and ACCEPTING that ask makes the identical
        // status change while owing them a confirmation. Only the decline path
        // writes this stamp.
        if (!declineStampedOn(before) && declineStampedOn(after)) {
          // Declined: the envelope-level key carries this news instead.
        } else {
          await dispatch('kincare.booking.cancel');
        }
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
