import { db } from './firestoreAdmin';

/**
 * The household display name for each kinfolk id, read once per household.
 *
 * #1577: the office's request queues (reschedule, cancel, new booking) have to
 * name WHO is asking. The visit documents under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares` carry no household name,
 * so the name comes from `families/{kinfolkId}.displayName`, the same field
 * `listPendingBookingRequests` already reads for a new request.
 *
 * One read per distinct household, not per row: a household with three asks
 * waiting is one read. A read that fails, or a family doc with no name, maps to
 * null so the row still lists. A nameless row the office can still answer
 * beats a row dropped because its parent would not read.
 */
export async function householdNamesFor(kinfolkIds: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(kinfolkIds.filter((id) => id.length > 0))];
  const entries = await Promise.all(
    unique.map(async (id): Promise<[string, string | null]> => {
      try {
        const snap = await db().doc(`families/${id}`).get();
        const name = (snap.data() as Record<string, unknown> | undefined)?.['displayName'];
        return [id, typeof name === 'string' && name.trim().length > 0 ? name.trim() : null];
      } catch {
        return [id, null];
      }
    }),
  );
  return new Map(entries);
}
