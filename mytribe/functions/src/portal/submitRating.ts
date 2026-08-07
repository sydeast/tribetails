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
