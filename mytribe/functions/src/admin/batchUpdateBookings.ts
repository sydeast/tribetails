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
 * TWO CALLERS, TWO ID SPACES, because "a booking" is a different document on
 * each platform:
 *
 *   kinCares envelope visits, `families/{kinfolkId}/bookings/{batchId}/kinCares
 *   /{visitId}` (written by requestBooking, read by the household's own
 *   getMyBookings via collectionGroup('kinCares')). This is what the React
 *   admin's Bookings screen sends (`bookingBulk.ts`'s `envelopeVisitId`, never
 *   its `kin_care_sessions` row id), and what android's Notifications quick
 *   approve/deny sends (the notification's `targetId`, stamped as `visitId` by
 *   `onBookingsWrite.ts`). On a hit, the same transition the existing
 *   single/series path uses (see manageBookingSeries) is mirrored onto the
 *   paired `kin_care_sessions/vis_{visitId}` doc when one exists, exactly as
 *   manageBookingSeries's own CANCEL path already does -- so this callable
 *   writes both sides of the split itself, rather than relying on a caller to
 *   duplicate the write (the React admin still writes `kin_care_sessions`
 *   directly today too; that write is now redundant, not required, and is
 *   left alone since it is the reference path).
 *
 *   `enhanced_bookings/{id}` top-level docs -- android's OWN flat booking
 *   table (`ServiceModels.kt`'s `EnhancedBooking`; "Android bookings persist
 *   as EnhancedBooking docs (web uses KinCareSession); each platform carries
 *   its own"). This is what android's Bookings/Schedule screen bulk bar sends
 *   (`ScheduleViewScreen.kt`'s `selectableIds`, built from `EnhancedBooking.id`).
 *   These docs carry no envelope linkage field at all (approveBooking's
 *   optional `incoming: IncomingKinCare?` parameter that would supply one is
 *   never actually wired from any android call site today), so a hit here is
 *   the WHOLE record: only its own `status` is written, one-sided.
 *
 * Before this fix the handler only ever tried the first space. Every id
 * android's Bookings screen bulk bar has ever sent was `enhanced_bookings`
 * shaped, so every one came back `not-found` and the action was a no-op
 * wearing a success banner (android's own quick-approve/deny on Notifications
 * already sent the right-shaped id and worked; the bulk screen's ids were the
 * broken path).
 *
 * Idempotent per id: if a doc is already in the target status it is reported
 * as updated without a redundant write. Per-id failures (missing id, a write
 * that throws, etc.) are collected into `failed` rather than aborting the
 * whole batch.
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

/** kinCares envelope + kin_care_sessions mirror status. APPROVE confirms, REJECT/CANCEL terminate. */
function kinCareTargetStatus(action: 'APPROVE' | 'REJECT' | 'CANCEL'): string {
  return action === 'APPROVE' ? 'confirmed' : 'cancelled';
}

/** kin_care_sessions uses its own (uppercase) status vocabulary; see bookingFormat.ts. */
function sessionMirrorStatus(action: 'APPROVE' | 'REJECT' | 'CANCEL'): string {
  return action === 'APPROVE' ? 'SCHEDULED' : 'CANCELLED';
}

/** android's EnhancedBooking status enum (ServiceModels.kt): DRAFT, ACCEPTED, REJECTED, COMPLETED. */
function enhancedBookingTargetStatus(action: 'APPROVE' | 'REJECT' | 'CANCEL'): string {
  return action === 'APPROVE' ? 'ACCEPTED' : 'REJECTED';
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

  const requestedIds = Array.from(new Set(args.ids));

  // Phase 1: try android's native enhanced_bookings table directly -- each id
  // IS a doc, no envelope indirection to resolve. One getAll, not a scan, and
  // cheap even at the 100-id cap.
  const enhancedRefs = requestedIds.map((id) => db().collection('enhanced_bookings').doc(id));
  const enhancedSnaps = await db().getAll(...enhancedRefs);
  const enhancedById = new Map<string, { ref: FirebaseFirestore.DocumentReference; status: string }>();
  enhancedSnaps.forEach((snap, i) => {
    if (snap.exists) {
      const data = snap.data() as { status?: string };
      enhancedById.set(requestedIds[i], { ref: snap.ref, status: data.status ?? 'DRAFT' });
    }
  });

  // Phase 2: whatever isn't an enhanced_bookings id resolves as a kinCares
  // envelope visit id (web's Bookings screen, android's Notifications quick
  // approve/deny). Skipped entirely once every id already resolved in phase
  // 1, so an all-android batch never pays for the collection-group scan.
  const remaining = requestedIds.filter((id) => !enhancedById.has(id));
  const kinCareById = new Map<string, { ref: FirebaseFirestore.DocumentReference; status: string }>();
  if (remaining.length > 0) {
    const cgSnap = await db().collectionGroup('kinCares').get();
    for (const d of cgSnap.docs) {
      const data = d.data() as { status?: string };
      kinCareById.set(d.id, { ref: d.ref, status: data.status ?? 'requested' });
    }
  }

  const kinCareWanted = kinCareTargetStatus(args.action);
  const sessionMirrorWanted = sessionMirrorStatus(args.action);
  const enhancedWanted = enhancedBookingTargetStatus(args.action);
  // ISO-8601 STRING, deliberately not FieldValue.serverTimestamp(): android's
  // EnhancedBooking.updatedAt decodes as a Kotlin String, and a Timestamp
  // there is a decode crash, not a type coercion.
  const nowIso = new Date().toISOString();

  let updated = 0;
  let enhancedResolved = 0;
  let kinCareResolved = 0;
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of requestedIds) {
    const enhancedHit = enhancedById.get(id);
    if (enhancedHit) {
      enhancedResolved += 1;
      try {
        if (enhancedHit.status === enhancedWanted) {
          // Idempotent: already in target state, count as updated, skip write.
          updated += 1;
          continue;
        }
        await enhancedHit.ref.set(
          { status: enhancedWanted, updatedAt: nowIso, lastModifiedBy: uid },
          { merge: true },
        );
        updated += 1;
      } catch (err) {
        failed.push({ id, error: (err as Error)?.message ?? 'write-failed' });
      }
      continue;
    }

    const hit = kinCareById.get(id);
    if (!hit) {
      failed.push({ id, error: 'not-found' });
      continue;
    }
    kinCareResolved += 1;
    try {
      if (hit.status !== kinCareWanted) {
        await hit.ref.set(
          { status: kinCareWanted, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
          { merge: true },
        );
      }
      // Mirror onto kin_care_sessions the same way manageBookingSeries's own
      // CANCEL path already does: only when the paired session doc exists (a
      // still-pending request that was never approved has none, and the
      // deterministic id is `vis_{visitId}`, minted by approveBookingSeriesCore).
      const sessionRef = db().collection('kin_care_sessions').doc(`vis_${id}`);
      const sessionSnap = await sessionRef.get();
      if (sessionSnap.exists) {
        await sessionRef.set(
          { status: sessionMirrorWanted, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
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
    targetCollection:
      enhancedResolved > 0 && kinCareResolved > 0
        ? 'mixed'
        : enhancedResolved > 0
          ? 'enhanced_bookings'
          : 'kinCares',
    description: `Batch ${args.action} on ${requestedIds.length} booking(s): ${updated} updated, ${failed.length} failed`,
    payload: {
      action: args.action,
      requested: requestedIds.length,
      updated,
      failedIds: failed.map((f) => f.id),
      enhancedBookingIds: enhancedResolved,
      kinCareVisitIds: kinCareResolved,
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
