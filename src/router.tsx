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

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  adminRoute.addChildren([homeRoute, featureFlagsRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
