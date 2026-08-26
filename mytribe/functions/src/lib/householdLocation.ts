import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { isValidLatLng, type LatLng } from './geo';

/**
 * ISSUE #582: the household coordinate. Where it lives, how it gets there, and
 * what happens when an address will not geocode.
 *
 * WHY A STORED COORDINATE AT ALL. `requireArrivalDepartureVerification` (#519)
 * can check that somebody pressed "Arrived"; it cannot check they were at the
 * house, because the data model held no household position — `serviceAddress`
 * is free text and `optimizeRoute.ts` geocodes it fresh on every run. Operator
 * ruling (2026-08-25): geocode the address already on file, store the
 * coordinate, and refuse arrival outside a configurable radius.
 *
 * WHERE IT LIVES: `kinfolk/{kinfolkId}.serviceLocation`, on the household's own
 * canonical record, next to the address it was derived from. That collection is
 * STAFF-ONLY on read (`firestore.rules` :318-320 — `isAuntie()` and a scoped
 * test admin, nothing else), and the kinfolk self-write allowlist
 * (`onlyAllowedKinfolkFields()`, :287-292) names seven contact fields and
 * neither the address nor this. So the coordinate needs no new rule to be
 * private: households can neither read it nor write it, and no portal callable
 * projects a field off `kinfolk` beyond `firstName`/`lastName`.
 *
 * WHEN IT IS WRITTEN: by `onKinfolkAddressWrite`, when the address on the
 * document changes, and lazily by `verifyVisitArrival` for a household whose
 * record predates this feature. Deliberately NOT at COMPLETE: a Mapbox outage
 * must never be able to block closing a billable visit.
 *
 * WHEN IT CANNOT BE WRITTEN: a household with no address, or an address Mapbox
 * cannot match, gets `serviceLocationError` instead and no coordinate. Every
 * consumer treats an absent coordinate as "cannot verify", which ALLOWS the
 * visit and records that it was unverified. A typo in an address is not grounds
 * to strand the Auntie standing in the kitchen.
 */

/** The household record. `firestore.rules` calls it "the AuntieOS canonical household record". */
export const HOUSEHOLD_COLLECTION = 'kinfolk';

/**
 * Address fields a household doc may carry, in resolution priority — the same
 * order and the same reason as `admin/optimizeRoute.ts`, which had it first:
 * kinfolk docs predate a normalized address, so there is no single canonical
 * field and the known ones are tried in turn.
 */
export const ADDRESS_FIELDS = ['serviceAddress', 'homeAddress', 'address'] as const;

/** The stored coordinate, and the provenance that makes staleness detectable. */
export interface ServiceLocation extends LatLng {
  /** The exact address string this coordinate was derived from. */
  geocodedFrom: string;
  /** ISO instant of the geocode. */
  geocodedAt: string;
  provider: 'mapbox';
}

export type GeocodeFailure = 'no_address' | 'no_match' | 'geocoder_unavailable';

/** Why a household has no coordinate, recorded so the next write does not retry blindly. */
export interface ServiceLocationError {
  address: string;
  reason: GeocodeFailure;
  at: string;
}

/** The first non-blank address on the document, or `''`. */
export function pickHouseholdAddress(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  for (const field of ADDRESS_FIELDS) {
    const v = data[field];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/** The stored coordinate off a household document, or null when it is absent or unusable. */
export function readServiceLocation(
  data: Record<string, unknown> | undefined,
): ServiceLocation | null {
  const raw = data?.['serviceLocation'];
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (!isValidLatLng({ lat: rec['lat'] as number, lng: rec['lng'] as number })) return null;
  return {
    lat: rec['lat'] as number,
    lng: rec['lng'] as number,
    geocodedFrom: typeof rec['geocodedFrom'] === 'string' ? rec['geocodedFrom'] : '',
    geocodedAt: typeof rec['geocodedAt'] === 'string' ? rec['geocodedAt'] : '',
    provider: 'mapbox',
  };
}

function readServiceLocationErrorAddress(data: Record<string, unknown> | undefined): string | null {
  const raw = data?.['serviceLocationError'];
  if (!raw || typeof raw !== 'object') return null;
  const addr = (raw as Record<string, unknown>)['address'];
  return typeof addr === 'string' ? addr : null;
}

/**
 * Is the stored coordinate still the answer for the address now on file?
 *
 * Provenance, not a clock. A coordinate does not decay — a house does not move —
 * so re-geocoding on a timer would spend Mapbox calls to reconfirm what is
 * already true. What DOES invalidate it is the address changing underneath it,
 * and `geocodedFrom` is what makes that detectable.
 */
export function isServiceLocationFresh(
  data: Record<string, unknown> | undefined,
  address: string,
): boolean {
  const stored = readServiceLocation(data);
  return stored !== null && address !== '' && stored.geocodedFrom === address;
}

// ── The geocode-on-write plan, decided without touching the network ──────────

export type HouseholdGeocodePlan =
  | { action: 'skip'; reason: string }
  | { action: 'clear'; reason: string }
  | { action: 'geocode'; address: string };

/**
 * What `onKinfolkAddressWrite` should do with the document it just saw.
 *
 * PURE, AND THE LOOP GUARD LIVES HERE. This trigger writes back to the very
 * document that fires it, so every branch has to reach a state where the next
 * fire returns `skip`, INCLUDING the failure branch:
 *
 *  - geocoded successfully -> `geocodedFrom` equals the address -> skip.
 *  - geocode failed        -> `serviceLocationError.address` equals the address
 *                             -> skip. Without this the error write (which
 *                             carries a fresh `at` every time) would retrigger,
 *                             find no coordinate, call Mapbox again, fail again,
 *                             and spin forever on one bad address.
 *  - address blanked       -> clear the coordinate once -> next fire sees no
 *                             address and no coordinate -> skip. A coordinate
 *                             for an address nobody has any more is stale
 *                             evidence, and stale evidence is what would refuse
 *                             a COMPLETE for the wrong reason.
 *
 * A known-bad address is retried only when the address itself changes, or by
 * `verifyVisitArrival`'s lazy path — never on an unrelated edit to the
 * household's phone number.
 */
export function planHouseholdGeocode(
  after: Record<string, unknown> | undefined,
): HouseholdGeocodePlan {
  if (!after) return { action: 'skip', reason: 'deleted' };
  if (after['isTestData'] === true) return { action: 'skip', reason: 'test_data' };

  const address = pickHouseholdAddress(after);
  if (address === '') {
    return readServiceLocation(after) === null
      ? { action: 'skip', reason: 'no_address' }
      : { action: 'clear', reason: 'address_removed' };
  }
  if (isServiceLocationFresh(after, address)) return { action: 'skip', reason: 'already_geocoded' };
  if (readServiceLocationErrorAddress(after) === address) {
    return { action: 'skip', reason: 'geocode_already_failed_for_this_address' };
  }
  return { action: 'geocode', address };
}

// ── Mapbox ───────────────────────────────────────────────────────────────────

const MAPBOX_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward';

/**
 * Mapbox v6 forward geocode -> `{lon,lat}`, or null when nothing matched.
 *
 * Lifted verbatim out of `admin/optimizeRoute.ts`, which is now its only other
 * caller, so the household coordinate an arrival is checked against and the one
 * the route optimizer drives to come from one request shape. Behaviour is
 * unchanged from that file: a non-OK response throws (an outage is not a
 * no-match), a match with no coordinates returns null.
 */
export async function mapboxForwardGeocode(
  address: string,
  token: string,
): Promise<{ lon: number; lat: number } | null> {
  const params = new URLSearchParams({ q: address, limit: '1', country: 'us', access_token: token });
  const resp = await fetch(`${MAPBOX_FORWARD_URL}?${params}`);
  if (!resp.ok) throw new HttpsError('unavailable', `mapbox_geocode_${resp.status}`);
  const body = (await resp.json()) as {
    features?: Array<{ geometry?: { coordinates?: unknown } }>;
  };
  const coords = body?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return { lon: Number(coords[0]), lat: Number(coords[1]) };
}

export type GeocodeOutcome =
  | { ok: true; location: ServiceLocation }
  | { ok: false; reason: GeocodeFailure };

/**
 * Geocode one address into a storable coordinate.
 *
 * Three outcomes, never a throw: a caller here is always on a path where the
 * visit must survive the geocoder being down. `no_match` and
 * `geocoder_unavailable` stay separate because they mean different things to an
 * operator — one is a typo in the address, the other is Mapbox.
 */
export async function geocodeHouseholdAddress(
  address: string,
  token: string,
  now: () => string = () => new Date().toISOString(),
): Promise<GeocodeOutcome> {
  const trimmed = address.trim();
  if (trimmed === '') return { ok: false, reason: 'no_address' };
  if (token.trim() === '') return { ok: false, reason: 'geocoder_unavailable' };
  let hit: { lon: number; lat: number } | null;
  try {
    hit = await mapboxForwardGeocode(trimmed, token);
  } catch {
    return { ok: false, reason: 'geocoder_unavailable' };
  }
  if (!hit || !isValidLatLng({ lat: hit.lat, lng: hit.lon })) {
    return { ok: false, reason: 'no_match' };
  }
  return {
    ok: true,
    location: {
      lat: hit.lat,
      lng: hit.lon,
      geocodedFrom: trimmed,
      geocodedAt: now(),
      provider: 'mapbox',
    },
  };
}

/** The patch that records a success, clearing any previous failure. */
export function serviceLocationPatch(location: ServiceLocation): Record<string, unknown> {
  return { serviceLocation: location, serviceLocationError: null };
}

/** The patch that records a failure, leaving any previous coordinate alone. */
export function serviceLocationErrorPatch(
  address: string,
  reason: GeocodeFailure,
  at: string,
): Record<string, unknown> {
  return { serviceLocationError: { address, reason, at } satisfies ServiceLocationError };
}

// ── Reading one household's coordinate, geocoding it if it has none ──────────

export type HouseholdLocationLookup =
  | { found: true; location: ServiceLocation; geocodedNow: boolean }
  | { found: false; reason: GeocodeFailure | 'no_household' };

/**
 * The coordinate for one household, geocoding and storing it if the record does
 * not have one yet.
 *
 * THE LAZY TOP-UP, and why it exists alongside the trigger. Every household on
 * file when this ships has an address and no coordinate, and nothing will edit
 * those addresses to make the trigger fire. Rather than a one-shot backfill
 * script that has to be remembered, run, and then is dead code, the first
 * arrival at a household pays for its geocode and every arrival after it is
 * free. A known-bad address is retried here — unlike in the trigger — because
 * this path only runs when somebody is actually standing at the house, which is
 * rare enough to be worth one more attempt and is the moment a transient Mapbox
 * failure is worth re-testing.
 */
export async function resolveHouseholdLocation(
  firestore: Firestore,
  kinfolkId: string,
  token: string,
): Promise<HouseholdLocationLookup> {
  if (!kinfolkId) return { found: false, reason: 'no_household' };
  const ref = firestore.collection(HOUSEHOLD_COLLECTION).doc(kinfolkId);
  const snap = await ref.get();
  if (!snap.exists) return { found: false, reason: 'no_household' };
  const data = (snap.data() ?? {}) as Record<string, unknown>;

  const address = pickHouseholdAddress(data);
  if (isServiceLocationFresh(data, address)) {
    return { found: true, location: readServiceLocation(data)!, geocodedNow: false };
  }
  if (address === '') return { found: false, reason: 'no_address' };

  const outcome = await geocodeHouseholdAddress(address, token);
  if (!outcome.ok) {
    await ref
      .set(serviceLocationErrorPatch(address, outcome.reason, new Date().toISOString()), {
        merge: true,
      })
      .catch(() => undefined);
    return { found: false, reason: outcome.reason };
  }
  await ref.set(serviceLocationPatch(outcome.location), { merge: true }).catch(() => undefined);
  return { found: true, location: outcome.location, geocodedNow: true };
}
