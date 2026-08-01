import { useState } from 'react';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { waitForAuthReady } from './lib/auth';
import { resolveAccess } from './lib/access';
import { SignIn } from './screens/SignIn';
import { Home } from './screens/Home';
import { FeatureFlags } from './screens/FeatureFlags';
import { ActivityLog } from './screens/ActivityLog';
import { Notifications } from './screens/Notifications';
import { FormSchemas } from './screens/FormSchemas';
import { Invoices } from './screens/Invoices';
import { Directory } from './screens/Directory';
import { HouseholdMembers } from './screens/HouseholdMembers';
import { Bookings } from './screens/Bookings';
import { Sessions } from './screens/Sessions';
import { KinTales } from './screens/KinTales';
import { Gallery } from './screens/Gallery';
import { Templates } from './screens/Templates';
import { KinTaleTemplates } from './screens/KinTaleTemplates';
import { TribalIntel } from './screens/TribalIntel';
import { Schedule } from './screens/Schedule';
import { CoveragePackageBuilder } from './screens/CoveragePackageBuilder';
import { Inbox } from './screens/Inbox';
import { Settings } from './screens/Settings';
import { Communicate } from './screens/Communicate';
import { AccountRouteView } from './screens/Account';
import { MyNotificationsEdit } from './screens/MyNotificationsEdit';
import { NotificationGate } from './screens/NotificationGate';
import { Media } from './screens/Media';
import { type MediaTargetType } from './lib/mediaScopeFormat';
import { FormSchemaEditor } from './screens/FormSchemaEditor';
import { KinTaleCompose } from './screens/KinTaleCompose';
import { KinTaleDetail } from './screens/KinTaleDetail';
import { AppShell } from './components/AppShell';
import { type NotificationRoute } from './lib/notificationActions';
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
  component: Home,
});

const featureFlagsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'feature-flags',
  component: FeatureFlags,
});

const activityRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'activity',
  component: ActivityLog,
});

/**
 * Performs the navigations the Notifications feed asks for.
 *
 * The feed hands up a `NotificationRoute` from its own tested routing table
 * (`lib/notificationActions.ts`) rather than calling the router itself, so the
 * table stays unit-testable and the screen stays renderable without a router.
 * The cast is the price of a runtime-computed destination: TanStack types
 * `navigate()` against the literal route tree, which cannot express "one of
 * four routes, decided from Firestore data". Every `to` the table can produce
 * is a route registered below, and `notificationActions.test.ts` pins all four.
 */
function NotificationsView() {
  const navigate = useNavigate();
  const go = (route: NotificationRoute) => {
    void navigate(route as unknown as Parameters<typeof navigate>[0]);
  };
  return <Notifications onNavigate={go} />;
}
const notificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notifications',
  component: NotificationsView,
});

function FormSchemasView() {
  const [editor, setEditor] = useState<{ id?: string } | null>(null);
  if (editor) {
    return (
      <FormSchemaEditor
        {...(editor.id ? { schemaId: editor.id } : {})}
        onSaved={() => setEditor(null)}
        onCancel={() => setEditor(null)}
      />
    );
  }
  return <FormSchemas onNew={() => setEditor({})} onSelect={(id) => setEditor({ id })} />;
}

const formSchemasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'form-schemas',
  component: FormSchemasView,
});

/** Adapts `/invoices?invoiceId=&composeQuoteForKinfolkId=` to Invoices' props. */
function InvoicesView() {
  const { invoiceId, composeQuoteForKinfolkId } = invoicesRoute.useSearch();
  return (
    <Invoices
      {...(invoiceId ? { initialInvoiceId: invoiceId } : {})}
      {...(composeQuoteForKinfolkId ? { composeQuoteForKinfolkId } : {})}
    />
  );
}

const invoicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invoices',
  validateSearch: optionalIdSearch(['invoiceId', 'composeQuoteForKinfolkId'] as const),
  component: InvoicesView,
});

const directoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory',
  component: Directory,
});

/**
 * Deep link to ONE household's profile, `/directory/{kinfolkId}`.
 *
 * Directory already owns the profile as a sibling view of its list; this route
 * just opens the list on that view, and closing it navigates back to the bare
 * list so the URL and the screen never disagree. Added for the Schedule detail
 * sheet's kinfolk link (operator issue 16), which needs somewhere real to
 * point: a link to a route that does not exist is worse than no link.
 */
function DirectoryProfileRouteView() {
  const { kinfolkId } = directoryProfileRoute.useParams();
  const navigate = useNavigate();
  return (
    <Directory
      initialKinfolkId={kinfolkId}
      onProfileClose={() => void navigate({ to: '/directory' })}
    />
  );
}

const directoryProfileRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory/$kinfolkId',
  component: DirectoryProfileRouteView,
});

/**
 * B1. `/household-members/{kinfolkId}` — members and invites for ONE household.
 *
 * Its own route rather than a fourth Directory sub-view, because it is the
 * destination of the household profile's "Members and invites" action and has
 * to be linkable on its own. Closing it returns to that household's profile,
 * which is where it was opened from, so the URL and the screen never disagree.
 */
function HouseholdMembersRouteView() {
  const { kinfolkId } = householdMembersRoute.useParams();
  const navigate = useNavigate();
  return (
    <HouseholdMembers
      kinfolkId={kinfolkId}
      onBack={() => void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })}
    />
  );
}

const householdMembersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'household-members/$kinfolkId',
  component: HouseholdMembersRouteView,
});

const bookingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'bookings',
  component: Bookings,
});

const sessionsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'sessions',
  component: Sessions,
});

/**
 * Three-state router wrapper, replacing the old two-state (list/compose)
 * `compose` local state now that the detail/view surface (`KinTaleDetail.tsx`)
 * exists alongside compose/edit (`KinTaleCompose.tsx`):
 *
 *   list      KinTales.tsx, the row feed.
 *   detail    KinTaleDetail.tsx, VIEWING one report: the recap, comment
 *             thread, and reaction. Reached by clicking a row (`onSelect`).
 *   compose   KinTaleCompose.tsx, EDITING (an existing `kinTaleId`) or
 *             starting a brand-new draft (`onNew`, no id).
 *
 * `onSelect` opens DETAIL, not compose: clicking a row in a list is a "view
 * this" gesture (the Inbox.tsx/Sessions.tsx convention for a row click),
 * never an implicit "start editing". Editing is its own explicit affordance,
 * `KinTaleDetail`'s own Edit button, which routes to `compose` carrying the
 * same `kinTaleId`. Both `detail` and `compose` return to `list` on close.
 */
type KinTalesMode =
  | { kind: 'list' }
  | { kind: 'detail'; kinTaleId: string }
  | { kind: 'compose'; kinTaleId?: string };

function KinTalesView() {
  // `/kintales?kinTaleId=<id>` opens straight into DETAIL, the destination of a
  // kintale notification's "Open". Initial state only, so closing the detail
  // returns to the list rather than bouncing back off a stale URL.
  const { kinTaleId } = kinTalesRoute.useSearch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<KinTalesMode>(
    kinTaleId ? { kind: 'detail', kinTaleId } : { kind: 'list' },
  );

  /**
   * Back to the list, and drop `?kinTaleId=` on the way out. Without clearing
   * the search param the URL keeps naming a report the operator has closed, and
   * a reload would reopen it.
   */
  function closeToList() {
    setMode({ kind: 'list' });
    if (kinTaleId) void navigate({ to: '/kintales', search: {} });
  }

  if (mode.kind === 'compose') {
    return (
      <KinTaleCompose
        {...(mode.kinTaleId ? { kinTaleId: mode.kinTaleId } : {})}
        onClose={closeToList}
      />
    );
  }
  if (mode.kind === 'detail') {
    return (
      <KinTaleDetail
        kinTaleId={mode.kinTaleId}
        onEdit={(id) => setMode({ kind: 'compose', kinTaleId: id })}
        onClose={closeToList}
      />
    );
  }
  return (
    <KinTales
      onNew={() => setMode({ kind: 'compose' })}
      onSelect={(id) => setMode({ kind: 'detail', kinTaleId: id })}
    />
  );
}

const kinTalesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintales',
  validateSearch: optionalIdSearch(['kinTaleId'] as const),
  component: KinTalesView,
});


const galleryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'gallery',
  component: Gallery,
});

const templatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'templates',
  component: Templates,
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
  component: KinTaleTemplates,
});

const tribalIntelRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tribal-intel',
  component: TribalIntel,
});

const coveragePackagesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'packages',
  component: CoveragePackageBuilder,
});

const scheduleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'schedule',
  component: Schedule,
});

const inboxRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'inbox',
  component: Inbox,
});

const settingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  component: Settings,
});

const communicateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'communicate',
  component: Communicate,
});

// AccountRouteView (not Account) so the screen's "Open my notification
// settings" control is a live button that lands on /my-notifications. Mounting
// Account bare left that control as a dead static span, which is how the
// operator's own notification settings became unreachable except by URL.
const accountRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'account',
  component: AccountRouteView,
});

const myNotificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'my-notifications',
  component: MyNotificationsEdit,
});

const notificationGateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notification-gate',
  component: NotificationGate,
});

/** Adapts the `media/$type/$id` route params to Media's typed props. */
function MediaRouteView() {
  const { type, id } = mediaRoute.useParams();
  const targetType: MediaTargetType = type === 'household' ? 'household' : 'kin';
  return <Media targetType={targetType} targetId={id} />;
}

const mediaRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'media/$type/$id',
  component: MediaRouteView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, directoryProfileRoute, householdMembersRoute, bookingsRoute, sessionsRoute, kinTalesRoute, galleryRoute, templatesRoute, kinTaleTemplatesRoute, tribalIntelRoute, coveragePackagesRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, accountRoute, myNotificationsRoute, notificationGateRoute, mediaRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
