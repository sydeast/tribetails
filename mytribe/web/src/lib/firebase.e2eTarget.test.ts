// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectAuthEmulator } from 'firebase/auth';
import { connectFirestoreEmulator } from 'firebase/firestore';
import { connectFunctionsEmulator } from 'firebase/functions';

/**
 * Where `src/lib/firebase.ts` points the portal in each e2e run (#1194).
 *
 * Three runs read the same module: a hosting build (no e2e variables at all),
 * the PR-time Cypress suite (`VITE_E2E_EMULATOR` only, callables pinned at the
 * dead port 5499), and the real-services run (`VITE_E2E_PROJECT_ID` and
 * `VITE_E2E_FUNCTIONS_PORT` too, from `npm run e2e:real:server`). The real run
 * must not leak into the other two, and a bad value must be refused at load,
 * because a wrong project id or port reads in the browser as "every callable is
 * down", nowhere near the cause.
 */

vi.mock('firebase/app', () => ({ initializeApp: vi.fn().mockReturnValue({ name: '[DEFAULT]' }) }));
vi.mock('firebase/auth', () => ({ getAuth: vi.fn().mockReturnValue({}), connectAuthEmulator: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getFirestore: vi.fn().mockReturnValue({}), connectFirestoreEmulator: vi.fn() }));
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn().mockReturnValue({}), connectFunctionsEmulator: vi.fn() }));
vi.mock('./sentry', () => ({ reportError: vi.fn(), initSentry: vi.fn() }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(),
  getToken: vi.fn(),
  ReCaptchaEnterpriseProvider: vi.fn(),
}));

describe('firebase.ts e2e target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('VITE_E2E_EMULATOR', '');
    vi.stubEnv('VITE_E2E_PROJECT_ID', '');
    vi.stubEnv('VITE_E2E_FUNCTIONS_PORT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('a hosting build keeps the production project and connects no emulator', async () => {
    const m = await import('./firebase');
    expect(m.firebaseConfig.projectId).toBe('auntieos-ttpc');
    expect(m.FUNCTIONS_HTTP_BASE).toBe('https://us-central1-auntieos-ttpc.cloudfunctions.net');
    expect(vi.mocked(connectAuthEmulator)).not.toHaveBeenCalled();
    expect(vi.mocked(connectFirestoreEmulator)).not.toHaveBeenCalled();
    expect(vi.mocked(connectFunctionsEmulator)).not.toHaveBeenCalled();
  });

  it('the PR-time suite still dials the dead functions port under the production id', async () => {
    vi.stubEnv('VITE_E2E_EMULATOR', '127.0.0.1');
    const m = await import('./firebase');
    expect(m.firebaseConfig.projectId).toBe('auntieos-ttpc');
    expect(m.E2E_FUNCTIONS_PORT).toBe(5499);
    expect(vi.mocked(connectFunctionsEmulator)).toHaveBeenCalledWith({}, '127.0.0.1', 5499);
    expect(m.FUNCTIONS_HTTP_BASE).toBe('http://127.0.0.1:5499/auntieos-ttpc/us-central1');
  });

  it('the real-services run dials the served port under its demo- project id', async () => {
    vi.stubEnv('VITE_E2E_EMULATOR', '127.0.0.1');
    vi.stubEnv('VITE_E2E_PROJECT_ID', 'demo-mytribe-e2e');
    vi.stubEnv('VITE_E2E_FUNCTIONS_PORT', '5498');
    const m = await import('./firebase');
    expect(m.firebaseConfig.projectId).toBe('demo-mytribe-e2e');
    expect(m.E2E_FUNCTIONS_PORT).toBe(5498);
    expect(vi.mocked(connectAuthEmulator)).toHaveBeenCalledWith({}, 'http://127.0.0.1:9499', { disableWarnings: true });
    expect(vi.mocked(connectFirestoreEmulator)).toHaveBeenCalledWith({}, '127.0.0.1', 8485);
    expect(vi.mocked(connectFunctionsEmulator)).toHaveBeenCalledWith({}, '127.0.0.1', 5498);
    expect(m.FUNCTIONS_HTTP_BASE).toBe('http://127.0.0.1:5498/demo-mytribe-e2e/us-central1');
  });

  it('refuses a project id that is not a demo- id', async () => {
    vi.stubEnv('VITE_E2E_EMULATOR', '127.0.0.1');
    vi.stubEnv('VITE_E2E_PROJECT_ID', 'auntieos-ttpc');
    await expect(import('./firebase')).rejects.toThrow(/VITE_E2E_PROJECT_ID must be a demo- project id/);
  });

  it.each(['abc', '0', '5499', '54.5'])('refuses the functions port %s', async (port) => {
    vi.stubEnv('VITE_E2E_EMULATOR', '127.0.0.1');
    vi.stubEnv('VITE_E2E_PROJECT_ID', 'demo-mytribe-e2e');
    vi.stubEnv('VITE_E2E_FUNCTIONS_PORT', port);
    await expect(import('./firebase')).rejects.toThrow(/VITE_E2E_FUNCTIONS_PORT must be a served port/);
  });
});
