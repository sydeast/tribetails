import { db } from './firestoreAdmin';

/**
 * Resolves the per-visit kinCare doc ref under
 * `families/{familyId}/bookings/{batchId}/kinCares/{visitId}`.
 *
 * Envelope-model callers pass `{ batchId, visitId }`. Mid-migration callers may
 * still send only a legacy `bookingId` (the old flat `bookings/{id}` id); in
 * that case we best-effort resolve it via `collectionGroup('kinCares')` scoped
 * to the family. The legacy id matched against is the kinCare doc id OR its
 * `sourceBookingId` back-reference (AuntieOS-written), whichever exists.
 *
 * Returns the doc ref + resolved ids, or null when nothing matches.
 */
export async function resolveKinCareRef(args: {
  familyId: string;
  batchId?: string | null;
  visitId?: string | null;
  /** Legacy flat-collection id sent by un-migrated callers. */
  bookingId?: string | null;
}): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  batchId: string;
  visitId: string;
} | null> {
  const { familyId } = args;
  const batchId = args.batchId ?? null;
  const visitId = args.visitId ?? null;

  // Direct envelope path.
  if (batchId && visitId) {
    const ref = db().doc(`families/${familyId}/bookings/${batchId}/kinCares/${visitId}`);
    const snap = await ref.get();
    if (snap.exists) return { ref, batchId, visitId };
    return null;
  }

  // Back-compat: only a legacy bookingId was supplied. Best-effort lookup so
  // nothing hard-breaks mid-migration.
  const legacyId = args.bookingId ?? null;
  if (!legacyId) return null;

  // Try the visit doc id directly first (cheapest, common case where the
  // caller's "bookingId" is actually the new visit id under a known family).
  const byVisitId = await db()
    .collectionGroup('kinCares')
    .where('familyId', '==', familyId)
    .get();
  for (const d of byVisitId.docs) {
    const data = d.data() as { batchId?: string; sourceBookingId?: string };
    if (d.id === legacyId || data.sourceBookingId === legacyId) {
      const parentBatchId = data.batchId ?? d.ref.parent.parent?.id ?? '';
      return { ref: d.ref, batchId: parentBatchId, visitId: d.id };
    }
  }
  return null;
}
