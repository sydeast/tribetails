import { initializeApp } from 'firebase/app';
import {
  getToken as getAppCheckToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { firestoreCacheMode } from './firestoreCache';
import { reportError } from './sentry';

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

// ---------------------------------------------------------------------------
// O-3 App Check, admin client half (#576). The backend policy layer shipped in
// #562 (`MyTribe/functions/src/lib/appCheckPolicy.ts`): a cohort list in code, a
// mode read from `business_settings/security.appCheckMode` (off | log | enforce,
// default log, fails open), and telemetry that tells an INVALID attestation
// apart from an ABSENT one. Until this file existed, every admin request was
// `absent` — the admin had no attestation at all, and said so in a comment where
// this code now is.
// ---------------------------------------------------------------------------

/**
 * The reCAPTCHA Enterprise site key App Check attests with, for the AuntieOS
 * WEB app (`1:153396971788:web:c2631409219d44727f2129`).
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE THING IN #576 A HUMAN HAS TO DO. Checked against the live
 * project on 2026-08-24 rather than assumed:
 *
 *   - `recaptchaenterprise.googleapis.com/v1/projects/auntieos-ttpc/keys` lists
 *     five keys. The only App Check one is `mytribe-appcheck-web`
 *     (6LcqhVItAAAAAJtyUQuqtYQED9UVpHcoJMdCtsy9), and its `allowedDomains` are
 *     `mytribe-kinfolk-beta.web.app` and `kinfolk.tribetails.com` — neither of
 *     which is where this app is served. The admin's three origins
 *     (auntie.tribetails.com, auntieos-ttpc.web.app,
 *     auntieos-ttpc.firebaseapp.com) are on the two IDENTITY-PLATFORM keys
 *     instead, and O-3 D1 already ruled that App Check must not share a key
 *     with another assessment stream: App Check runs its own assessments, so
 *     one key would pollute both metric streams and couple two unrelated
 *     tuning knobs.
 *   - `firebaseappcheck.googleapis.com/.../apps/<appId>/recaptchaEnterpriseConfig`
 *     returns a `siteKey` for the MyTribe web app and NO `siteKey` for this
 *     one. The AuntieOS web app is known to App Check and has no provider
 *     registered against it.
 *
 * So the operator creates ONE new key and registers it. Exactly:
 *
 *   1. reCAPTCHA console (project auntieos-ttpc) > Create key
 *      - display name: `auntieos-appcheck-web`
 *      - platform: Website, score-based (no challenge)
 *      - domains: auntie.tribetails.com, auntieos-ttpc.web.app,
 *        auntieos-ttpc.firebaseapp.com  (leave localhost OFF; local dev uses
 *        the debug token below)
 *   2. Firebase console > App Check > Apps > "AuntieOS Web" > reCAPTCHA
 *      Enterprise > register, pasting that key.
 *   3. Put the key in [ADMIN_APP_CHECK_SITE_KEY] below (or set
 *      `VITE_ADMIN_APPCHECK_SITE_KEY` in the build env, which wins).
 *
 * Everything else about App Check in this app is already built and tested.
 * Until step 3 lands, [getAppCheckStatus] reports `unconfigured` and says so
 * once, loudly, on every boot — the one thing #576 forbids is this being
 * quiet. `unconfigured` is deliberately not `failed` and not `inactive`: it is
 * neither a broken attestation nor a session that chose to skip one.
 *
 * A site key is a PUBLIC identifier, like the apiKey above. It belongs in the
 * bundle and not in Secret Manager (checked: no reCAPTCHA key is in there).
 */
export const ADMIN_APP_CHECK_SITE_KEY: string = (
  (import.meta.env.VITE_ADMIN_APPCHECK_SITE_KEY as string | undefined) ?? ''
).trim();

if (import.meta.env.DEV) {
  // Debug token for local dev only — dead code (tree-shaken) in production
  // builds since `import.meta.env.DEV` is statically false there. Each operator
  // registers their own token in the App Check console; never commit a real one
  // to VITE_APPCHECK_DEBUG_TOKEN. `globalThis` (not `self` — undefined under
  // Node/vitest, only a browser/worker global) so this doesn't crash test runs
  // that import this module transitively.
  (
    globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
  ).FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
}

/**
 * What actually happened when we tried, as a value anything can read.
 *
 * - `inactive`     — never attempted. This page lifetime chose the auth
 *                    reCAPTCHA loader instead (see `lib/boot.ts`), or it is an
 *                    e2e run.
 * - `unconfigured` — no site key is compiled in. See above; the operator step.
 * - `unsupported`  — no DOM (Node/vitest). Not a failure, not attestation either.
 * - `pending`      — activated, first token not back yet.
 * - `active`       — a real App Check token was minted in this session.
 * - `failed`       — activation threw, or the first token never arrived.
 *
 * The point of `failed` and `unconfigured` existing SEPARATELY from `inactive`
 * is that a broken attestation must not read the same as a session that
 * deliberately skipped one. The portal had no way to tell those apart before
 * #556, which is a large part of why nobody noticed App Check had never once
 * activated there; this app starts with the distinction rather than acquiring
 * it after the same outage.
 */
export type AppCheckStatus =
  | 'inactive'
  | 'unconfigured'
  | 'unsupported'
  | 'pending'
  | 'active'
  | 'failed';

let appCheckInstance: ReturnType<typeof initializeAppCheck> | null = null;
let appCheckStatus: AppCheckStatus = 'inactive';

/** Current App Check state for this page lifetime. */
export function getAppCheckStatus(): AppCheckStatus {
  return appCheckStatus;
}

/** Test seam: forget that activation was attempted in this module's lifetime. */
export function resetAppCheckForTest(): void {
  appCheckInstance = null;
  appCheckStatus = 'inactive';
}

/**
 * How long the first token may take before we call it a failure.
 *
 * Sized above `fns.ts`'s 20s callable timeout on purpose: the Functions SDK
 * awaits the App Check token OUTSIDE its own timeout, so a token promise that
 * pends forever presents as callables hanging with no error at all. 25s means
 * the console line and the Sentry event land after the first callable has
 * already given up, which is the order that makes the pair legible — a
 * `CallableTimeoutError` next to an App Check failure is a different bug report
 * from a `CallableTimeoutError` on its own.
 */
const APP_CHECK_PROBE_TIMEOUT_MS = 25_000;

function appCheckFailed(reason: string, err: unknown): void {
  appCheckStatus = 'failed';
  // Loud in the console AND in Sentry. A silent pass here is the whole defect
  // class #556/#576 are about.
  console.error(`[AppCheck] ${reason}. Callables from this session are unattested.`, err);
  reportError(err, 'appCheck');
}

/**
 * Fetch one token, so activation means something.
 *
 * `initializeAppCheck` returning is not evidence of anything: it constructs a
 * provider and returns synchronously, and every real failure (unregistered app,
 * wrong site key, a domain the key does not allow, a blocked reCAPTCHA script,
 * a token promise that pends because the auth loader already owns `grecaptcha`)
 * shows up later, inside a token fetch nobody was watching.
 */
async function probeAppCheck(instance: ReturnType<typeof initializeAppCheck>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getAppCheckToken(instance),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`App Check token did not arrive within ${APP_CHECK_PROBE_TIMEOUT_MS}ms`),
            ),
          APP_CHECK_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    appCheckStatus = 'active';
    console.log('[AppCheck] attestation active');
  } catch (err) {
    appCheckFailed('attestation failed', err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Turn attestation on for this page lifetime. Idempotent; `lib/boot.ts` owns
 * WHETHER it is called, this owns what happens when it is.
 */
export function activateAppCheck(): void {
  if (appCheckInstance !== null || appCheckStatus === 'failed') return;
  if (typeof document === 'undefined') {
    appCheckStatus = 'unsupported';
    return;
  }
  // Declared further down this file, and read here only at CALL time — which is
  // always after module evaluation, so the const is initialized by then.
  if (E2E_EMULATOR_HOST !== '') {
    // An e2e run talks to emulators on localhost and must not reach out to
    // Google for a real attestation: the key does not allow localhost, the
    // request would leave the machine, and `e2e/no-production-egress.spec.ts`
    // exists to fail on exactly that.
    appCheckStatus = 'inactive';
    return;
  }
  if (ADMIN_APP_CHECK_SITE_KEY === '') {
    appCheckStatus = 'unconfigured';
    console.error(
      '[AppCheck] no site key compiled in, so this session is unattested. ' +
        'Create the reCAPTCHA Enterprise key and register it — see ADMIN_APP_CHECK_SITE_KEY in lib/firebase.ts.',
    );
    return;
  }
  try {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(ADMIN_APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    appCheckFailed('initializeAppCheck threw', err);
    return;
  }
  appCheckStatus = 'pending';
  void probeAppCheck(appCheckInstance);
}

export const auth = getAuth(app);

/**
 * WHICH CACHE THIS SESSION GOT, `persistent` or `memory`. Decided by
 * `lib/firestoreCache.ts`; exported so a surface can DISCLOSE a memory-only
 * session rather than let the operator find out by losing a write.
 */
export const firestoreCache = firestoreCacheMode(
  typeof indexedDB !== 'undefined',
  // The same expression `E2E_EMULATOR_HOST` is built from, read again here
  // because that constant is declared further down this file, after `db` needs
  // the answer. Both fold to a constant in a hosting build.
  ((import.meta.env.VITE_E2E_EMULATOR as string | undefined) ?? '') !== '',
);

/**
 * FIRESTORE, WITH AN OFFLINE WRITE QUEUE.
 *
 * This was `getFirestore(app)` until 2026-09-12, which is the SDK's memory
 * cache. Two things made that wrong:
 *
 *   MOBILE WEB IS THE FIELD FALLBACK (operator ruling). This admin gets opened
 *   on a phone, at a door, on whatever coverage the street has. It is not the
 *   office screen the old code assumed.
 *   THE VISIT CLOCK IS A DIRECT WRITE NOW (`api/sessionsWrite.ts`). "Arrived"
 *   used to be a callable, so it either reached the server or failed visibly.
 *   It is a document write today, and a document write is exactly the thing
 *   Firestore's queue exists to carry across a dead zone.
 *
 * WHAT THE PERSISTENT CACHE ACTUALLY BUYS: a write started with no signal is
 * held in IndexedDB and replayed when the connection returns, INCLUDING ACROSS
 * A RELOAD OR A KILLED TAB. With the memory cache the same write lives only in
 * RAM and is lost the moment the page goes away.
 *
 * WHAT IT DOES NOT BUY, and every one of these has bitten somebody somewhere:
 *
 *   THE PROMISE STILL WAITS FOR THE SERVER. `await updateDoc(...)` resolves on
 *   the server ack, not on the local write, so offline the clock button stays
 *   "saving" until signal comes back. The local document — and any live
 *   listener on it — updates immediately, so the ROW repaints while the BUTTON
 *   spins. Painting the button optimistically instead is a separate operator
 *   decision and is deliberately not taken here.
 *   A QUEUED WRITE IS NOT A PROMISE IT WILL LAND. It still meets
 *   `firestore.rules` when it replays, and it can still be refused then, hours
 *   later, with nobody watching.
 *   THE AUDIT AND THE HOUSEHOLD PUSH ARE CALLABLES AND CALLABLES DO NOT QUEUE.
 *   Offline they simply fail, which is why `sessionsWrite.ts` fires both
 *   fire-and-forget: the visit is still clocked, and the trail and the push are
 *   what an offline tap costs.
 *   MULTI-TAB IS HANDLED, NOT FREE. `persistentMultipleTabManager` lets several
 *   admin tabs share one IndexedDB queue instead of the first tab taking an
 *   exclusive lock and the rest silently failing to persist. It is the right
 *   default for an app whose users keep the board and a detail sheet open at
 *   once.
 *   IT CAN BE UNAVAILABLE ENTIRELY. Private windows, blocked site data and test
 *   runners have no usable IndexedDB; `firestoreCache` says which one this
 *   session got, and `memory` means none of the above applies.
 */
export const db = initializeFirestore(
  app,
  firestoreCache === 'persistent'
    ? { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }
    : { localCache: memoryLocalCache() },
);
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
