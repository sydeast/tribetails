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
 * Guard for every admin-only screen: signed in AND access is not `denied`.
 * A signed-in non-admin (e.g. a kinfolk who used their portal password) is
 * bounced to /signin, where the component signs the stale session out.
 */
async function requireAdmin() {
  const state = await waitForAuthReady();
  if (state.status !== 'signedIn') throw redirect({ to: '/signin' });
  const access = await resolveAccess(state.user);
  if (access.status === 'denied') throw redirect({ to: '/signin' });
  return { access };
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/home',
  beforeLoad: requireAdmin,
  component: Home,
});

const routeTree = rootRoute.addChildren([indexRoute, signInRoute, homeRoute]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
