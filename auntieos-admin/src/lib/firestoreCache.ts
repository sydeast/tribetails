/**
 * WHICH FIRESTORE CACHE THIS BROWSER GETS, decided here as a pure function so
 * the choice is testable and, more importantly, so it is a CHOICE at all.
 *
 * WHY THE ADMIN NEEDS AN OFFLINE QUEUE. `lib/firebase.ts` took
 * `getFirestore(app)` raw until 2026-09-12, which is the SDK's memory cache:
 * nothing survives a reload and a write started with no signal simply sits in
 * RAM until the tab is closed. That was defensible while the admin was an
 * office screen. It is not defensible now. The operator ruled that MOBILE WEB
 * IS THE FIELD FALLBACK, so this app gets opened on a phone, at a door, on
 * whatever coverage the street has, and `api/sessionsWrite.ts` now writes the
 * visit clock straight to Firestore rather than through a callable. A queued
 * "Arrived" that evaporates on a reload would be worse than the cold start it
 * replaced.
 *
 * WHY THE CHOICE IS MADE HERE RATHER THAN LEFT TO THE SDK. `persistentLocalCache`
 * falls back on its own when IndexedDB is missing, and it does it SILENTLY. This
 * tree's standing rule is that a fallback is acceptable only when it is
 * disclosed, so the mode is picked explicitly and exported, and a surface that
 * wants to tell the operator "this browser cannot queue work offline" has
 * something to read.
 */

/** The cache this session actually got. Exported by `lib/firebase.ts`. */
export type FirestoreCacheMode = 'persistent' | 'memory';

/**
 * `persistent` when the browser can hold a durable queue, `memory` when it
 * cannot -- or when it must not.
 *
 * THE THREE WAYS `indexedDB` IS NOT USABLE, all of which land on `memory`:
 * a test runner with no IndexedDB at all (jsdom, which every vitest spec that
 * transitively imports `lib/firebase.ts` runs in); a browser in private mode or
 * with site data blocked, where the global exists but opening a database
 * throws; and a non-browser build target. Only the first is detectable here
 * without side effects -- the second surfaces later as a failed write, which is
 * why callers must never treat `persistent` as a promise that anything was
 * actually stored.
 *
 * AN E2E RUN IS MEMORY-ONLY ON PURPOSE, and this is the one case where the
 * cache is refused rather than unavailable. Playwright and Cypress both run
 * real Chromium, which HAS IndexedDB, and neither clears it between tests the
 * way they clear cookies and localStorage. With a persistent cache the
 * Firestore store would then outlive a test: a live listener would deliver a
 * `fromCache` snapshot of the PREVIOUS test's document before the emulator's
 * own, and a spec asserting on first paint or counting rows would fail for a
 * reason that has nothing to do with the code under test. Production is
 * unaffected -- `VITE_E2E_EMULATOR` is set only by the harness's dev server, so
 * Vite folds this argument to a constant `false` in a hosting build, exactly as
 * `lib/firebase.ts` documents for the emulator wiring itself.
 */
export function firestoreCacheMode(
  hasIndexedDb: boolean = typeof indexedDB !== 'undefined',
  isE2eRun = false,
): FirestoreCacheMode {
  if (isE2eRun) return 'memory';
  return hasIndexedDb ? 'persistent' : 'memory';
}
