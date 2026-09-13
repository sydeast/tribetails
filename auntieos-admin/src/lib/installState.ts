/**
 * Is the admin running as an installed app, and is this an iPhone or iPad?
 *
 * Mirrors mytribe/web/src/lib/installState.ts, which established the shape.
 * Both answers decide what components/InstallPrompt.tsx offers the operator.
 *
 * WHY INSTALLING MATTERS AND IS NOT JUST TIDIER (operator ruling 2026-09-12:
 * mobile web is the FIELD FALLBACK). On iOS, WebKit deletes all script-writable
 * storage for a site after seven days of Safari use with no interaction with
 * that site, and that includes the service worker registration itself. A site
 * only ever opened in a tab therefore has no offline cache by the time it is
 * needed. A web app on the HOME SCREEN is exempt and keeps its own use counter,
 * so installing is what makes "opens without a signal" true rather than
 * theoretical. The installed app also gets a storage partition of its own, so
 * the operator signs in once more the first time they open it.
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
