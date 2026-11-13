import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { waitForAuthReady } from './lib/auth';
import { signInSearch, signInSearchFor } from './lib/signInRedirect';
import { isAuntieAccess, resolveAccess, type AdminAccess } from './lib/access';
import {
  getSessionHealth,
  noteRefreshFailure,
  noteRefreshSucceeded,
  subscribeSessionHealth,
} from './lib/sessionHealth';
import { enterReadOnlySession, leaveReadOnlySession } from './lib/readOnlySession';
import { NOTIFICATION_GATE_REDIRECT, navTitle } from './lib/nav';
import { NOT_FOUND_TITLE, useRouteTitle } from './lib/pageTitle';
import { AppShell } from './components/AppShell';
import { RoutePending } from './components/RoutePending';
import { RouteError } from './components/RouteError';
import { AdminNotFound, SignedOutNotFound } from './components/NotFound';
import { QueuedWritesBanner } from './components/QueuedWritesBanner';
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
  // #2007: the browser tab names the screen. One writer for the whole app; see
  // lib/pageTitle.ts.
  useRouteTitle();
  return (
    <>
      <span className="orb a" aria-hidden="true" />
      <span className="orb b" aria-hidden="true" />
      <span className="orb c" aria-hidden="true" />
      <span className="grain" aria-hidden="true" />
      <Outlet />
      {/* #807: the writes Firestore is holding while the device is offline.
          Mounted at the ROOT rather than on the admin layout, because a queued
          write outlives the screen that made it and has to stay visible while
          the operator moves on. Renders nothing when the queue is empty, which
          is almost always. */}
      <QueuedWritesBanner />
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
  staticData: { title: 'Sign in' },
  // #1384: `redirect` is the location the guard turned the operator away from.
  validateSearch: signInSearch,
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
async function requireAdmin(ctx: { location: Parameters<typeof signInSearchFor>[0] }) {
  const { location } = ctx;
  // #1845 reads the router's `matches` too, off the same object but kept out of
  // the declared parameter: declaring it makes TypeScript resolve the router's
  // own match type while inferring the route tree, a cycle (TS7022).
  const matches: unknown = (ctx as { matches?: unknown }).matches;
  // #1384: every /signin bounce below carries where the operator was going.
  const toSignIn = () => redirect({ to: '/signin', search: signInSearchFor(location) });
  const state = await waitForAuthReady();
  if (state.status !== 'signedIn') {
    // #1845: an address no screen owns is not a screen to sign in for. The
    // visitor gets the root's not-found card, with a way to sign in on it,
    // rather than a sign-in that lands on nothing. Only the signed-out exit:
    // a denied or expired session still goes to /signin, below.
    if (isNotFoundMatch(matches)) throw notFound();
    throw toSignIn();
  }
  let access: AdminAccess;
  try {
    access = await resolveAccess(state.user);
  } catch (err) {
    // Handed to sessionHealth rather than classified here, so the shell's
    // existing banner says it on this paint instead of a minute from now, and
    // so the retry loop that eventually clears the state starts at the same
    // moment the operator first sees it.
    if (noteRefreshFailure(err) === 'expired') throw toSignIn();
    enterReadOnlySession();
    return { access: null };
  }
  if (access.status === 'denied') throw toSignIn();
  // A resolved token is proof the session can mint one, so the degraded state
  // and the banner that explains it both go at the same moment.
  leaveReadOnlySession();
  noteRefreshSucceeded();
  return { access };
}

/**
 * Guard for the owner's screens (#2163, operator ruling 2026-11-13: "auntie
 * user level cannot see templates or business settings"; #2200 / #2201 added
 * Packages, Invoices, Marketing blasts and Activity Log). An Auntie who
 * reaches one by any address, the retired ones included, is sent Home; the
 * rail already shows her none of them (`lib/nav.ts#ownerOnly`).
 *
 * Reads the access the admin layout's `requireAdmin` already resolved, so it
 * costs no second token read. `null` (the #812 offline entry) is let through,
 * as everywhere else: the claims were not read, and the server refuses her
 * Settings writes and Templates reads regardless.
 *
 * The parameter is annotated, not inferred, for the TS7022 reason the
 * `sessionsRoute` comment below gives.
 */
function refuseAuntie({ context }: { context: { access?: AdminAccess | null } }) {
  if (isAuntieAccess(context.access)) throw redirect({ to: '/home' });
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
  staticData: { title: navTitle('home') },
  component: lazyRouteComponent(() => import('./screens/Home'), 'Home'),
});

const featureFlagsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'feature-flags',
  staticData: { title: navTitle('featureFlags') },
  component: lazyRouteComponent(() => import('./screens/FeatureFlags'), 'FeatureFlags'),
});

const activityRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'activity',
  staticData: { title: navTitle('activity') },
  // #2201: reading the log is audit oversight, the owner's.
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(() => import('./screens/ActivityLog'), 'ActivityLog'),
});

const notificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notifications',
  staticData: { title: navTitle('notifications') },
  component: lazyRouteComponent(() => import('./routes/NotificationsView'), 'NotificationsView'),
});

const formSchemasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'form-schemas',
  staticData: { title: navTitle('formSchemas') },
  component: lazyRouteComponent(() => import('./routes/FormSchemasView'), 'FormSchemasView'),
});

const invoicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invoices',
  staticData: { title: navTitle('invoices') },
  validateSearch: optionalIdSearch(['invoiceId', 'composeQuoteForKinfolkId'] as const),
  // #2200: money. Her deep links (`?invoiceId=`, `?composeQuoteForKinfolkId=`)
  // land Home with the bare address.
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(() => import('./routes/InvoicesView'), 'InvoicesView'),
});

const directoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory',
  staticData: { title: navTitle('directory') },
  // `tab=kin` opens the Kin tab; `inCare=1` narrows it to the pets Home's "Kin
  // in care" card counts (#1601).
  validateSearch: optionalIdSearch(['tab', 'inCare'] as const),
  component: lazyRouteComponent(() => import('./routes/DirectoryView'), 'DirectoryView'),
});

// Every household's invites in one list. Distinct from
// `/household-members/$kinfolkId` below, which is the same data for ONE
// household plus the controls that act on it. This one is read-only and
// admin-wide, and each of its cards links into that household-scoped screen.
const invitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invites',
  staticData: { title: navTitle('invites') },
  component: lazyRouteComponent(() => import('./screens/Invites'), 'Invites'),
});

// One invite (#1339). The `invite.auntie-notify` email links here as
// `${AUNTIE_OS_REVIEW_BASE_URL}/invites/<inviteId>`; the admin layout is
// path-less, so that base URL is the bare admin origin.
const inviteDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invites/$inviteId',
  staticData: { title: navTitle('invites') },
  component: lazyRouteComponent(() => import('./routes/InviteDetailView'), 'InviteDetailView'),
});

const directoryProfileRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory/$kinfolkId',
  staticData: { title: navTitle('directory') },
  // #1003: the `invoice.payment.unapplied` notice lands here with
  // `?section=unapplied-payments&paymentId=...`, which opens the Account credit
  // panel's "Payments needing a decision" list and that payment's dialog.
  // `view` is the profile's sub-view (#1594): `household` or `edit`.
  validateSearch: optionalIdSearch(['section', 'paymentId', 'view'] as const),
  component: lazyRouteComponent(
    () => import('./routes/DirectoryProfileView'),
    'DirectoryProfileView',
  ),
});

const householdMembersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'household-members/$kinfolkId',
  staticData: { title: navTitle('householdMembers') },
  component: lazyRouteComponent(
    () => import('./routes/HouseholdMembersView'),
    'HouseholdMembersView',
  ),
});

const bookingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'bookings',
  staticData: { title: navTitle('bookings') },
  // `kinRemoval=<request id>` is where a "Kinfolk asked to remove a Kin" notice
  // opens: the removal queue on this screen, already unfolded (#1912).
  validateSearch: optionalIdSearch(['bookingId', 'kinRemoval'] as const),
  component: lazyRouteComponent(() => import('./routes/BookingsView'), 'BookingsView'),
});

const sessionsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'sessions',
  staticData: { title: navTitle('sessions') },
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
  staticData: { title: navTitle('sessions') },
  component: lazyRouteComponent(() => import('./routes/SessionDetailView'), 'SessionDetailView'),
});

const kinTalesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintales',
  staticData: { title: navTitle('kintales') },
  // `range` is the list's date window (7d / 30d / 90d / all). Home's "KinTales
  // to review" card and its pending rows send `all`, because the drafts Home
  // counts are not limited to the last week (#1601).
  // `kinTaleId` opens one report in DETAIL (a kintale notification's "Open").
  // `sessionId` opens the COMPOSER scaffolded from that visit, which is where
  // Auntie Time's "Send the KinTale" button routes (#703, #2123): the write-up belongs
  // to a visit, and the composer already takes a `sessionId` to seed a draft
  // from one. Two ids because they name two different things and two different
  // destinations, never one id the view has to guess the meaning of.
  validateSearch: optionalIdSearch(['kinTaleId', 'sessionId', 'range'] as const),
  component: lazyRouteComponent(() => import('./routes/KinTalesView'), 'KinTalesView'),
});

const galleryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'gallery',
  staticData: { title: navTitle('gallery') },
  component: lazyRouteComponent(() => import('./screens/Gallery'), 'Gallery'),
});

const templatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'templates',
  staticData: { title: navTitle('templates') },
  // `template` is the open editor (#1594): a template id, or `new`. Absent is the bank.
  validateSearch: optionalIdSearch(['template'] as const),
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(() => import('./routes/TemplatesView'), 'TemplatesView'),
});

// The retired standalone Template Bank and Template assignment addresses. Both
// were folded into the two-tab Templates screen, and `lib/nav.ts` has always
// mapped their slugs there, but the router never registered them, so they
// fell to the not-found card. Redirect-only, like `/notification-gate`: the
// owner lands on Templates, and an Auntie Home (#2163).
const templateBankRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'template-bank',
  beforeLoad: (ctx: { context: { access?: AdminAccess | null } }) => {
    refuseAuntie(ctx);
    throw redirect({ to: '/templates' });
  },
});

const templateAssignmentRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'template-assignment',
  beforeLoad: (ctx: { context: { access?: AdminAccess | null } }) => {
    refuseAuntie(ctx);
    throw redirect({ to: '/templates' });
  },
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
  staticData: { title: navTitle('kinTaleTemplates') },
  component: lazyRouteComponent(() => import('./screens/KinTaleTemplates'), 'KinTaleTemplates'),
});

const tribalIntelRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tribal-intel',
  staticData: { title: navTitle('trainingDocs') },
  component: lazyRouteComponent(() => import('./screens/TribalIntel'), 'TribalIntel'),
});

const coveragePackagesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'packages',
  staticData: { title: navTitle('coveragePackages') },
  // #2200: Packages prices visits, which is money.
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(
    () => import('./screens/CoveragePackageBuilder'),
    'CoveragePackageBuilder',
  ),
});

const scheduleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'schedule',
  staticData: { title: navTitle('schedule') },
  component: lazyRouteComponent(() => import('./screens/Schedule'), 'Schedule'),
});

const inboxRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'inbox',
  staticData: { title: navTitle('inbox') },
  component: lazyRouteComponent(() => import('./screens/Inbox'), 'Inbox'),
});

const settingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  staticData: { title: navTitle('settings') },
  // `section` seeds which panel opens first (`?section=notifications`). The
  // only caller today is the `/notification-gate` redirect below (#718); a
  // plain visit to `/settings` carries none and opens Settings' own default.
  validateSearch: optionalIdSearch(['section'] as const),
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(() => import('./routes/SettingsView'), 'SettingsView'),
});

const communicateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'communicate',
  staticData: { title: navTitle('communicate') },
  // `draftId` opens one stored `generated_drafts` doc in Personalize for
  // review, send or delete (#1563). It is where KinTales > Drafts and Home's
  // "KinTales pending" rows land; without it every stored draft was stranded.
  validateSearch: optionalIdSearch(['draftId'] as const),
  component: lazyRouteComponent(() => import('./routes/CommunicateView'), 'CommunicateView'),
});

// Scheduled campaigns: Communicate's sibling, the same act at a later time.
const marketingBlastsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'marketing-blasts',
  staticData: { title: navTitle('marketingBlasts') },
  // #2201: marketing is the owner's.
  beforeLoad: refuseAuntie,
  component: lazyRouteComponent(() => import('./screens/MarketingBlasts'), 'MarketingBlasts'),
});

// AccountRouteView (not Account) so the screen's "Open my notification
// settings" control is a live button that lands on /my-notifications. Mounting
// Account bare left that control as a dead static span, which is how the
// operator's own notification settings became unreachable except by URL.
const accountRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'account',
  staticData: { title: navTitle('accountSettings') },
  component: lazyRouteComponent(() => import('./screens/Account'), 'AccountRouteView'),
});

const myNotificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'my-notifications',
  staticData: { title: navTitle('myNotifications') },
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
  beforeLoad: (ctx: { context: { access?: AdminAccess | null } }) => {
    refuseAuntie(ctx);
    throw redirect(NOTIFICATION_GATE_REDIRECT);
  },
});

const vetClinicsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'vet-clinics',
  staticData: { title: navTitle('vetClinics') },
  component: lazyRouteComponent(() => import('./screens/VetClinics'), 'VetClinics'),
});

const mediaRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'media/$type/$id',
  staticData: { title: navTitle('mediaGallery') },
  component: lazyRouteComponent(() => import('./routes/MediaView'), 'MediaView'),
});

/**
 * Every address no screen owns (#1845), signed in. A catch-all under the admin
 * layout rather than only a router default, because the default renders at the
 * root, outside the shell: the operator would lose the rail, which is the way
 * to every screen. Ranked below every real path, so it shadows none of them;
 * `/invoices/garbage` lands here too. Signed out, `requireAdmin` sends this one
 * route to the root's not-found card instead of to sign-in.
 */
const ADMIN_NOT_FOUND_ROUTE_ID = '/admin/$';
function isNotFoundMatch(matches: unknown): boolean {
  return (
    Array.isArray(matches) &&
    matches.some((m: unknown) => (m as { routeId?: unknown } | null)?.routeId === ADMIN_NOT_FOUND_ROUTE_ID)
  );
}
const adminNotFoundRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '$',
  staticData: { title: NOT_FOUND_TITLE },
  component: AdminNotFound,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, invitesRoute, inviteDetailRoute, directoryProfileRoute, householdMembersRoute, bookingsRoute, sessionsRoute, sessionDetailRoute, kinTalesRoute, galleryRoute, templatesRoute, templateBankRoute, templateAssignmentRoute, kinTaleTemplatesRoute, tribalIntelRoute, coveragePackagesRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, marketingBlastsRoute, accountRoute, myNotificationsRoute, notificationGateRoute, vetClinicsRoute, mediaRoute, adminNotFoundRoute]),
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
  // #1845: and what it renders for an address nothing owns when the admin
  // layout is not in play (signed out; see `adminNotFoundRoute`). Without one
  // the library painted a bare "Not Found" in the corner of an empty page.
  defaultNotFoundComponent: SignedOutNotFound,
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
