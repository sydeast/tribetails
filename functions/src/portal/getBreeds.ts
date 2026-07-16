import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface GetBreedsResult {
  dogBreeds: string[];
  catBreeds: string[];
}

/**
 * Breed name lists for the Kin breed dropdown, read from the seeded
 * `dog_breeds` (478) and `cat_breeds` (103) collections in auntieos-ttpc. The
 * breed name is the doc id; a `name` field wins if present. Signed-in only;
 * the Admin SDK read bypasses Firestore rules, so no rule change is needed.
 * Small animals / reptiles / fish / birds / turtles keep a free-text breed
 * until their banks are seeded.
 */
export async function getBreedsHandler(req: CallableRequest<unknown>): Promise<GetBreedsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const [dogSnap, catSnap] = await Promise.all([
    firestore.collection('dog_breeds').get(),
    firestore.collection('cat_breeds').get(),
  ]);

  const nameOf = (d: { id: string; data: () => Record<string, unknown> }): string => {
    const n = d.data()['name'];
    return typeof n === 'string' && n.trim().length > 0 ? n : d.id;
  };
  const sortNames = (a: string, b: string) => a.localeCompare(b);
  const dogBreeds = dogSnap.docs.map(nameOf).sort(sortNames);
  const catBreeds = catSnap.docs.map(nameOf).sort(sortNames);

  logEvent({
    severity: 'info',
    function: 'getBreeds',
    event: 'portal.breeds.resolved',
    uid,
    extra: { dogs: dogBreeds.length, cats: catBreeds.length },
  });
  return { dogBreeds, catBreeds };
}

export const getBreeds = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getBreeds', getBreedsHandler),
);
