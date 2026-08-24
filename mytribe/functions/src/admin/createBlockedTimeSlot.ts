import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { guardVisitOverlapConflict } from '../lib/visitOverlapConflict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const BlockTimeArgs = z
  .object({
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    startTime: z.string().regex(TIME_RE, 'startTime must be HH:mm'),
    endTime: z.string().regex(TIME_RE, 'endTime must be HH:mm'),
    notes: z.string().max(500).default(''),
    /**
     * The same window as `date`+`startTime`/`endTime`, as REAL INSTANTS, so the
     * server can check it against the visits already on the books (#397 M11).
     *
     * WHY IT EXISTS AND WHY IT IS OPTIONAL. The three fields above are plain
     * wall clock with no zone anywhere on this document — that is the stored
     * shape, shared with the Google importer, and this task does not get to
     * change it (`lib/scheduleFormat.ts` and `lib/bookingBusyConflict.ts` both
     * carry the full write-up of that asymmetry). But `kin_care_sessions` holds
     * real instants, so comparing a zoneless wall clock against them on the
     * SERVER would misread the block by whatever the operator's UTC offset
     * happens to be — precisely the mistake `bookingBusyConflict.ts`
     * deliberately refused to make when it scoped INTERNAL_MANUAL rows out of
     * its own check.
     *
     * The client is the one place that knows the operator's zone, so it sends
     * the same window a second time as epoch ms and the server guards on THAT.
     * Additive and optional because it has to be: the desktop admin's
     * `BlockTimeDialog.kt` already calls this callable with the wall-clock
     * fields alone and keeps working unchanged. A caller that omits these is
     * simply not overlap-checked, which is exactly its behaviour today — never
     * a silent downgrade for a caller that does send them.
     */
    startTimeMs: z.number().int().finite().optional(),
    endTimeMs: z.number().int().finite().optional(),
    /** Admin-only escape hatch: block the window even though a visit already occupies it. See `lib/visitOverlapConflict.ts` for why this guard has an override. */
    overrideVisitConflict: z.boolean().optional(),
  })
  .refine((a) => a.startTime < a.endTime, {
    message: 'startTime must be before endTime',
    path: ['endTime'],
  })
  .refine(
    (a) => a.startTimeMs === undefined || a.endTimeMs === undefined || a.startTimeMs < a.endTimeMs,
    { message: 'startTimeMs must be before endTimeMs', path: ['endTimeMs'] },
  );

export interface CreateBlockedTimeSlotResult {
  ok: true;
  docId: string;
}

/**
 * B6: admin manually blocks an unavailable window. Writes a private BLOCKED slot
 * to `booking_time_slots` (isAvailable=false, source INTERNAL_MANUAL) — the SAME
 * doc shape the Google-busy importer writes, so the existing Schedule "Busy"
 * render (web + android) and the kinfolk booking-availability checks pick it up
 * with no read-side change. This replaces the old admin-direct "New Visit" create
 * on the Schedule screen: admins create visits via Bookings, and use this to
 * block out time off. Admin claim enforced by [wrapAdminCallable].
 *
 * ── TWO SHAPES THIS DOCUMENT GOT WRONG, AND WHY THE SERVER IS THE SIDE THAT
 *    MOVED ───────────────────────────────────────────────────────────────────
 *
 * Both are the same mistake: this handler wrote a value the readers of this
 * collection cannot take, on a document whose entire purpose is being read.
 *
 *  1. `syncState: 'LOCAL'`. The vocabulary is five values - LOCAL_ONLY, SYNCED,
 *     OVERRIDDEN, DISMISSED, FAILED - declared by the Android model
 *     (`ServiceModels.kt#TimeSlotSyncState`) and defaulted to `LOCAL_ONLY` by
 *     the Compose web client (`FirestoreClient.kt#BookingTimeSlot`). The SIBLING
 *     server writer, `syncGoogleCalendarBusyEvents`, writes the in-vocabulary
 *     `'SYNCED'`. `'LOCAL'` appears nowhere else in the repo: three of the four
 *     writers/readers already agreed, so the server was the one out of step and
 *     the fix is here, not a sixth enum value.
 *  2. `createdAt: FieldValue.serverTimestamp()`. `createdAt` is a STRING on both
 *     client models, and the sibling importer writes it as an ISO string
 *     (`busyIntervalToSlot`'s `nowIso`). `updatedAt` is on neither model, so it
 *     is ignored on decode today - it gets the same shape anyway because it is
 *     written in the same statement and every other model in this repo declares
 *     `updatedAt: String`.
 *
 * WHAT EITHER ONE COSTS, measured rather than guessed at. Android decodes these
 * documents with `snapshot.toObjects(BookingTimeSlot::class.java)`, and
 * Firestore's `CustomClassMapper` THROWS on both:
 *
 *     Could not deserialize object. Could not find enum value of
 *     com.tribetails.auntieos.data.model.TimeSlotSyncState for value "LOCAL"
 *     (found in field 'syncState')
 *
 *     Could not deserialize object. Failed to convert value of type
 *     com.google.firebase.Timestamp to String (found in field 'createdAt')
 *
 * Not a wrong label, and not a slot that renders oddly: `toObjects` converts the
 * WHOLE snapshot, so ONE window blocked from the web admin took the phone's
 * entire busy overlay down with it - every other slot in the collection
 * included. In `BookingRepository.bookingTimeSlotsStream` the throw is raised
 * inside the snapshot-listener callback with nothing catching it; in
 * `getTimeSlots`/`getUnavailableSlotsForDate` it turns the whole read into a
 * `Result.failure`. `BookingTimeSlotDiffTest` pins both throws so nobody
 * "fixes" this by widening the enum instead.
 *
 * DOCUMENTS ALREADY WRITTEN are not fixed by this change - Firestore stores what
 * it was given. `mytribe/scripts/repairBlockedTimeSlotShape.ts` repairs them,
 * and it is an operator step.
 */
export async function createBlockedTimeSlotHandler(
  req: CallableRequest<unknown>,
): Promise<CreateBlockedTimeSlotResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof BlockTimeArgs>;
  try {
    args = BlockTimeArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'createBlockedTimeSlot validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // #397 M11: blocking out a window that already has a promised visit in it is
  // the operator saying two contradictory things at once, and until now nothing
  // said so — the slot was written and the visit stayed on the calendar
  // underneath it. Runs ONLY when the caller sent the epoch-ms twin of its wall
  // clock (see `BlockTimeArgs.startTimeMs`): without a zone there is no honest
  // comparison to make, so a caller that omits it is left exactly where it was.
  if (args.startTimeMs !== undefined && args.endTimeMs !== undefined) {
    await guardVisitOverlapConflict({
      firestore: db(),
      visits: [{ startTimeMs: args.startTimeMs, endTimeMs: args.endTimeMs }],
      actorUid: uid,
      actorRole: 'AUNTIE',
      override: args.overrideVisitConflict,
      attempt: 'block_time',
      auditContext: { date: args.date, startTime: args.startTime, endTime: args.endTime },
    });
  }

  const ref = db().collection('booking_time_slots').doc();
  // One instant for both stamps: they describe the same write.
  const nowIso = new Date().toISOString();
  await ref.set({
    date: args.date,
    startTime: args.startTime,
    endTime: args.endTime,
    isAvailable: false,
    slotType: 'BLOCKED',
    notes: args.notes,
    source: 'INTERNAL_MANUAL',
    externalEventId: '',
    externalCalendarId: '',
    hideDetailsFromKinfolk: true,
    isEditableByAdmin: true,
    isRemovableByAdmin: true,
    // 'LOCAL_ONLY', not 'LOCAL'. See TWO SHAPES THIS DOCUMENT GOT WRONG above.
    syncState: 'LOCAL_ONLY',
    createdBy: uid,
    // ISO strings, not FieldValue.serverTimestamp(). Same reason. The sibling
    // importer already writes `createdAt` this way (busyIntervalToSlot's nowIso),
    // so the collection now has ONE time format rather than two.
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CREATE_BLOCKED_TIME_SLOT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { docId: ref.id, date: args.date, startTime: args.startTime, endTime: args.endTime },
  });

  logEvent({
    severity: 'info',
    function: 'createBlockedTimeSlot',
    event: 'admin.timeSlot.blocked',
    uid,
    extra: { docId: ref.id, date: args.date },
  });

  return { ok: true, docId: ref.id };
}

export const createBlockedTimeSlot = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createBlockedTimeSlot', createBlockedTimeSlotHandler),
);
