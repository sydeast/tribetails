import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * A device platform, spelled the way the clients actually send it: a base
 * platform, plus an optional suffix naming which of our apps is on the device.
 *
 * This replaces the enum `['android', 'web', 'jvm']`, which the AuntieOS admin
 * Android app satisfied ('android') and the kinfolk portal did not. The
 * portal's Kotlin `pushPlatform` is declared per target and reads
 * 'android-mytribe' / 'web-mytribe' / 'desktop-mytribe'
 * (mytribe/src/*Main/kotlin/com/kinfolk/portal/push/PushToken.*.kt), so every
 * portal registration was rejected by Zod and the device silently never got a
 * push (MYTRIBE-FUNCTIONS-A). The SERVER moved rather than the clients because
 * the Android app already in the field cannot be updated remotely, and a
 * dropped token registration is the one outcome worse than a noisy one.
 *
 * The suffix is stored as sent rather than normalised away: which app a token
 * belongs to is exactly what "why did this device not get it" needs, and
 * nothing reads the field to branch on (pushChannel finds devices with
 * `where('uid','==',...)`; the value is otherwise only logged).
 *
 * Still a closed grammar, so a typo or a junk payload is still refused.
 */
const PLATFORM_PATTERN = /^(android|ios|web|jvm|desktop)(-[a-z0-9]+)*$/;

const Args = z.object({
  token: z.string().min(10),
  platform: z
    .string()
    .max(40)
    .regex(
      PLATFORM_PATTERN,
      "platform must be android, ios, web, jvm or desktop, optionally with an app suffix (e.g. 'android-mytribe')",
    ),
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
