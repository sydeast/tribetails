import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

/**
 * AuntieOS admin Firebase config.
 *
 * These are public client identifiers, not secrets: they ship in every bundle and
 * are governed by Security Rules, not by obscurity. Same posture as
 * ../MyTribe/web/src/lib/firebase.ts.
 *
 * NOTE the appId. This project has TWO registered web apps:
 *   MyTribe Web    1:153396971788:web:23eab70f9dfe37447f2129
 *   AuntieOS Web   1:153396971788:web:c2631409219d44727f2129   <- this one
 * Verified against the live project 2026-07-15. AO-6 in the plan doc claims the
 * web app "was never registered and the bridge uses an Android appId"; that is
 * stale. The wasm bridge already uses the real AuntieOS Web app, and the comment
 * above its config (still giving instructions to go register one) was left behind
 * after someone did exactly that.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo',
  authDomain: 'auntieos-ttpc.firebaseapp.com',
  projectId: 'auntieos-ttpc',
  storageBucket: 'auntieos-ttpc.firebasestorage.app',
  messagingSenderId: '153396971788',
  appId: '1:153396971788:web:c2631409219d44727f2129',
  measurementId: 'G-NNCB4GT3M6',
} as const;

export const app = initializeApp(firebaseConfig);

/**
 * No App Check here yet, deliberately.
 *
 * MyTribe/web activates it (O-3 ruling). AuntieOS ships its own registration at
 * A8 (O-30 Phase 2), AFTER cutover. The reason is the collision documented in
 * MyTribe's auth.ts: whichever reCAPTCHA Enterprise script loads second executes
 * its key against the other's instance and its token promise pends SILENTLY,
 * which is how the claim screen came to hang forever. Do not add App Check here
 * without reading that ruling first and unifying the loaders.
 */

export const auth = getAuth(app);
export const db = getFirestore(app);
// us-central1 to match the wasm bridge and every deployed callable.
export const functions = getFunctions(app, 'us-central1');
