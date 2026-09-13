/**
 * Is this browser running the portal as an installed app, and is it iOS?
 *
 * Pulled out of AddToHomeScreen.tsx because a second component now has to ask
 * the same two questions, and because the answers decide which banner a
 * kinfolk sees rather than only how one banner renders. See
 * components/InstallAndAlerts.tsx for what turns on them.
 *
 * WHY IT MATTERS ON iOS, written down because it is not obvious from the code:
 * WebKit deletes all script-writable storage for a site after seven days of
 * Safari use with no interaction with that site. That is IndexedDB,
 * localStorage AND the service worker registration, so for a household that
 * only ever opens the URL in a tab, the cached app is gone before their next
 * visit (households book monthly). A web app on the HOME SCREEN is exempt and
 * keeps its own use counter. Installing is therefore what makes the offline
 * cache real on iOS, and it is also the only way Safari delivers push.
 */

/** True when the page is running as an installed app rather than in a tab. */
export function isStandalone(): boolean {
  // Optional-chained for jsdom, which has no layout and no matchMedia.
  const displayMode = window.matchMedia?.('(display-mode: standalone)').matches === true;
  // Safari never implemented display-mode: standalone for home-screen web apps;
  // `navigator.standalone` is the iOS-only answer to the same question.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
}

/** True on iPhone, iPod and iPad, including iPadOS masquerading as a Mac. */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  const classicIos = /iPhone|iPad|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; the touch check tells them apart.
  const iPadOs = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
  return classicIos || iPadOs;
}
