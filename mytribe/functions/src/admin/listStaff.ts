import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { withSignInFallback } from '../lib/staffIdentity';

/**
 * The staff roster, for the Assigned Auntie picker (web + android). One doc
 * per staff member at `staff/{uid}`; today that is the operator plus any
 * future Aunties. Sorted by displayName so the picker reads stably.
 */

export interface StaffMemberDto {
  uid: string;
  /**
   * The name to show (#1564): the staff record's, else the sign-in account's
   * display name, else an email. Null only when none of those exists.
   */
  displayName: string | null;
  /** The staff record's email, as stored. */
  email: string | null;
}

/**
 * #1564: a staff record with no name made the picker (and the Gallery's
 * uploader line, which reads this list) show a raw uid. The name now falls
 * back to the sign-in account's display name, then an email.
 */
export async function listStaffHandler(
  _req: CallableRequest<unknown>,
): Promise<{ staff: StaffMemberDto[] }> {
  initSentry();
  const snap = await db().collection('staff').get();
  const uids = snap.docs.map((d) => d.id);
  const records = snap.docs.map((d) => d.data() as { displayName?: unknown; email?: unknown });
  const identities = await withSignInFallback(uids, records, 'listStaff');
  const staff = identities
    .map((who) => ({
      uid: who.uid,
      displayName: who.displayName,
      email: who.email,
    }))
    .sort((a, b) => (a.displayName ?? a.email ?? a.uid).localeCompare(b.displayName ?? b.email ?? b.uid));
  return { staff };
}

export const listStaff = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listStaff', listStaffHandler),
);
