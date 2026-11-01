// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
/**
 * #1384. A visit or invoice link from an email, opened with no portal session,
 * must survive the sign-in it forces.
 *
 * Drives the REAL router, guards and sign-in screen: the guard turns a
 * signed-out visit away, the `redirect` search param carries where it was
 * going, and the screen lands there once the household authenticates. Harness
 * follows `offlineLaunch.test.tsx`.
 */
type AuthUser = { uid: string; email: string } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

const { signInWithEmailAndPassword } = vi.hoisted(() => ({ signInWithEmailAndPassword: vi.fn() }));
const { getMyAccess, getMyHome, setActiveTribe } = vi.hoisted(() => ({
  getMyAccess: vi.fn(),
  getMyHome: vi.fn(),
  setActiveTribe: vi.fn(),
}));

vi.mock('./lib/firebase', () => ({
  auth: {
    get currentUser() {
      return currentUser;
    },
  },
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
  signInWithEmailAndPassword,
  signOut: vi.fn(async () => {
    currentUser = null;
    for (const l of authListeners) l(null);
  }),
}));

vi.mock('./lib/push', () => ({ unregisterForPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./api/authApi', () => ({ signOutAllDevices: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('./api/portal', () => ({ getMyAccess, getMyHome, setActiveTribe }));

/** The destination of the deep link, stubbed: whether it mounts is the question. */
vi.mock('./screens/BookingDetail', () => ({ BookingDetail: () => <div>THE BOOKING</div> }));
vi.mock('./screens/Home', () => ({ Home: () => <div>PORTAL HOME</div> }));

/** jsdom reports a live connection by default; these two say otherwise. */
function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
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
type PortalRouter = Awaited<ReturnType<typeof importRouterTrackingListeners>>['router'];
/** The most recently booted router, so `afterEach` can drain it without every test threading it through. */
let lastRouter: PortalRouter | undefined;
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
 * this FILE's jsdom environment is torn down. `window` is gone by then, so
 * React's scheduler throws `ReferenceError: window is not defined` as an
 * unhandled rejection vitest reports as a run failure, rather than a test
 * failure anyone sees. So every test drains its own router to `'idle'` before
 * finishing, whether or not it did anything past the initial boot.
 */
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}


const KIN = { uid: 'uid-1', email: 'pawsome@hanasamku.com' };
/** The mocked SDK signs the account in and tells every auth listener, as the real one does. */
function signInSucceeds(): void {
  signInWithEmailAndPassword.mockImplementation(async () => {
    currentUser = KIN;
    for (const cb of authListeners) cb(currentUser);
    return { user: KIN };
  });
}
async function fillAndSubmit(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Email Address'), { target: { value: KIN.email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-not-real' } });
  fireEvent.submit(screen.getByLabelText('Email Address').closest('form') as HTMLFormElement);
}
describe('#1384 portal sign-in keeps the deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    sessionStorage.clear();
    setOnline(true);
    currentUser = null;
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    setActiveTribe.mockResolvedValue({ ok: true, kinfolkId: 'kin-1' });
    signInSucceeds();
  });
  afterEach(async () => {
    await settleRouter();
    lastRouter = undefined;
    dropBootedOnlineListeners();
    setOnline(true);
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  it('carries the visit link to /signin, then lands on the visit after sign-in', async () => {
    window.history.replaceState(null, '', '/schedule/bk-2291?from=email');
    await boot();
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    expect(new URLSearchParams(window.location.search).get('redirect')).toBe('/schedule/bk-2291?from=email');
    await fillAndSubmit();
    expect(await screen.findByText('THE BOOKING')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/schedule/bk-2291');
    expect(window.location.search).toBe('?from=email');
    expect(screen.queryByText('PORTAL HOME')).toBeNull();
  });
  it('still lands on Home when the household went to /signin directly', async () => {
    window.history.replaceState(null, '', '/signin');
    await boot();
    await fillAndSubmit();
    expect(await screen.findByText('PORTAL HOME')).toBeInTheDocument();
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
    expect(await screen.findByText('PORTAL HOME')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/home');
    expect(window.location.hostname).not.toBe('evil.example');
  });
});
