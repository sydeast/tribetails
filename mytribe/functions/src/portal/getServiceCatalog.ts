import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isOwner, isOwnerClaim, refuseAuntie } from '../lib/staffGate';
import { resolveNonStaffKinfolkId } from '../lib/resolveNonStaffKinfolkId';
import { hasBillingAccess } from '../lib/memberGate';

export interface ServiceDto {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  /**
   * The three price fields are ABSENT (not null) for a caller without billing
   * access. See `pricesVisible` and D-2026-09-28-VISIT-PRICES-ARE-BILLING.
   */
  priceCents?: number | null;
  priceMinCents?: number | null;
  priceMaxCents?: number | null;
  durationMinutes: number | null;
  isOvernight: boolean;
  iconKey: string | null;
}

interface GetServiceCatalogRequest {
  /** The household the caller is booking for. Needed only by an account holding 2+ tribes. */
  kinfolkId?: string;
}
interface GetServiceCatalogResult {
  services: ServiceDto[];
  /**
   * D-2026-09-28-VISIT-PRICES-ARE-BILLING (#1037): false when the caller has
   * no billing access to the household (a SECONDARY the PRIMARY did not grant
   * `billing_full`). The price fields are then stripped from every service,
   * and the clients draw no price label and no estimate row. Clients decode a
   * missing field as true, the same deploy-skew rule as `getMyHome.billingAccess`.
   */
  pricesVisible: boolean;
}

/**
 * Returns the service catalog.
 *
 * Primary source: the AuntieOS "KinCare types" at `business_settings/business_settings`
 * field `serviceRates` — a map of name -> rate-in-dollars-as-string, e.g.
 * `{ "30Minute": "25", "Half-Day 6Hrs": "100" }`. That map is what the business
 * actually charges, so it wins whenever it has usable entries.
 *
 * Fallback: the legacy `base_services` collection (single stale doc in practice).
 * Its field names drifted from what the portal used to read (`title`/`basePrice`
 * in dollars vs `name`/`priceCents`), so the mapping below accepts both shapes
 * and drops junk rows (no real name AND no price) so they never reach the client.
 */
export async function getServiceCatalogHandler(
  req: CallableRequest<GetServiceCatalogRequest | undefined>,
): Promise<GetServiceCatalogResult> {
  refuseAuntie(req.auth, 'getServiceCatalog'); // docket Q1: an Auntie never uses the portal
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
  const serviceRates = settingsSnap.data()?.serviceRates;
  let services = mapServiceRates(serviceRates);
  let source: 'serviceRates' | 'base_services' = 'serviceRates';

  if (services.length === 0) {
    source = 'base_services';
    const snap = await db().collection('base_services').get();
    services = snap.docs
      .filter((d) => d.data()?.active !== false)
      .map((d) => mapBaseServiceDoc(d.id, d.data() as Record<string, unknown>))
      .filter(isRenderableService);
  }

  // Stripped AFTER `isRenderableService` ran above: that guard keeps a row by
  // its price, so stripping first would drop services it means to keep.
  const pricesVisible = await callerSeesPrices(req, uid);
  if (!pricesVisible) services = services.map(withoutPrices);
  logEvent({ severity: 'info', function: 'getServiceCatalog', event: 'portal.services.resolved', uid, extra: { count: services.length, source, pricesVisible } });
  return { services, pricesVisible };
}
/**
 * D-2026-09-28-VISIT-PRICES-ARE-BILLING (#1037, operator ruling 2026-09-28):
 * "visit prices are billing information; hide them from members without
 * billing access." Billing access is `hasBillingAccess`: the owner, the
 * household PRIMARY, and a SECONDARY holding `billing_full`.
 *
 * The owner skips household resolution entirely: `resolveKinfolkAccess`
 * refuses an operator who names no household and holds none. Everyone else
 * resolves the household first, which `hasBillingAccess` requires. A caller
 * whose household cannot be resolved (no tribe linked, or 2+ tribes and no
 * `kinfolkId`) still gets the catalog, without prices: the names are not
 * money, and refusing to guess the household must not hand out the prices.
 */
async function callerSeesPrices(
  req: CallableRequest<GetServiceCatalogRequest | undefined>,
  uid: string,
): Promise<boolean> {
  if (isOwner(uid, isOwnerClaim(req.auth?.token), 'getServiceCatalog')) return true;
  const requested = typeof req.data?.kinfolkId === 'string' ? req.data.kinfolkId : undefined;
  let kinfolkId: string;
  try {
    kinfolkId = await resolveNonStaffKinfolkId(uid, requested);
  } catch (err) {
    logEvent({
      severity: 'info',
      function: 'getServiceCatalog',
      event: 'portal.services.prices.withheld',
      uid,
      extra: { reason: 'household_unresolved', message: (err as Error)?.message },
    });
    return false;
  }
  return hasBillingAccess(uid, kinfolkId, false, 'getServiceCatalog');
}
/** Drops the price keys outright, so no client can print a `$0` or `$NaN` from them. */
export function withoutPrices(s: ServiceDto): ServiceDto {
  const { priceCents: _p, priceMinCents: _min, priceMaxCents: _max, ...rest } = s;
  return rest;
}

/**
 * Maps the `serviceRates` map (name -> dollars-as-string) into ServiceDtos.
 * Entries whose rate does not parse to a positive number are skipped.
 * Returns [] when the map is missing/empty so callers can fall back.
 */
export function mapServiceRates(raw: unknown): ServiceDto[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const services: ServiceDto[] = [];
  for (const [key, rate] of Object.entries(raw as Record<string, unknown>)) {
    const priceCents = rateToCents(rate);
    if (priceCents == null) continue;
    services.push({
      id: key,
      name: prettifyRateKey(key),
      category: null,
      description: null,
      priceCents,
      priceMinCents: null,
      priceMaxCents: null,
      durationMinutes: durationFromRateKey(key),
      isOvernight: false,
      iconKey: null,
    });
  }
  // Stable display order: shortest visit first, unknown durations last.
  services.sort((a, b) => {
    const da = a.durationMinutes ?? Number.MAX_SAFE_INTEGER;
    const dbn = b.durationMinutes ?? Number.MAX_SAFE_INTEGER;
    return da !== dbn ? da - dbn : a.name.localeCompare(b.name);
  });
  return services;
}

/** Maps a legacy `base_services` doc, accepting both the old (`name`/`priceCents`) and stale (`title`/`basePrice` in dollars) shapes. */
export function mapBaseServiceDoc(id: string, data: Record<string, unknown>): ServiceDto {
  const name = stringOrNull(data['name']) ?? stringOrNull(data['title']) ?? id;
  const basePrice = numericOrNull(data['basePrice']);
  const priceCents = numericOrNull(data['priceCents']) ?? (basePrice != null ? Math.round(basePrice * 100) : null);
  return {
    id,
    name,
    category: stringOrNull(data['category']),
    description: stringOrNull(data['description']),
    priceCents,
    priceMinCents: numericOrNull(data['priceMinCents']),
    priceMaxCents: numericOrNull(data['priceMaxCents']),
    durationMinutes: numericOrNull(data['durationMinutes']),
    isOvernight: typeof data['isOvernight'] === 'boolean' ? (data['isOvernight'] as boolean) : false,
    iconKey: stringOrNull(data['iconKey']),
  };
}

/** Junk guard: a service with no real name (name fell back to the doc id) AND no price must never reach the client. */
export function isRenderableService(s: ServiceDto): boolean {
  const hasPrice = s.priceCents != null || s.priceMinCents != null || s.priceMaxCents != null;
  return s.name !== s.id || hasPrice;
}

/** "30Minute" -> "30 Minute", "2Hrs" -> "2 Hrs", "Half-Day 6Hrs" -> "Half-Day 6 Hrs". */
export function prettifyRateKey(key: string): string {
  return key.replace(/(\d)(Minute|Hrs)/g, '$1 $2');
}

/** Parses an obvious duration out of a rate key: "45Minute" -> 45, "2Hrs" -> 120, "Half-Day 6Hrs" -> 360; null otherwise. */
export function durationFromRateKey(key: string): number | null {
  const minutes = /(\d+)\s*Minute/.exec(key);
  if (minutes) return parseInt(minutes[1], 10);
  const hours = /(\d+)\s*Hrs/.exec(key);
  if (hours) return parseInt(hours[1], 10) * 60;
  return null;
}

/** Dollars-as-string (or number) -> integer cents; null when unparseable or <= 0. */
function rateToCents(rate: unknown): number | null {
  const dollars = numericOrNull(rate);
  if (dollars == null || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

export const getServiceCatalog = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getServiceCatalog', getServiceCatalogHandler),
);
