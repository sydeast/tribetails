// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeRecaptchaConfig, onAuthStateChanged } from 'firebase/auth';
import { activateAppCheck } from './firebase';

/**
 * Issue #556: App Check never activated in the kinfolk portal.
 *
 * `main.tsx` called `ensureRecaptcha()` at module init, which set auth.ts's
 * `recaptchaReady` promise before the auth listener could ever fire. That made
 * `authRecaptchaLoaded()` permanently true, so the `activateAppCheck()` call
 * behind it was unreachable in every session, on every boot.
 *
 * The guard was right; the eager call was wrong. The ordering it protects
 * (O-3 / S7-BLOCKER-1) is: exactly one reCAPTCHA Enterprise loader per page
 * lifetime. A signed-out boot needs the AUTH loader, because sign-in, sign-up
 * and password reset are what that surface does. A signed-in boot needs the
 * APP CHECK loader, because it makes callables, and nothing on it signs in.
 *
 * These specs pin both halves plus the once-only rule, and they run against
 * the boot sequence itself rather than against the guard, because the guard
 * in isolation was never the broken part.
 */

vi.mock('./firebase', () => ({ auth: {}, activateAppCheck: vi.fn() }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn() }));
vi.mock('./push', () => ({ unregisterForPush: vi.fn() }));
vi.mock('firebase/auth', () => ({
  initializeRecaptchaConfig: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: vi.fn().mockReturnValue(vi.fn()),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

/** The user object Firebase hands the listener. Only its truthiness matters here. */
const SIGNED_IN = { uid: 'kinfolk-1' } as const;

/**
 * Imports auth.ts + boot.ts fresh and hands back the listener Firebase would
 * have called. auth.ts registers `onAuthStateChanged` at module evaluation, so
 * the listener only exists after the import, and it has to be captured per
 * test because `vi.resetModules()` re-registers it.
 */
async function bootPortal(): Promise<(user: unknown) => void> {
  const { bootAttestation } = await import('./boot');
  bootAttestation();
  const registered = vi.mocked(onAuthStateChanged).mock.calls.at(-1);
  if (!registered) throw new Error('auth.ts never registered an auth listener');
  return registered[1] as (user: unknown) => void;
}

describe('portal boot: reCAPTCHA and App Check never share a page lifetime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('activates App Check on a signed-in boot', async () => {
    const onAuth = await bootPortal();

    onAuth(SIGNED_IN);

    expect(vi.mocked(activateAppCheck)).toHaveBeenCalledTimes(1);
  });

  it('leaves the auth reCAPTCHA loader alone on a signed-in boot', async () => {
    const onAuth = await bootPortal();

    onAuth(SIGNED_IN);
    // Let the boot sequence's own promise chain settle before reading.
    await vi.waitFor(() => expect(vi.mocked(activateAppCheck)).toHaveBeenCalled());

    expect(vi.mocked(initializeRecaptchaConfig)).not.toHaveBeenCalled();
  });

  it('installs the auth reCAPTCHA interceptor on a signed-out boot', async () => {
    const onAuth = await bootPortal();

    onAuth(null);

    await vi.waitFor(() => expect(vi.mocked(initializeRecaptchaConfig)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(activateAppCheck)).not.toHaveBeenCalled();
  });

  it('does not install the auth loader when a signed-in boot later signs out', async () => {
    const onAuth = await bootPortal();

    onAuth(SIGNED_IN);
    await vi.waitFor(() => expect(vi.mocked(activateAppCheck)).toHaveBeenCalled());
    // Signing out inside the SPA: App Check's Enterprise script already owns
    // `grecaptcha`, so loading the auth one on top of it is the collision this
    // whole ordering exists to prevent. signOut() reloads the page for exactly
    // that reason, and the boot sequence must not pre-empt it.
    onAuth(null);

    await vi.waitFor(() => expect(vi.mocked(activateAppCheck)).toHaveBeenCalled());
    expect(vi.mocked(initializeRecaptchaConfig)).not.toHaveBeenCalled();
  });
});
