// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { NAV, isOwnerOnlyPath } from './lib/nav';

/**
 * #2163, operator ruling 2026-11-13: "auntie user level cannot see templates
 * or business settings". An Auntie (`staffRole: 'auntie'`) gets no Settings
 * and no Templates rail entry, and every address for either screen, the old
 * ones included, sends her Home. KinTale templates stays. The owner and the
 * Stage 0I test admin are unchanged.
 *
 * Drives the REAL router, guard and shell; the screens are sentinels, so a
 * sentinel on the page is proof the guard let the screen mount. Harness
 * follows `notFoundAndTitles.test.tsx`.
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

vi.mock('./screens/Home', () => ({ Home: () => <div>ADMIN HOME</div> }));
vi.mock('./routes/SettingsView', () => ({ SettingsView: () => <div>SETTINGS SCREEN</div> }));
vi.mock('./routes/TemplatesView', () => ({ TemplatesView: () => <div>TEMPLATES SCREEN</div> }));
vi.mock('./screens/KinTaleTemplates', () => ({
  KinTaleTemplates: () => <div>KINTALE TEMPLATES SCREEN</div>,
}));
// #2200 / #2201: the four money, marketing and audit screens.
vi.mock('./screens/ActivityLog', () => ({ ActivityLog: () => <div>ACTIVITY LOG SCREEN</div> }));
vi.mock('./routes/InvoicesView', () => ({ InvoicesView: () => <div>INVOICES SCREEN</div> }));
vi.mock('./screens/CoveragePackageBuilder', () => ({
  CoveragePackageBuilder: () => <div>PACKAGES SCREEN</div>,
}));
vi.mock('./screens/MarketingBlasts', () => ({
  MarketingBlasts: () => <div>MARKETING BLASTS SCREEN</div>,
}));

const USER = { uid: 'uid-staff', email: 'e2e-admin@tribetails.com', displayName: 'Auntie' };
const OWNER_CLAIMS = { admin: true };
const AUNTIE_CLAIMS = { staffRole: 'auntie' };
// A minting mistake; the gate degrades it to the Auntie (lib/access.ts).
const DOUBLE_CLAIMS = { admin: true, staffRole: 'auntie' };
const TEST_ADMIN_CLAIMS = { testTribeId: 'tribe-sandbox' };

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
async function boot(path: string, claims: Record<string, unknown>) {
  getIdTokenResult.mockResolvedValue({ claims });
  currentUser = USER;
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
async function settleRouter(): Promise<void> {
  if (!lastRouter) return;
  const router = lastRouter;
  await waitFor(() => expect(router.state.status).toBe('idle'));
}

/** Exact rail names, so "KinTale templates" can neither satisfy nor trip "Templates". */
function railLink(name: string) {
  return screen.queryByRole('link', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  authListeners.clear();
  useCollection.mockReturnValue({ status: 'loading' });
  currentUser = null;
});
afterEach(async () => {
  await settleRouter();
  lastRouter = undefined;
  dropBootedOnlineListeners();
  window.history.replaceState(null, '', '/');
});

const OWNER_SCREEN_ADDRESSES = [
  '/settings',
  '/settings?section=notifications',
  '/templates',
  '/templates?template=new',
  '/template-bank',
  '/template-assignment',
  '/notification-gate',
];

describe('#2163 an Auntie never reaches Settings or Templates', () => {
  it('shows her no Settings and no Templates rail entry, and keeps KinTale templates', async () => {
    await boot('/home', AUNTIE_CLAIMS);
    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    expect(railLink('Home')).not.toBeNull();
    expect(railLink('Settings')).toBeNull();
    expect(railLink('Templates')).toBeNull();
    expect(railLink('KinTale templates')).not.toBeNull();
  });

  for (const path of OWNER_SCREEN_ADDRESSES) {
    it(`sends her from ${path} to Home`, async () => {
      await boot(path, AUNTIE_CLAIMS);
      await waitFor(() => expect(window.location.pathname).toBe('/home'));
      expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
      expect(screen.queryByText('SETTINGS SCREEN')).toBeNull();
      expect(screen.queryByText('TEMPLATES SCREEN')).toBeNull();
    });
  }

  it('treats a double-claimed account as the Auntie', async () => {
    await boot('/settings', DOUBLE_CLAIMS);
    await waitFor(() => expect(window.location.pathname).toBe('/home'));
    expect(screen.queryByText('SETTINGS SCREEN')).toBeNull();
    expect(railLink('Settings')).toBeNull();
    expect(railLink('Templates')).toBeNull();
  });

  it('still opens KinTale templates for her', async () => {
    await boot('/kintale-templates', AUNTIE_CLAIMS);
    expect(await screen.findByText('KINTALE TEMPLATES SCREEN')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/kintale-templates');
  });
});

describe('#2163 the owner and the test admin are unchanged', () => {
  for (const claims of [OWNER_CLAIMS, TEST_ADMIN_CLAIMS]) {
    const who = claims === OWNER_CLAIMS ? 'owner' : 'test admin';

    it(`shows the ${who} both rail entries`, async () => {
      await boot('/home', claims);
      expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
      expect(railLink('Settings')).not.toBeNull();
      expect(railLink('Templates')).not.toBeNull();
      expect(railLink('KinTale templates')).not.toBeNull();
    });

    it(`opens Settings for the ${who}`, async () => {
      await boot('/settings', claims);
      expect(await screen.findByText('SETTINGS SCREEN')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/settings');
    });

    it(`opens Templates for the ${who}`, async () => {
      await boot('/templates?template=new', claims);
      expect(await screen.findByText('TEMPLATES SCREEN')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/templates');
    });
  }

  for (const path of ['/template-bank', '/template-assignment']) {
    it(`sends the owner from the old ${path} address to Templates`, async () => {
      await boot(path, OWNER_CLAIMS);
      await waitFor(() => expect(window.location.pathname).toBe('/templates'));
      expect(await screen.findByText('TEMPLATES SCREEN')).toBeInTheDocument();
    });
  }

  // The #812 offline entry: the token read failed on the network, so the
  // claims were not read and `access` is null. The guard must not treat that
  // as an Auntie, or an owner on a bad network loses Settings and Templates.
  it('keeps Settings and Templates for the offline session whose claims were not read', async () => {
    const offline = Object.assign(new Error('Failed to fetch'), { code: 'auth/network-request-failed' });
    currentUser = USER;
    window.history.replaceState(null, '', '/settings');
    const { router } = await importRouterTrackingListeners();
    getIdTokenResult.mockRejectedValue(offline);
    lastRouter = router;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // Proof this is the null-access path and not a stale owner token: the
    // shell's degraded banner shows only when the claims were not read.
    expect(await screen.findByText(/Signed in, but out of touch/i)).toBeInTheDocument();
    expect(await screen.findByText('SETTINGS SCREEN')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(railLink('Settings')).not.toBeNull();
    expect(railLink('Templates')).not.toBeNull();
  });

  it('still sends the owner from the old notification-gate address to Settings > Notifications', async () => {
    await boot('/notification-gate', OWNER_CLAIMS);
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(new URLSearchParams(window.location.search).get('section')).toBe('notifications');
    expect(await screen.findByText('SETTINGS SCREEN')).toBeInTheDocument();
  });
});

/**
 * #2200 / #2201, lead ruling 2026-11-13: an Auntie never sees money, and
 * marketing and audit oversight are the owner's. Activity Log, Marketing
 * blasts, Packages and Invoices come off her rail the way Settings and
 * Templates did, and every address for them sends her Home. None of the four
 * has a retired slug (lib/nav.ts `BY_SLUG` holds none), so the addresses are
 * the live paths and the deep-link query strings Invoices takes.
 */
const MONEY_SCREENS = [
  { rail: 'Activity Log', path: '/activity', sentinel: 'ACTIVITY LOG SCREEN' },
  { rail: 'Marketing blasts', path: '/marketing-blasts', sentinel: 'MARKETING BLASTS SCREEN' },
  { rail: 'Packages', path: '/packages', sentinel: 'PACKAGES SCREEN' },
  { rail: 'Invoices', path: '/invoices', sentinel: 'INVOICES SCREEN' },
] as const;

const MONEY_ADDRESSES = [
  '/activity',
  '/marketing-blasts',
  '/packages',
  '/invoices',
  '/invoices?invoiceId=inv-1',
  '/invoices?composeQuoteForKinfolkId=kf-1',
];

function noMoneyScreen(): void {
  for (const s of MONEY_SCREENS) expect(screen.queryByText(s.sentinel)).toBeNull();
}

describe('#2200 / #2201 an Auntie never reaches Activity Log, Marketing blasts, Packages or Invoices', () => {
  it('shows her none of the four rail entries, and keeps her work screens', async () => {
    await boot('/home', AUNTIE_CLAIMS);
    expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    for (const s of MONEY_SCREENS) expect(railLink(s.rail)).toBeNull();
    for (const name of ['Directory', 'KinTales', 'Schedule', 'Bookings', 'Auntie Time', 'Communicate', 'Inbox', 'Notifications']) {
      expect(railLink(name)).not.toBeNull();
    }
  });

  for (const path of MONEY_ADDRESSES) {
    it(`sends her from ${path} to Home`, async () => {
      await boot(path, AUNTIE_CLAIMS);
      await waitFor(() => expect(window.location.pathname).toBe('/home'));
      expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
      noMoneyScreen();
    });
  }

  it('treats a double-claimed account as the Auntie', async () => {
    await boot('/invoices', DOUBLE_CLAIMS);
    await waitFor(() => expect(window.location.pathname).toBe('/home'));
    noMoneyScreen();
    for (const s of MONEY_SCREENS) expect(railLink(s.rail)).toBeNull();
  });
});

describe('#2200 / #2201 the owner and the test admin keep all four', () => {
  for (const claims of [OWNER_CLAIMS, TEST_ADMIN_CLAIMS]) {
    const who = claims === OWNER_CLAIMS ? 'owner' : 'test admin';

    it(`shows the ${who} all four rail entries`, async () => {
      await boot('/home', claims);
      expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
      for (const s of MONEY_SCREENS) expect(railLink(s.rail)).not.toBeNull();
    });

    for (const s of MONEY_SCREENS) {
      it(`opens ${s.rail} for the ${who}`, async () => {
        await boot(s.path, claims);
        expect(await screen.findByText(s.sentinel)).toBeInTheDocument();
        expect(window.location.pathname).toBe(s.path);
      });
    }
  }

  it('keeps the invoice deep link for the owner', async () => {
    await boot('/invoices?invoiceId=inv-1', OWNER_CLAIMS);
    expect(await screen.findByText('INVOICES SCREEN')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/invoices');
    expect(new URLSearchParams(window.location.search).get('invoiceId')).toBe('inv-1');
  });

  it('keeps all four for the offline session whose claims were not read', async () => {
    const offline = Object.assign(new Error('Failed to fetch'), { code: 'auth/network-request-failed' });
    currentUser = USER;
    window.history.replaceState(null, '', '/invoices');
    const { router } = await importRouterTrackingListeners();
    getIdTokenResult.mockRejectedValue(offline);
    lastRouter = router;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Signed in, but out of touch/i)).toBeInTheDocument();
    expect(await screen.findByText('INVOICES SCREEN')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/invoices');
    for (const s of MONEY_SCREENS) expect(railLink(s.rail)).not.toBeNull();
  });
});

/**
 * #2209 review: `lib/nav.ts#ownerOnly` decides the rail and every in-app link
 * (`isOwnerOnlyPath`), while the router guard is a `beforeLoad` written on each
 * route. This pins the two together from the nav side: an entry marked
 * owner-only whose route has no `refuseAuntie` fails here, so the rail can
 * never hide a screen her address still opens.
 */
describe('#2200 / #2201 every owner-only nav entry is guarded in the router', () => {
  const ownerOnly = NAV.filter((e) => e.ownerOnly);

  it('covers the six owner screens and agrees with isOwnerOnlyPath', () => {
    expect(ownerOnly.map((e) => e.slug).sort()).toEqual(
      ['activity', 'invoices', 'marketing-blasts', 'packages', 'settings', 'templates'],
    );
    for (const e of NAV) expect(isOwnerOnlyPath(`/${e.slug}`)).toBe(e.ownerOnly === true);
  });

  for (const e of ownerOnly) {
    it(`sends an Auntie from /${e.slug} to Home`, async () => {
      await boot(`/${e.slug}`, AUNTIE_CLAIMS);
      await waitFor(() => expect(window.location.pathname).toBe('/home'));
      expect(await screen.findByText('ADMIN HOME')).toBeInTheDocument();
    });
  }
});
