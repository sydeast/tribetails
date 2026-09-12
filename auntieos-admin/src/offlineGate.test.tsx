// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #812. An offline deep link crashed the admin once the cached token needed a
 * refresh it could not get.
 *
 * WHAT IS UNDER TEST IS THE GATE, not a screen. #804 made the service worker
 * answer an offline navigation with the precached shell, so the page paints;
 * `router.tsx`'s `requireAdmin` then decides what mounts into it. It calls
 * `resolveAccess`, which calls `getIdTokenResult`, and that promise REJECTS
 * once the cached token is past its hour with no network to renew it. Nothing
 * caught it, no route declared an `errorComponent`, and the operator (who
 * opened mobile web on a driveway precisely because the Android app would not
 * start) got a crash page.
 *
 * THE THREE CAUSES MUST STAY THREE, which is what most of this file is for. A
 * fix that admitted every failure would be worse than the crash: it would let a
 * kinfolk's credentials into the admin. So each spec below drives ONE cause and
 * asserts its OWN destination:
 *
 *   no network         the read-only app  (`auth/network-request-failed`)
 *   unrenewable        /signin            (any other auth failure)
 *   not permitted      /signin            (claims read, and they say no)
 *
 * Assertions are positive wherever they can be (the shell really rendered, the
 * URL really moved), because "the crash text is absent" is satisfied by a
 * router that renders nothing at all, and that is not a passing grade.
 */

// ---------------------------------------------------------------------------
// Firebase, driven by hand. `getIdTokenResult` is the whole subject of the
// file, so it is a per-test fixture rather than a fixed stub.
// ---------------------------------------------------------------------------

type AuthUser = { uid: string; email: string; displayName: string | null } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

const { getIdTokenResult } = vi.hoisted(() => ({ getIdTokenResult: vi.fn() }));
const { httpsCallable } = vi.hoisted(() => ({ httpsCallable: vi.fn() }));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));

vi.mock('./lib/firebase', () => ({
  auth: {
    get currentUser() {
      return currentUser;
    },
  },
  db: {},
  functions: {},
  app: {},
  firebaseConfig: {},
  ADMIN_APP_CHECK_SITE_KEY: '',
  activateAppCheck: vi.fn(),
  getAppCheckStatus: () => 'off',
  resetAppCheckForTest: vi.fn(),
  E2E_EMULATOR_HOST: '',
  E2E_FUNCTIONS_PORT: 5399,
}));

vi.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: vi.fn() },
  getIdTokenResult,
  onAuthStateChanged: (_auth: unknown, cb: (u: AuthUser) => void) => {
    authListeners.add(cb);
    cb(currentUser);
    return () => authListeners.delete(cb);
  },
  reauthenticateWithCredential: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updatePassword: vi.fn(),
  verifyBeforeUpdateEmail: vi.fn(),
}));

vi.mock('firebase/functions', () => ({ httpsCallable }));

vi.mock('./lib/sentry', () => ({ reportError, initSentry: vi.fn() }));
vi.mock('./lib/boot', () => ({
  decideAttestation: vi.fn(),
  attestationOwnsRecaptcha: () => false,
}));
// The rail's unread pill opens a Firestore listener. Not this file's subject,
// and a real one would need an emulator.
vi.mock('./lib/firestore', () => ({ useCollection }));

/**
 * The authenticated screen, stubbed. What matters here is whether an admin
 * surface mounts AT ALL on a device with no signal, not which cards Home draws.
 */
vi.mock('./screens/Home', () => ({ Home: () => <div>ADMIN HOME</div> }));

/** A token whose claims say this account is an admin. */
function adminToken() {
  return { claims: { admin: true } };
}

function networkRefusal(): Error & { code: string } {
  return Object.assign(new Error('Failed to fetch'), { code: 'auth/network-request-failed' });
}

function unrenewable(): Error & { code: string } {
  return Object.assign(new Error('nope'), { code: 'auth/internal-error' });
}

/**
 * Each `boot()` imports a fresh `./router`, which registers a module-level
 * `online` listener that outlives the render. Those stale routers share this
 * document's history, so a later `dispatchEvent(new Event('online'))` would
 * wake all of them and let a dead router's guard redirect the URL out from
 * under the live one. Real in production only in the sense that a page has one
 * router; here it is pure test bleed, so each boot's listener is tracked and
 * dropped with its test.
 */
const bootedOnlineListeners: EventListener[] = [];
async function importRouterTrackingListeners() {
  const realAdd = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    fn: EventListener,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'online') bootedOnlineListeners.push(fn);
    realAdd(type, fn, opts);
  }) as typeof window.addEventListener);
  try {
    return await import('./router');
  } finally {
    spy.mockRestore();
  }
}
function dropBootedOnlineListeners(): void {
  for (const fn of bootedOnlineListeners.splice(0)) window.removeEventListener('online', fn);
}
async function boot() {
  const { router } = await importRouterTrackingListeners();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

/** Every control that would end the session, by accessible name. */
function sessionEndingControls(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /sign out|sign in again/i });
}

describe('#812 the admin gate on a device with no signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    useCollection.mockReturnValue({ status: 'loading' });
    currentUser = { uid: 'uid-admin', email: 'auntie@example.com', displayName: 'Auntie' };
    // The reported journey: a link opened cold, straight onto a deep route.
    window.history.replaceState(null, '', '/home');
  });

  afterEach(() => {
    dropBootedOnlineListeners();
    window.history.replaceState(null, '', '/');
  });

  it('mounts the admin read-only when the cached token cannot be renewed', async () => {
    getIdTokenResult.mockRejectedValue(networkRefusal());

    await boot();

    // The screen is THERE. This is the assertion the crash fallback failed.
    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    // And it says why it is degraded, in the shell's own standing banner.
    expect(await screen.findByText(/Signed in, but out of touch/i)).toBeInTheDocument();
    // Not bounced to a sign-in form it could never submit.
    expect(window.location.pathname).toBe('/home');
  });

  it('offers nothing that would sign the operator out while they are offline', async () => {
    getIdTokenResult.mockRejectedValue(networkRefusal());

    await boot();
    await screen.findByText('ADMIN HOME');

    // Sign-out clears the cached session, and signing back in needs the network
    // that is missing. Offline it is a one-way door out of a readable app.
    expect(sessionEndingControls()).toHaveLength(0);
  });

  it('refuses a callable outright while degraded, rather than dialling', async () => {
    getIdTokenResult.mockRejectedValue(networkRefusal());

    await boot();
    await screen.findByText('ADMIN HOME');

    const { call } = await import('./lib/fns');
    const { OfflineSessionError } = await import('./lib/readOnlySession');
    await expect(call('listBookings', {})).rejects.toBeInstanceOf(OfflineSessionError);
    // The proof that it was refused rather than attempted and failed.
    expect(httpsCallable).not.toHaveBeenCalled();
  });

  it('sends a session that cannot renew for any other reason to sign in again', async () => {
    getIdTokenResult.mockRejectedValue(unrenewable());

    await boot();

    // A different cause, a different destination. Retrying cannot mint a token
    // for this session; only authenticating again can.
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    expect(screen.queryByText('ADMIN HOME')).not.toBeInTheDocument();
  });

  it('still refuses an account whose claims say it is not an admin', async () => {
    // The token reads fine. It simply does not carry the claim. NOT PERMITTED,
    // which must never be answered with the offline treatment.
    getIdTokenResult.mockResolvedValue({ claims: { role: 'kinfolk', kinfolkId: 'k1' } });

    await boot();

    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    expect(screen.queryByText('ADMIN HOME')).not.toBeInTheDocument();
    expect(screen.queryByText(/Signed in, but out of touch/i)).not.toBeInTheDocument();
  });

  it('leaves a healthy admin exactly as it was, with its sign out', async () => {
    getIdTokenResult.mockResolvedValue(adminToken());

    await boot();

    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    expect(screen.queryByText(/Signed in, but out of touch/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('becomes the real app again when the connection comes back', async () => {
    // The read-only entry has to be a waiting room, not a dead end. Nothing is
    // tapped here: the browser's own `online` event is the whole input.
    getIdTokenResult.mockRejectedValueOnce(networkRefusal());
    await boot();
    await screen.findByText(/Signed in, but out of touch/i);
    expect(sessionEndingControls()).toHaveLength(0);
    getIdTokenResult.mockResolvedValue(adminToken());
    window.dispatchEvent(new Event('online'));
    // The banner goes, the sign out comes back, and callables are dialled again
    // rather than refused on the way out.
    await waitFor(() =>
      expect(screen.queryByText(/Signed in, but out of touch/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    const { isReadOnlySession } = await import('./lib/readOnlySession');
    expect(isReadOnlySession()).toBe(false);
  });
  it('registers an errorComponent, so no route rejection can reach the crash fallback', async () => {
    getIdTokenResult.mockResolvedValue(adminToken());
    const { router } = await boot();
    const { RouteError } = await import('./components/RouteError');
    expect(router.options.defaultErrorComponent).toBe(RouteError);
  });
});
