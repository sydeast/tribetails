import { db } from './firestoreAdmin';

/**
 * Looks up the Firebase Auth uid linked to a kinfolk doc via the uid backwrite
 * (`onClientsWrite` writes `kinfolk/{kinfolkId}.uid = clientUid`).
 *
 * Returns null when no uid is set yet (kinfolk hasn't installed MyTribe).
 * Callers should swallow the null case rather than throw, the kinfolk-side
 * notification simply won't dispatch, business side still goes through.
 */
export async function resolveKinfolkUid(kinfolkId: string): Promise<string | null> {
  const snap = await db().collection('kinfolk').doc(kinfolkId).get();
  const uid = (snap.data() as { uid?: string } | undefined)?.uid;
  return uid && uid.length > 0 ? uid : null;
}
