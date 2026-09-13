import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { waitForAuthReady } from './lib/auth';
import { resolveAccess, type AdminAccess } from './lib/access';
import {
  getSessionHealth,
  noteRefreshFailure,
  noteRefreshSucceeded,
  subscribeSessionHealth,
} from './lib/sessionHealth';
import { enterReadOnlySession, leaveReadOnlySession } from './lib/readOnlySession';
import { NOTIFICATION_GATE_REDIRECT } from './lib/nav';
import { AppShell } from './components/AppShell';
import { RoutePending } from './components/RoutePending';
import { RouteError } from './components/RouteError';
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
 * Shared chrome: the mocks' ground, behind every screen. Three drifting orbs,
 * and the grain sheet over them.
 *
 * Three orbs, not two, because the ambient wash in every `ui-ideas/*.html` mock
 * and in the shipped MyTribe portal is a three-hue mesh. Two of the three brand
 * hues cannot read as the Tribe palette. The order is the mocks' own: orange,
 * teal, pink, running out from the top-left corner.
 *
 * The grain comes LAST of the four, and markup order is the whole of how it is
 * layered. All four sit at `z-index: -1`, so the one written last paints over
 * the others and still under the screen, which is how the mocks stack them
 * (mesh, then grain, then content). Purely decorative, so aria-hidden; the
 * geometry lives in styles/base.css.
 */
function RootLayout() {
  return (
    <>
      <span className="orb a" aria-hidden="true" />
      <span className="orb b" aria-hidden="true" />
      <span className="orb c" aria-hidden="true" />
      <span className="grain" aria-hidden="true" />
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
 *
 * THREE EXITS, AND THEY MUST STAY THREE (#812). `resolveAccess` calls
 * `getIdTokenResult`, so this one line can fail in two entirely different ways,
 * and until now they shared a single destination: the Sentry crash fallback,
 * which is not a destination at all.
 *
 *   resolves `denied`       the claims were read and they say no. NOT
 *                           PERMITTED. /signin, unchanged.
 *   rejects, `expired`      a refresh failed for a reason retrying cannot fix
 *                           (`lib/sessionHealth.ts` classifies this off the
 *                           Firebase code). Only a re-auth mints a token now,
 *                           so /signin is the honest answer.
 *   rejects, `unreachable`  `auth/network-request-failed`. CANNOT REACH THE
 *                           NETWORK. Admitted, read-only.
 *
 * The third exit must never fall through to /signin, and that is not a
 * preference. `screens/SignIn.tsx` presents a form that cannot be submitted
 * without a network, so bouncing an offline operator there strands them at the
 * one screen guaranteed not to work, and every route they try lands back on it.
 * Worse, signing out is what clears the cached session, which is the only thing
 * still making this app readable at all. A session that is merely out of touch
 * keeps its place.
 *
 * `access` is therefore `AdminAccess | null`, and null means exactly "offline,
 * so the claims were not read this navigation". It is not a third access level
 * and nothing may treat it as one. The residual edge, named rather than left to
 * be found: a Stage 0I test admin entering this way has no `setTestScope` pin,
 * because nothing resolved a `testTribeId` to pin with. No scoped callable can
 * fire regardless (`lib/readOnlySession.ts` refuses all of them while the flag
 * is set), but a direct `onSnapshot` started on this pass would be unscoped,
 * and the sandbox banner is absent until a gate pass succeeds.
 */
async function requireAdmin() {
  const state = await waitForAuthReady();
  if (state.status !== 'signedIn') throw redirect({ to: '/signin' });
  let access: AdminAccess;
  try {
    access = await resolveAccess(state.user);
  } catch (err) {
    // Handed to sessionHealth rather than classified here, so the shell's
    // existing banner says it on this paint instead of a minute from now, and
    // so the retry loop that eventually clears the state starts at the same
    // moment the operator first sees it.
    if (noteRefreshFailure(err) === 'expired') throw redirect({ to: '/signin' });
    enterReadOnlySession();
    return { access: null };
  }
  if (access.status === 'denied') throw redirect({ to: '/signin' });
  // A resolved token is proof the session can mint one, so the degraded state
  // and the banner that explains it both go at the same moment.
  leaveReadOnlySession();
  noteRefreshSucceeded();
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
  // `sessionId` is where an invoice line bound to a visit used to route (#408):
  // a bound line's money is corrected on the visit itself, so the invoice, the
  // composer and the ledger all offer the way here. Since #753 the visit has a
  // route of its own and those links point at it, so this search param survives
  // only to forward the old shape, which is stored in records and in bookmarks.
  validateSearch: optionalIdSearch(['sessionId'] as const),
  // Annotated rather than inferred: TanStack builds a route's `beforeLoad`
  // context from the same object literal that declares `validateSearch`, so the
  // validator's own return type is not available to it yet and `search` widens
  // to `{}`. The annotation is the validator's shape, written once.
  beforeLoad: ({ search }: { search: { sessionId?: string } }) => {
    if (search.sessionId !== undefined) {
      throw redirect({ to: '/sessions/$sessionId', params: { sessionId: search.sessionId } });
    }
  },
  component: lazyRouteComponent(() => import('./routes/SessionsView'), 'SessionsView'),
});

/**
 * ONE Kin Care session, addressable (#753). "KinCares should have their own id
 * numbers in the params. I don't want to refresh the KinCare."
 *
 * The detail was a local-state view of the board, so opening one changed no URL
 * and a refresh, a bookmark, a shared link or browser Back lost it. The param is
 * the `kin_care_sessions` document id, which is the id every other admin surface
 * already names a visit by.
 */
const sessionDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'sessions/$sessionId',
  component: lazyRouteComponent(() => import('./routes/SessionDetailView'), 'SessionDetailView'),
});

const kinTalesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintales',
  // `kinTaleId` opens one report in DETAIL (a kintale notification's "Open").
  // `sessionId` opens the COMPOSER scaffolded from that visit, which is where
  // Auntie Time's "Complete KinTale" button routes (#703): the write-up belongs
  // to a visit, and the composer already takes a `sessionId` to seed a draft
  // from one. Two ids because they name two different things and two different
  // destinations, never one id the view has to guess the meaning of.
  validateSearch: optionalIdSearch(['kinTaleId', 'sessionId'] as const),
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
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, invitesRoute, directoryProfileRoute, householdMembersRoute, bookingsRoute, sessionsRoute, sessionDetailRoute, kinTalesRoute, galleryRoute, templatesRoute, kinTaleTemplatesRoute, tribalIntelRoute, coveragePackagesRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, accountRoute, myNotificationsRoute, notificationGateRoute, vetClinicsRoute, mediaRoute]),
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
  // #812: and what it renders when a route THROWS. Without one, every
  // `beforeLoad` rejection, chiefly a token refresh that cannot reach the
  // network, propagated past the router to `main.tsx`'s Sentry boundary and
  // the operator got a crash page. See RouteError.tsx.
  defaultErrorComponent: RouteError,
});

/**
 * Re-run the gate when a degraded session recovers (#812).
 *
 * `requireAdmin` is the only thing that can leave the read-only state, and it
 * only runs on a navigation. Without this, an operator whose signal came back
 * would sit in a read-only app until they clicked something, and every screen
 * in it would still be refusing callables. `sessionHealth`'s own retry loop is
 * already probing on a backoff, so its transition back to `ok` is the earliest
 * trustworthy news that the network is there; `online` is the browser's own,
 * usually sooner and sometimes wrong, which is why both are wired and neither
 * is trusted alone. `invalidate()` re-runs every committed guard, so the gate
 * re-resolves access, clears the flag, and the shell becomes the real app.
 *
 * Same mechanism as the portal's #539 auth subscription, for the same reason:
 * a fact about the session that arrives without a navigation reaches no guard.
 */
let lastSessionStatus = getSessionHealth().status;
subscribeSessionHealth(() => {
  const status = getSessionHealth().status;
  if (status === lastSessionStatus) return;
  lastSessionStatus = status;
  if (status === 'ok') void router.invalidate();
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void router.invalidate();
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
