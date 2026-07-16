import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const BlockTimeArgs = z
  .object({
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    startTime: z.string().regex(TIME_RE, 'startTime must be HH:mm'),
    endTime: z.string().regex(TIME_RE, 'endTime must be HH:mm'),
    notes: z.string().max(500).default(''),
  })
  .refine((a) => a.startTime < a.endTime, {
    message: 'startTime must be before endTime',
    path: ['endTime'],
  });

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

  const ref = db().collection('booking_time_slots').doc();
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
    syncState: 'LOCAL',
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
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
