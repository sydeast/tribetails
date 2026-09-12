import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSignOut } from '../lib/auth';
import { OfflineAccessError } from '../lib/activeTribe';
import { LaunchError } from '../screens/LaunchError';
import { LaunchOffline } from '../screens/LaunchOffline';

/**
 * What the router renders when a route throws: the `defaultErrorComponent`
 * this app did not have (#812).
 *
 * Before this, a `beforeLoad` rejection propagated past the router to the
 * Sentry boundary in `main.tsx`, so a household got a crash page. The portal's
 * guards rarely threw, which is why the hole went unnoticed; the moment the
 * guard learned to throw `OfflineAccessError`, the router needed somewhere for
 * it to land.
 *
 * TWO ARMS, and the offline one is deliberately a whole screen rather than a
 * notice bolted onto an error page. `OfflineAccessError` is certain: the guard
 * checked `navigator.onLine` before throwing it. `!navigator.onLine` catches
 * everything else that reaches here on a phone with no signal, chiefly a
 * lazily-imported screen chunk that never arrives; calling that "an error"
 * would be the same misattribution this issue is about. Read at render rather
 * than held in state, so a re-render after the `online` event can change the
 * answer.
 *
 * The other arm keeps `LaunchError` exactly as it is, Sign out and all, and
 * that is the point of having two. A launch that failed with a network present
 * is a real failure, and a household whose account is genuinely broken still
 * needs the screen that can sign them out of it. Only the offline arm withholds
 * that button, because only offline is signing out destructive. See
 * LaunchOffline.tsx.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const { signOut, signingOut } = useSignOut();
  if (error instanceof OfflineAccessError || !online) return <LaunchOffline />;
  return <LaunchError onRetry={reset} onSignOut={signOut} signingOut={signingOut} />;
}
