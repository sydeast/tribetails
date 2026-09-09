import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Mapbox secret access token. Held server-side so the kinfolk app bundle never
 * ships a Mapbox key. Mirrors the AuntieOS-side `MAPBOX_ACCESS_TOKEN` secret
 *, they can share the same value.
 *
 * ALWAYS READ IT THROUGH `.trim()`. A secret version added with `echo` rather
 * than `printf` stores a trailing newline, and Secret Manager hands the bytes
 * back exactly as stored. `URLSearchParams` then percent-encodes it, so the
 * request carries `access_token=pk.%E2%80%A6%0A`, Mapbox does not recognise the
 * token, and answers 401 with a perfectly valid credential in the secret. That
 * is MYTRIBE-FUNCTIONS-D: 29 `mapbox_401`s in under two minutes from one
 * operator typing into the address field, while `getLocalWeather`,
 * `optimizeRoute`, `verifyVisitArrival` and `onKinfolkAddressWrite`, every one
 * of which already trimmed, kept working off the same secret.
 */
const MAPBOX_ACCESS_TOKEN = defineSecret('MAPBOX_ACCESS_TOKEN');

interface SuggestRequest {
  query: string;
  sessionToken: string;
  limit?: number;
  country?: string;
}

interface SuggestionDto {
  name: string;
  full_address: string;
  mapbox_id: string;
  place_formatted: string;
}

interface SuggestResult {
  suggestions: SuggestionDto[];
  signedBy: 'mapboxSearch';
}

interface RetrieveRequest {
  mapboxId: string;
  sessionToken: string;
}

/** Mapbox Search Box autocomplete proxy, kinfolk-authed. */
export async function mapboxSearchHandler(
  req: CallableRequest<SuggestRequest>,
): Promise<SuggestResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { query, sessionToken, limit, country } = req.data || ({} as SuggestRequest);
  if (!query || query.length < 2) return { suggestions: [], signedBy: 'mapboxSearch' };
  if (!sessionToken || sessionToken.length < 8) {
    throw new HttpsError('invalid-argument', 'sessionToken required');
  }

  const token = MAPBOX_ACCESS_TOKEN.value().trim();
  if (!token) throw new HttpsError('failed-precondition', 'mapbox_signing_not_configured');

  const params = new URLSearchParams({
    q: query,
    access_token: token,
    session_token: sessionToken,
    limit: String(Math.max(1, Math.min(limit ?? 5, 10))),
  });
  if (country) params.set('country', country);

  const resp = await fetch(`https://api.mapbox.com/search/searchbox/v1/suggest?${params}`);
  if (!resp.ok) {
    logEvent({ severity: 'warn', function: 'mapboxSearch', event: 'mapbox.suggest.failed', uid, extra: { status: resp.status } });
    throw new HttpsError('unavailable', `mapbox_${resp.status}`);
  }
  const body = (await resp.json()) as { suggestions?: SuggestionDto[] };
  return { suggestions: body.suggestions ?? [], signedBy: 'mapboxSearch' };
}

/** Mapbox Search Box retrieve proxy, kinfolk-authed. */
export async function mapboxRetrieveHandler(
  req: CallableRequest<RetrieveRequest>,
): Promise<{ feature: unknown; signedBy: 'mapboxRetrieve' }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { mapboxId, sessionToken } = req.data || ({} as RetrieveRequest);
  if (!mapboxId) throw new HttpsError('invalid-argument', 'mapboxId required');
  if (!sessionToken || sessionToken.length < 8) {
    throw new HttpsError('invalid-argument', 'sessionToken required');
  }

  const token = MAPBOX_ACCESS_TOKEN.value().trim();
  if (!token) throw new HttpsError('failed-precondition', 'mapbox_signing_not_configured');

  const params = new URLSearchParams({
    access_token: token,
    session_token: sessionToken,
  });
  const resp = await fetch(`https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(mapboxId)}?${params}`);
  if (!resp.ok) {
    logEvent({ severity: 'warn', function: 'mapboxRetrieve', event: 'mapbox.retrieve.failed', uid, extra: { status: resp.status } });
    throw new HttpsError('unavailable', `mapbox_${resp.status}`);
  }
  const body = (await resp.json()) as { features?: unknown[] };
  return { feature: body.features?.[0] ?? null, signedBy: 'mapboxRetrieve' };
}

export const mapboxSearch = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: [MAPBOX_ACCESS_TOKEN, 'SENTRY_DSN'] },
  wrapCallable('mapboxSearch', mapboxSearchHandler),
);

export const mapboxRetrieve = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: [MAPBOX_ACCESS_TOKEN, 'SENTRY_DSN'] },
  wrapCallable('mapboxRetrieve', mapboxRetrieveHandler),
);
