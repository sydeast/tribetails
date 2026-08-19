import { getIdTokenResult, type User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { allowIntoApp, testModeFromClaim } from './gate';
import { setTestScope } from './testScope';
import { useAuth } from './auth';
import { reportError } from './sentry';

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
  const access = accessFromClaims(token.claims as Record<string, unknown>);
  // Pin every scoped collection query to the sandbox tribe, HERE, because this
  // is the one place access is decided — so the query scope can never drift from
  // the claim. Without it a test admin is permission-denied on every screen
  // (verified live 2026-07-20). See lib/testScope.ts.
  setTestScope(access.status === 'testAdmin' ? access.testTribeId : null);
  return access;
}

/**
 * Reactive access for components (e.g. the shell's "Test admin, sandbox" banner).
 * Null while auth is loading or resolving; a concrete AdminAccess once known.
 *
 * A REJECTION LEAVES IT NULL, ON PURPOSE (#454). `getIdTokenResult` mints a
 * token, so a refresh outage rejects here. Before this catch existed that was
 * an unhandled promise rejection and access simply stayed null forever with
 * nothing said. Null is still the right answer — it means "not resolved yet",
 * which is true — and mapping the failure to `denied` would be worse: a few
 * seconds of bad network would read to every caller as this operator not
 * being an admin. lib/sessionHealth.ts is what tells the operator, and the
 * report below is what tells us.
 */
export function useAdminAccess(): AdminAccess | null {
  const state = useAuth();
  const [access, setAccess] = useState<AdminAccess | null>(null);
  useEffect(() => {
    let live = true;
    if (state.status === 'signedIn') {
      void resolveAccess(state.user)
        .then((a) => {
          if (live) setAccess(a);
        })
        .catch((err: unknown) => {
          console.warn('Admin access unresolved: could not read the ID token.', err);
          reportError(err, 'useAdminAccess');
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
