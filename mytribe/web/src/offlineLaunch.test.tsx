// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #812. A deep link opened with no signal showed a household `LaunchError`
 * rather than their booking or an offline screen.
 *
 * The portal never crashed the way the admin did, and that is exactly what hid
 * this. `ensureAccess` catches the failed `getMyAccess` into `access.error`,
 * `requireActiveTribe` returned early on it, and the screen fell onto the
 * launch-error card: "We're having trouble loading your tribe", a Try again
 * that cannot work without a network, and a **Sign out** that would clear the
 * last readable copy of this household's own data. Correct for a backend that
 * is genuinely down. Wrong, and destructive, for a phone with no bars.
 *
 * So both causes are driven here, one spec each, and each must reach its OWN
 * screen. A fix that sent every launch failure to the offline screen would take
 * the sign-out away from the household who actually needs it.
 */

type AuthUser = { uid: string; email: string } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

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
  signInWithEmailAndPassword: vi.fn(),
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

describe('#812 a portal deep link opened with no signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    sessionStorage.clear();
    setOnline(true);
    currentUser = { uid: 'uid-1', email: 'kin@example.com' };
    // The journey: a link to one visit, tapped cold.
    window.history.replaceState(null, '', '/schedule/bk-2291');
  });

  afterEach(async () => {
    await settleRouter();
    lastRouter = undefined;
    dropBootedOnlineListeners();
    setOnline(true);
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('says the phone is offline instead of blaming the tribe load', async () => {
    setOnline(false);
    getMyAccess.mockRejectedValue(new Error('internal'));

    await boot();

    expect(await screen.findByText(/We can’t reach Tribe Tails/i)).toBeInTheDocument();
    expect(screen.queryByText(/having trouble loading your tribe/i)).not.toBeInTheDocument();
  });

  it('offers no way to sign out from the offline screen', async () => {
    setOnline(false);
    getMyAccess.mockRejectedValue(new Error('internal'));

    await boot();
    await screen.findByText(/We can’t reach Tribe Tails/i);

    // #805's ruling, honoured here: sign-out clears the cache that is the only
    // thing this household can still read, and signing back in needs the
    // network that is missing.
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    // No Retry either: `refetch` on a device with no connection cannot start.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('leaves a refusal from the backend on the path it already had', async () => {
    // Online, and the server said no. The guard's documented behaviour is to
    // fall through so the screen's OWN query surfaces it, which is where the
    // launch-error card and its Sign out come from, and that is deliberately
    // untouched. What must not happen is this landing on the offline screen: a
    // household whose account is genuinely refused still needs the screen that
    // can act on it.
    getMyAccess.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'functions/permission-denied' }),
    );

    await boot();

    expect(await screen.findByText('THE BOOKING')).toBeInTheDocument();
    expect(screen.queryByText(/We can’t reach Tribe Tails/i)).not.toBeInTheDocument();
  });

  it('still sends a genuinely broken account to the launch-error screen, sign out and all', async () => {
    // The "one kinfolk, one tribe" data defect, online: the guard redirects to
    // the dead-end /error screen, which IS `LaunchError`. Nothing on this path
    // moved, and this spec is here to hold that line. It is the proof that
    // "cannot reach the network" and "this account is not allowed through" did
    // not collapse into one answer.
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1', 'kin-2'], isOperator: false });

    await boot();

    expect(await screen.findByText(/having trouble loading your tribe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText(/We can’t reach Tribe Tails/i)).not.toBeInTheDocument();
  });

  it('opens the booking as usual when the tribe resolves', async () => {
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    setActiveTribe.mockResolvedValue({ ok: true, kinfolkId: 'kin-1' });

    await boot();

    expect(await screen.findByText('THE BOOKING')).toBeInTheDocument();
  });

  it('registers an errorComponent, so no guard rejection can reach the crash boundary', async () => {
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    const { router } = await boot();
    const { RouteError } = await import('./components/RouteError');
    expect(router.options.defaultErrorComponent).toBe(RouteError);
  });

  it('re-launches by itself when the connection comes back', async () => {
    setOnline(false);
    getMyAccess.mockRejectedValueOnce(new Error('internal'));

    await boot();
    await screen.findByText(/We can’t reach Tribe Tails/i);

    // The way out is the signal returning, not a tap. `clearAccess` is what
    // makes the next pass call getMyAccess again instead of replaying the
    // failure it cached.
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    setActiveTribe.mockResolvedValue({ ok: true, kinfolkId: 'kin-1' });
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(screen.getByText('THE BOOKING')).toBeInTheDocument());
  });

  it('does not re-fetch a healthy access every time the connection flaps', async () => {
    // The reconnect path clears only a FAILED access. Dropping a healthy one
    // would blank `getActiveKinfolkId()` under the refetches React Query starts
    // on the same event, and a kinfolkId-less callable reads the caller's first
    // household server-side, which for an operator is the wrong one.
    //
    // Counted as a DELTA rather than an absolute. Every `boot()` in this file
    // leaves its own `online` listener on the window, so the shared mock's
    // total is not this test's alone. What the reconnect must not do is add to
    // it, and that is exactly what the delta measures.
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    setActiveTribe.mockResolvedValue({ ok: true, kinfolkId: 'kin-1' });
    await boot();
    await screen.findByText('THE BOOKING');
    const before = getMyAccess.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.getByText('THE BOOKING')).toBeInTheDocument());
    expect(getMyAccess.mock.calls.length).toBe(before);
  });
});
