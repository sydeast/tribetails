// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #2007, the portal's half: the browser tab said "MyTribe" on every screen. It
 * now names the screen, and the Kin, visit or record when one is open. Drives
 * the REAL router; harness (Firebase by hand, router booted fresh per test,
 * drained to idle) follows `notFound.test.tsx`.
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
  signOut: vi.fn(),
}));

vi.mock('./lib/push', () => ({ unregisterForPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./api/authApi', () => ({ signOutAllDevices: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('./api/portal', () => ({ getMyAccess, getMyHome, setActiveTribe }));

// The screens are stubbed: this file is about the router and the tab, not what
// each screen draws. The Kin detail stub names its Kin through the real hook,
// the way the real screen does once its read lands.
vi.mock('./screens/Home', () => ({ Home: () => <div>HOME SCREEN</div> }));
vi.mock('./screens/Schedule', () => ({ Schedule: () => <div>SCHEDULE SCREEN</div> }));
vi.mock('./screens/Kin', () => ({ Kin: () => <div>KIN SCREEN</div> }));
vi.mock('./screens/KinDetail', async () => {
  const { useRecordTitle } = await import('./lib/pageTitle');
  return {
    KinDetail: () => {
      useRecordTitle('Biscuit');
      return <div>KIN DETAIL</div>;
    },
  };
});

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
type PortalRouter = Awaited<ReturnType<typeof importRouterTrackingListeners>>['router'];
let lastRouter: PortalRouter | undefined;
async function boot(path: string) {
  window.history.replaceState(null, '', path);
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
/** See notFound.test.tsx: every test drains its router to idle before its jsdom goes away. */
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  authListeners.clear();
  sessionStorage.clear();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  getMyHome.mockResolvedValue({ businessName: 'Tribe Tails', businessLogoUrl: null });
  getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
  currentUser = null;
  document.title = '';
});
afterEach(async () => {
  await settleRouter();
  lastRouter = undefined;
  dropBootedOnlineListeners();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('#2007 the portal tab names the screen', () => {
  it('gives every route that draws a screen a title', async () => {
    const { router } = await import('./router');
    const missing: string[] = [];
    for (const [id, route] of Object.entries(router.routesById)) {
      if (id === '__root__') continue;
      const options = (route as { options: { component?: unknown; staticData?: { title?: string } } }).options;
      if (options.component === undefined) continue; // redirect-only routes draw nothing
      if (!options.staticData?.title) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('names detail and nested routes after the screen they belong to', async () => {
    const { router } = await import('./router');
    const title = (id: string) =>
      (router.routesById as Record<string, { options: { staticData?: { title?: string } } }>)[id]!.options
        .staticData?.title;
    expect(title('/signin')).toBe('Sign in');
    expect(title('/home')).toBe('Home');
    expect(title('/kin/$kinId')).toBe('Kin');
    expect(title('/kin/$kinId/edit')).toBe('Edit Kin');
    expect(title('/schedule/$visitId')).toBe('Schedule');
    expect(title('/schedule/book')).toBe('New booking');
    expect(title('/invoices/$invoiceId')).toBe('Invoice');
    expect(title('/account/notifications')).toBe('Notification settings');
  });

  it('follows a household from screen to screen, into a Kin and back out', async () => {
    currentUser = { uid: 'uid-1', email: 'pawsome@hanasamku.com' };
    const { router } = await boot('/home');
    expect(await screen.findByText('HOME SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Home · MyTribe'));

    await router.navigate({ to: '/schedule' });
    expect(await screen.findByText('SCHEDULE SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Schedule · MyTribe'));

    await router.navigate({ to: '/kin/$kinId', params: { kinId: 'kin_doc_1' } });
    expect(await screen.findByText('KIN DETAIL')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Biscuit · Kin · MyTribe'));
    expect(document.title).not.toContain('kin_doc_1');

    await router.navigate({ to: '/kin' });
    expect(await screen.findByText('KIN SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Kin · MyTribe'));
  });

  it('names the sign-in screen', async () => {
    currentUser = null;
    await boot('/signin');
    await waitFor(() => expect(document.title).toBe('Sign in · MyTribe'));
  });

  it('names the not-found screen, signed in or out', async () => {
    currentUser = null;
    await boot('/this-page-does-not-exist');
    expect(await screen.findByText('We can’t find that page.')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Page not found · MyTribe'));
  });
});
