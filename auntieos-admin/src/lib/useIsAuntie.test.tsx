// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * #2185: the one question copy asks, "is an Auntie signed in?". Read off the
 * real `currentSessionSeat`, so the claims decide it, not a stand-in.
 */
const { authRef, getIdTokenResult } = vi.hoisted(() => ({
  authRef: { currentUser: null as { uid: string } | null },
  getIdTokenResult: vi.fn(),
}));
vi.mock('./firebase', () => ({ auth: authRef }));
vi.mock('firebase/auth', () => ({ getIdTokenResult }));

import { useIsAuntie } from './useIsAuntie';

beforeEach(() => {
  authRef.currentUser = { uid: 'u1' };
  getIdTokenResult.mockReset();
});

describe('#2185 useIsAuntie', () => {
  it('is true for an Auntie sign-in', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { staffRole: 'auntie' } });
    const { result } = renderHook(() => useIsAuntie());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is true for an account holding both claims, as the gate and the server read it', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { admin: true, staffRole: 'auntie' } });
    const { result } = renderHook(() => useIsAuntie());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false for the owner', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { admin: true } });
    const { result } = renderHook(() => useIsAuntie());
    await waitFor(() => expect(getIdTokenResult).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('is false for the test admin, who keeps the owner wording', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { testTribeId: 'sandbox' } });
    const { result } = renderHook(() => useIsAuntie());
    await waitFor(() => expect(getIdTokenResult).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('is false while the token is still being read', () => {
    getIdTokenResult.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useIsAuntie());
    expect(result.current).toBe(false);
  });

  it('is false when the token cannot be read, and with nobody signed in', async () => {
    getIdTokenResult.mockRejectedValue(new Error('auth/network-request-failed'));
    const unread = renderHook(() => useIsAuntie());
    await waitFor(() => expect(getIdTokenResult).toHaveBeenCalled());
    expect(unread.result.current).toBe(false);

    authRef.currentUser = null;
    const nobody = renderHook(() => useIsAuntie());
    expect(nobody.result.current).toBe(false);
  });
});
