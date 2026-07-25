import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { resolveKinCareRef } from '../lib/resolveKinCareRef';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText } from '../lib/richText';
import { assertNoteWindowOpen } from '../lib/bookingNoteCutoff';

/**
 * Append a STAFF-ONLY note to
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}/internalNotes`.
 *
 * The kinfolk boundary is drawn at the PATH, not by masking a field:
 * `firestore.rules` reads `notes` for members and `internalNotes` for
 * `isAuntie()` only, and denies every client write to both, which is why this
 * is a callable at all.
 *
 * SAME 3-HOUR CUTOFF as the kinfolk-facing `portal/addBookingNote.ts`, through
 * the shared `lib/bookingNoteCutoff.ts`. It did not used to have one: the rule
 * was private to the other callable, so this thread was guarded by client code
 * alone and any other caller walked past it. Both threads now freeze together
 * and reject with the same typed error.
 */
const Args = z
  .object({
    kinfolkId: z.string().min(1),
    batchId: z.string().min(1).optional(),
    visitId: z.string().min(1).optional(),
    /** Legacy flat id, accepted for back-compat mid-migration. */
    bookingId: z.string().min(1).optional(),
    body: z
      .string()
      .min(1)
      .max(4000)
      .refine((s) => s.trim().length > 0, { message: 'body cannot be whitespace-only' }),
  })
  .refine((a) => (a.batchId && a.visitId) || a.bookingId, {
    message: 'Provide batchId+visitId (preferred) or a legacy bookingId.',
  });

export async function addInternalBookingNoteHandler(
  req: CallableRequest<unknown>,
): Promise<{ noteId: string }> {
  initSentry();
  const uid = req.auth!.uid;
  const args = Args.parse(req.data);
  const body = sanitizeRichText(args.body);
  if (body.length === 0) {
    throw new HttpsError('invalid-argument', 'body cannot be whitespace-only');
  }

  const resolved = await resolveKinCareRef({
    familyId: args.kinfolkId,
    batchId: args.batchId,
    visitId: args.visitId,
    bookingId: args.bookingId,
  });
  if (!resolved) throw new HttpsError('not-found', 'booking not found');
  const visitSnap = await resolved.ref.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'booking not found');

  // Same 3-hour cutoff the kinfolk-facing thread enforces, same shared helper,
  // same typed rejection, so a client can render one message for either thread.
  // Runs AFTER the not-found check so a missing booking never surfaces as a
  // cutoff failure.
  assertNoteWindowOpen(visitSnap.data() ?? {});

  const ref = await resolved.ref.collection('internalNotes').add({
    authorUid: uid,
    authorRole: 'admin',
    body,
    createdAt: FieldValue.serverTimestamp(),
  });
  logEvent({
    severity: 'info',
    function: 'addInternalBookingNote',
    event: 'admin.booking.internalNote.added',
    uid,
    extra: { kinfolkId: args.kinfolkId, batchId: resolved.batchId, visitId: resolved.visitId, noteId: ref.id },
  });
  return { noteId: ref.id };
}

export const addInternalBookingNote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('addInternalBookingNote', addInternalBookingNoteHandler),
);
