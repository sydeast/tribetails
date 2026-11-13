// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #1845: an unknown address rendered the library's bare "Not Found" in the top
 * left of an empty page. It now renders a real screen: inside the shell, with
 * the rail, for a signed-in operator; on its own, with the brand and a way to
 * sign in, for a visitor who is signed out.
 *
 * #2007: every screen names itself in the browser tab, and a screen with a
 * record open names the record too.
 *
 * Drives the REAL router, guard and shell. Harness (Firebase driven by hand,
 * router booted fresh per test, drained to idle) follows `signInRedirect.test.tsx`.
 */
type AuthUser = { uid: string; email: string; displayName: string | null } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

const { getIdTokenResult } = vi.hoisted(() => ({ getIdTokenResult: vi.fn() }));
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

vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('./lib/sentry', () => ({ reportError: vi.fn(), initSentry: vi.fn() }));
vi.mock('./lib/boot', () => ({
  decideAttestation: vi.fn(),
  attestationOwnsRecaptcha: () => false,
}));
// The rail's unread pill opens a Firestore listener; a real one needs an emulator.
vi.mock('./lib/firestore', () => ({ useCollection }));

// The screens themselves are stubbed: this file is about the router and the
// shell, not what each screen draws. The detail stub names its record the way
// the real detail screens do, through the real hook.
vi.mock('./screens/Home', () => ({ Home: () => <div>ADMIN HOME</div> }));
vi.mock('./routes/InvoicesView', () => ({ InvoicesView: () => <div>INVOICES SCREEN</div> }));
vi.mock('./screens/Schedule', () => ({ Schedule: () => <div>SCHEDULE SCREEN</div> }));
vi.mock('./routes/SessionsView', () => ({ SessionsView: () => <div>SESSIONS SCREEN</div> }));
vi.mock('./routes/SessionDetailView', async () => {
  const { useRecordTitle } = await import('./lib/pageTitle');
  return {
    SessionDetailView: () => {
      useRecordTitle('Biscuit');
      return <div>SESSION DETAIL</div>;
    },
  };
});

const ADMIN = { uid: 'uid-admin', email: 'e2e-admin@tribetails.com', displayName: 'Auntie' };

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
type AdminRouter = Awaited<ReturnType<typeof importRouterTrackingListeners>>['router'];
let lastRouter: AdminRouter | undefined;
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
/** See signInRedirect.test.tsx: every test drains its router to idle before its jsdom goes away. */
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}

const NOT_FOUND_HEADING = 'We can’t find that page.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  authListeners.clear();
  useCollection.mockReturnValue({ status: 'loading' });
  getIdTokenResult.mockResolvedValue({ claims: { admin: true } });
  currentUser = null;
  document.title = '';
});
afterEach(async () => {
  await settleRouter();
  lastRouter = undefined;
  dropBootedOnlineListeners();
  window.history.replaceState(null, '', '/');
});

describe('#1845 an unknown admin address', () => {
  it('matches anything no screen owns to the not-found route, under the admin guard', async () => {
    const { router } = await import('./router');
    for (const path of ['/qa-r1-nope', '/invoices/garbage', '/directory/kf_1/extra']) {
      const matches = router.matchRoutes(path, {});
      expect(matches[matches.length - 1]!.routeId, path).toBe('/admin/$');
      expect(matches.map((m) => m.routeId), path).toContain('/admin');
    }
  });

  it('leaves every real screen where it was', async () => {
    const { router } = await import('./router');
    const leaf = (path: string) => {
      const matches = router.matchRoutes(path, {});
      return matches[matches.length - 1]!.routeId;
    };
    expect(leaf('/signin')).toBe('/signin');
    expect(leaf('/invoices')).toBe('/admin/invoices');
    expect(leaf('/invites/inv_1')).toBe('/admin/invites/$inviteId');
    expect(leaf('/sessions/s_1')).toBe('/admin/sessions/$sessionId');
    expect(leaf('/media/kin/k_1')).toBe('/admin/media/$type/$id');
  });

  it('shows a signed-in operator the not-found screen inside the shell, with a way Home', async () => {
    currentUser = ADMIN;
    await boot('/qa-r1-nope');
    expect(await screen.findByRole('heading', { name: NOT_FOUND_HEADING })).toBeInTheDocument();
    // The shell: the rail is there, so every screen is one click away.
    expect(screen.getAllByRole('link', { name: /Invoices/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/home');
    expect(screen.queryByText(/^Not Found$/)).toBeNull();
    expect(window.location.pathname).toBe('/qa-r1-nope');
    await waitFor(() => expect(document.title).toBe('Page not found · AuntieOS'));
  });

  it('shows the not-found screen for a nested unknown path too', async () => {
    currentUser = ADMIN;
    await boot('/invoices/garbage');
    expect(await screen.findByRole('heading', { name: NOT_FOUND_HEADING })).toBeInTheDocument();
    expect(screen.queryByText('INVOICES SCREEN')).toBeNull();
  });

  it('shows a signed-out visitor the brand and a way to sign in, without the rail', async () => {
    currentUser = null;
    await boot('/qa-r1-nope');
    expect(await screen.findByRole('heading', { name: NOT_FOUND_HEADING })).toBeInTheDocument();
    expect(screen.getByText('AuntieOS')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
    expect(screen.queryByRole('link', { name: /Invoices/ })).toBeNull();
    expect(screen.queryByText(/^Not Found$/)).toBeNull();
    expect(window.location.pathname).toBe('/qa-r1-nope');
    await waitFor(() => expect(document.title).toBe('Page not found · AuntieOS'));
  });

  it('still sends a signed-out visitor on a real screen to sign in', async () => {
    currentUser = null;
    await boot('/invoices');
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    expect(screen.queryByRole('heading', { name: NOT_FOUND_HEADING })).toBeNull();
  });
});

describe('#2007 the browser tab names the screen', () => {
  it('gives every route that draws a screen a title', async () => {
    const { router } = await import('./router');
    const missing: string[] = [];
    for (const [id, route] of Object.entries(router.routesById)) {
      if (id === '__root__' || id === '/admin') continue;
      const options = (route as { options: { component?: unknown; staticData?: { title?: string } } }).options;
      if (options.component === undefined) continue; // redirect-only routes draw nothing
      if (!options.staticData?.title) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('uses the rail’s names, detail routes included', async () => {
    const { router } = await import('./router');
    const title = (id: string) =>
      (router.routesById as Record<string, { options: { staticData?: { title?: string } } }>)[id]!.options
        .staticData?.title;
    expect(title('/signin')).toBe('Sign in');
    expect(title('/admin/home')).toBe('Home');
    expect(title('/admin/invoices')).toBe('Invoices');
    expect(title('/admin/sessions')).toBe('Auntie Time');
    expect(title('/admin/sessions/$sessionId')).toBe('Auntie Time');
    expect(title('/admin/directory/$kinfolkId')).toBe('Directory');
    expect(title('/admin/invites/$inviteId')).toBe('Invites');
    expect(title('/admin/household-members/$kinfolkId')).toBe('Members and invites');
    expect(title('/admin/kintale-templates')).toBe('KinTale templates');
    expect(title('/admin/$')).toBe('Page not found');
  });

  it('follows the operator from screen to screen, into a record and back out', async () => {
    currentUser = ADMIN;
    const { router } = await boot('/invoices');
    expect(await screen.findByText('INVOICES SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Invoices · AuntieOS'));

    await router.navigate({ to: '/schedule' });
    expect(await screen.findByText('SCHEDULE SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Schedule · AuntieOS'));

    await router.navigate({ to: '/sessions/$sessionId', params: { sessionId: 'kcs_1' } });
    expect(await screen.findByText('SESSION DETAIL')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Biscuit · Auntie Time · AuntieOS'));
    expect(document.title).not.toContain('kcs_1');

    await router.navigate({ to: '/sessions' });
    expect(await screen.findByText('SESSIONS SCREEN')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Auntie Time · AuntieOS'));
  });

  it('names the sign-in screen', async () => {
    currentUser = null;
    await boot('/signin');
    await screen.findByLabelText('Email');
    await waitFor(() => expect(document.title).toBe('Sign in · AuntieOS'));
  });
});
