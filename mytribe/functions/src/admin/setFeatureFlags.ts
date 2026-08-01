import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Admin-only setter for global feature flags. Writes (merges) the provided
 * `{ key: bool }` map into `business_settings/feature_flags.flags`, the same doc
 * `getFeatureFlags` reads. Used by the AuntieOS Feature Flags admin screen so
 * operators can toggle the central `auntieos.*` flags at runtime instead of
 * hand-editing Firestore.
 *
 * Keys must be dotted namespaces (e.g. `auntieos.schedule.newVisit`); values
 * must be booleans. Unspecified flags are preserved (Firestore map merge).
 */
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

const SetFlagsSchema = z.object({
  flags: z.record(z.string().regex(KEY_RE), z.boolean()),
});

export async function setFeatureFlagsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; flags: Record<string, boolean> }> {
  initSentry();
  const parsed = SetFlagsSchema.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Expected { flags: { "<dotted.key>": boolean } }.');
  }
  const { flags } = parsed.data;
  const keys = Object.keys(flags);
  if (keys.length === 0) throw new HttpsError('invalid-argument', 'No flags provided.');
  if (keys.length > 200) throw new HttpsError('invalid-argument', 'Too many flags in one call.');

  // Firestore map-merge: only the supplied keys are written; others preserved.
  await db().collection('business_settings').doc('feature_flags').set({ flags }, { merge: true });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.ADMIN_FEATURE_FLAGS_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    targetCollection: 'business_settings',
    targetUid: 'feature_flags',
    description: `Updated ${keys.length} feature flag(s): ${keys.join(', ')}`,
    payload: { flags },
  });

  return { ok: true, flags };
}

export const setFeatureFlags = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setFeatureFlags', setFeatureFlagsHandler),
);
