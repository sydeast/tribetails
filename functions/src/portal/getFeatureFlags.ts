import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface FeatureFlagsDto {
  /** key -> bool, already merged (global overlaid by per-tester). The client
   *  applies these over its own compile-time defaults, so only flags actually
   *  set somewhere need to appear here. */
  flags: Record<string, boolean>;
}

/** Keeps only boolean-valued entries from an arbitrary object. */
function boolMap(v: unknown): Record<string, boolean> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

/**
 * Resolves MyTribe feature flags for the signed-in kinfolk.
 *
 * Two override layers, per-tester wins:
 *   - global:   business_settings/feature_flags  (a `{ flags: {...} }` doc, or a
 *               flat `{ key: bool }` doc, both accepted)
 *   - perUser:  clients/{uid}.featureFlags        (a `{ key: bool }` map)
 *
 * The client (FeatureFlags.fromOverrides) layers the result over its compile-time
 * defaults and ignores any key it does not recognize, so this handler does not
 * need to know the flag catalog.
 */
export async function getFeatureFlagsHandler(
  req: CallableRequest<unknown>,
): Promise<FeatureFlagsDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const [globalSnap, clientSnap] = await Promise.all([
    db().collection('business_settings').doc('feature_flags').get(),
    db().collection('clients').doc(uid).get(),
  ]);

  const globalData = globalSnap.data() ?? {};
  const global = boolMap((globalData as Record<string, unknown>)['flags'] ?? globalData);
  const perUser = boolMap((clientSnap.data() ?? {})['featureFlags']);
  const flags = { ...global, ...perUser };

  logEvent({
    severity: 'info',
    function: 'getFeatureFlags',
    event: 'portal.featureFlags.resolved',
    uid,
  });
  return { flags };
}

export const getFeatureFlags = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getFeatureFlags', getFeatureFlagsHandler),
);
