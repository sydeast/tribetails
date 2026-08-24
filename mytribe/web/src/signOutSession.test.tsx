// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #539 — "clicking the signout does not honor logout. users can click browser
 * back or forward to regain access without logging in again."
 *
 * WHAT THIS FILE PINS DOWN. Sign-out is a security boundary, so the property
 * under test is not "the sign-in screen appears" but "no authenticated surface
 * is reachable afterwards" — including through the browser's own back and
 * forward buttons, which re-enter history entries the app has already rendered.
 *
 * WHERE THE HOLE ACTUALLY WAS, because the obvious suspect turned out to be
 * innocent and that is worth writing down. TanStack DOES re-run `beforeLoad` on
 * a popstate, and it commits redirects with `replace: true`, so an in-document
 * back button onto an authenticated URL was already being bounced correctly —
 * measured, by deleting the fix and watching this file's back-navigation
 * assertions still pass. What was NOT happening is anything at all when the
 * session ended without a navigation. Sign-out flipped the auth store and left
 * the mounted screen, the React Query cache and the persisted tribe pick
 * exactly where they were, delegating the whole sweep to a
 * `window.location.reload()` at the end of a function whose first statement was
 * a network round trip. Nothing was signed out of; there was nothing to
 * "regain".
 *
 * WHY jsdom AND NOT PLAYWRIGHT. jsdom models `pushState`, `back()` and
 * `popstate`, which is the whole of TanStack Router's history integration
 * (verified with a spike before this file was written, rather than assumed).
 * The one thing it cannot model is the cross-document reload — and it does not
 * need to: `lib/auth.ts`'s `window.location.reload()` throws "Not implemented:
 * navigation" here and is caught, so every assertion below runs against the app
 * WITHOUT the reload. That is not a weakened test. It is the production branch
 * where the reload never arrives, which is the branch this issue is about.
 */

// ---------------------------------------------------------------------------
// Firebase auth, driven by hand.
// ---------------------------------------------------------------------------

type AuthUser = { uid: string; email: string } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

function emitAuth(u: AuthUser): void {
  currentUser = u;
  for (const l of authListeners) l(u);
}

const fakeAuth = {
  get currentUser() {
    return currentUser;
  },
};

vi.mock('./lib/firebase', () => ({
  auth: fakeAuth,
  functions: {},
  firestore: {},
  activateAppCheck: vi.fn(),
  FUNCTIONS_HTTP_BASE: 'https://example.invalid',
  FUNCTIONS_REGION: 'us-central1',
  app: {},
}));

vi.mock('firebase/auth', () => ({
  initializeRecaptchaConfig: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: (_auth: unknown, cb: (u: AuthUser) => void) => {
    authListeners.add(cb);
    cb(currentUser);
    return () => authListeners.delete(cb);
  },
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(async () => {
    emitAuth(null);
  }),
}));

// Push cleanup is a network round trip in production; here it is instant and
// harmless. The "it hangs" case gets its own spec in lib/auth.test.ts.
vi.mock('./lib/push', () => ({ unregisterForPush: vi.fn().mockResolvedValue(undefined) }));

vi.mock('./api/portal', () => ({
  getMyAccess: vi.fn().mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false }),
  getMyHome: vi.fn().mockResolvedValue({ kinfolkId: 'kin-1', displayName: 'Test Tribe' }),
  setActiveTribe: vi.fn().mockResolvedValue({ ok: true, kinfolkId: 'kin-1' }),
}));

vi.mock('./api/authApi', () => ({ signOutAllDevices: vi.fn().mockResolvedValue({ ok: true }) }));

/**
 * The authenticated screen, stubbed. What matters for #539 is whether a
 * kinfolk-only surface renders at all, and whether the previous account's data
 * is still readable from the caches behind it — not which cards Home draws.
 */
vi.mock('./screens/Home', () => ({
  Home: () => <div>AUTHENTICATED HOME</div>,
}));
/** A SECOND authenticated screen, so there is an earlier history entry to go back TO. */
vi.mock('./screens/Kin', () => ({
  Kin: () => <div>AUTHENTICATED KIN</div>,
}));

const SESSION_KEY = 'mytribe.activeKinfolkId.uid-1';

async function boot() {
  const { router } = await import('./router');
  const { queryClient } = await import('./lib/queryClient');
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

/**
 * jsdom's back() settles on a queued task, not synchronously — and how many
 * ticks it takes is not something to guess at. Wait for the URL to actually
 * move, or the assertions afterwards pass without the navigation ever having
 * happened. (It does; that is how the control below earned its place.)
 */
async function historyBack(): Promise<void> {
  const popped = new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true });
  });
  window.history.back();
  await popped;
}

describe('#539 sign-out session teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    currentUser = { uid: 'uid-1', email: 'catch@example.com' };
    sessionStorage.clear();
    sessionStorage.setItem(SESSION_KEY, 'kin-1');
    // The reported shape: a kinfolk who browsed to a second screen, so the
    // back button has an authenticated entry waiting for it. `/kin` is the
    // earlier entry; `/home` is where the operator was when they signed out.
    window.history.replaceState(null, '', '/kin');
    window.history.pushState(null, '', '/home');
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  /**
   * The control. Without this, the repro below could pass for the wrong reason
   * — a `/kin` route that never renders in this harness at all would satisfy
   * "AUTHENTICATED KIN is absent" whether the guard works or not. This proves
   * the back button really does re-enter that screen while the session is live,
   * which is what makes its absence afterwards mean something.
   */
  it('back-navigating WHILE SIGNED IN does re-enter the earlier authenticated screen', async () => {
    await boot();
    expect(await screen.findByText('AUTHENTICATED HOME')).toBeInTheDocument();

    await historyBack();
    expect(window.location.pathname).toBe('/kin');
    expect(await screen.findByText('AUTHENTICATED KIN')).toBeInTheDocument();
    expect(screen.queryByText('AUTHENTICATED HOME')).not.toBeInTheDocument();
  });

  it('back-navigating after sign-out does not re-enter the authenticated screen', async () => {
    const { queryClient } = await boot();

    expect(await screen.findByText('AUTHENTICATED HOME')).toBeInTheDocument();

    // Something the previous account could read. A cache that survives
    // sign-out is the same defect as a route that survives it.
    queryClient.setQueryData(['myHome', 'kin-1'], { displayName: 'Test Tribe' });

    const { signOut } = await import('./lib/auth');
    await signOut();

    // 1. The authenticated screen must give way immediately, with no reload.
    await waitFor(() => {
      expect(screen.queryByText('AUTHENTICATED HOME')).not.toBeInTheDocument();
    });

    // 2. The reported path: the browser's own back button, onto an earlier
    //    authenticated entry.
    await historyBack();
    // The guard bounces it straight back to /signin, replacing the entry it
    // landed on — so the authenticated URL is not even left in the history for
    // a second attempt.
    await waitFor(() => {
      expect(window.location.pathname).toBe('/signin');
    });
    expect(screen.queryByText('AUTHENTICATED KIN')).not.toBeInTheDocument();
    expect(screen.queryByText('AUTHENTICATED HOME')).not.toBeInTheDocument();

    // 3. Nothing the previous account loaded is still readable.
    expect(queryClient.getQueryData(['myHome', 'kin-1'])).toBeUndefined();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
