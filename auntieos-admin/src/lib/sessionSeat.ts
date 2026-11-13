import { getIdTokenResult } from 'firebase/auth';
import { auth } from './firebase';
import { caretakerFromClaim } from './gate';

/**
 * Who is signed in, as far as a READ needs to know: the uid, and whether the
 * session is an Auntie's (#2164).
 *
 * The same reading the gate makes (`lib/access.ts#accessFromClaims`, first
 * branch): a `staffRole: 'auntie'` claim is an Auntie whatever else the token
 * carries, so an account holding both claims reads as her, as it does on the
 * server and in `firestore.rules`.
 *
 * Read off the CACHED token (no forced refresh): the gate already refreshed it
 * on the way in, and this is asked on every screen that loads settings. With no
 * user signed in (a unit test, or the moment after sign-out) it answers the
 * owner's path with a blank uid; the owner's reads then fail on their own
 * terms, as they always have.
 */
export interface SessionSeat {
  uid: string;
  caretaker: boolean;
}

export async function currentSessionSeat(): Promise<SessionSeat> {
  const user = auth.currentUser;
  if (!user) return { uid: '', caretaker: false };
  const token = await getIdTokenResult(user);
  return { uid: user.uid, caretaker: caretakerFromClaim(token.claims.staffRole) };
}

/**
 * A cache key that cannot carry one session's answer into another's: an owner
 * who signs out and an Auntie who signs in on the same tab get different keys,
 * so she is never served the owner's cached settings.
 */
export function seatKey(prefix: string, seat: SessionSeat): string {
  return `${prefix}:${seat.uid}:${seat.caretaker ? 'auntie' : 'owner'}`;
}
