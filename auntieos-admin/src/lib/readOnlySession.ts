/**
 * The admin's DEGRADED ENTRY: signed in, no network, and running on an ID token
 * that can no longer be refreshed.
 *
 * WHY THERE IS A STATE HERE AT ALL (#812). #804 made an offline navigation
 * paint: the service worker answers a cold deep link with the precached shell.
 * What mounts into that shell was the next question. `router.tsx`'s
 * `requireAdmin` calls `resolveAccess`, which calls `getIdTokenResult(user,
 * false)`. Firebase serves the cached token straight out of IndexedDB while it
 * is still inside its hour, so a deep route rendered. Once the token needs a
 * refresh it cannot reach, that promise REJECTS, `beforeLoad` did not catch it,
 * and the route landed on the Sentry crash fallback. The operator is on mobile
 * web precisely because the Android app would not load on the job, and they
 * have very likely had the admin shut for more than an hour, so the crash
 * arrived exactly in the scenario the fallback exists for.
 *
 * The gate now admits that session rather than crashing on it, and this flag is
 * how the rest of the app knows it is running on a session the server has not
 * confirmed.
 *
 * WHAT READ-ONLY MEANS, precisely, because the word is worth nothing without
 * its edges. Nothing leaves the device through either of this app's two network
 * seams while the flag is set:
 *
 *   lib/fns.ts `call`      every one of the ~175 admin callables
 *   lib/adminApiFetch.ts   the two `/api/*` endpoints behind the rewrites
 *
 * Both refuse locally and throw `OfflineSessionError` instead of dialling.
 * READS ARE REFUSED TOO, deliberately rather than by omission: this app keeps
 * no offline data cache (no `persistQueryClient`, no Firestore persistence),
 * so every "read" is a network read that would spend `fns.ts`'s twenty-second
 * timeout and land on `AsyncRegion`'s error arm regardless. Refusing now
 * reaches the same screen sooner, and with a sentence naming the cause instead
 * of a deadline. So what read-only leaves standing is the shell: the rail, the
 * account chip, the session banner, and whatever each screen can draw without
 * asking the network. That is a smaller app than the operator wanted, and a far
 * larger one than a crash page.
 *
 * WHAT IT DOES NOT COVER, said plainly rather than left to be discovered. Ten
 * modules write to Firestore directly (`screens/KinTaleCompose.tsx`,
 * `screens/KinEdit.tsx`, `screens/TagsEditor.tsx`, `screens/KinfolkEdit.tsx`,
 * `screens/Media.tsx`, `screens/settings/sections.tsx`,
 * `components/MediaViewerDialog.tsx`, `lib/closureRecurrence.ts`,
 * `lib/visitTracking.ts`, `api/sessionsWrite.ts`). Offline those sit on
 * "Saving…" until the SDK gives up, which is what they already do today and is
 * not a regression this issue introduced. Routing ten call sites through a new
 * guard is a different change with a different blast radius; it is named here
 * so the next reader knows the boundary was chosen rather than missed.
 *
 * WHY THIS IS NOT `lib/sessionHealth.ts`'s FLAG. That module reports
 * `unreachable` for a blip while the cached token is still valid. Its own
 * header argues, correctly, that nothing the operator does is being refused in
 * that window. Gating every callable on it would turn a recoverable
 * thirteen-second wobble into an app-wide outage. This flag is set only by the
 * gate, only when a refresh was genuinely needed and genuinely failed.
 *
 * HOW IT CLEARS. `requireAdmin` clears it the moment `resolveAccess` resolves
 * again, and `router.tsx` re-runs the gate when the session recovers or the
 * browser fires `online`. Nothing has to be reloaded by hand.
 *
 * No imports on purpose: both seams below it in the dependency graph read this,
 * and a module with dependencies here would be a cycle waiting to happen.
 */

let degraded = false;

/** Thrown by both network seams while the entry is degraded. */
export class OfflineSessionError extends Error {
  constructor(what: string) {
    super(
      `This device is offline and its sign-in can no longer be renewed, so ${what} did not reach ` +
        'Tribe Tails. Nothing already on screen has changed. It works again once there is a signal.',
    );
    this.name = 'OfflineSessionError';
  }
}

/** True while the app is running on a session the network could not confirm. */
export function isReadOnlySession(): boolean {
  return degraded;
}

/** Called by the gate when a token refresh failed for want of a network. */
export function enterReadOnlySession(): void {
  degraded = true;
}

/** Called by the gate the next time access resolves for real. */
export function leaveReadOnlySession(): void {
  degraded = false;
}
