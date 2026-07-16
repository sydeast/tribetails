import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Assign (or unassign) an Auntie on a single KinCare visit.
 *
 * Writes `assignedAuntieUid` + `auntieDisplayName` on
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`. The
 * onBookingsWrite trigger owns the notification fallout (assignment.assigned
 * to the new Auntie, assignment.changed to the previous one), so this callable
 * only validates and writes.
 *
 * auntieUid: null clears the assignment.
 */
const Args = z.object({
  kinfolkId: z.string().min(1).max(200),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  auntieUid: z.string().min(1).max(200).nullable(),
});

export async function assignAuntieHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; visitId: string; auntieUid: string | null }> {
  initSentry();
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'assignAuntie validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const visitRef = db().doc(
    `families/${args.kinfolkId}/bookings/${args.batchId}/kinCares/${args.visitId}`,
  );
  const visitSnap = await visitRef.get();
  if (!visitSnap.exists) {
    throw new HttpsError('not-found', 'assignAuntie: visit not found.');
  }

  let displayName: string | null = null;
  if (args.auntieUid) {
    const staffSnap = await db().collection('staff').doc(args.auntieUid).get();
    if (!staffSnap.exists) {
      throw new HttpsError('failed-precondition', 'assignAuntie: no staff record for that uid.');
    }
    displayName = (staffSnap.data() as { displayName?: string } | undefined)?.displayName ?? null;
  }

  await visitRef.set(
    {
      assignedAuntieUid: args.auntieUid ?? FieldValue.delete(),
      auntieDisplayName: displayName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'assignAuntie',
    event: 'visit.assignee.changed',
    uid: req.auth?.uid,
    extra: { kinfolkId: args.kinfolkId, batchId: args.batchId, visitId: args.visitId, auntieUid: args.auntieUid },
  });
  return { ok: true, visitId: args.visitId, auntieUid: args.auntieUid };
}

export const assignAuntie = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('assignAuntie', assignAuntieHandler),
);
