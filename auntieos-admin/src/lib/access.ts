import { getIdTokenResult, type User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { allowIntoApp, caretakerFromClaim, testModeFromClaim } from './gate';
import { setTestScope } from './testScope';
import { useAuth } from './auth';
import { reportError } from './sentry';

/**
 * The admin GATE decision, derived from a signed-in user's custom claims.
 *
 * Three ways in (see gate.ts for why the asymmetry IS the safety property):
 *   - owner: `admin === true` and no caretaker role. Gets everything.
 *   - caretaker: `staffRole: 'auntie'`, no `admin` claim (#944). The contractor
 *     boundary: household information yes, money never, dossiers never.
 *   - Stage 0I test admin: neither claim, but a non-blank `testTribeId`.
 * Anyone else who authenticates (e.g. a kinfolk signing in with their portal
 * credentials) is DENIED, the admin app is not theirs.
 *
 * `caretaker` IS NOT A WEAKER `admin`, and callers must not treat it as one.
 * Every screen behind this gate is still rendered by a build that predates the
 * role, so what stops an Auntie from doing owner work is the SERVER — the
 * rules, `wrapAdminCallable` and the second codebase's gate — not this status.
 * The status exists so the app can say which boundary the session is on;
 * hiding the controls the server now refuses is the client follow-up.
 */
export type AdminAccess =
  | { status: 'admin' }
  | { status: 'caretaker' }
  | { status: 'testAdmin'; testTribeId: string }
  | { status: 'denied' };

/**
 * Pure claims -> access mapping. Kept free of Firebase so the gate logic is
 * unit-testable without a live token. `claims` is the decoded (untrusted-shaped
 * but signed) JWT payload.
 *
 * THE ORDER OF THESE FOUR BRANCHES IS THE BOUNDARY. Read it as a precedence:
 *
 *   1. caretaker, INCLUDING an account that also carries `admin: true`. That
 *      account should not exist — `grant-staff-role.mjs` refuses to mint it and
 *      so, as of this change, does `setAdminClaim` — but if one is made by hand
 *      it must degrade to the caretaker rather than keep the owner's reach.
 *      `firestore.rules:isOwner()` and `lib/staffGate.ts:isOwnerClaim()` both
 *      subtract the caretaker from the owner the same way; a gate that admitted
 *      such a token as `admin` would put the client on one boundary and the
 *      server on another, which is the disagreement #944 exists to prevent.
 *      `isOwner` below therefore ALSO subtracts her, belt and braces: the two
 *      guards fail independently, and either one alone holds the property.
 *   2. owner.
 *   3. Stage 0I test admin.
 *   4. denied.
 *
 * A caretaker who also carries `testTribeId` resolves to `caretaker` and gets
 * NO sandbox pin, because the rules do not scope `isCaretaker()` either. A
 * caretaker is a real account working real households; the sandbox claim on one
 * would be a minting mistake, and pinning her queries to a test tribe would
 * quietly empty every screen instead of saying so.
 */
export function accessFromClaims(claims: Record<string, unknown>): AdminAccess {
  const isCaretaker = caretakerFromClaim(claims.staffRole);
  const isOwner = claims.admin === true && !isCaretaker;
  const testMode = testModeFromClaim(claims.testTribeId);
  if (!allowIntoApp(isOwner, isCaretaker, testMode)) return { status: 'denied' };
  if (isCaretaker) return { status: 'caretaker' };
  if (isOwner) return { status: 'admin' };
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
