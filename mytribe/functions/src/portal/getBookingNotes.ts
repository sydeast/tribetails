import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { validateResponse } from '../lib/callableResponse';

/**
 * #1283: what a household told its Auntie about one visit, read back to it.
 *
 * `addBookingNote` writes a household's note to `kinCares/{id}/notes` and the
 * booking wizard's "Extra Love & Context" text to the parent envelope's
 * `notes`. Neither was ever returned to the household, so the note box cleared
 * to its placeholder and the screen looked as if nothing had been saved.
 *
 * This is the read. Its one hard rule is WHOSE notes: the `notes` subcollection
 * is a shared thread. `addBookingNote` stamps `authorRole: 'kinfolk'` for a
 * household and `'admin'` for staff (an Auntie answering through the same
 * callable), and `addInternalBookingNote` keeps the office's private thread
 * beside it. A household reads only the rows stamped `kinfolk`. Staff rows,
 * the internal thread, dossier and 411 text are never in this response, and
 * the filter is applied on the server before anything is serialised, so no
 * client has to be trusted to hide what it was sent.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
});

export const BookingNoteSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    /** Epoch millis the note was written; null for a row with no readable timestamp. */
    createdAtMs: z.number().int().nullable(),
  })
  .strict();

export const Result = z
  .object({
    /**
     * The text the household typed in the booking wizard's Extra Love & Context
     * step, from the parent booking. Null when it left that blank. One note per
     * booking, so a series' visits all carry the same one.
     */
    bookingNote: z.string().nullable(),
    /** Notes the household saved on this visit, oldest first. */
    notes: z.array(BookingNoteSchema),
  })
  .strict();

/** Hard ceiling so a runaway thread cannot make one read unbounded. */
const MAX_NOTES = 200;

function millisOf(v: unknown): number | null {
  const ms = (v as { toMillis?: () => number } | null | undefined)?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}

export async function getBookingNotesHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getBookingNotes validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    householdStaffFlag(req.auth, 'getBookingNotes'),
    'getBookingNotes',
  );

  const parentRef = db().doc(`families/${kinfolkId}/bookings/${args.batchId}`);
  const visitRef = parentRef.collection('kinCares').doc(args.visitId);
  const visitSnap = await visitRef.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'Visit not found.');

  const parentSnap = await parentRef.get();
  const rawBookingNote = (parentSnap.data() ?? {})['notes'];
  const bookingNote =
    typeof rawBookingNote === 'string' && rawBookingNote.trim() !== '' ? rawBookingNote.trim() : null;

  const notesSnap = await visitRef.collection('notes').orderBy('createdAt', 'asc').limit(MAX_NOTES).get();
  const notes = notesSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    // The privacy line. Only rows the household itself wrote.
    .filter(({ data }) => data['authorRole'] === 'kinfolk' && typeof data['body'] === 'string')
    .map(({ id, data }) => ({
      id,
      body: data['body'] as string,
      createdAtMs: millisOf(data['createdAt']),
    }));

  logEvent({
    severity: 'info',
    function: 'getBookingNotes',
    event: 'portal.booking.notes.read',
    uid,
    extra: { kinfolkId, batchId: args.batchId, visitId: args.visitId, count: notes.length },
  });
  return validateResponse('getBookingNotes', Result, { bookingNote, notes });
}

export const getBookingNotes = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getBookingNotes', getBookingNotesHandler),
);
