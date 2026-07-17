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

const formSchemasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'form-schemas',
  component: FormSchemas,
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

const kinTalesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'kintales',
  component: KinTales,
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  adminRoute.addChildren([homeRoute, featureFlagsRoute, activityRoute, notificationsRoute, formSchemasRoute, invoicesRoute, directoryRoute, bookingsRoute, sessionsRoute, kinTalesRoute, galleryRoute, templatesRoute, tribalIntelRoute, scheduleRoute, inboxRoute, settingsRoute, communicateRoute, accountRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
