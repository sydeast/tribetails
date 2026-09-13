import { AddToHomeScreen } from './AddToHomeScreen';
import { PushPrompt } from './PushPrompt';
import { isIos, isStandalone } from '../lib/installState';

/**
 * Decides WHICH of the two home-screen banners a household sees, and in what
 * order. Home.tsx used to render <PushPrompt /> and <AddToHomeScreen /> as
 * unordered siblings, which produced the one arrangement that helps nobody:
 * on iOS Safari the notifications banner came first and rendered NOTHING
 * (lib/push.ts correctly answers "unsupported" when `Notification` does not
 * exist, which is exactly iOS in a tab), so the screen looked as though the
 * portal had simply decided not to offer notifications.
 *
 * iOS SAFARI, NOT INSTALLED: the install coach ALONE. Not the notifications
 * banner first, and never nothing. On that platform the coach IS the
 * notifications answer, and it says so in its own copy: Safari delivers push
 * to a home-screen app and to nothing else, so "Enable notifications" is not a
 * button anyone can be given yet. Offering a control that cannot work is the
 * silent-degradation failure this repo does not ship.
 *
 * EVERYWHERE ELSE, including iOS once installed: the notifications banner
 * first, then the install coach. Chrome's install prompt and web push are
 * independent there, so both are real offers, and the coach hides itself when
 * the app is already installed or the browser has not offered a prompt.
 */
export function InstallAndAlerts() {
  // Read once per render rather than held in state: neither answer can change
  // without a navigation or a relaunch, and an install completed in this tab
  // is already handled inside AddToHomeScreen by the `appinstalled` event.
  if (isIos() && !isStandalone()) return <AddToHomeScreen />;

  return (
    <>
      <PushPrompt />
      <AddToHomeScreen />
    </>
  );
}
