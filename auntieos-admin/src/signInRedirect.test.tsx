// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
/**
 * #1384. An email deep link opened with no admin session must survive the
 * sign-in it forces.
 *
 * This drives the REAL router, guard and sign-in screen end to end: the guard
 * turns a signed-out visit away, the `redirect` search param carries where it
 * was going, and the screen lands there once the operator authenticates.
 * Harness (Firebase driven by hand, router booted fresh per test, drained to
 * idle) follows `offlineGate.test.tsx`.
 */
type AuthUser = { uid: string; email: string; displayName: string | null } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

const { getIdTokenResult } = vi.hoisted(() => ({ getIdTokenResult: vi.fn() }));
const { signInWithEmailAndPassword } = vi.hoisted(() => ({ signInWithEmailAndPassword: vi.fn() }));
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
  signInWithEmailAndPassword,
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
vi.mock('./screens/Invites', () => ({ Invites: () => <div>INVITES SCREEN</div> }));

/** A token whose claims say this account is an admin. */
function adminToken() {
  return { claims: { admin: true } };
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
/** The type of the router `./router` hands back, without importing it eagerly. */
type AdminRouter = Awaited<ReturnType<typeof importRouterTrackingListeners>>['router'];
/** The most recently booted router, so `afterEach` can drain it without every test threading it through. */
let lastRouter: AdminRouter | undefined;
async function boot() {
  const { router } = await importRouterTrackingListeners();
  lastRouter = router;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

/**
 * Every `beforeLoad` guard above can throw `redirect()`, which the router
 * follows as ITS OWN further navigation -- a promise chain no test holds a
 * reference to. A `findByText` match on the destination screen proves that
 * chain reached the point of rendering, not that it has fully committed:
 * `router.state.status` stays `'pending'` for a few more microtasks while
 * TanStack finishes `startTransition`. Confirmed by instrumenting this exact
 * spot: "registers an errorComponent" -- the one test here that reads
 * `router.options` straight off `boot()` without waiting on any screen --
 * left its router `'pending'`, not `'idle'`, every other test's boot had
 * already reached `'idle'` by the time its own assertions ran. Left running,
 * that tail settles whenever the real clock gets to it, which can land after
 * this FILE's jsdom environment is torn down -- `window` is gone by then, so
 * React's scheduler throws `ReferenceError: window is not defined` as an
 * unhandled rejection vitest reports as a run failure, rather than a test
 * failure anyone sees. So every test drains its own router to `'idle'` before
 * finishing, whether or not it did anything past the initial boot. Mirrors
 * mytribe/web/src/offlineLaunch.test.tsx, which hit this first (that CI run's
 * "Kinfolk portal" job; this file was not itself observed to fail in CI, but
 * shares the exact same latent gap).
 */
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}


const ADMIN = { uid: 'uid-admin', email: 'e2e-admin@tribetails.com', displayName: 'Auntie' };
/** The mocked SDK signs the account in and tells every auth listener, as the real one does. */
function signInSucceeds(): void {
  signInWithEmailAndPassword.mockImplementation(async () => {
    currentUser = ADMIN;
    for (const cb of authListeners) cb(currentUser);
    return { user: ADMIN };
  });
}
async function fillAndSubmit(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: ADMIN.email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-not-real' } });
  fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);
}
describe('#1384 admin sign-in keeps the deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    useCollection.mockReturnValue({ status: 'loading' });
    currentUser = null;
    getIdTokenResult.mockResolvedValue(adminToken());
    signInSucceeds();
  });
  afterEach(async () => {
    await settleRouter();
    lastRouter = undefined;
    dropBootedOnlineListeners();
    window.history.replaceState(null, '', '/');
  });
  it('carries the path and search to /signin, then lands on them after sign-in', async () => {
    window.history.replaceState(null, '', '/invites?inviteId=inv_1');
    await boot();
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    expect(new URLSearchParams(window.location.search).get('redirect')).toBe('/invites?inviteId=inv_1');
    await fillAndSubmit();
    expect(await screen.findByText('INVITES SCREEN')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/invites');
    expect(window.location.search).toBe('?inviteId=inv_1');
    expect(screen.queryByText('ADMIN HOME')).toBeNull();
  });
  it('still lands on Home when the operator went to /signin directly', async () => {
    window.history.replaceState(null, '', '/signin');
    await boot();
    await fillAndSubmit();
    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/home');
  });
  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a javascript URI', 'javascript:alert(1)'],
  ])('refuses %s in the redirect param and lands on Home', async (_label, bad) => {
    window.history.replaceState(null, '', `/signin?redirect=${encodeURIComponent(bad)}`);
    await boot();
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    await fillAndSubmit();
    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/home');
    expect(window.location.hostname).not.toBe('evil.example');
  });
});
