import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { getMyAccount, getFormSchema as getAccountFormSchema, getMyPaymentMethod } from '../api/accountApi';
import { getBookingPolicy, getBusinessClosures, getServiceCatalog } from '../api/bookingApi';
import { BREEDS_QUERY, getBreeds } from '../api/breeds';
import { getAccountCreditHistory, getMyInvoices } from '../api/invoicesApi';
import { getMyKinPhotos } from '../api/kinTalesApi';
import { getMyNotificationPrefs, getNotificationCatalog } from '../api/notificationsApi';
import { getBusinessContact, getMyHome, getMyVisits } from '../api/portal';
import { getFormSchema as getTribeFormSchema, getMyTribeProfile, getVetClinics, listMembers } from '../api/tribeApi';
import { getAccessState, subscribeAccess } from './activeTribe';
import { getAuthState } from './auth';
import { billingAccessOf } from './billingAccess';
import { BOOKING_HORIZON_DAYS, bookingHorizonEnd, dateKey } from './bookingWizardLogic';
import type { CallOptions } from './fns';
import {
  GALLERY_CARD_PAGE,
  PAST_VISITS_LIMIT,
  accountCreditHistoryKey,
  bookingPolicyKey,
  businessClosuresKey,
  businessContactKey,
  formSchemaKey,
  membersKey,
  myAccountKey,
  myHomeKey,
  myInvoicesKey,
  myNotificationPrefsKey,
  myPaymentMethodKey,
  myVisitsKey,
  notificationCatalogKey,
  serviceCatalogKey,
  tribeHubPhotosKey,
  tribeProfileKey,
  vetClinicsKey,
} from './portalQueryKeys';
import { queryClient as appQueryClient } from './queryClient';

/**
 * #1282, option B: warm the screen reads when the portal opens.
 *
 * THE PROBLEM. Every portal callable is its own Cloud Run service with
 * minInstances 0 (nine warm ones aside), so the FIRST open of a screen pays a
 * cold start per callable it reads: Invoices measured 13 s on prod on
 * 2026-11-01, Notification settings and Tribe Profile 10-14 s, the booking
 * wizard 9 s, Add Kin 5-13 s. The second open is fast. Kinfolk do not open the
 * portal to look at Home; they open it to do one thing on one of those screens,
 * so the slow open is the one they came for.
 *
 * WHAT THIS DOES. The moment an active tribe is resolved (`ensureAccess` landed
 * with an `activeKinfolkId`, which only happens behind a portal route guard),
 * every one of those screens' reads is fired once, together, under the EXACT
 * query key the screen reads (`lib/portalQueryKeys.ts`, shared with the
 * screens). Each read lands on its own Cloud Run service and leaves it warm,
 * and its answer sits in the React Query cache, so the screen's own `useQuery`
 * mounts into data instead of a spinner. The reads a screen already fires on
 * Home (`myHome`, `myBookings`, the KinTales preview) are not duplicated; the
 * cache dedupes any that overlap.
 *
 * THE MONEY GATE (#1005). `getMyInvoices`, `getAccountCreditHistory` and
 * `getMyPaymentMethod` refuse a member without billing access, and the server
 * says who has it on `getMyHome.billingAccess`. So `myHome` is awaited first
 * (PortalNav fetches it anyway, same key, same staleTime) and the three money
 * reads fire only when it says yes. `billingAccessOf(undefined)` is true on
 * purpose for the SCREENS, so a household never loses its bills to a deploy
 * window; a warm-up has no such duty, and a failed `myHome` warms no money at
 * all rather than fire three refusals on a guess. The payment method
 * additionally waits for `myAccount` and is skipped for an operator stepping
 * into a household (`impersonated`), mirroring Account's own `enabled`.
 *
 * SILENT, BY CONSTRUCTION. Nobody is looking at these reads, so nothing about
 * them may reach the household:
 *   - every call carries `{ background: true }` (`lib/fns.ts`), which keeps a
 *     refusal out of the revocation sign-out path; the screen's own foreground
 *     call is what ends a genuinely revoked session;
 *   - `retry: false`, so a cold start that fails does not double its own wait;
 *   - a failed read is REMOVED from the cache when no screen holds it. React
 *     Query retries an errored query on mount but reports `isError` while it
 *     does, and every screen here paints `LaunchError` on `isError`, so an
 *     error left behind would flash the failure screen over a read that was
 *     about to succeed;
 *   - nothing here rejects: `warmPortalScreens` resolves whatever happens.
 *
 * ONCE PER SESSION PER TRIBE. The access store notifies on every change and
 * the route guards resolve access on every navigation, so the fan-out is keyed
 * by `uid/kinfolkId` and runs once for each. The set empties when access is
 * cleared (sign-out purges the query cache in the same breath, and an
 * operator's tribe switch resolves a new id), so the next resolution warms
 * again. This is installed from `main.tsx`, not from a route guard or a
 * component, because an active tribe is a fact about the session that arrives
 * without a navigation, and because the guards run inside thirty test files
 * that mock only what their own screen reads.
 *
 * NOT HERE: saves (#1504) and `getVetClinics` as a direct Firestore read
 * (#1503) are separate issues.
 */

/** Marks every warm-up call so `lib/fns.ts` keeps its refusal out of the sign-out path. */
const BACKGROUND: CallOptions = { background: true };

/** Same freshness PortalNav gives `myHome`, so a nav that already fetched it is not asked again. */
const HOME_STALE_MS = 5 * 60_000;

type Outcome<T> = { ok: true; data: T } | { ok: false };

/**
 * One cached read that leaves nothing behind on failure. `fetchQuery` dedupes
 * with a screen's in-flight read of the same key and returns cached data that
 * is still within `staleTime`, so a screen that got there first costs nothing
 * here.
 */
async function warmOne<T>(
  client: QueryClient,
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
  staleTime = 0,
): Promise<Outcome<T>> {
  try {
    const data = await client.fetchQuery({ queryKey, queryFn, staleTime, retry: false });
    return { ok: true, data };
  } catch {
    const query = client.getQueryCache().find({ queryKey, exact: true });
    if (query !== undefined && query.getObserversCount() === 0 && query.state.data === undefined) {
      client.removeQueries({ queryKey, exact: true });
    }
    return { ok: false };
  }
}

/**
 * Fires every portal screen's reads for [kinfolkId], money reads gated on the
 * home payload. Resolves when all of them have settled; never rejects.
 */
export async function warmPortalScreens(kinfolkId: string, client: QueryClient = appQueryClient): Promise<void> {
  const k = kinfolkId;
  const warm = <T>(key: QueryKey, fn: () => Promise<T>, staleTime?: number) => warmOne(client, key, fn, staleTime);

  // The two gates, started with everything else rather than ahead of it.
  const home = warm(myHomeKey(k), () => getMyHome(k, BACKGROUND), HOME_STALE_MS);
  const account = warm(myAccountKey(k), () => getMyAccount(k, BACKGROUND));

  const today = new Date();
  const closures = {
    fromDate: dateKey(today),
    toDate: dateKey(bookingHorizonEnd(today, BOOKING_HORIZON_DAYS)),
  };

  const reads: Promise<Outcome<unknown>>[] = [
    home,
    account,
    // Account
    warm(formSchemaKey('account'), () => getAccountFormSchema('account', BACKGROUND)),
    // Notification settings
    warm(notificationCatalogKey(), () => getNotificationCatalog(BACKGROUND)),
    warm(myNotificationPrefsKey(), () => getMyNotificationPrefs(BACKGROUND)),
    // Tribe Profile (and the Tribe hub's home-info card)
    warm(tribeProfileKey(k), () => getMyTribeProfile(k, BACKGROUND)),
    warm(formSchemaKey('tribeProfile'), () => getTribeFormSchema('tribeProfile', BACKGROUND)),
    warm(formSchemaKey('homeAccess'), () => getTribeFormSchema('homeAccess', BACKGROUND)),
    warm(vetClinicsKey(), () => getVetClinics(BACKGROUND)),
    warm(businessContactKey(), () => getBusinessContact(BACKGROUND)),
    warm(membersKey(k), () => listMembers(k, BACKGROUND)),
    // Booking wizard
    warm(serviceCatalogKey(k), () => getServiceCatalog(k, BACKGROUND)),
    warm(businessClosuresKey(), () => getBusinessClosures(closures, BACKGROUND)),
    warm(bookingPolicyKey(), () => getBookingPolicy(BACKGROUND)),
    // Schedule, Past Visits tab
    warm(myVisitsKey(k), () => getMyVisits(k, PAST_VISITS_LIMIT, BACKGROUND)),
    // Tribe hub photo strip (see tribeHubPhotosKey for why not Gallery's key)
    warm(tribeHubPhotosKey(k), () => getMyKinPhotos(k, { limit: GALLERY_CARD_PAGE }, BACKGROUND)),
    // Add Kin breed banks; seeded data, cached for the session like the editor does
    warm(BREEDS_QUERY.queryKey, () => getBreeds(BACKGROUND), BREEDS_QUERY.staleTime),
  ];

  const [homeResult, accountResult] = await Promise.all([home, account]);
  if (homeResult.ok && billingAccessOf(homeResult.data)) {
    reads.push(warm(myInvoicesKey(k), () => getMyInvoices(k, BACKGROUND)));
    reads.push(warm(accountCreditHistoryKey(k), () => getAccountCreditHistory(k, BACKGROUND)));
    if (accountResult.ok && accountResult.data.impersonated !== true) {
      reads.push(warm(myPaymentMethodKey(k), () => getMyPaymentMethod(k, BACKGROUND)));
    }
  }
  await Promise.all(reads);
}

const warmed = new Set<string>();
let inFlight: Promise<void> | null = null;
let uninstall: (() => void) | null = null;

function onAccessChange(): void {
  const access = getAccessState();
  if (access === null) {
    // Sign-out purge, a Retry on the account-error screen, or a reconnect after
    // a failed fetch: whatever resolves next is a fresh session as far as the
    // cache is concerned, so it gets warmed again.
    warmed.clear();
    return;
  }
  if (access.error !== null || access.activeKinfolkId === null) return;
  const auth = getAuthState();
  if (auth.status !== 'signedIn') return;
  const tag = `${auth.user.uid}/${access.activeKinfolkId}`;
  if (warmed.has(tag)) return;
  warmed.add(tag);
  const run = warmPortalScreens(access.activeKinfolkId).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
}

/**
 * Starts listening for a resolved active tribe. Idempotent: a second call
 * returns the same teardown. Called once from `main.tsx`.
 */
export function installPortalWarmup(): () => void {
  if (uninstall !== null) return uninstall;
  const unsubscribe = subscribeAccess(onAccessChange);
  uninstall = () => {
    unsubscribe();
    uninstall = null;
  };
  onAccessChange();
  return uninstall;
}

/** Test seam: the fan-out currently running, if any. */
export function portalWarmupInFlight(): Promise<void> | null {
  return inFlight;
}

/** Test seam: forget which tribes were warmed. */
export function resetPortalWarmupForTest(): void {
  warmed.clear();
  inFlight = null;
  uninstall?.();
}
