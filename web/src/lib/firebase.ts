import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

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
 * Guarded on `document` so importing this module never crashes a plain
 * Node/vitest context (most `*Api.test.ts` files import `lib/fns.ts`, which
 * imports this module, without mocking it). Idempotent by construction.
 */
let appCheckInstance: ReturnType<typeof initializeAppCheck> | null = null;

export function activateAppCheck(): void {
  if (appCheckInstance !== null || typeof document === 'undefined') return;
  appCheckInstance = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6LcqhVItAAAAAJtyUQuqtYQED9UVpHcoJMdCtsy9'),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
/** Direct Firestore reads gated by firestore.rules (e.g. live breadcrumbs). */
export const firestore = getFirestore(app);

/** All MyTribe callables are deployed in us-central1. */
export const FUNCTIONS_REGION = 'us-central1';
export const functions = getFunctions(app, FUNCTIONS_REGION);

/** Base URL for public onRequest endpoints (confirmSecureReset). */
export const FUNCTIONS_HTTP_BASE = `https://${FUNCTIONS_REGION}-${firebaseConfig.projectId}.cloudfunctions.net`;
