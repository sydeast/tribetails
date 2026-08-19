import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { resolveKinCareRef } from '../lib/resolveKinCareRef';
import { resolveNonStaffKinfolkId } from '../lib/resolveNonStaffKinfolkId';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText } from '../lib/richText';

const Args = z
  .object({
    kinfolkId: z.string().optional(),
    batchId: z.string().min(1).optional(),
    visitId: z.string().min(1).optional(),
    /** Legacy flat id, accepted for back-compat mid-migration. */
    bookingId: z.string().min(1).optional(),
    score: z.number().int().min(1).max(5),
    comment: z.string().max(2000).nullable().optional(),
  })
  .refine((a) => (a.batchId && a.visitId) || a.bookingId, {
    message: 'Provide batchId+visitId (preferred) or a legacy bookingId.',
  });

export async function submitRatingHandler(
  req: CallableRequest<unknown>,
): Promise<{ ratingId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);
  const kinfolkId = await resolveNonStaffKinfolkId(uid, args.kinfolkId);

  const resolved = await resolveKinCareRef({
    familyId: kinfolkId,
    batchId: args.batchId,
    visitId: args.visitId,
    bookingId: args.bookingId,
  });
  if (!resolved) throw new HttpsError('not-found', 'booking not found');
  const visitSnap = await resolved.ref.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'booking not found');

  // One rating per visit, deterministic id (the visit id) keeps it idempotent.
  const ratingRef = db().doc(`families/${kinfolkId}/ratings/${resolved.visitId}`);
  const existing = await ratingRef.get();
  if (existing.exists) {
    throw new HttpsError('already-exists', 'Rating already submitted for this booking');
  }
  await ratingRef.set({
    batchId: resolved.batchId,
    visitId: resolved.visitId,
    // THE VISIT THIS RATING IS ABOUT, under the name the notification pipeline
    // reads. `onRatingCreate` hands `bookingId` to the dispatcher, whose
    // `resolveTargetRef` needs it to give the notification a BOOKING target;
    // without it every rating notification fell through to the household, and
    // its Open button landed on the household profile rather than the visit
    // that was rated (issue #389's emitter half). Same value as `visitId` and
    // as this document's own id, written explicitly so a reader does not have
    // to already know that the id and the field are the same thing.
    bookingId: resolved.visitId,
    score: args.score,
    comment: args.comment ? sanitizeRichText(args.comment) || null : null,
    submittedByUid: uid,
    submittedAt: FieldValue.serverTimestamp(),
  });
  logEvent({
    severity: 'info',
    function: 'submitRating',
    event: 'portal.rating.submitted',
    uid,
    extra: { kinfolkId, batchId: resolved.batchId, visitId: resolved.visitId, score: args.score },
  });
  return { ratingId: resolved.visitId };
}

export const submitRating = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('submitRating', submitRatingHandler),
);
