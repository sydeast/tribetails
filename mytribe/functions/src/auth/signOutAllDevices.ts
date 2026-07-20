import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { wrapCallable } from '../lib/wrapCallable';
import { auth } from '../lib/firestoreAdmin';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

export async function signOutAllDevicesHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  await auth().revokeRefreshTokens(req.auth.uid);
  await writeAuditEntry({
    event: AUDIT_EVENTS.AUTH_LOGOUT_ALL,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    payload: {},
  });
  return { ok: true };
}

export const signOutAllDevices = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('signOutAllDevices', signOutAllDevicesHandler),
);
