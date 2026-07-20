import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { SaveArgs } from '../notifications/prefsSchema';
import type { UserNotificationPrefs } from '../notifications/types';

/**
 * The ADMIN's OWN notification receive-preferences.
 *
 * Same model as the kinfolk portal prefs, but for the operator: stored at
 * `staff/{uid}.notificationPrefs`. The dispatcher already honors these via
 * `loadUserPrefs(uid, 'staff')` in resolveChannels. These callables back the
 * admin's notification settings screen in AuntieOS, where the operator picks,
 * within the channels the business gate enabled, which they actually receive.
 *
 * Admin-gated by wrapAdminCallable. The handler writes the CALLER's own staff
 * doc (req.auth.uid), so an admin can only edit their own prefs.
 */

interface PrefsDto {
  prefs: UserNotificationPrefs;
  updatedAtMs: number | null;
}

export async function getMyAdminNotificationPrefsHandler(
  req: CallableRequest<unknown>,
): Promise<PrefsDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection('staff').doc(uid).get();
  const data = snap.data() ?? {};
  const prefs = (data['notificationPrefs'] as UserNotificationPrefs | undefined) ?? {};
  const ts = data['notificationPrefsUpdatedAt'];
  const updatedAtMs =
    ts && typeof (ts as { toMillis?: () => number }).toMillis === 'function'
      ? (ts as { toMillis(): number }).toMillis()
      : null;

  return { prefs, updatedAtMs };
}

export async function saveMyAdminNotificationPrefsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = SaveArgs.parse(req.data);
  await db().collection('staff').doc(uid).set(
    {
      notificationPrefs: args.prefs,
      notificationPrefsUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logEvent({ severity: 'info', function: 'saveMyAdminNotificationPrefs', event: 'admin.prefs.saved', uid });
  return { ok: true };
}

export const getMyAdminNotificationPrefs = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getMyAdminNotificationPrefs', getMyAdminNotificationPrefsHandler),
);

export const saveMyAdminNotificationPrefs = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveMyAdminNotificationPrefs', saveMyAdminNotificationPrefsHandler),
);
