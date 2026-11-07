import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText } from '../lib/richText';
import { validateResponse } from '../lib/callableResponse';
import { isAuntieClaim } from '../lib/staffGate';
import {
  ADMIN_ONLY_NOTES,
  NO_BOOKING_RECORD_CODE,
  SHARED_NOTES,
  VISIT_NOTE_KINDS,
  appendSessionNote,
  resolveVisitNoteTarget,
} from '../lib/visitNotes';

/**
 * Append an internal (staff) note to a visit. #1580: one store, two kinds.
 *
 *   visibility 'shared'     -> `.../kinCares/{visitId}/internalNotes`  (owner + Aunties)
 *   visibility 'adminOnly'  -> `.../kinCares/{visitId}/adminNotes`     (owner only)
 *
 * Operator ruling, 2026-11-05 docket: "two kinds, shared and admin-only. The
 * writer marks each note. Aunties see only shared notes." The kind is a PATH
 * because `firestore.rules` gates documents, not fields; see `lib/visitNotes.ts`.
 *
 * WHO MAY WRITE WHICH. This callable is on the Auntie allowlist, so the refusal
 * of an admin-only note from an Auntie is HERE, on her claim, not in a hidden
 * composer control. An Auntie writes shared notes only.
 *
 * TWO WAYS IN. Bookings names the booking record (`kinfolkId` + `batchId` +
 * `visitId`, or a legacy `bookingId`); Auntie Time and Schedule name the
 * session (`sessionId`). Both land in the same thread, which is the point of
 * #1580: before it, Auntie Time wrote the session's `notes` text and Bookings
 * wrote this thread, and neither screen showed the other's notes.
 *
 * AN OLDER VISIT WITH NO BOOKING RECORD (made before #1575 / #1630) has no
 * thread to hold a note. A shared note is appended to its session `notes` text
 * instead, the one place such a visit has always kept them; an admin-only note
 * is refused with `visit_has_no_booking_record`, because that text is readable
 * by every Auntie and the note would not stay admin-only.
 *
 * NO 3-HOUR CUTOFF ON THIS THREAD (#1580, a behaviour change). c780f8d9 put the
 * kinfolk-facing thread's freeze on this one too, for parity. Its reason is
 * about the household's words: what the Auntie read at the door is what the
 * household asked for. Staff notes are written during and after a visit (Auntie
 * Time's note box always was), so the freeze would refuse exactly the notes this
 * thread now has to take. The household thread (`portal/addBookingNote.ts`)
 * keeps the cutoff unchanged.
 */
export const Args = z
  .object({
    kinfolkId: z.string().min(1).optional(),
    batchId: z.string().min(1).optional(),
    visitId: z.string().min(1).optional(),
    /** Legacy flat id, accepted for back-compat mid-migration. */
    bookingId: z.string().min(1).optional(),
    /** #1580: the visit by its session (Auntie Time, Schedule). */
    sessionId: z.string().min(1).max(200).optional(),
    body: z
      .string()
      .min(1)
      .max(4000)
      .refine((s) => s.trim().length > 0, { message: 'body cannot be whitespace-only' }),
    /** #1580: the writer's mark. Absent reads as 'shared', which is what every older client meant. */
    visibility: z.enum(VISIT_NOTE_KINDS).optional(),
  })
  .refine((a) => a.sessionId || (a.kinfolkId && ((a.batchId && a.visitId) || a.bookingId)), {
    message: 'Provide sessionId, or kinfolkId with batchId+visitId (preferred) or a legacy bookingId.',
  });

export const Result = z
  .object({
    noteId: z.string().min(1),
    visibility: z.enum(VISIT_NOTE_KINDS),
    /** 'thread' for the booking record's thread; 'visitRecord' for an older visit's session text. */
    storedOn: z.enum(['thread', 'visitRecord']),
  })
  .strict();

export async function addInternalBookingNoteHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth!.uid;
  const args = Args.parse(req.data);
  const body = sanitizeRichText(args.body);
  if (body.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'body cannot be whitespace-only');
  }
  const visibility = args.visibility ?? 'shared';
  // wrapAdminCallable has already admitted the caller as staff, so anyone who
  // is not an Auntie here is the owner (or the owner's sandbox test admin).
  const isAuntie = isAuntieClaim(req.auth?.token);
  if (visibility === 'adminOnly' && isAuntie) {
    throw new HttpsError('permission-denied', 'Only the owner can keep a note from Aunties.');
  }

  const target = await resolveVisitNoteTarget(args);

  if (target.visitRef === null) {
    if (visibility === 'adminOnly') {
      throw new HttpsError(
        'failed-precondition',
        'This visit has no booking record, so a note on it is seen by every Auntie. Add it as a shared note instead.',
        { code: NO_BOOKING_RECORD_CODE },
      );
    }
    const sessionRef = target.sessionRef!;
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      const existing = typeof data['notes'] === 'string' ? data['notes'] : '';
      const nowIso = `${new Date().toISOString().split('.')[0]}Z`;
      tx.set(
        sessionRef,
        {
          notes: appendSessionNote(existing, body, isAuntie ? 'auntie' : 'office', nowIso),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    });
    logEvent({
      severity: 'info',
      function: 'addInternalBookingNote',
      event: 'admin.booking.internalNote.added',
      uid,
      extra: { sessionId: sessionRef.id, storedOn: 'visitRecord', visibility },
    });
    return validateResponse('addInternalBookingNote', Result, {
      noteId: `session:${sessionRef.id}`,
      visibility,
      storedOn: 'visitRecord',
    });
  }

  const ref = await target.visitRef
    .collection(visibility === 'adminOnly' ? ADMIN_ONLY_NOTES : SHARED_NOTES)
    .add({
      authorUid: uid,
      authorRole: isAuntie ? 'auntie' : 'admin',
      body,
      visibility,
      createdAt: FieldValue.serverTimestamp(),
    });
  logEvent({
    severity: 'info',
    function: 'addInternalBookingNote',
    event: 'admin.booking.internalNote.added',
    uid,
    extra: {
      kinfolkId: target.kinfolkId,
      batchId: target.batchId,
      visitId: target.visitId,
      noteId: ref.id,
      visibility,
    },
  });
  return validateResponse('addInternalBookingNote', Result, { noteId: ref.id, visibility, storedOn: 'thread' });
}

export const addInternalBookingNote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('addInternalBookingNote', addInternalBookingNoteHandler),
);
