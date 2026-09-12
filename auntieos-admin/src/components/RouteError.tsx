import type { ErrorComponentProps } from '@tanstack/react-router';
import { OfflineSessionError } from '../lib/readOnlySession';
import { Banner } from './Banner';
import { GlassSurface } from './GlassSurface';
import { PrimaryButton } from './Buttons';
import './RouteError.css';

/**
 * What the router renders when a route throws: the `defaultErrorComponent`
 * this app did not have (#812).
 *
 * WHAT IT REPLACED. Nothing caught a `beforeLoad` rejection, so it propagated to
 * `main.tsx`'s Sentry boundary and the operator got `CrashFallback`: "Something
 * broke on this screen", a Reload button, and no account of what happened. On a
 * cold offline deep link that was not merely unhelpful, it was wrong. Nothing
 * had broken. The device had no signal, and the one screen the operator reached
 * for on a driveway told them the app was faulty.
 *
 * IT RENDERS IN TWO PLACES, and the markup has to work in both. Standing in for
 * `AppShell` when the admin gate itself throws, which is the whole viewport with
 * no rail; and inside the outlet beside a live rail when one screen's chunk
 * fails to load. So it is a centred card that lays out at any width and paints no
 * ground of its own, because `RootLayout`'s orbs and grain are already behind it,
 * exactly as they are behind the sign-in screen.
 *
 * NO SIGN OUT, and this is the load-bearing omission rather than a tidy one.
 * Signing out clears the ID token, the IndexedDB session and every cache behind
 * it, the only copy of anything still readable on a device with no signal. #805
 * settled this for the portal for the same reason. What is offered instead is
 * Try again, which re-runs the guard that threw: worth a tap the moment a bar of
 * signal comes back, and `router.tsx` fires it unprompted when the browser says
 * the connection has returned.
 *
 * Existing kit only: `GlassSurface` for the card, `Banner` for the notice, the
 * shell's own button. Nothing here is a new visual idea.
 */

/**
 * Whether this failure is the network rather than the app, as copy.
 *
 * `OfflineSessionError` is certain: the gate set the degraded flag and one of
 * the two network seams refused. `navigator.onLine` is the fallback for
 * everything else that can reach here, chunk loads included. A screen's
 * JavaScript that never arrives on a device with no signal is an offline fact
 * too, and saying "something broke" about it would be the same lie.
 *
 * Pure, so the wording is testable without a router.
 */
export function routeErrorNotice(error: unknown, online: boolean): {
  tone: 'warning' | 'error';
  title: string;
  body: string;
} {
  if (error instanceof OfflineSessionError || !online) {
    return {
      tone: 'warning',
      title: 'This device is offline',
      body: "This screen needs the network and there isn't one right now. Nothing has been lost, and nothing you can see has changed. Stay signed in and it opens as soon as the connection is back.",
    };
  }
  return {
    tone: 'error',
    title: "This screen didn't open",
    body: 'Something went wrong loading it, and the error has been reported. Trying again usually clears it, and nothing you saved has been lost.',
  };
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  // Read at render, not held in state: a re-render after the `online` event has
  // fired must be able to change the answer.
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const notice = routeErrorNotice(error, online);
  return (
    <main className="routeerr">
      <div className="routeerr__stage">
        <GlassSurface className="routeerr__card">
          <Banner
            tone={notice.tone}
            title={notice.title}
            trailing={<PrimaryButton label="Try again" onClick={reset} />}
          >
            {notice.body}
          </Banner>
        </GlassSurface>
      </div>
    </main>
  );
}
