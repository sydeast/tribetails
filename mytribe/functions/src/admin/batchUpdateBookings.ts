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

/**
 * Stage 2 tail: apply ONE booking transition to many individual visits at once.
 *
 * Individual bookings are the per-visit kinCare docs that live under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}` (written by
 * requestBooking, read by getMyBookings via collectionGroup('kinCares')). The
 * existing single/series transition (see manageBookingSeries) flips the visit's
 * `status` field: APPROVE -> 'confirmed', CANCEL -> 'cancelled'. This batch
 * callable applies the SAME transition to each id supplied. REJECT terminates a
 * still-pending request and maps to 'cancelled' (the codebase has no distinct
 * 'rejected' status value), but is logged/audited as a REJECT so the intent is
 * preserved in the trail.
 *
 * Ids are flat visit ids resolved via collectionGroup('kinCares'); the handler
 * does not require the caller to know each visit's parent family/batch.
 *
 * Idempotent per id: if a visit is already in the target status it is reported
 * as updated without a redundant write. Per-id failures (missing id, etc.) are
 * collected into `failed` rather than aborting the whole batch.
 */
const Args = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(100),
  action: z.enum(['APPROVE', 'REJECT', 'CANCEL']),
});

export interface BatchUpdateBookingsResult {
  ok: true;
  action: 'APPROVE' | 'REJECT' | 'CANCEL';
  updated: number;
  failed: Array<{ id: string; error: string }>;
}

function targetStatus(action: 'APPROVE' | 'REJECT' | 'CANCEL'): string {
  // Mirrors manageBookingSeries: APPROVE confirms, REJECT/CANCEL terminate.
  return action === 'APPROVE' ? 'confirmed' : 'cancelled';
}

export async function batchUpdateBookingsHandler(
  req: CallableRequest<unknown>,
): Promise<BatchUpdateBookingsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'batchUpdateBookings validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const wanted = targetStatus(args.action);

  // Resolve every requested id once via the collection group. Build an id ->
  // doc-ref map so each id's parent family/batch is recovered without the
  // caller supplying it.
  const cgSnap = await db().collectionGroup('kinCares').get();
  const byId = new Map<string, { ref: FirebaseFirestore.DocumentReference; status: string }>();
  for (const d of cgSnap.docs) {
    const data = d.data() as { status?: string };
    byId.set(d.id, { ref: d.ref, status: data.status ?? 'requested' });
  }

  const requestedIds = Array.from(new Set(args.ids));
  let updated = 0;
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of requestedIds) {
    const hit = byId.get(id);
    if (!hit) {
      failed.push({ id, error: 'not-found' });
      continue;
    }
    try {
      if (hit.status === wanted) {
        // Idempotent: already in target state, count as updated, skip write.
        updated += 1;
        continue;
      }
      await hit.ref.set(
        { status: wanted, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
        { merge: true },
      );
      updated += 1;
    } catch (err) {
      failed.push({ id, error: (err as Error)?.message ?? 'write-failed' });
    }
  }

  await writeAuditEntry({
    // Any per-id failure means this batch did not fully do what it was asked;
    // the enum has no PARTIAL, so a batch that didn't fully succeed is
    // audited as FAILURE, not SUCCESS. Counts stay in description/payload.
    status: failed.length === 0 ? 'SUCCESS' : 'FAILURE',
    event: AUDIT_EVENTS.BOOKING_BATCH_ACTION,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'kinCares',
    description: `Batch ${args.action} on ${requestedIds.length} booking(s): ${updated} updated, ${failed.length} failed`,
    payload: {
      action: args.action,
      requested: requestedIds.length,
      updated,
      failedIds: failed.map((f) => f.id),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'batchUpdateBookings',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'batchUpdateBookings',
    event: 'admin.bookings.batch',
    uid,
    extra: { action: args.action, requested: requestedIds.length, updated, failed: failed.length },
  });

  return { ok: true, action: args.action, updated, failed };
}

export const batchUpdateBookings = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('batchUpdateBookings', batchUpdateBookingsHandler),
);
