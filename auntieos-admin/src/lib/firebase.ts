import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

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
 * drops the branch together with all three `connect*Emulator` imports.
 *
 * That was CHECKED, not assumed, and re-checked when the functions leg was added.
 * After `vite build`, `dist/assets/*.js` contains zero occurrences of `9399`,
 * `5399`, `VITE_E2E_EMULATOR`, `EMULATOR MODE`, `connectAuthEmulator` or
 * `connectFunctionsEmulator` (2026-08-01). Two hits survive and both are
 * innocent: the one `connectFirestoreEmulator` is a string inside a Firebase SDK
 * warning message, and the one `8385` is a code point in a Unicode range table.
 *
 * `E2E_EMULATOR_HOST` folds to `''` the same way, which is what keeps `fns.ts`'s
 * `CallableNotStubbedError` branch out of production: grep the bundle for
 * `CallableNotStubbedError` and `e2e emulator mode` and both are zero. That
 * matters, because that branch relabels `functions/internal`, and a real
 * production outage must not be reported to an operator as a test-harness
 * problem.
 *
 * Redo those greps if this gate is ever rewritten to read a RUNTIME value: a
 * runtime read cannot be folded, and the emulator path would then ship to
 * production.
 *
 * THE PORTS ARE THE E2E ONES (9399 auth, 8385 firestore, 5399 functions), not
 * the defaults, and not the 9099/8085/5001 set `web/firebase.json` declares for
 * the wasm tree. A test run that silently attached to somebody else's
 * already-running emulator would read their seed data and report a green that
 * meant nothing. Distinct ports turn that into a connection refused. See
 * `e2e.firebase.json`.
 *
 * It reads a HOST, not a boolean, so the harness stays movable: CI can point it
 * at a service container without this file learning about CI.
 */
export const E2E_EMULATOR_HOST = (import.meta.env.VITE_E2E_EMULATOR as string | undefined) ?? '';

/**
 * The functions port, dialled by `connectFunctionsEmulator` below, with NOTHING
 * LISTENING ON IT. That is deliberate, and it is the fix for the defect this
 * file used to carry.
 *
 * Until 2026-08-01 this branch connected auth and Firestore and left `functions`
 * alone, so every `httpsCallable` in an e2e run resolved to
 * `https://us-central1-auntieos-ttpc.cloudfunctions.net/<name>` and left the
 * machine. Measured on the unmodified tree: one visit to `/home` fired ten POSTs
 * at production (listConversations, listExpirations, listExpenses, listSupplies,
 * optimizeRoute, twice each). They never returned data, for two independent
 * reasons recorded here so nobody has to re-derive them:
 *
 *   1. The emulator mints `{"alg":"none"}` JWTs with an EMPTY signature. Deployed
 *      callables reject them at token verification, before the handler runs, with
 *      the framework's own `{"error":{"message":"Unauthenticated"}}` (401) rather
 *      than any handler's `Sign in required.`. Verified by curl 2026-08-01.
 *   2. Production's CORS preflight answers `http://127.0.0.1:5174` with a 204
 *      that carries NO `access-control-allow-origin`, so the browser discards the
 *      response and the POST body never lands.
 *
 * Misleading, then, not a data leak. But traffic still left the machine, the
 * failure mode was a `functions/internal` that reads like a backend fault, and
 * whether it stays harmless depends on production's CORS allowlist and token
 * verifier, neither of which this repo controls. Pinning the SDK at a localhost
 * port makes reaching production STRUCTURALLY IMPOSSIBLE instead: `_url()` can
 * only produce `http://127.0.0.1:5399/...`. `e2e/no-production-egress.spec.ts`
 * is the regression test, and it fails on any non-localhost request at all.
 *
 * NOTHING SERVES THAT PORT ON PURPOSE. The alternative was to build and run
 * `mytribe/functions` under the functions emulator, which was measured and
 * rejected; see `docs/runbooks/e2e.md` for the numbers. A refused connection is
 * turned into a readable sentence by `lib/fns.ts`, which is what makes a spec
 * that needs a callable stub it deliberately (`page.route`) rather than inherit
 * one by accident.
 */
export const E2E_FUNCTIONS_PORT = 5399;

if (E2E_EMULATOR_HOST !== '') {
  // Loud, because a real session that somehow reached this branch would be
  // talking to an empty throwaway database and would otherwise look merely
  // "logged out" rather than misconfigured.
  console.warn(
    `[firebase] EMULATOR MODE: auth + firestore + functions pinned to ${E2E_EMULATOR_HOST}. Not production data.`,
  );
  // SYNCHRONOUS, not a dynamic import. All three connect calls have to land
  // before the first auth, Firestore or callable operation; `firebase/firestore`
  // throws "Firestore has already been started" if a listener beats it. An
  // `import().then()` here would win that race most of the time and lose it on
  // a slow machine, which is the worst kind of flake to own.
  connectAuthEmulator(auth, `http://${E2E_EMULATOR_HOST}:9399`, { disableWarnings: true });
  connectFirestoreEmulator(db, E2E_EMULATOR_HOST, 8385);
  connectFunctionsEmulator(functions, E2E_EMULATOR_HOST, E2E_FUNCTIONS_PORT);
}
