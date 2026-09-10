import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { waitForAuthReady } from './lib/auth';
import { resolveAccess } from './lib/access';
import { NOTIFICATION_GATE_REDIRECT } from './lib/nav';
import { AppShell } from './components/AppShell';
import { RoutePending } from './components/RoutePending';
// Every admin screen below is code-split via lazyRouteComponent (each resolves
// to its own chunk at build time) instead of being imported here. The single
// bundle had reached 1,666 KB: the whole app, all 26 routes and the Firebase
// SDK, downloaded before first paint by an operator who was about to open one
// screen. MyTribe/web made this move first (`mytribe/web/src/router.tsx`,
// note O-26) and this is the same mechanism against the same defect.
//
// TWO THINGS STAY STATIC, both on purpose:
//   SignIn    the first thing an unauthenticated visitor needs. Splitting it
//             would put a network round trip in front of the sign-in form.
//   AppShell  the nav rail and the outlet. It is on every admin route, so a
//             chunk of its own would be a second blocking request for a
//             guaranteed dependency, and the rail is what the pending state
//             renders INSIDE.
//
// Routes that are more than one screen (a list plus its editor, a search-param
// adapter) live in `./routes/`. They have to be separate modules rather than
// small functions in this file: an adapter defined here would import its
// screens at the top of this file and put them straight back in the entry
// chunk, which is exactly the split we are making. See `src/routes/README.md`.
import { SignIn } from './screens/SignIn';

/**
 * Search-param validator for the deep links the Notifications feed emits.
 *
 * Keeps only the listed keys, and only when they are non-blank strings.
 * Deliberately NON-THROWING: a hand-edited or stale URL should land the
 * operator on the plain list, not on a router error boundary, and a screen that
 * receives no id already renders correctly (that is its normal state).
 */
function optionalIdSearch<K extends string>(keys: readonly K[]) {
  return (raw: Record<string, unknown>): Partial<Record<K, string>> => {
    const out: Partial<Record<K, string>> = {};
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim() as never;
    }
    return out;
  };
}

/**
 * Shared chrome: the three drifting orbs behind every screen (Den background).
 *
 * Three, not two, because the ambient wash in all 39 `ui-ideas/*.html` mocks and
 * in the shipped MyTribe portal is a purple / orange / teal triad. Two of the
 * three brand hues cannot read as the Tribe palette. Purely decorative, so
 * aria-hidden; the drift and the blend live in styles/base.css.
 */
function RootLayout() {
  return (
    <>
      <span className="orb a" aria-hidden="true" />
      <span className="orb b" aria-hidden="true" />
      <span className="orb c" aria-hidden="true" />
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

/**
 * Guard for the whole admin layout: signed in AND access is not `denied`. A
 * signed-in non-admin is bounced to /signin, where the component signs the stale
 * session out. Runs once at the layout level, so every child screen is protected.
 */
async function requireAdmin() {
  const state = await waitForAuthReady();
  if (state.status !== 'signedIn') throw redirect({ to: '/signin' });
  const access = await resolveAccess(state.user);
  if (access.status === 'denied') throw redirect({ to: '/signin' });
  return { access };
}

/** Path-less layout route: renders AppShell (nav rail + <Outlet/>) around its children. */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin',
  beforeLoad: requireAdmin,
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'home',
  component: lazyRouteComponent(() => import('./screens/Home'), 'Home'),
});

const featureFlagsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'feature-flags',
  component: lazyRouteComponent(() => import('./screens/FeatureFlags'), 'FeatureFlags'),
});

const activityRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'activity',
  component: lazyRouteComponent(() => import('./screens/ActivityLog'), 'ActivityLog'),
});

const notificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notifications',
  component: lazyRouteComponent(() => import('./routes/NotificationsView'), 'NotificationsView'),
});

const formSchemasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'form-schemas',
  component: lazyRouteComponent(() => import('./routes/FormSchemasView'), 'FormSchemasView'),
});

const invoicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invoices',
  validateSearch: optionalIdSearch(['invoiceId', 'composeQuoteForKinfolkId'] as const),
  component: lazyRouteComponent(() => import('./routes/InvoicesView'), 'InvoicesView'),
});

const directoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory',
  component: lazyRouteComponent(() => import('./screens/Directory'), 'Directory'),
});

// Every household's invites in one list. Distinct from
// `/household-members/$kinfolkId` below, which is the same data for ONE
// household plus the controls that act on it. This one is read-only and
// admin-wide, and each of its cards links into that household-scoped screen.
const invitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invites',
  component: lazyRouteComponent(() => import('./screens/Invites'), 'Invites'),
});

const directoryProfileRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory/$kinfolkId',
  component: lazyRouteComponent(
    () => import('./routes/DirectoryProfileView'),
    'DirectoryProfileView',
  ),
});

const householdMembersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'household-members/$kinfolkId',
  component: lazyRouteComponent(
    () => import('./routes/HouseholdMembersView'),
    'HouseholdMembersView',
  ),
});

const bookingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'bookings',
  validateSearch: optionalIdSearch(['bookingId'] as const),
  component: lazyRouteComponent(() => import('./routes/BookingsView'), 'BookingsView'),
});

const sessionsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'sessions',
  // `sessionId` is where an invoice line bound to a visit routes (#408): a
  // bound line's money is corrected on the visit itself, so the invoice, the
  // composer and the ledger all offer the way here.
  validateSearch: optionalIdSearch(['sessionId'] as const),
  component: lazyRouteComponent(() => import('./routes/SessionsView'), 'SessionsView'),
});

const kinTalesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintales',
  validateSearch: optionalIdSearch(['kinTaleId'] as const),
  component: lazyRouteComponent(() => import('./routes/KinTalesView'), 'KinTalesView'),
});

const galleryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'gallery',
  component: lazyRouteComponent(() => import('./screens/Gallery'), 'Gallery'),
});

const templatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'templates',
  component: lazyRouteComponent(() => import('./screens/Templates'), 'Templates'),
});

/**
 * The KinTale template editor (visit-recap / checklist templates in
 * `kintale_templates`). Distinct from the email `templates` route above; the
 * screen is list + edit in one, so it mounts as a bare route component with no
 * multi-view wrapper.
 */
const kinTaleTemplatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintale-templates',
  component: lazyRouteComponent(() => import('./screens/KinTaleTemplates'), 'KinTaleTemplates'),
});

const tribalIntelRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tribal-intel',
  component: lazyRouteComponent(() => import('./screens/TribalIntel'), 'TribalIntel'),
});

const coveragePackagesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'packages',
  component: lazyRouteComponent(
    () => import('./screens/CoveragePackageBuilder'),
    'CoveragePackageBuilder',
  ),
});

const scheduleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'schedule',
  component: lazyRouteComponent(() => import('./screens/Schedule'), 'Schedule'),
});

const inboxRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'inbox',
  component: lazyRouteComponent(() => import('./screens/Inbox'), 'Inbox'),
});

const settingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  // `section` seeds which panel opens first (`?section=notifications`). The
  // only caller today is the `/notification-gate` redirect below (#718); a
  // plain visit to `/settings` carries none and opens Settings' own default.
  validateSearch: optionalIdSearch(['section'] as const),
  component: lazyRouteComponent(() => import('./routes/SettingsView'), 'SettingsView'),
});

const communicateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'communicate',
  component: lazyRouteComponent(() => import('./screens/Communicate'), 'Communicate'),
});

// AccountRouteView (not Account) so the screen's "Open my notification
// settings" control is a live button that lands on /my-notifications. Mounting
// Account bare left that control as a dead static span, which is how the
// operator's own notification settings became unreachable except by URL.
const accountRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'account',
  component: lazyRouteComponent(() => import('./screens/Account'), 'AccountRouteView'),
});

const myNotificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'my-notifications',
  component: lazyRouteComponent(
    () => import('./screens/MyNotificationsEdit'),
    'MyNotificationsEdit',
  ),
});

// #718: the notification gate is no longer its own screen in the rail or the
// router; it lives only under Settings > Notifications now. This route stays
// registered, redirect-only, so an old rail click, bookmark or shared link
// still lands somewhere instead of 404ing.
const notificationGateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notification-gate',
  beforeLoad: () => {
    throw redirect(NOTIFICATION_GATE_REDIRECT);
  },
});

const vetClinicsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'vet-clinics',
  component: lazyRouteComponent(() => import('./screens/VetClinics'), 'VetClinics'),
});

const mediaRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'media/$type/$id',
  component: lazyRouteComponent(() => import('./routes/MediaView'), 'MediaView'),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, invitesRoute, directoryProfileRoute, householdMembersRoute, bookingsRoute, sessionsRoute, kinTalesRoute, galleryRoute, templatesRoute, kinTaleTemplatesRoute, tribalIntelRoute, coveragePackagesRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, accountRoute, myNotificationsRoute, notificationGateRoute, vetClinicsRoute, mediaRoute]),
]);

export const router = createRouter({
  routeTree,
  // Preload on INTENT (hover / touch-start / keyboard focus of a rail link).
  // This was already set before the screens were split, and it is what makes
  // the split cost nothing on the second click: the rail is 19 links an
  // operator's pointer crosses constantly, so a screen's chunk is usually
  // fetched and parsed before the click lands. Not 'render', which would
  // prefetch all 19 on first paint and rebuild the single bundle out of 19
  // requests; not 'viewport', which for a rail that is entirely on screen is
  // 'render' with extra steps.
  defaultPreload: 'intent',
  // What the outlet renders while a screen's chunk is in flight. Without one
  // the wait is a blank content area beside a live nav rail.
  defaultPendingComponent: RoutePending,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
