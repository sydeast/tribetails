import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { waitForAuthReady } from './lib/auth';
import { ensureAccess } from './lib/activeTribe';
// O-26: every screen below is code-split via lazyRouteComponent (each
// resolves to its own chunk at build time) instead of a static import here —
// the single main bundle had grown to 348KB gz (from 204KB at S3) once
// booking wizard + TipTap + Messages + push all landed in one session, all
// paid on first load regardless of which screen a kinfolk actually opened.
// SignIn stays static: it's the very first thing an unauthenticated visitor
// needs, splitting it would just add a network round-trip before anyone can
// even see the sign-in form.
import { SignIn } from './screens/SignIn';

/** Shared chrome: the two drifting orbs behind every screen. */
function RootLayout() {
  return (
    <>
      <span className="orb a" aria-hidden="true" />
      <span className="orb b" aria-hidden="true" />
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const state = await waitForAuthReady();
    throw redirect({ to: state.status === 'signedIn' ? '/home' : '/signin' });
  },
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  component: SignIn,
});

const claimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/claim',
  component: lazyRouteComponent(() => import('./screens/ClaimInvite'), 'ClaimInvite'),
});

/** Legacy path form /claim/<id> from older invite emails. */
const claimIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/claim/$inviteId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/claim', search: { invite: params.inviteId } });
  },
});

const secureResetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/secure-reset',
  component: lazyRouteComponent(() => import('./screens/SecureReset'), 'SecureReset'),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/home',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Home'), 'Home'),
});

/** Shared auth guard for every signed-in-only screen below. */
async function requireSignedIn() {
  const state = await waitForAuthReady();
  if (state.status !== 'signedIn') throw redirect({ to: '/signin' });
}

/**
 * Guard for every screen that needs a resolved active tribe (everything past
 * the picker). Mirrors Kotlin's resolveLaunchDestination: 0 tribes -> NoTribes,
 * operator or 2+ tribes with none picked yet -> Pick, otherwise falls through
 * with activeKinfolkId already set (single-tribe autopick or a prior pick
 * restored from sessionStorage).
 */
async function requireActiveTribe() {
  await requireSignedIn();
  const access = await ensureAccess();
  if (access.error !== null) return; // let the screen's own query surface the error via LaunchError
  if (access.kinfolkIds.length === 0) throw redirect({ to: '/no-tribes' });
  if (access.activeKinfolkId === null) throw redirect({ to: '/pick' });
}

const pickRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pick',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./screens/TribePicker'), 'TribePicker'),
});

const noTribesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/no-tribes',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./screens/NoTribes'), 'NoTribes'),
});

const scheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedule',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Schedule'), 'Schedule'),
});

/**
 * Booking drill-in (B3, punchlist item): the "tap a visit" destination the
 * cancellation and note actions need. Declared before /schedule/book below so
 * a reader sees "/schedule -> its children" in path order; TanStack Router
 * itself doesn't care about declaration order for static vs dynamic segments.
 */
const bookingDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedule/$visitId',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/BookingDetail'), 'BookingDetail'),
});

const bookingWizardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedule/book',
  beforeLoad: requireActiveTribe,
  // "Set up a recurring visit" (Schedule.tsx) starts the wizard pre-set to
  // the Weekly pattern via ?weekly=1 (BookingWizardProps.startWeekly), rather
  // than needing a second route for the same screen.
  validateSearch: (search: Record<string, unknown>): { weekly: boolean } => ({
    weekly: search['weekly'] === '1' || search['weekly'] === true,
  }),
  // BookingWizardRoute (the search-aware wrapper) lives in screens/BookingWizard.tsx
  // itself, not inlined here, so this dynamic import pulls the whole chunk in one piece.
  component: lazyRouteComponent(() => import('./screens/BookingWizard'), 'BookingWizardRoute'),
});

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Messages'), 'Messages'),
});

const kinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kin',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Kin'), 'Kin'),
});

/**
 * Declared before `/kin/$kinId` below: TanStack Router matches a static
 * path segment ("new") before a dynamic one ("$kinId") regardless of
 * declaration order, but this ordering keeps the file reading the way the
 * routes resolve.
 */
const kinNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kin/new',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/KinAdd'), 'KinAdd'),
});

const kinDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kin/$kinId',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/KinDetail'), 'KinDetail'),
});

const kinEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kin/$kinId/edit',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/KinEdit'), 'KinEdit'),
});

const kinTalesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kintales',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/KinTales'), 'KinTales'),
});

const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invoices',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Invoices'), 'Invoices'),
});

const invoiceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invoices/$invoiceId',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/InvoiceDetail'), 'InvoiceDetail'),
});

const tribeHubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tribe',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/TribeHub'), 'TribeHub'),
});

const tribeEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tribe/edit',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/TribeProfile'), 'TribeProfile'),
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Account'), 'Account'),
});

const notificationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/notifications',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/NotificationSettings'), 'NotificationSettings'),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  claimRoute,
  claimIdRoute,
  secureResetRoute,
  pickRoute,
  noTribesRoute,
  homeRoute,
  scheduleRoute,
  bookingDetailRoute,
  bookingWizardRoute,
  messagesRoute,
  kinRoute,
  kinNewRoute,
  kinDetailRoute,
  kinEditRoute,
  kinTalesRoute,
  invoicesRoute,
  invoiceDetailRoute,
  tribeHubRoute,
  tribeEditRoute,
  accountRoute,
  notificationSettingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
