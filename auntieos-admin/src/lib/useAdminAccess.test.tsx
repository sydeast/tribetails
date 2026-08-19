// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * #454. `resolveAccess` mints an ID token, so a refresh outage rejects here.
 * The hook used to call it with a bare `.then`, which meant an unhandled
 * rejection and access silently stuck at null with nobody told. These pin the
 * two halves of the fix: the failure is reported, and it is NOT mistaken for
 * the operator being denied.
 */

const { getIdTokenResult } = vi.hoisted(() => ({ getIdTokenResult: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
const { setTestScope } = vi.hoisted(() => ({ setTestScope: vi.fn() }));

vi.mock('firebase/auth', () => ({ getIdTokenResult }));
vi.mock('./auth', () => ({ useAuth }));
vi.mock('./sentry', () => ({ reportError }));
vi.mock('./testScope', () => ({ setTestScope }));

import { useAdminAccess } from './access';

const user = { uid: 'op-1' };

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ status: 'signedIn', user });
});

describe('useAdminAccess', () => {
  it('resolves access from the token claims as it always did', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { admin: true } });
    const { result } = renderHook(() => useAdminAccess());
    await waitFor(() => {
      expect(result.current).toEqual({ status: 'admin' });
    });
  });

  it('reports a token that could not be read, instead of dropping it on the floor', async () => {
    const boom = Object.assign(new Error('Failed to fetch'), {
      code: 'auth/network-request-failed',
    });
    getIdTokenResult.mockRejectedValue(boom);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { result } = renderHook(() => useAdminAccess());

    await waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(boom, 'useAdminAccess');
    });
    expect(warn).toHaveBeenCalled();
    // Null means "not resolved". Mapping a network blip to `denied` would tell
    // every caller this operator is not an admin, which is a lie the app would
    // then act on.
    expect(result.current).toBeNull();
    warn.mockRestore();
  });

  it('has no access to offer once nobody is signed in', () => {
    useAuth.mockReturnValue({ status: 'signedOut' });
    const { result } = renderHook(() => useAdminAccess());
    expect(result.current).toBeNull();
    expect(getIdTokenResult).not.toHaveBeenCalled();
  });
});
