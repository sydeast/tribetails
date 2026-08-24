import { useState } from 'react';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { getAuthState, subscribeAuthState, waitForAuthReady, useSignOut } from './lib/auth';
import { clearAccess, ensureAccess, type AccessState } from './lib/activeTribe';
// O-26: every screen below is code-split via lazyRouteComponent (each
// resolves to its own chunk at build time) instead of a static import here —
// the single main bundle had grown to 348KB gz (from 204KB at S3) once
// booking wizard + TipTap + Messages + push all landed in one session, all
// paid on first load regardless of which screen a kinfolk actually opened.
// SignIn stays static: it's the very first thing an unauthenticated visitor
// needs, splitting it would just add a network round-trip before anyone can
// even see the sign-in form. AccountError below is also static — it's a tiny
// wrapper, not worth its own chunk.
import { SignIn } from './screens/SignIn';
import { LaunchError } from './screens/LaunchError';
import { SessionNotice } from './components/SessionNotice';

/**
 * Shared chrome: the two drifting orbs behind every screen, and the session
 * notice.
 *
 * The notice lives HERE rather than in PortalNav because the portal has no
 * layout route — every screen renders its own nav, and several (the claim
 * flow, SecureReset, LaunchError) render none at all. The root layout is the
 * one component every route passes through, which is the only place a fact
 * about the whole session can be told once. It renders nothing while the
 * session is healthy, so signed-out screens are untouched.
 */
function RootLayout() {
  return (
    <>
      <span className="orb a" aria-hidden="true" />
      <span className="orb b" aria-hidden="true" />
      <SessionNotice />
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
 * an operator with none picked yet -> Pick, otherwise falls through with
 * activeKinfolkId already set (single-tribe autopick or a prior pick restored
 * from sessionStorage).
 *
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": a non-operator with
 * 2+ ids is a data defect (the ruling says this can't happen), not a routing
 * case, and it's routed to the dead-end /error screen rather than falling
 * through to /home. It CANNOT fall through here the way access.error above
 * does: unlike a genuine access-fetch failure, the backend is healthy for
 * this account, and every kinfolkId-scoped callable (getMyHome included)
 * falls back server-side to the caller's first linked id when kinfolkId is
 * omitted (resolveKinfolkAccess.ts) — so a screen that fires such a query
 * with no id resolved would silently render a real, wrong household instead
 * of failing. Redirecting away is what keeps that query from ever firing.
 */
async function requireActiveTribe() {
  await requireSignedIn();
  const access = await ensureAccess();
  if (access.error !== null) return; // let the screen's own query surface the error via LaunchError
  if (access.kinfolkIds.length === 0) throw redirect({ to: '/no-tribes' });
  if (!access.isOperator && access.kinfolkIds.length >= 2) throw redirect({ to: '/error' }); // data defect, see doc comment above
  if (access.activeKinfolkId === null) throw redirect({ to: '/pick' });
}

/**
 * Where a non-operator who lands on /pick should go instead of seeing the
 * screen. Pure so it's testable without a router harness. `null` means "stay"
 * (operators always stay — they see the directory even with 1 id — and an
 * access-fetch failure is left alone, unrelated to this gate).
 *
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": the 2+ case goes to
 * '/error', same destination and same reasoning as requireActiveTribe's doc
 * comment above — not '/home', which would fire the very query this whole
 * gate exists to prevent.
 */
export function pickGuardRedirect(access: AccessState): '/home' | '/no-tribes' | '/error' | null {
  if (access.error !== null) return null;
  if (access.isOperator) return null;
  if (access.kinfolkIds.length === 0) return '/no-tribes';
  if (access.kinfolkIds.length >= 2) return '/error';
  return '/home'; // exactly 1
}

async function requireOperatorForPick() {
  await requireSignedIn();
  const access = await ensureAccess();
  const target = pickGuardRedirect(access);
  if (target !== null) throw redirect({ to: target });
}

const pickRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pick',
  beforeLoad: requireOperatorForPick,
  component: lazyRouteComponent(() => import('./screens/TribePicker'), 'TribePicker'),
});

/**
 * Dead end for account states no screen should ever mount past — currently
 * only the 2+-tribe non-operator data defect (ruling 2026-08-06, "one
 * kinfolk, one tribe"; ensureAccess already logged the anomaly and refused
 * to resolve an activeKinfolkId for it, see lib/activeTribe.ts). Reuses the
 * existing LaunchError presentation as-is — it's pure/presentational, no
 * query of its own. Retry clears the cached access and re-navigates to
 * /home: an account that's since been fixed (e.g. the duplicate link was
 * removed) lands there via the normal guard; one that's still broken bounces
 * straight back here.
 */
function AccountError() {
  const navigate = useNavigate();
  const { signOut, signingOut } = useSignOut();
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    setRetrying(true);
    clearAccess();
    await ensureAccess();
    await navigate({ to: '/home' });
    setRetrying(false);
  }

  return <LaunchError onRetry={() => void handleRetry()} retrying={retrying} onSignOut={signOut} signingOut={signingOut} />;
}

const errorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/error',
  beforeLoad: requireSignedIn,
  component: AccountError,
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

/**
 * Everything /schedule/book reads out of the URL, which is one boolean.
 *
 * "Set up a recurring visit" (Schedule.tsx) starts the wizard pre-set to the
 * Weekly pattern via `?weekly=1` (BookingWizardProps.startWeekly), rather than
 * needing a second route for the same screen.
 *
 * #545: this is also the reason no URL can put a household on a wizard step
 * they should not be on. The wizard's step is component state and is not
 * addressable at all, and this validator returns a fresh object holding ONLY
 * `weekly` — an unknown key such as `?step=4` is not passed through, it is
 * dropped. Exported so router.test.ts can hold that line.
 */
export function bookingWizardSearch(search: Record<string, unknown>): { weekly: boolean } {
  return { weekly: search['weekly'] === '1' || search['weekly'] === true };
}

const bookingWizardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedule/book',
  beforeLoad: requireActiveTribe,
  validateSearch: bookingWizardSearch,
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
// #399 item 1: the destination the Tribe hub's "All photos" never had.
const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gallery',
  beforeLoad: requireActiveTribe,
  component: lazyRouteComponent(() => import('./screens/Gallery'), 'Gallery'),
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
  errorRoute,
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
  galleryRoute,
  tribeEditRoute,
  accountRoute,
  notificationSettingsRoute,
]);

export const router = createRouter({ routeTree });

/**
 * #539: make the route guards react to the session ending, instead of waiting
 * to be asked.
 *
 * Every `beforeLoad` above is an authorization check, and until now all of them
 * ran only when somebody navigated. A session that ended WITHOUT a navigation
 * therefore reached no guard at all: the authenticated screen already on
 * display simply stayed on display, and sign-out relied on a full page reload
 * to sweep it away — a reload that is the last line of a function with network
 * calls above it (see lib/auth.ts). Until it arrived, or if it never did, the
 * previous kinfolk's household was still on screen and still one back button
 * away. That is #539.
 *
 * `invalidate()` marks every committed match stale and re-runs it, guards
 * included. For a signed-out session that means `requireSignedIn` throws its
 * redirect, and TanStack commits redirects with `replace: true` — so the
 * authenticated URL is not merely left behind, it is overwritten in the history
 * entry it occupied, leaving nothing to come forward to either.
 *
 * The popstate path itself was already sound and is deliberately untouched:
 * TanStack re-runs `beforeLoad` on every history entry it re-enters, which
 * signOutSession.test.tsx measures rather than assumes. This closes the case
 * that had no navigation in it.
 *
 * Only on the transition INTO signedOut. Invalidating on sign-in would re-run
 * every guard underneath a screen the sign-in flow is already navigating away
 * from, and the boot transition (loading -> signedIn) would pay for a second
 * pass over guards that have not finished their first.
 */
let lastAuthStatus = getAuthState().status;
subscribeAuthState(() => {
  const status = getAuthState().status;
  if (status === lastAuthStatus) return;
  lastAuthStatus = status;
  if (status === 'signedOut') void router.invalidate();
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
