// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { signOutAllDevices } from '../api/authApi';
import { clearAccess, clearActiveTribeSession } from './activeTribe';
import { unregisterForPush } from './push';
import { queryClient } from './queryClient';

/**
 * O-36: sign-out is multi-second (unregisterForPush does a network round trip
 * to unregisterFcmToken before the auth state that authorizes it disappears).
 * Until now every Sign Out button stayed live for that whole wait, so double
 * taps queued a second signOut() into the void. useSignOut owns the busy flag
 * so the ~8 call sites can't each get it subtly wrong.
 */

vi.mock('./firebase', () => ({ auth: { currentUser: { uid: 'uid-1' } }, activateAppCheck: vi.fn() }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn(), clearActiveTribeSession: vi.fn() }));
vi.mock('./queryClient', () => ({ queryClient: { clear: vi.fn() } }));
vi.mock('../api/authApi', () => ({ signOutAllDevices: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('./push', () => ({ unregisterForPush: vi.fn() }));
vi.mock('firebase/auth', () => ({
  applyActionCode: vi.fn().mockResolvedValue(undefined),
  checkActionCode: vi.fn(),
  confirmPasswordReset: vi.fn().mockResolvedValue(undefined),
  initializeRecaptchaConfig: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: vi.fn().mockReturnValue(vi.fn()),
  sendPasswordResetEmail: vi.fn(),
  verifyPasswordResetCode: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

/** A promise we resolve by hand, to hold sign-out mid-flight like the real network wait. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSignOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('is idle before the button is pressed', async () => {
    const { useSignOut } = await import('./auth');
    const { result } = renderHook(() => useSignOut());
    expect(result.current.signingOut).toBe(false);
  });

  it('flips to signingOut synchronously on press, while the push wait is still in flight', async () => {
    const d = deferred();
    vi.mocked(unregisterForPush).mockReturnValue(d.promise);

    const { useSignOut } = await import('./auth');
    const { result } = renderHook(() => useSignOut());

    act(() => result.current.signOut());

    // The whole point of O-36: busy BEFORE the multi-second wait finishes.
    expect(result.current.signingOut).toBe(true);

    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it('swallows double taps — the second press must not fire a second sign-out', async () => {
    const d = deferred();
    vi.mocked(unregisterForPush).mockReturnValue(d.promise);

    const { useSignOut } = await import('./auth');
    const { result } = renderHook(() => useSignOut());

    act(() => result.current.signOut());
    act(() => result.current.signOut());
    act(() => result.current.signOut());

    await act(async () => {
      d.resolve();
      await d.promise;
    });

    await waitFor(() => expect(vi.mocked(firebaseSignOut)).toHaveBeenCalledTimes(1));
  });

  it('stays busy after a successful sign-out (a full page reload is imminent)', async () => {
    vi.mocked(unregisterForPush).mockResolvedValue(undefined);

    const { useSignOut } = await import('./auth');
    const { result } = renderHook(() => useSignOut());

    await act(async () => {
      result.current.signOut();
    });

    // Re-enabling here would flash a live button onto a page that is unloading.
    expect(result.current.signingOut).toBe(true);
  });

  it('re-enables the button when sign-out fails, so the user is not stranded', async () => {
    vi.mocked(unregisterForPush).mockResolvedValue(undefined);
    vi.mocked(firebaseSignOut).mockRejectedValueOnce(new Error('network down'));

    const { useSignOut } = await import('./auth');
    const { result } = renderHook(() => useSignOut());

    await act(async () => {
      result.current.signOut();
    });

    await waitFor(() => expect(result.current.signingOut).toBe(false));
  });
});
/**
 * #539 — the ordering half of "clicking the signout does not honor logout".
 *
 * The old signOut() awaited push cleanup, unbounded, BEFORE it touched the auth
 * session, so a stalled callable or a chunk fetch that never landed meant the
 * kinfolk stayed signed in with no error anywhere: useSignOut's catch quietly
 * put the button back and that was the whole of it. These specs hold sign-out
 * to the rule that came out of it — everything that needs a live session is
 * best-effort and on a clock; ending the session is not.
 */
describe('signOut teardown order (#539)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(unregisterForPush).mockResolvedValue(undefined);
    vi.mocked(signOutAllDevices).mockResolvedValue({ ok: true });
    vi.mocked(firebaseSignOut).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });
  it('signs out anyway when the push cleanup never settles', async () => {
    vi.useFakeTimers();
    // A promise with no resolve path at all — the "callable that never answers"
    // the timebox exists for.
    vi.mocked(unregisterForPush).mockReturnValue(new Promise<void>(() => undefined));
    const { signOut, SIGN_OUT_CLEANUP_TIMEOUT_MS } = await import('./auth');
    const done = signOut();
    await vi.advanceTimersByTimeAsync(SIGN_OUT_CLEANUP_TIMEOUT_MS + 1);
    await done;
    expect(vi.mocked(firebaseSignOut)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearAccess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryClient.clear)).toHaveBeenCalledTimes(1);
  });
  it('signs out anyway when the server-side revoke never settles', async () => {
    vi.useFakeTimers();
    vi.mocked(signOutAllDevices).mockReturnValue(new Promise(() => undefined));
    const { signOut, SIGN_OUT_CLEANUP_TIMEOUT_MS } = await import('./auth');
    const done = signOut();
    await vi.advanceTimersByTimeAsync(SIGN_OUT_CLEANUP_TIMEOUT_MS + 1);
    await done;
    expect(vi.mocked(firebaseSignOut)).toHaveBeenCalledTimes(1);
  });
  it('signs out anyway when the push chunk fails to load or rejects', async () => {
    vi.mocked(unregisterForPush).mockRejectedValue(new Error('chunk load failed'));
    const { signOut } = await import('./auth');
    await signOut();
    expect(vi.mocked(firebaseSignOut)).toHaveBeenCalledTimes(1);
  });
  it('revokes the session server-side, because a local sign-out does not', async () => {
    const { signOut } = await import('./auth');
    await signOut();
    // Firebase's client signOut() only drops this browser's copy of the refresh
    // token. Without this call the token keeps minting IDs for anyone holding
    // it. See api/authApi.ts for what it does and does not cover.
    expect(vi.mocked(signOutAllDevices)).toHaveBeenCalledTimes(1);
  });
  it('revokes BEFORE the local sign-out, while the call is still authorized', async () => {
    const order: string[] = [];
    vi.mocked(signOutAllDevices).mockImplementation(async () => {
      order.push('revoke');
      return { ok: true };
    });
    vi.mocked(firebaseSignOut).mockImplementation(async () => {
      order.push('local');
    });
    const { signOut } = await import('./auth');
    await signOut();
    expect(order).toEqual(['revoke', 'local']);
  });
  it('purges every cache holding the previous account, keyed by the uid it read first', async () => {
    const { signOut } = await import('./auth');
    await signOut();
    expect(vi.mocked(clearAccess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryClient.clear)).toHaveBeenCalledTimes(1);
    // Read from auth.currentUser BEFORE firebaseSignOut nulls it — the
    // persisted tribe pick is keyed by uid and cannot be found afterwards.
    expect(vi.mocked(clearActiveTribeSession)).toHaveBeenCalledWith('uid-1');
  });
  it('purges the caches even when the local sign-out itself fails', async () => {
    vi.mocked(firebaseSignOut).mockRejectedValueOnce(new Error('network down'));
    const { signOut } = await import('./auth');
    await expect(signOut()).rejects.toThrow('network down');
    // A purge that only runs on the happy path is not a purge.
    expect(vi.mocked(clearAccess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryClient.clear)).toHaveBeenCalledTimes(1);
  });
});
/**
 * #892: the reset and email-link helpers the email action page runs on. The
 * page tests mock these; this pins that each one reaches the right Firebase
 * call with the right arguments.
 */
describe('email action helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('sendReset continues to the portal sign-in by default', async () => {
    const { sendPasswordResetEmail } = await import('firebase/auth');
    const { sendReset } = await import('./auth');
    await sendReset('pepper@example.com');
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(expect.anything(), 'pepper@example.com', {
      url: 'https://kinfolk.tribetails.com/signin',
      handleCodeInApp: false,
    });
  });
  it('sendReset keeps a continue URL it is given (a fresh link for staff stays on the admin site)', async () => {
    const { sendPasswordResetEmail } = await import('firebase/auth');
    const { sendReset } = await import('./auth');
    await sendReset('ops@example.com', 'https://auntie.tribetails.com/signin');
    expect(vi.mocked(sendPasswordResetEmail).mock.calls[0]?.[2]).toEqual({
      url: 'https://auntie.tribetails.com/signin',
      handleCodeInApp: false,
    });
  });
  it('sendReset with a null continue URL sends a bare link, so the page offers both sign-ins again (#892 review)', async () => {
    const { sendPasswordResetEmail } = await import('firebase/auth');
    const { sendReset } = await import('./auth');
    await sendReset('ops@example.com', null);
    expect(vi.mocked(sendPasswordResetEmail).mock.calls[0]).toHaveLength(2);
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(expect.anything(), 'ops@example.com');
  });
  it('verifyResetCode resolves the account email from the code', async () => {
    const { verifyPasswordResetCode } = await import('firebase/auth');
    vi.mocked(verifyPasswordResetCode).mockResolvedValue('pepper@example.com');
    const { verifyResetCode } = await import('./auth');
    await expect(verifyResetCode('CODE')).resolves.toBe('pepper@example.com');
    expect(verifyPasswordResetCode).toHaveBeenCalledWith(expect.anything(), 'CODE');
  });
  it('completeReset sets the password with the code', async () => {
    const { confirmPasswordReset } = await import('firebase/auth');
    const { completeReset } = await import('./auth');
    await completeReset('CODE', 'new-password-1');
    expect(confirmPasswordReset).toHaveBeenCalledWith(expect.anything(), 'CODE', 'new-password-1');
  });
  it('readActionCode returns the email and previous email off the code', async () => {
    const { checkActionCode } = await import('firebase/auth');
    vi.mocked(checkActionCode).mockResolvedValue({
      operation: 'RECOVER_EMAIL',
      data: { email: 'old@example.com', previousEmail: 'new@example.com' },
    } as never);
    const { readActionCode } = await import('./auth');
    await expect(readActionCode('R')).resolves.toEqual({
      operation: 'RECOVER_EMAIL',
      email: 'old@example.com',
      previousEmail: 'new@example.com',
    });
  });
  it('applyEmailAction applies the code', async () => {
    const { applyActionCode } = await import('firebase/auth');
    const { applyEmailAction } = await import('./auth');
    await applyEmailAction('V');
    expect(applyActionCode).toHaveBeenCalledWith(expect.anything(), 'V');
  });
});
