import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
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

/**
 * Emulator wiring for the e2e harness (`e2e/`), and for nothing else.
 *
 * OPT-IN BY AN ENV VAR THAT NOTHING IN THE DEPLOY PATH SETS. `VITE_E2E_EMULATOR`
 * is written in exactly one place, `e2e/playwright.config.ts`'s `webServer.env`,
 * and reaches only the dev server that run boots. A hosting build sees no such
 * variable, so Vite substitutes `undefined` for the whole `import.meta.env`
 * access at build time, the condition folds to a constant false, and Rollup
 * drops the branch together with both `connect*Emulator` imports.
 *
 * That was CHECKED, not assumed. After `npm run build`, `dist/assets/*.js`
 * contains zero occurrences of `9399`, `8385`, `VITE_E2E_EMULATOR`,
 * `EMULATOR MODE` or `connectAuthEmulator` (2026-07-25). The one
 * `connectFirestoreEmulator` hit is a string inside a Firebase SDK warning
 * message, not this call site. Redo that grep if this gate is ever rewritten to
 * read a RUNTIME value: a runtime read cannot be folded, and the emulator path
 * would then ship to production.
 *
 * THE PORTS ARE THE E2E ONES (9399 auth, 8385 firestore), not the defaults, and
 * not the 9099/8085 pair `web/firebase.json` declares for the wasm tree. A test
 * run that silently attached to somebody else's already-running emulator would
 * read their seed data and report a green that meant nothing. Distinct ports
 * turn that into a connection refused. See `e2e/firebase.json`.
 *
 * It reads a HOST, not a boolean, so the harness stays movable: CI can point it
 * at a service container without this file learning about CI.
 */
const emulatorHost = import.meta.env.VITE_E2E_EMULATOR as string | undefined;
if (emulatorHost !== undefined && emulatorHost !== '') {
  // Loud, because a real session that somehow reached this branch would be
  // talking to an empty throwaway database and would otherwise look merely
  // "logged out" rather than misconfigured.
  console.warn(`[firebase] EMULATOR MODE: auth + firestore pinned to ${emulatorHost}. Not production data.`);
  // SYNCHRONOUS, not a dynamic import. Both connect calls have to land before
  // the first auth or Firestore operation; `firebase/firestore` throws
  // "Firestore has already been started" if a listener beats it. An
  // `import().then()` here would win that race most of the time and lose it on
  // a slow machine, which is the worst kind of flake to own.
  connectAuthEmulator(auth, `http://${emulatorHost}:9399`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8385);
}
