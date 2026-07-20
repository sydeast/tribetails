import { getIdTokenResult, type User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { allowIntoApp, testModeFromClaim } from './gate';
import { useAuth } from './auth';

/**
 * The admin GATE decision, derived from a signed-in user's custom claims.
 *
 * Two ways in (see gate.ts for why the asymmetry IS the safety property):
 *   - real admin: `admin === true`.
 *   - Stage 0I test admin: no `admin` claim, but a non-blank `testTribeId`.
 * Anyone else who authenticates (e.g. a kinfolk signing in with their portal
 * credentials) is DENIED, the admin app is not theirs.
 */
export type AdminAccess =
  | { status: 'admin' }
  | { status: 'testAdmin'; testTribeId: string }
  | { status: 'denied' };

/**
 * Pure claims -> access mapping. Kept free of Firebase so the gate logic is
 * unit-testable without a live token. `claims` is the decoded (untrusted-shaped
 * but signed) JWT payload.
 */
export function accessFromClaims(claims: Record<string, unknown>): AdminAccess {
  const isAdmin = claims.admin === true;
  const testMode = testModeFromClaim(claims.testTribeId);
  if (!allowIntoApp(isAdmin, testMode)) return { status: 'denied' };
  if (isAdmin) return { status: 'admin' };
  // allowIntoApp guarantees testMode.active here, so testTribeId is non-null.
  return { status: 'testAdmin', testTribeId: testMode.testTribeId as string };
}

/**
 * Resolve access for a signed-in user by reading its ID-token claims.
 * `forceRefresh` re-mints the token when a stale one might predate a claim
 * write (the portal's O-37 lesson: a token minted before the claim trigger ran
 * carries no claim yet).
 */
export async function resolveAccess(user: User, forceRefresh = false): Promise<AdminAccess> {
  const token = await getIdTokenResult(user, forceRefresh);
  return accessFromClaims(token.claims as Record<string, unknown>);
}

/**
 * Reactive access for components (e.g. the shell's "Test admin, sandbox" banner).
 * Null while auth is loading or resolving; a concrete AdminAccess once known.
 */
export function useAdminAccess(): AdminAccess | null {
  const state = useAuth();
  const [access, setAccess] = useState<AdminAccess | null>(null);
  useEffect(() => {
    let live = true;
    if (state.status === 'signedIn') {
      void resolveAccess(state.user).then((a) => {
        if (live) setAccess(a);
      });
    } else {
      setAccess(null);
    }
    return () => {
      live = false;
    };
  }, [state]);
  return access;
}
