import { useSyncExternalStore } from 'react';
import { getMyAccess, setActiveTribe } from '../api/portal';
import { getAuthState, useAuth } from './auth';
import { auth } from './firebase';

/**
 * Multi-tribe launch destination, ported from the Kotlin
 * `resolveLaunchDestination` (src/commonMain/kotlin/com/kinfolk/portal/launch/LaunchRouter.kt)
 * so web and Android branch on the exact same rule set:
 *   - no auth yet            -> 'loading'
 *   - signed out              -> 'signIn'
 *   - access fetch failed     -> 'error'
 *   - access not fetched yet  -> 'loading'
 *   - 0 kinfolkIds             -> 'noTribes'
 *   - operator                -> 'pick' (always, even with 1 id — they see the directory)
 *   - exactly 1, non-operator -> 'home'
 *   - 2+, non-operator         -> 'error'
 *
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": a non-operator can
 * only ever belong to exactly one household. The picker used to also serve a
 * non-operator with 2+ ids; that case is withdrawn — see the branch below.
 */
export type LaunchDestination = 'loading' | 'signIn' | 'noTribes' | 'pick' | 'home' | 'error';

/**
 * Thrown by the route guards when access could not be fetched AND the device
 * says it has no network (#812).
 *
 * A SEPARATE TYPE, not a flag on `AccessState`, because the guards want to do
 * something with it that no other consumer does. `access.error` stays exactly
 * what it was (a string a screen can show), and this is the one signal meaning
 * "do not mount this route at all, show the offline screen".
 * `components/RouteError.tsx` is what catches it.
 *
 * WHY `navigator.onLine` IS THE DISCRIMINATOR, given that guessing at causes is
 * what produced this issue. The failure arrives as whatever `getMyAccess`
 * rejected with, and `lib/fns.ts`'s own header records that the Functions SDK
 * reports `functions/internal` for ANY transport failure: a dropped connection,
 * a reply that never came back, a wedged revision. The error genuinely cannot
 * tell us which. The browser can, and it is the only thing here that can.
 *
 * Its false negative, written down rather than left to be discovered: a phone
 * on a wifi network with no route out reports `onLine === true`, so that
 * household falls through to today's `LaunchError` path. That is the screen
 * they already get, so nothing regresses; it is simply not improved. The false
 * POSITIVE is the one that would matter, and it cannot happen: `onLine` is
 * false only when the device has no usable network at all, and no callable is
 * reaching a backend in that state.
 */
export class OfflineAccessError extends Error {
  constructor() {
    super('This device is offline, so your tribe could not be loaded.');
    this.name = 'OfflineAccessError';
  }
}

export interface AccessState {
  kinfolkIds: string[];
  isOperator: boolean;
  /** Currently selected tribe. Null until resolved (single-tribe autopick or user pick). */
  activeKinfolkId: string | null;
  error: string | null;
}

export function resolveLaunchDestination(
  authStatus: 'loading' | 'signedOut' | 'signedIn',
  access: AccessState | null,
): LaunchDestination {
  if (authStatus === 'loading') return 'loading';
  if (authStatus === 'signedOut') return 'signIn';
  if (access === null) return 'loading';
  if (access.error !== null) return 'error';
  if (access.kinfolkIds.length === 0) return 'noTribes';
  if (access.isOperator) return 'pick';
  if (access.kinfolkIds.length === 1) return 'home';
  // Operator ruling 2026-08-06, "one kinfolk, one tribe": under the ruling
  // this cannot happen, so it's a data defect, not a routing case. Do NOT
  // auto-pick (that would show someone else's household — pet medical
  // records included — to whichever id happened to sort first) and do NOT
  // fall back to the picker (its existence for non-operators is exactly what
  // the ruling withdrew, so routing here would silently resurrect it).
  // Fail loud instead: surface it as an error, activeKinfolkId or not, so a
  // broken invite/migration gets fixed rather than "working" by accident.
  // (ensureAccess below is what actually runs in the app and logs this —
  // this function has no consumers wired up yet, see its own comment.)
  return 'error';
}

let state: AccessState | null = null;
let inFlight: Promise<AccessState> | null = null;
let resolvedForUid: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AccessState | null {
  return state;
}

function sessionKeyFor(uid: string): string {
  return `mytribe.activeKinfolkId.${uid}`;
}

/**
 * O-37: make the ID token agree with the tribe we just resolved.
 *
 * Firestore + Storage rules gate every kinfolk read on
 * `token.role == 'kinfolk' && token.kinfolkId`, but a single-tribe kinfolk is
 * auto-picked below and never touches setActiveKinfolkId's re-mint path — so
 * nothing ever refreshed the token they were issued at account-creation, back
 * before acceptInvite stamped the claim. Result: realtime Messages and live GPS
 * breadcrumbs were denied until the token happened to age out (up to an hour).
 *
 * Cheapest thing that is correct, in order:
 *   1. read the CACHED claims (no network) — a warm boot stops here;
 *   2. claim missing/stale -> force one refresh; acceptInvite has already
 *      stamped it server-side, so this is enough for the fresh-accept case;
 *   3. still disagrees (e.g. another device switched tribes) -> only then
 *      spend a setActiveTribe re-mint and refresh again.
 *
 * Never throws: a kinfolk who cannot reconcile their token still gets their
 * callable-backed screens, and the console.warn keeps the degradation visible
 * rather than silent.
 */
async function reconcileClaim(activeKinfolkId: string): Promise<void> {
  try {
    const cached = await auth.currentUser?.getIdTokenResult();
    if (cached?.claims['kinfolkId'] === activeKinfolkId) return;

    const refreshed = await auth.currentUser?.getIdTokenResult(true);
    if (refreshed?.claims['kinfolkId'] === activeKinfolkId) return;

    await setActiveTribe(activeKinfolkId);
    await auth.currentUser?.getIdToken(true);
  } catch (err: unknown) {
    console.warn('[activeTribe] could not reconcile kinfolk claim; live reads may be denied:', err);
  }
}

/**
 * Resolves getMyAccess for the current uid (cached; call is idempotent per
 * sign-in). Restores a previously-picked tribe from sessionStorage if it's
 * still in the allowed set, and auto-picks the sole tribe for non-operators.
 *
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": a non-operator with
 * 2+ ids is a data defect the ruling says can't happen. This is the one
 * place that MUST refuse to hand out an activeKinfolkId for it — every
 * kinfolkId-scoped callable (getMyHome included) falls back server-side to
 * the caller's first linked id when kinfolkId is omitted
 * (resolveKinfolkAccess.ts), so restoring a session pick or auto-reconciling
 * a token here would let a defective account reach real household data
 * through the very query a screen fires next. router.tsx's guards send this
 * state straight to the dead-end /error screen; nothing downstream may ever
 * fire a kinfolkId query for it, which is why this function must not resolve
 * one either.
 */
export async function ensureAccess(): Promise<AccessState> {
  const auth = getAuthState();
  if (auth.status !== 'signedIn') {
    throw new Error('ensureAccess called while signed out');
  }
  const uid = auth.user.uid;
  if (state !== null && resolvedForUid === uid) return state;
  if (inFlight !== null && resolvedForUid === uid) return inFlight;

  resolvedForUid = uid;
  inFlight = getMyAccess()
    .then(async (result) => {
      if (!result.isOperator && result.kinfolkIds.length >= 2) {
        console.error(
          `[activeTribe] non-operator account has ${result.kinfolkIds.length} tribes; ` +
            'expected exactly 1 under the "one kinfolk, one tribe" ruling. Account needs attention.',
        );
        const next: AccessState = { kinfolkIds: result.kinfolkIds, isOperator: false, activeKinfolkId: null, error: null };
        state = next;
        notify();
        return next;
      }
      const saved = sessionStorage.getItem(sessionKeyFor(uid));
      const restored = saved !== null && result.kinfolkIds.includes(saved) ? saved : null;
      const autoPicked = !result.isOperator && result.kinfolkIds.length === 1 ? result.kinfolkIds[0]! : null;
      const activeKinfolkId = restored ?? autoPicked;
      // Awaited, not fire-and-forget: screens subscribe their claim-gated
      // onSnapshot listeners as soon as this resolves, and a listener that
      // starts on a stale token is simply denied — it does not retry.
      if (activeKinfolkId !== null) await reconcileClaim(activeKinfolkId);
      const next: AccessState = {
        kinfolkIds: result.kinfolkIds,
        isOperator: result.isOperator,
        activeKinfolkId,
        error: null,
      };
      state = next;
      notify();
      return next;
    })
    .catch((err: unknown) => {
      const next: AccessState = {
        kinfolkIds: [],
        isOperator: false,
        activeKinfolkId: null,
        error: err instanceof Error ? err.message : 'Could not load your tribes.',
      };
      state = next;
      notify();
      return next;
    });
  return inFlight;
}

/**
 * Sets the active tribe (TribePicker selection) and persists it for the
 * session. Updates local state synchronously (instant UI — callable reads
 * pass kinfolkId explicitly so they're correct immediately regardless), and
 * fires the O-5 `setActiveTribe` claim re-mint + a forced ID token refresh
 * in the background: that's what makes DIRECT Firestore reads (live GPS
 * breadcrumbs, gated by `request.auth.token.kinfolkId`) honor the pick too.
 * A failure here is logged, not surfaced — the picker flow shouldn't block
 * or error out over it; the kinfolk still lands on the right tribe's data
 * via callables, and the next tribe switch (or natural token refresh cycle)
 * will retry the claim sync anyway (onClientsWrite doesn't fire again on
 * its own, but this fires on every switch so it's self-healing per-switch).
 */
export function setActiveKinfolkId(kinfolkId: string): void {
  const authState = getAuthState();
  if (authState.status !== 'signedIn' || state === null) return;
  sessionStorage.setItem(sessionKeyFor(authState.user.uid), kinfolkId);
  state = { ...state, activeKinfolkId: kinfolkId };
  notify();

  void setActiveTribe(kinfolkId)
    .then((res) => {
      // An operator viewing a household that is not theirs comes back ok with
      // claimReminted:false. That is the designed outcome, not a failure: the
      // server deliberately does not mint a kinfolkId claim for a household the
      // caller does not own. Nothing to refresh in that case.
      if (res?.claimReminted === false) return undefined;
      return auth.currentUser?.getIdToken(true);
    })
    .catch((err: unknown) => {
      // Was a bare console.warn, which swallowed a real permission-denied on
      // every operator tribe switch and would equally have hidden a genuine
      // claim-sync outage. The operator case is now an ok response above, so
      // anything reaching here is a real failure and must be visible.
      console.error('[activeTribe] setActiveTribe claim re-mint failed:', err);
      reportActiveTribeError(err);
    });
}

/** Set by the app shell so a failed claim re-mint can reach the user. */
let activeTribeErrorSink: ((err: unknown) => void) | null = null;

/** Register a sink for claim-sync failures (see setActiveKinfolkId). */
export function onActiveTribeError(sink: ((err: unknown) => void) | null): void {
  activeTribeErrorSink = sink;
}

function reportActiveTribeError(err: unknown): void {
  activeTribeErrorSink?.(err);
}

/**
 * Forgets the tribe pick persisted for [uid] (#539, sign-out).
 *
 * Deliberately NOT folded into `clearAccess` below. `clearAccess` means "drop
 * the resolved access so it gets fetched again", and its other callers — the
 * /error screen's Retry, and the router's own recovery path — want the
 * persisted pick to survive. Only sign-out wants it gone, and only sign-out
 * knows whose it was: `auth.currentUser` is already null by the time the caches
 * are purged, which is why the uid is passed in rather than read here.
 *
 * try/catch because sessionStorage throws outright in a browser with site data
 * blocked, and a storage refusal must not be what stops somebody signing out.
 */
export function clearActiveTribeSession(uid: string): void {
  try {
    sessionStorage.removeItem(sessionKeyFor(uid));
  } catch {
    // Storage unavailable; nothing was persisted to begin with.
  }
}

/** Clears the resolved access (call on sign-out) so the next sign-in re-resolves. */
export function clearAccess(): void {
  state = null;
  inFlight = null;
  resolvedForUid = null;
  notify();
}

/** Reactive access state for components. Null until ensureAccess() resolves. */
export function useAccessState(): AccessState | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Non-reactive read of the active tribe id, for use in queryFn closures. */
export function getActiveKinfolkId(): string | undefined {
  return state?.activeKinfolkId ?? undefined;
}

/** Reactive launch destination, combining auth + access state. */
export function useLaunchDestination(): LaunchDestination {
  const auth = useAuth();
  const access = useAccessState();
  return resolveLaunchDestination(auth.status, access);
}
