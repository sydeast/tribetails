import { call } from '../lib/fns';

/**
 * Mapbox Search Box address autocomplete, proxied through MyTribe.
 *
 * The browser NEVER holds a Mapbox key. `mapboxSearch` / `mapboxRetrieve`
 * (`mytribe/functions/src/portal/mapboxSearch.ts`) hold `MAPBOX_ACCESS_TOKEN`
 * as a Functions secret and forward to `api.mapbox.com` server-side. Both are
 * `wrapCallable`, so any signed-in caller qualifies, which an admin session is.
 * That is the whole reason web could not ship this before: there was no
 * transport that did not mean publishing a token to the bundle.
 *
 * SESSION BILLING, the one rule a caller must not get wrong. Mapbox bills a
 * "search session", not a request: every `suggest` a user types plus the single
 * `retrieve` for the address they pick count as ONE session when they carry the
 * same `sessionToken`. Generate one token per search, reuse it across every
 * keystroke, pass the SAME token to `mapboxRetrieve`, and rotate only AFTER the
 * retrieve lands. A fresh token per keystroke bills each keystroke as its own
 * session, which multiplies the bill by however fast the operator types.
 * See https://docs.mapbox.com/api/search/search-box/#session-billing
 */

export interface MapboxSuggestion {
  name: string;
  fullAddress: string;
  mapboxId: string;
  placeFormatted: string;
}

/** Raw `suggest` row as the callable returns it (Mapbox's snake_case, passed through). */
interface SuggestionWire {
  name?: unknown;
  full_address?: unknown;
  mapbox_id?: unknown;
  place_formatted?: unknown;
}

interface SuggestWire {
  suggestions?: SuggestionWire[];
}

interface RetrieveWire {
  feature?: { properties?: { name?: unknown; full_address?: unknown; place_formatted?: unknown } } | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * A 32-char hex session token. `crypto.getRandomValues` where it exists, which
 * is every browser this app runs in and jsdom; the `Math.random` path exists so
 * a node test environment without webcrypto cannot throw. Uniqueness within one
 * search session is all this needs, it is a billing grouping key and not a
 * secret, so the fallback is not a security downgrade.
 */
export function newMapboxSessionToken(): string {
  const bytes = new Uint8Array(16);
  const webcrypto = globalThis.crypto as Crypto | undefined;
  if (webcrypto?.getRandomValues !== undefined) {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Address suggestions for a partial query. Throws on a callable failure rather
 * than returning `[]`: an empty list and a failed lookup look identical to a
 * component, and the operator has to be told which one happened.
 */
export async function mapboxSuggest(query: string, sessionToken: string, limit = 5): Promise<MapboxSuggestion[]> {
  const res = await call<{ query: string; sessionToken: string; limit: number; country: string }, SuggestWire>(
    'mapboxSearch',
    // `country: 'us'` matches the android geocoding call this replaces. Auntie
    // serves one metro; unfiltered results put a same-named street in another
    // country at the top of the list.
    { query, sessionToken, limit, country: 'us' },
  );
  const rows = Array.isArray(res.suggestions) ? res.suggestions : [];
  return rows.map((s) => ({
    name: str(s.name),
    fullAddress: str(s.full_address),
    mapboxId: str(s.mapbox_id),
    placeFormatted: str(s.place_formatted),
  }));
}

/**
 * Resolves a picked suggestion to its full street address. Must be called with
 * the same `sessionToken` the suggests used (see the session-billing note above).
 *
 * Throws when Mapbox returns no usable address instead of resolving to `''`:
 * writing an empty string back would erase whatever the operator had typed, on
 * a required field, as the result of a click that looked like it succeeded.
 */
export async function mapboxRetrieve(mapboxId: string, sessionToken: string): Promise<string> {
  const res = await call<{ mapboxId: string; sessionToken: string }, RetrieveWire>('mapboxRetrieve', {
    mapboxId,
    sessionToken,
  });
  const props = res.feature?.properties;
  const resolved = str(props?.full_address).trim() || str(props?.name).trim();
  if (resolved === '') throw new Error('Mapbox returned no address for that suggestion.');
  return resolved;
}
