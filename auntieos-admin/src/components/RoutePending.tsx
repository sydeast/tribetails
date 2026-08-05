import { useRouterState } from '@tanstack/react-router';
import { screenTitle } from '../lib/nav';
import { AsyncLoading } from './AsyncRegion';

/**
 * What the outlet shows while a screen's chunk is still in flight.
 *
 * Every admin screen is loaded on demand (`lazyRouteComponent` in
 * `router.tsx`), so between asking for a screen and having it there is a real
 * wait, and the router needs something to render for it. Three decisions:
 *
 *   SAME MARKUP AS EVERY OTHER WAIT. `AsyncLoading` is `AsyncRegion`'s loading
 *   branch, lifted so both can use it: `div[role=status][aria-live=polite]`,
 *   announced, and already the selector `e2e/visual.capture.spec.ts` waits on
 *   before it photographs a screen. A route spinner of its own invention would
 *   be a second idiom for a screen reader, for the harness, and for the CSS.
 *
 *   IT NAMES THE SCREEN, from `lib/nav.ts`, so the wait reads "Loading
 *   Bookings…" rather than a bare bar. The rail is already the single source of
 *   truth for screen names; this is the same name the operator just clicked.
 *
 *   IT IS RARELY SEEN, and that is deliberate rather than a hedge. TanStack
 *   drives navigation through `React.startTransition`, so a chunk that arrives
 *   inside `defaultPendingMs` (1s) never replaces the screen the operator is
 *   looking at. The old screen simply stays until the new one is ready. This
 *   renders on FIRST paint of a deep link, and on a genuinely slow fetch. The
 *   rail preloads on hover besides (`defaultPreload: 'intent'`), so the common
 *   path has the chunk before the click.
 */
export function RoutePending() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <AsyncLoading what={screenTitle(pathname) ?? 'this screen'} />;
}
