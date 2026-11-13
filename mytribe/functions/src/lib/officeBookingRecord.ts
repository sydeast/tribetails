import { FieldValue, type Timestamp } from 'firebase-admin/firestore';
import type { BookingCommunication } from '../portal/requestBooking';

/**
 * #1575 / #1726: the booking record behind a visit the OFFICE put on the
 * calendar, as two documents:
 *
 *   families/{kinfolkId}/bookings/{batchId}           envelopeStatus 'confirmed'
 *   .../kinCares/{visitId}                             status 'confirmed', sessionId set
 *
 * The Auntie assignment and both note threads live on the visit document, and
 * a session reaches it through `kinCareBatchId` / `kinCareVisitId`. A session
 * with no record behind it reads "This visit is not part of a booking request"
 * under Assigned Auntie on every client.
 *
 * Two writers share this shape, so the record cannot drift between them:
 *  - `createKinCareSession` (Schedule > New visit, and Android's approval of
 *    its own booking since #1630) writes it with a new session.
 *  - `transitionBookingStatus` APPROVE (#1726) writes it for a session that
 *    already exists and has none: the desktop console's draft, or an older
 *    one-visit request written straight to `kin_care_sessions`.
 *
 * Nobody is notified by these documents. `onBookingEnvelopeCreate` answers
 * only an envelope created `requested`; the visit carries `seriesApprovedAt`,
 * which tells `onBookingsWrite` the confirmation was decided by the code that
 * wrote the whole set, so it sends no per-visit "your visit is confirmed".
 * No default assignee either: choosing the Auntie is the step the record makes
 * possible, and an assignee on create would fire `assignment.assigned`.
 */
export interface OfficeBookingRecordInput {
  kinfolkId: string;
  /** Who put the visit on the calendar. */
  uid: string;
  batchId: string;
  visitId: string;
  /** The `kin_care_sessions` id the visit points back at. */
  sessionId: string;
  serviceType: string;
  startTs: Timestamp | null;
  endTs: Timestamp | null;
  kinIds: string[];
  kinNames: string[];
  /**
   * #1574: a record of a visit that already happened, completed from birth on
   * the household's copy as on the office's.
   */
  backdated: boolean;
  /**
   * The household's own words for the visit, kept on the ENVELOPE as
   * `requestBooking` keeps a request's note (#1579). Null for a New visit,
   * whose office note stays on the session.
   */
  householdNote: string | null;
}

export function officeBookingRecordDocs(o: OfficeBookingRecordInput): {
  envelope: Record<string, unknown>;
  visit: Record<string, unknown>;
} {
  const envelope: Record<string, unknown> = {
    familyId: o.kinfolkId,
    requestBatchId: o.batchId,
    visitIds: [o.visitId],
    envelopeStatus: o.backdated ? 'completed' : 'confirmed',
    requestedByUid: o.uid,
    // Marks the record as the office's own, so nobody reads it as a household
    // request that was approved.
    scheduledByOffice: true,
    pattern: 'individual',
    weeklyDays: null,
    serviceId: null,
    serviceName: o.serviceType,
    kinIds: o.kinIds,
    kinNames: o.kinNames,
    notes: o.householdNote,
    billing: null,
    // `COMMUNICATION_DEFAULT` (portal/requestBooking.ts), spelled out so this
    // module does not load the portal callable's module at cold start.
    communication: { emailConfirmation: false } satisfies BookingCommunication,
    visitCount: 1,
    confirmedCount: o.backdated ? 0 : 1,
    completedCount: o.backdated ? 1 : 0,
    cancelledCount: 0,
    firstStartTime: o.startTs,
    lastStartTime: o.startTs,
    targetType: 'KIN',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const visit: Record<string, unknown> = {
    batchId: o.batchId,
    familyId: o.kinfolkId,
    status: o.backdated ? 'completed' : 'confirmed',
    ...(o.backdated && { completedAt: o.endTs }),
    visitProgress: null,
    serviceId: null,
    serviceName: o.serviceType,
    serviceType: o.serviceType,
    priceCents: null,
    timeBlockId: null,
    timeBlockLabel: null,
    title: o.serviceType,
    startTime: o.startTs,
    endTime: o.endTs,
    startTimePending: false,
    requestedDate: null,
    kinIds: o.kinIds,
    kinNames: o.kinNames,
    assignedAuntieUid: null,
    auntieDisplayName: null,
    auntieAvatarUrl: null,
    // The visit's own note slot stays empty: a household note is on the
    // envelope, and the office's note is on the session.
    notes: null,
    requestedByUid: o.uid,
    sourceBookingId: o.visitId,
    sessionId: o.sessionId,
    scheduledByOffice: true,
    seriesApprovedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  return { envelope, visit };
}
