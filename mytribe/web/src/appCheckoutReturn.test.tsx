// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

/**
 * #2401. A household who paid by card from the MyTribe app was returned to
 * this site's invoice page, and with no web sign-in in that browser the first
 * thing they saw after paying was the sign-in screen. The app now sends
 * `/app/invoices/{id}`. This drives the REAL router to show that the address
 * opens with nobody signed in, reads nothing, and points back to the app.
 * Harness (Firebase by hand, router booted fresh per test, drained to idle)
 * follows `notFound.test.tsx`.
 */
type AuthUser = { uid: string; email: string } | null;
let currentUser: AuthUser = null;
const authListeners = new Set<(u: AuthUser) => void>();

const { getMyAccess, getMyHome, setActiveTribe, getMyInvoices } = vi.hoisted(() => ({
  getMyAccess: vi.fn(),
  getMyHome: vi.fn(),
  setActiveTribe: vi.fn(),
  getMyInvoices: vi.fn(),
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
vi.mock('./api/invoicesApi', () => ({ getMyInvoices }));

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
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const realUserAgent = window.navigator.userAgent;
function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

describe('#2401 the address Stripe returns a MyTribe app payment to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    authListeners.clear();
    sessionStorage.clear();
    currentUser = null;
    setUserAgent(ANDROID_CHROME);
  });
  afterEach(async () => {
    await settleRouter();
    lastRouter = undefined;
    dropBootedOnlineListeners();
    sessionStorage.clear();
    setUserAgent(realUserAgent);
    window.history.replaceState(null, '', '/');
  });

  it('opens for a household not signed in on the web, and never the sign-in screen', async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    const page = await screen.findByTestId('app-checkout-return');
    expect(page).toHaveTextContent('Your payment was sent.');
    expect(page).toHaveTextContent('Go back to MyTribe to see your invoice.');
    await settleRouter();
    expect(window.location.pathname).toBe('/app/invoices/inv-1');
    expect(screen.queryByLabelText('Email Address')).toBeNull();
    // The address cannot know the invoice is paid, so the page never says so.
    expect(page.textContent ?? '').not.toMatch(/\bis paid\b|\bpaid in full\b|received/i);
  });

  it('reads nothing: no account, no household and no invoice call', async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    await screen.findByTestId('app-checkout-return');
    await settleRouter();
    expect(getMyAccess).not.toHaveBeenCalled();
    expect(getMyHome).not.toHaveBeenCalled();
    expect(getMyInvoices).not.toHaveBeenCalled();
  });

  it("offers the app's own link on Android, carrying the invoice and the marker", async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    expect(await screen.findByRole('link', { name: 'Open MyTribe' })).toHaveAttribute(
      'href',
      'mytribe://invoices/inv-1?checkout=done',
    );
  });

  it('the link to the invoice on this site keeps the marker, so that page checks the payment too', async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    expect(await screen.findByRole('link', { name: 'See this invoice here' })).toHaveAttribute(
      'href',
      '/invoices/inv-1?checkout=done',
    );
  });

  it('a cancelled checkout says no payment was sent and carries no marker anywhere', async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1');
    await boot();
    const page = await screen.findByTestId('app-checkout-return');
    expect(page).toHaveTextContent('Checkout was closed.');
    expect(page).not.toHaveTextContent('Your payment was sent.');
    expect(page).not.toHaveTextContent('show as paid');
    expect(screen.getByRole('link', { name: 'Open MyTribe' })).toHaveAttribute('href', 'mytribe://invoices/inv-1');
    expect(screen.getByRole('link', { name: 'See this invoice here' })).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('a marker that is not exactly checkout=done is read as no payment', async () => {
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=maybe');
    await boot();
    const page = await screen.findByTestId('app-checkout-return');
    expect(page).toHaveTextContent('Checkout was closed.');
    expect(screen.getByRole('link', { name: 'Open MyTribe' })).toHaveAttribute('href', 'mytribe://invoices/inv-1');
  });

  it('writes an unusual invoice id into both links encoded', async () => {
    window.history.replaceState(null, '', '/app/invoices/INV%202027?checkout=done');
    await boot();
    expect(await screen.findByRole('link', { name: 'Open MyTribe' })).toHaveAttribute(
      'href',
      'mytribe://invoices/INV%202027?checkout=done',
    );
    expect(screen.getByRole('link', { name: 'See this invoice here' })).toHaveAttribute(
      'href',
      '/invoices/INV%202027?checkout=done',
    );
  });

  it('on a computer there is no app link to open, so no button that would do nothing', async () => {
    setUserAgent(DESKTOP_CHROME);
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    const page = await screen.findByTestId('app-checkout-return');
    expect(page).toHaveTextContent('Go back to MyTribe to see your invoice.');
    expect(screen.queryByRole('link', { name: 'Open MyTribe' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See this invoice here' })).toBeInTheDocument();
  });

  it('opens the same way for a household who is signed in on the web', async () => {
    currentUser = { uid: 'uid-1', email: 'e2e-admin@tribetails.com' };
    getMyAccess.mockResolvedValue({ kinfolkIds: ['kin-1'], isOperator: false });
    window.history.replaceState(null, '', '/app/invoices/inv-1?checkout=done');
    await boot();
    expect(await screen.findByTestId('app-checkout-return')).toHaveTextContent('Your payment was sent.');
    await settleRouter();
    expect(window.location.pathname).toBe('/app/invoices/inv-1');
    expect(getMyInvoices).not.toHaveBeenCalled();
  });

  it('the address with no invoice in it is not a page', async () => {
    window.history.replaceState(null, '', '/app/invoices');
    await boot();
    expect(await screen.findByText('We can’t find that page.')).toBeInTheDocument();
    expect(screen.queryByTestId('app-checkout-return')).toBeNull();
  });
});
