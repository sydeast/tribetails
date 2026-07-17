import { useState } from 'react';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
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
import { Bookings } from './screens/Bookings';
import { Sessions } from './screens/Sessions';
import { KinTales } from './screens/KinTales';
import { Gallery } from './screens/Gallery';
import { Templates } from './screens/Templates';
import { TribalIntel } from './screens/TribalIntel';
import { Schedule } from './screens/Schedule';
import { Inbox } from './screens/Inbox';
import { Settings } from './screens/Settings';
import { Communicate } from './screens/Communicate';
import { Account } from './screens/Account';
import { MyNotificationsEdit } from './screens/MyNotificationsEdit';
import { Media } from './screens/Media';
import { type MediaTargetType } from './lib/mediaScopeFormat';
import { FormSchemaEditor } from './screens/FormSchemaEditor';
import { KinTaleCompose } from './screens/KinTaleCompose';
import { KinTaleDetail } from './screens/KinTaleDetail';
import { AppShell } from './components/AppShell';

/** Shared chrome: the two drifting orbs behind every screen (Den background). */
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

const notificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'notifications',
  component: Notifications,
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

const invoicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invoices',
  component: Invoices,
});

const directoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'directory',
  component: Directory,
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
  const [mode, setMode] = useState<KinTalesMode>({ kind: 'list' });

  if (mode.kind === 'compose') {
    return (
      <KinTaleCompose
        {...(mode.kinTaleId ? { kinTaleId: mode.kinTaleId } : {})}
        onClose={() => setMode({ kind: 'list' })}
      />
    );
  }
  if (mode.kind === 'detail') {
    return (
      <KinTaleDetail
        kinTaleId={mode.kinTaleId}
        onEdit={(id) => setMode({ kind: 'compose', kinTaleId: id })}
        onClose={() => setMode({ kind: 'list' })}
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

const tribalIntelRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'tribal-intel',
  component: TribalIntel,
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

const accountRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'account',
  component: Account,
});

const myNotificationsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'my-notifications',
  component: MyNotificationsEdit,
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
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, bookingsRoute, sessionsRoute, kinTalesRoute, galleryRoute, templatesRoute, tribalIntelRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, accountRoute, myNotificationsRoute, mediaRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
