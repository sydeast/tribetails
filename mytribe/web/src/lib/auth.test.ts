// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { unregisterForPush } from './push';

/**
 * O-36: sign-out is multi-second (unregisterForPush does a network round trip
 * to unregisterFcmToken before the auth state that authorizes it disappears).
 * Until now every Sign Out button stayed live for that whole wait, so double
 * taps queued a second signOut() into the void. useSignOut owns the busy flag
 * so the ~8 call sites can't each get it subtly wrong.
 */

vi.mock('./firebase', () => ({ auth: {}, activateAppCheck: vi.fn() }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn() }));
vi.mock('./push', () => ({ unregisterForPush: vi.fn() }));
vi.mock('firebase/auth', () => ({
  initializeRecaptchaConfig: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: vi.fn().mockReturnValue(vi.fn()),
  sendPasswordResetEmail: vi.fn(),
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
