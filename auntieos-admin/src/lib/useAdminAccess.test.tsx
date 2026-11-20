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

import { resolveAccess, useAdminAccess } from './access';
import { isCaretakerScope, setCaretakerScope } from './caretakerScope';
import { type User } from 'firebase/auth';

const user = { uid: 'op-1' };

beforeEach(() => {
  vi.clearAllMocks();
  setCaretakerScope(false);
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
/**
 * An Auntie's drafts list has to name the KinTale type (`lib/caretakerScope.ts`).
 * The switch is set where access is decided, so it cannot drift from the claim.
 */
describe('resolveAccess sets what an Auntie\'s lists carry', () => {
  const asUser = user as unknown as User;
  it('HAPPY: turns it on for an Auntie', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { staffRole: 'auntie' } });
    expect(await resolveAccess(asUser)).toEqual({ status: 'caretaker' });
    expect(isCaretakerScope()).toBe(true);
  });
  it('an account carrying both roles is the Auntie here too', async () => {
    getIdTokenResult.mockResolvedValue({ claims: { admin: true, staffRole: 'auntie' } });
    await resolveAccess(asUser);
    expect(isCaretakerScope()).toBe(true);
  });
  it.each([
    ['the owner', { admin: true }],
    ['a sandbox account', { testTribeId: 'test-kinfolk-001' }],
    ['an account with no access', {}],
  ])('leaves it off for %s, and turns it off after an Auntie signed out', async (_label, claims) => {
    setCaretakerScope(true);
    getIdTokenResult.mockResolvedValue({ claims });
    await resolveAccess(asUser);
    expect(isCaretakerScope()).toBe(false);
  });
  it('ERROR: a token that cannot be read leaves the last answer in place and rejects', async () => {
    setCaretakerScope(true);
    getIdTokenResult.mockRejectedValue(new Error('Failed to fetch'));
    await expect(resolveAccess(asUser)).rejects.toThrow('Failed to fetch');
    expect(isCaretakerScope()).toBe(true);
  });
});
