// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #1293. An unknown path rendered the library's bare "Not Found" in the
 * top-left corner: no header, no nav, no way back. It now renders the portal's
 * own screen inside the shell, for a signed-in household and for a visitor who
 * is signed out.
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


function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}
describe('#1293 an unknown portal URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    sessionStorage.clear();
    setOnline(true);
    getMyHome.mockResolvedValue({ businessName: 'Tribe Tails', businessLogoUrl: null });
    window.history.replaceState(null, '', '/this-page-does-not-exist');
  });
  afterEach(async () => {
    await settleRouter();
    lastRouter = undefined;
    dropBootedOnlineListeners();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  it('registers the screen as the router default, so no path can fall back to the library text', async () => {
    currentUser = { uid: 'uid-1', email: 'kin@example.com' };
    const { router } = await boot();
    const { NotFound } = await import('./screens/NotFound');
    expect(router.options.defaultNotFoundComponent).toBe(NotFound);
  });
  it('shows a signed-in household the portal nav and a link Home', async () => {
    currentUser = { uid: 'uid-1', email: 'kin@example.com' };
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    await boot();
    expect(await screen.findByText('We can\u2019t find that page.')).toBeInTheDocument();
    // The shell: the real nav, so every screen is one tap away.
    expect(screen.getAllByRole('link', { name: 'Schedule' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/home');
    // The library's bare default is gone.
    expect(screen.queryByText(/^Not Found$/)).toBeNull();
  });
  it('shows a signed-out visitor the wordmark and a link that lands on sign-in', async () => {
    currentUser = null;
    await boot();
    expect(await screen.findByText('We can\u2019t find that page.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Schedule' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
    expect(getMyHome).not.toHaveBeenCalled();
  });
});
