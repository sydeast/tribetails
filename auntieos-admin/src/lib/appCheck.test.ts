// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #576: activation has to be OBSERVABLE, and a failure has to be loud.
 *
 * The defect this replaces was not a misconfiguration. `auntieos-admin` shipped
 * a comment saying App Check was deliberately deferred, and the portal — which
 * did have the code — shipped a readiness guard that was always true, so its
 * `activateAppCheck()` was unreachable on every boot for months (#556). Both
 * failures survived because nothing anywhere could answer "did attestation
 * actually happen in this session?" with a value.
 *
 * So these tests assert the value. Every state `getAppCheckStatus()` can report
 * is exercised, and the three that mean "no attestation" are held apart:
 *
 *   inactive     — never attempted (signed-out lifetime, or an e2e run)
 *   unconfigured — no site key compiled in yet; the operator step
 *   failed       — we tried and it broke
 *
 * Folding those together is what makes a broken attestation indistinguishable
 * from a deliberate skip, which is the shape of the original bug.
 */

const {
  initializeAppCheck,
  getAppCheckTokenMock,
  ReCaptchaEnterpriseProvider,
  reportError,
} = vi.hoisted(() => ({
  initializeAppCheck: vi.fn(() => ({ kind: 'app-check-instance' })),
  getAppCheckTokenMock: vi.fn(),
  ReCaptchaEnterpriseProvider: vi.fn(function (this: Record<string, unknown>, key: string) {
    this.siteKey = key;
  }),
  reportError: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({ name: 'admin-app' })) }));
vi.mock('firebase/auth', () => ({ getAuth: vi.fn(() => ({})), connectAuthEmulator: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  // `lib/firebase.ts` picks its own local cache rather than taking the SDK's
  // silent fallback, so the four cache symbols have to exist here too.
  initializeFirestore: vi.fn(() => ({})),
  memoryLocalCache: vi.fn(() => ({ kind: 'memory' })),
  persistentLocalCache: vi.fn(() => ({ kind: 'persistent' })),
  persistentMultipleTabManager: vi.fn(() => ({ kind: 'multi-tab' })),
  connectFirestoreEmulator: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  connectFunctionsEmulator: vi.fn(),
}));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck,
  getToken: getAppCheckTokenMock,
  ReCaptchaEnterpriseProvider,
}));
vi.mock('./sentry', () => ({ reportError }));

const SITE_KEY = '6LtestKeyAAAAAtestKeytestKeytestKeyABCD';

/**
 * Every `import.meta.env` key `lib/firebase.ts` reads. Blanked before each load
 * so a test's environment is what the test SAYS it is.
 *
 * `vi.unstubAllEnvs()` alone is not that. It restores the ambient value rather
 * than deleting it, and Vite loads `auntieos-admin/.env` in the test mode too,
 * so on a machine whose `.env` carries VITE_ADMIN_APPCHECK_SITE_KEY the "without
 * a site key" case ran WITH one and reported `pending`. That file is gitignored,
 * so CI has no key, stayed green, and the failure only appeared during a release
 * on the operator's laptop. A test that asserts the absence of a variable has to
 * establish the absence itself.
 */
const FIREBASE_ENV_KEYS = [
  'VITE_ADMIN_APPCHECK_SITE_KEY',
  'VITE_APPCHECK_DEBUG_TOKEN',
  'VITE_E2E_EMULATOR',
] as const;

/** Fresh module instance, so `activateAppCheck`'s once-per-lifetime state resets. */
async function loadFirebase(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const k of FIREBASE_ENV_KEYS) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('./firebase');
}

beforeEach(() => {
  vi.clearAllMocks();
  initializeAppCheck.mockReturnValue({ kind: 'app-check-instance' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('activateAppCheck, with a site key', () => {
  it('starts inactive, so nothing can mistake "not asked yet" for attestation', async () => {
    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    expect(fb.getAppCheckStatus()).toBe('inactive');
    expect(initializeAppCheck).not.toHaveBeenCalled();
  });

  it('activates against the compiled-in key and reports active once a token arrives', async () => {
    let resolveToken: (v: unknown) => void = () => undefined;
    getAppCheckTokenMock.mockReturnValue(
      new Promise((resolve) => {
        resolveToken = resolve;
      }),
    );

    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    fb.activateAppCheck();

    // `pending`, not `active`: initializeAppCheck returning proves nothing. It
    // constructs a provider synchronously and every real failure shows up later
    // inside a token fetch. This is the distinction #556 did not have.
    expect(fb.getAppCheckStatus()).toBe('pending');
    expect(ReCaptchaEnterpriseProvider).toHaveBeenCalledWith(SITE_KEY);
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);

    resolveToken({ token: 'attestation-token' });
    await vi.waitFor(() => {
      expect(fb.getAppCheckStatus()).toBe('active');
    });
  });

  it('reports failed, loudly, when the first token never arrives', async () => {
    getAppCheckTokenMock.mockRejectedValue(new Error('recaptcha blocked'));

    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    fb.activateAppCheck();

    await vi.waitFor(() => {
      expect(fb.getAppCheckStatus()).toBe('failed');
    });
    // Loud in BOTH places. A console line alone is invisible on an operator's
    // machine; a Sentry event alone is invisible while debugging one.
    expect(console.error).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toBe('appCheck');
  });

  it('reports failed when initializeAppCheck itself throws', async () => {
    initializeAppCheck.mockImplementation(() => {
      throw new Error('app not registered for App Check');
    });

    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    fb.activateAppCheck();

    expect(fb.getAppCheckStatus()).toBe('failed');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('does not retry after a failure', async () => {
    initializeAppCheck.mockImplementation(() => {
      throw new Error('app not registered for App Check');
    });
    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    fb.activateAppCheck();
    fb.activateAppCheck();
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
  });

  it('activates at most once per page lifetime', async () => {
    getAppCheckTokenMock.mockResolvedValue({ token: 't' });
    const fb = await loadFirebase({ VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY });
    fb.activateAppCheck();
    fb.activateAppCheck();
    fb.activateAppCheck();
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
  });
});

describe('activateAppCheck, without a site key', () => {
  it('reports unconfigured — not inactive, and not failed — and says so out loud', async () => {
    const fb = await loadFirebase();
    fb.activateAppCheck();

    expect(fb.getAppCheckStatus()).toBe('unconfigured');
    expect(initializeAppCheck).not.toHaveBeenCalled();
    // The operator step is the ONLY missing piece of #576, so a build without
    // it must announce itself on every boot rather than pass quietly.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no site key'));
  });
});

describe('activateAppCheck, in an e2e run', () => {
  it('stays inactive rather than reaching Google from a localhost harness', async () => {
    const fb = await loadFirebase({
      VITE_ADMIN_APPCHECK_SITE_KEY: SITE_KEY,
      VITE_E2E_EMULATOR: '127.0.0.1',
    });
    fb.activateAppCheck();

    expect(fb.getAppCheckStatus()).toBe('inactive');
    expect(initializeAppCheck).not.toHaveBeenCalled();
  });
});
