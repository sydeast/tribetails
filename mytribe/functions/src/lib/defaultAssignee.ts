import { db } from './firestoreAdmin';
import { resolveDefaultAssigneeUid } from './businessAdmins';

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
 *
 * Never throws and never writes, unlike `resolveBusinessAdminUids` which reads
 * the SAME document and does both. That asymmetry is deliberate and is set out
 * in full under "The two resolvers deliberately disagree" in
 * `lib/businessAdmins.ts`: this sits on `requestBooking`, and an unassigned
 * visit is a working booking, so failing (or taking write risk) here would fail
 * a kinfolk's booking over an operator-side configuration gap.
 */
export async function resolveDefaultAssignee(): Promise<Assignee | null> {
  const uid = await resolveDefaultAssigneeUid();
  if (!uid) return null;

  const staffSnap = await db().collection('staff').doc(uid).get();
  const displayName =
    (staffSnap.data() as { displayName?: string } | undefined)?.displayName ?? null;
  return { uid, displayName };
}
