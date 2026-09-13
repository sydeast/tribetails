import { OfflineNotice } from '../components/OfflineNotice';

/**
 * What a household sees when a deep route cannot launch because the phone has
 * no signal (#812).
 *
 * WHAT IT REPLACED. `requireActiveTribe` calls `ensureAccess`, which calls the
 * `getMyAccess` callable, which always needs the network. `ensureAccess`
 * catches its own failure into `error`, the guard returned early on that, and
 * the screen mounted straight onto `LaunchError`: "We're having trouble loading
 * your tribe", a Try again button, and a **Sign out** button. Three things
 * wrong with that on a driveway. It blames the app for a missing bar of signal.
 * Try again cannot work while the phone is offline. And sign-out clears the
 * session and every cache behind it, the only copy of anything this household
 * can still read, which #805 settled for the portal and this screen honours:
 * THERE IS NO SIGN OUT HERE, and that omission is the point of the screen.
 *
 * There is no Try again either, for #805's reason rather than a new one: the
 * button would do nothing, every time, while `navigator.onLine` is false.
 * `router.tsx` listens for the browser's `online` event and re-runs the guard
 * itself, so the way back is the connection returning, not a tap.
 *
 * NOTHING NEW IS DRAWN. The frame is `LaunchError`'s own (`errshell`,
 * `errbrand`, the glass card, `errfoot`), because this is the same moment in
 * the same journey and a second full-screen vocabulary would be one more thing
 * for a household to learn. The words inside it are `OfflineNotice`'s, which is
 * the sentence the portal already uses everywhere a read cannot be reached.
 * This screen is the launch-shaped frame around that one component.
 */
export function LaunchOffline() {
  return (
    <main className="errshell">
      <div className="errbrand">
        My<span className="grad">Tribe</span>
      </div>

      <section className="glass card launcherrcard">
        <OfflineNotice what="your tribe" />
      </section>

      <p className="errfoot">
        Cared for by <b>Tribe Tails Pet Care</b>
      </p>
    </main>
  );
}
