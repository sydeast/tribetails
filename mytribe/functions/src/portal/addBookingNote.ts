import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { resolveKinCareRef } from '../lib/resolveKinCareRef';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText } from '../lib/richText';
import { assertNoteWindowOpen } from '../lib/bookingNoteCutoff';
import { validateResponse } from '../lib/callableResponse';

export const Result = z
  .object({
    noteId: z.string().min(1),
  })
  .strict();

export const Args = z
  .object({
    kinfolkId: z.string().optional(),
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

// The 3-hour cutoff, its comparison and its typed rejection now live in
// `lib/bookingNoteCutoff.ts`, shared with `admin/addInternalBookingNote.ts`.
// Behaviour here is unchanged; the rule simply stopped being private to this
// file, which is what let the internal thread go unguarded.

export async function addBookingNoteHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);
  const body = sanitizeRichText(args.body);
  if (body.length === 0) {
    throw new HttpsError('invalid-argument', 'body cannot be whitespace-only');
  }

  // RULING O-6, Q2: kinfolkId remains required as a path locator (the doc
  // path needs it — resolveKinCareRef.ts), but authorization now inverts to
  // resolve-then-authorize: resolve the visit first, then gate on
  // isStaff || membership. Closes the CWE-863 split — a staff caller on the
  // AUNTIE_OPERATOR_UIDS fallback (no admin claim) previously could NOT add a
  // note (this handler checked the claim only); now they can, same as every
  // other staff-facing portal callable.
  if (!args.kinfolkId) {
    throw new HttpsError('invalid-argument', 'kinfolkId is required.');
  }
  const kinfolkId = args.kinfolkId;

  // Authorize on the client-supplied kinfolkId BEFORE resolving the booking:
  // resolving first would let a non-member caller distinguish "booking
  // exists, no access" from "booking not found" via the error code alone.
  const isAdmin = req.auth?.token?.admin === true;
  const staff = isStaff(uid, isAdmin, 'addBookingNote');
  if (!staff) {
    const clientSnap = await db().collection('clients').doc(uid).get();
    const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
    if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');
    if (!allowed.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');
  }

  const resolved = await resolveKinCareRef({
    familyId: kinfolkId,
    batchId: args.batchId,
    visitId: args.visitId,
    bookingId: args.bookingId,
  });
  if (!resolved) throw new HttpsError('not-found', 'booking not found');
  const visitSnap = await resolved.ref.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'booking not found');

  assertNoteWindowOpen(visitSnap.data() ?? {});

  const ref = await resolved.ref.collection('notes').add({
    authorUid: uid,
    authorRole: staff ? 'admin' : 'kinfolk',
    body,
    createdAt: FieldValue.serverTimestamp(),
  });
  logEvent({
    severity: 'info',
    function: 'addBookingNote',
    event: 'portal.booking.note.added',
    uid,
    extra: {
      kinfolkId,
      batchId: resolved.batchId,
      visitId: resolved.visitId,
      noteId: ref.id,
      authorRole: staff ? 'admin' : 'kinfolk',
    },
  });
  return validateResponse('addBookingNote', Result, { noteId: ref.id });
}

export const addBookingNote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('addBookingNote', addBookingNoteHandler),
);
