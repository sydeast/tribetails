import { db } from './firestoreAdmin';

/**
 * Batch-resolves kin (pet) display names for a household from their ids, the
 * same `families/{kinfolkId}/kin/{kinId}` doc + `name` field getMyKin.ts
 * reads for the portal's own kin list.
 *
 * Booking/session writers have `kinIds` at write time but, until now, wrote
 * `kinNames: []` unconditionally: the portal's live-visit card fell back to
 * "your kin" and Android's Schedule dropped its Pets line, on every booking,
 * because nothing ever populated the array.
 *
 * A missing kin doc (deleted kin, or a stale/bad id) is left OUT of the
 * result rather than failing the caller: a booking or session should still
 * write with whatever names DID resolve, not block on one bad id. Reads are
 * batched with `getAll` so an envelope with N kin costs one round trip, not N.
 */
export async function resolveKinNames(kinfolkId: string, kinIds: string[]): Promise<string[]> {
  const ids = [...new Set(kinIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return [];

  const firestore = db();
  const refs = ids.map((id) => firestore.doc(`families/${kinfolkId}/kin/${id}`));
  const snaps = await firestore.getAll(...refs);

  const names: string[] = [];
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const name = (snap.data() as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.trim().length > 0) names.push(name);
  }
  return names;
}
