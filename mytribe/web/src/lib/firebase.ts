import { initializeApp } from 'firebase/app';
import { getToken as getAppCheckToken, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { reportError } from './sentry';

/**
 * Firebase web app config, copied from the Kotlin app's init
 * (src/jsMain/kotlin/com/kinfolk/portal/Main.kt, FirebaseOptions).
 * These are public client identifiers, not secrets.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo',
  authDomain: 'auntieos-ttpc.firebaseapp.com',
  projectId: 'auntieos-ttpc',
  storageBucket: 'auntieos-ttpc.firebasestorage.app',
  messagingSenderId: '153396971788',
  appId: '1:153396971788:web:23eab70f9dfe37447f2129',
} as const;

export const app = initializeApp(firebaseConfig);

/**
 * O-3 App Check (docs/O3_APP_CHECK_RULING_2026-07-13.md, D1/Phase 1):
 * reCAPTCHA Enterprise provider, dedicated key (NOT the guest-comment
 * assessment key or the Identity-Platform auth key — see the ruling for why
 * mixing streams is wrong). Monitor-only: nothing in this repo passes
 * `enforceAppCheck` yet, so this purely populates `req.app` server-side for
 * telemetry — no request is ever rejected by this alone. Initialized
 * immediately after `initializeApp`, before any other handle is grabbed, per
 * the ruling's Phase 1 sequencing.
 */
if (import.meta.env.DEV) {
  // Debug token for local dev only — dead code (tree-shaken) in production
  // builds since `import.meta.env.DEV` is statically false there. Each
  // developer registers their own token in the App Check console; never
  // commit a real one to VITE_APPCHECK_DEBUG_TOKEN. `globalThis` (not `self`
  // — undefined under Node/vitest, only a browser/worker global) so this
  // doesn't crash test runs that import this module transitively.
  (globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
}

/**
 * S7-BLOCKER-1 (2026-07-15): App Check is DEFERRED, not initialized at boot.
 *
 * `ReCaptchaEnterpriseProvider` loads Google's Enterprise api.js, which takes
 * ownership of `window.grecaptcha`. The Identity-Platform auth flow
 * (`ensureRecaptcha` + the SDK's internal password-sign-in protection) then
 * executes its OWN site key against that instance and dies with "Invalid site
 * key or not loaded in api.js" — `signIn()` never settles and the sign-in
 * button spins forever. This was masked until the App Check web app was
 * registered (O-31): the unregistered provider was throttled and never loaded
 * its script.
 *
 * Resolution order matters and auth must win: `activateAppCheck()` is called
 * only once a session is signed in (auth.ts onAuthStateChanged), so the
 * signed-out surfaces (/signin, /claim, reset) always get the auth recaptcha
 * first. The reverse cost is accepted for Phase 1: in a session where auth's
 * script loaded first, App Check token fetches may fail and telemetry reads
 * 'absent' — nothing enforces yet (monitor-only per the O-3 ruling). Phase 2
 * enforcement must unify both streams onto one loader before flipping any
 * enforcement switch; see docs/DEVELOPMENT_PLAN_2026-07-10.md S7 entry.
 *
 * `lib/boot.ts` is what decides which loader this page lifetime gets, and
 * before issue #556 that decision was never actually made: `main.tsx` warmed
 * the auth loader up on every boot, so the guard in front of this function was
 * true forever and App Check activated in no session at all.
 *
 * Guarded on `document` so importing this module never crashes a plain
 * Node/vitest context (most `*Api.test.ts` files import `lib/fns.ts`, which
 * imports this module, without mocking it). Idempotent by construction.
 */
let appCheckInstance: ReturnType<typeof initializeAppCheck> | null = null;

/**
 * What actually happened when we tried, as a value anything can read.
 *
 * - `inactive`   — never attempted. This session chose the auth loader.
 * - `unsupported`— no DOM (Node/vitest). Not a failure, not attestation either.
 * - `pending`    — activated, first token not back yet.
 * - `active`     — a real App Check token was minted in this session.
 * - `failed`     — activation threw, or the first token never arrived.
 *
 * The point of `failed` existing separately from `inactive` is that a broken
 * attestation must not read the same as a session that deliberately skipped
 * it. Before #556 the portal had no way to tell those apart, which is a large
 * part of why nobody noticed App Check had never once activated.
 */
export type AppCheckStatus = 'inactive' | 'unsupported' | 'pending' | 'active' | 'failed';

let appCheckStatus: AppCheckStatus = 'inactive';

/** Current App Check state for this page lifetime. */
export function getAppCheckStatus(): AppCheckStatus {
  return appCheckStatus;
}

/**
 * How long the first token may take before we call it a failure.
 *
 * Sized above `fns.ts`'s 20s callable timeout on purpose: the Functions SDK
 * awaits the App Check token OUTSIDE its own timeout, so a token promise that
 * pends forever presents as callables hanging with no error at all — the
 * "Accepting your invite…" hang. 25s means the console line and the Sentry
 * event land after the first callable has already given up, which is the
 * order that makes the pair legible: a `CallableTimeoutError` next to an
 * App Check failure is a different bug report from a `CallableTimeoutError`
 * on its own.
 */
const APP_CHECK_PROBE_TIMEOUT_MS = 25_000;

function appCheckFailed(reason: string, err: unknown): void {
  appCheckStatus = 'failed';
  // Loud in the console AND in Sentry. A silent pass here is the whole defect
  // class this issue is about.
  console.error(`[AppCheck] ${reason}. Callables from this session are unattested.`, err);
  reportError(err, 'appCheck');
}

/**
 * Fetch one token, so activation means something.
 *
 * `initializeAppCheck` returning is not evidence of anything: it constructs a
 * provider and returns synchronously, and every real failure (unregistered
 * app, wrong site key, blocked recaptcha script, a token promise that pends
 * because the auth loader already owns `grecaptcha`) shows up later, inside a
 * token fetch nobody was watching.
 */
async function probeAppCheck(instance: ReturnType<typeof initializeAppCheck>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getAppCheckToken(instance),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`App Check token did not arrive within ${APP_CHECK_PROBE_TIMEOUT_MS}ms`)),
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

export function activateAppCheck(): void {
  if (appCheckInstance !== null || appCheckStatus === 'failed') return;
  if (typeof document === 'undefined') {
    appCheckStatus = 'unsupported';
    return;
  }
  try {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider('6LcqhVItAAAAAJtyUQuqtYQED9UVpHcoJMdCtsy9'),
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
/** Direct Firestore reads gated by firestore.rules (e.g. live breadcrumbs). */
export const firestore = getFirestore(app);

/** All MyTribe callables are deployed in us-central1. */
export const FUNCTIONS_REGION = 'us-central1';
export const functions = getFunctions(app, FUNCTIONS_REGION);

/** Base URL for public onRequest endpoints (confirmSecureReset). */
export const FUNCTIONS_HTTP_BASE = `https://${FUNCTIONS_REGION}-${firebaseConfig.projectId}.cloudfunctions.net`;
