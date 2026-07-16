import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  token: z.string().min(10),
  platform: z.enum(['android', 'web', 'jvm']),
  appVersion: z.string().max(40).optional(),
});

/**
 * Stores an FCM device token so AuntieOS / scheduled jobs can target this user.
 * Doc id is the token itself (deduped). Caller's uid is recorded.
 */
export async function registerFcmTokenHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  await db().collection('fcm_tokens').doc(args.token).set(
    {
      uid,
      token: args.token,
      platform: args.platform,
      appVersion: args.appVersion ?? null,
      updatedAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'registerFcmToken',
    event: 'portal.fcm.registered',
    uid,
    extra: { platform: args.platform },
  });
  return { ok: true };
}

const UnregArgs = z.object({ token: z.string().min(10) });

export async function unregisterFcmTokenHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = UnregArgs.parse(req.data);
  // Only delete if it belongs to this caller, defense in depth on top of rules.
  const ref = db().collection('fcm_tokens').doc(args.token);
  const snap = await ref.get();
  if (snap.exists && snap.data()?.uid === uid) {
    await ref.delete();
  }
  return { ok: true };
}

export const registerFcmToken = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('registerFcmToken', registerFcmTokenHandler),
);

export const unregisterFcmToken = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('unregisterFcmToken', unregisterFcmTokenHandler),
);
