import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { getMyAccount, getFormSchema as getAccountFormSchema, getMyPaymentMethod } from '../api/accountApi';
import { getBookingPolicy, getBusinessClosures, getServiceCatalog } from '../api/bookingApi';
import { BREEDS_QUERY, getBreeds } from '../api/breeds';
import { getAccountCreditHistory, getMyInvoices } from '../api/invoicesApi';
import { getMyKinPhotos } from '../api/kinTalesApi';
import { getMyNotificationPrefs, getNotificationCatalog } from '../api/notificationsApi';
import { getBusinessContact, getMyHome, getMyVisits } from '../api/portal';
import { getFormSchema as getTribeFormSchema, getMyTribeProfile, listMembers } from '../api/tribeApi';
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
 * WHAT THIS DOES. Once an active tribe is resolved (`ensureAccess` landed with
 * an `activeKinfolkId`, which only happens behind a portal route guard) AND the
 * screen the household opened has finished its own reads, every one of those
 * screens' reads is fired once, together, under the EXACT query key the screen
 * reads (`lib/portalQueryKeys.ts`, shared with the screens). Each read lands on
 * its own Cloud Run service and leaves it warm, and its answer sits in the
 * React Query cache, so the screen's own `useQuery` mounts into data instead of
 * a spinner. A key the opened screen already filled (`myHome` from PortalNav,
 * `myInvoices` on an invoice deep link) is not asked again.
 *
 * THE ORDER (#1561). The warm-up makes the NEXT screen fast and must never slow
 * the CURRENT one. It used to fire the moment access resolved, which is inside
 * the route guard, before the screen's chunk had loaded: on a deep link to
 * `/invoices/<id>` the twenty warm-up reads took the browser's six HTTP/1.1
 * connections to the emulator first, and the screen's own `getMyInvoices` left
 * 18 s after the visit. `lib/portalWarmup.ts` now holds the fan-out until the
 * opened screen has mounted its queries and none of them has been fetching for
 * a short quiet window, with a 10 s ceiling so a screen that hangs still gets
 * the rest of the portal warmed. Prod callables are HTTP/2 and do not queue
 * like that, but the cold starts are the same, and the household's read is the
 * one that has to win.
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
 * WHEN IT RUNS is `lib/portalWarmup.ts`'s business: once per session per
 * tribe, from a listener on the access store, after the opened screen's reads
 * have settled (THE ORDER, above). That module loads THIS one on
 * demand. The reads below pull every api module and the booking date logic
 * into whatever chunk holds them, and O-26 took exactly those out of the
 * entry chunk (measured here: a static import grew it by 27 KB raw). As a
 * lazy chunk they load once, when the first tribe resolves, alongside the
 * screen chunk the household is already waiting for.
 *
 * NOT HERE: saves (#1504) are a separate issue. `getVetClinics` is not warmed:
 * it is a direct Firestore read (#1503), so there is no instance to wake.
 */

/** Marks every warm-up call so `lib/fns.ts` keeps its refusal out of the sign-out path. */
const BACKGROUND: CallOptions = { background: true };

/** Same freshness PortalNav gives `myHome`, so a nav that already fetched it is not asked again. */
const HOME_STALE_MS = 5 * 60_000;

type Outcome<T> = { ok: true; data: T } | { ok: false };

/**
 * One cached read that leaves nothing behind on failure.
 *
 * A key the cache already answers, or one a mounted screen holds, is left
 * alone: the warm-up now runs AFTER the opened screen's reads (#1561), so
 * those are the reads that screen just made, and `fetchQuery` with a
 * staleTime of 0 would fire each of them a second time. Its data, when there
 * is some, is handed back so the money gate can still read the home payload.
 * Otherwise `fetchQuery` dedupes with any in-flight read of the same key.
 */
async function warmOne<T>(
  client: QueryClient,
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
  staleTime = 0,
): Promise<Outcome<T>> {
  const existing = client.getQueryCache().find({ queryKey, exact: true });
  if (existing !== undefined && existing.state.data !== undefined) return { ok: true, data: existing.state.data as T };
  if (existing !== undefined && existing.getObserversCount() > 0) return { ok: false };
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
