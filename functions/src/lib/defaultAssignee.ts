import { db } from './firestoreAdmin';

export interface Assignee {
  uid: string;
  displayName: string | null;
}

/**
 * The Auntie a new visit is assigned to when nobody picks one explicitly.
 *
 * Source of truth: `businessSettings/admins`. An optional `defaultAssigneeUid`
 * field wins; otherwise the first entry of `uids` (the operator, in this
 * solo-operator business). Returns null when the doc is missing or empty so
 * callers can create unassigned visits rather than fail the booking.
 */
export async function resolveDefaultAssignee(): Promise<Assignee | null> {
  const snap = await db().collection('businessSettings').doc('admins').get();
  const data = snap.data() as { defaultAssigneeUid?: string; uids?: string[] } | undefined;
  const uid =
    (typeof data?.defaultAssigneeUid === 'string' && data.defaultAssigneeUid) ||
    data?.uids?.[0] ||
    null;
  if (!uid) return null;

  const staffSnap = await db().collection('staff').doc(uid).get();
  const displayName =
    (staffSnap.data() as { displayName?: string } | undefined)?.displayName ?? null;
  return { uid, displayName };
}
