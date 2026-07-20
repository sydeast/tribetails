import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * The staff roster, for the Assigned Auntie picker (web + android). One doc
 * per staff member at `staff/{uid}`; today that is the operator plus any
 * future Aunties. Sorted by displayName so the picker reads stably.
 */

export interface StaffMemberDto {
  uid: string;
  displayName: string | null;
  email: string | null;
}

export async function listStaffHandler(
  _req: CallableRequest<unknown>,
): Promise<{ staff: StaffMemberDto[] }> {
  initSentry();
  const snap = await db().collection('staff').get();
  const staff = snap.docs
    .map((d) => {
      const data = d.data() as { displayName?: string; email?: string };
      return {
        uid: d.id,
        displayName: typeof data.displayName === 'string' ? data.displayName : null,
        email: typeof data.email === 'string' ? data.email : null,
      };
    })
    .sort((a, b) => (a.displayName ?? a.uid).localeCompare(b.displayName ?? b.uid));
  return { staff };
}

export const listStaff = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listStaff', listStaffHandler),
);
