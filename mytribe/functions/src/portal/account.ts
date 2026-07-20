import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, auth as authAdmin } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { normalizeE164 } from '../lib/phoneNormalize';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface AccountDto {
  uid: string;
  email: string | null;
  displayName: string | null;
  phone: string | null;
  /** Cloudinary or any HTTPS image URL, surfaced in MyTribe AccountSettings. */
  photoUrl: string | null;
  backupEmail: string | null;
  backupPhone: string | null;
  kinfolkIds: string[];
  hasPaymentMethod: boolean;
  updatedAtMs: number | null;
}

export async function getMyAccountHandler(req: CallableRequest<unknown>): Promise<AccountDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const [clientSnap, authUser] = await Promise.all([
    firestore.collection('clients').doc(uid).get(),
    authAdmin().getUser(uid).catch(() => null),
  ]);
  const data = (clientSnap.data() ?? {}) as Record<string, unknown>;
  const ts = data['updatedAt'];
  const updatedAtMs = ts instanceof Timestamp ? ts.toMillis() : null;

  return {
    uid,
    email: authUser?.email ?? (typeof data['email'] === 'string' ? (data['email'] as string) : null),
    displayName:
      authUser?.displayName ??
      (typeof data['displayName'] === 'string' ? (data['displayName'] as string) : null),
    phone:
      authUser?.phoneNumber ??
      (typeof data['phone'] === 'string' ? (data['phone'] as string) : null),
    photoUrl:
      authUser?.photoURL ??
      (typeof data['photoUrl'] === 'string' ? (data['photoUrl'] as string) : null),
    backupEmail: typeof data['backupEmail'] === 'string' ? (data['backupEmail'] as string) : null,
    backupPhone: typeof data['backupPhone'] === 'string' ? (data['backupPhone'] as string) : null,
    kinfolkIds: Array.isArray(data['kinfolkIds']) ? (data['kinfolkIds'] as string[]) : [],
    hasPaymentMethod: data['stripePaymentMethodId'] != null,
    updatedAtMs,
  };
}

const SaveArgs = z.object({
  displayName: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  /** HTTPS-only, must start with https:// to keep mixed-content + SSRF risk down. */
  photoUrl: z.string().url().regex(/^https:\/\//).max(2_000).nullable().optional(),
  backupEmail: z.string().email().max(200).nullable().optional(),
  backupPhone: z.string().max(40).nullable().optional(),
});

export async function saveMyAccountHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = SaveArgs.parse(req.data);
  const firestore = db();
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  if (args.phone !== undefined) {
    try {
      update['phone'] = normalizeE164(args.phone);
    } catch (err) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
  }
  if (args.photoUrl !== undefined) update['photoUrl'] = args.photoUrl;
  if (args.backupEmail !== undefined) update['backupEmail'] = args.backupEmail;
  if (args.backupPhone !== undefined) {
    try {
      update['backupPhone'] = normalizeE164(args.backupPhone);
    } catch (err) {
      throw new HttpsError('invalid-argument', (err as Error).message);
    }
  }

  await firestore.collection('clients').doc(uid).set(update, { merge: true });

  // Mirror displayName + photoURL to Firebase Auth profile when provided.
  if (args.displayName !== undefined || args.photoUrl !== undefined) {
    try {
      const authUpdate: { displayName?: string; photoURL?: string | null } = {};
      if (args.displayName !== undefined) authUpdate.displayName = args.displayName;
      if (args.photoUrl !== undefined) authUpdate.photoURL = args.photoUrl;
      await authAdmin().updateUser(uid, authUpdate);
    } catch {
      // best-effort; Firestore doc still has it
    }
  }

  logEvent({ severity: 'info', function: 'saveMyAccount', event: 'portal.account.saved', uid, extra: { fields: Object.keys(update) } });
  return { ok: true };
}

export const getMyAccount = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], minInstances: 1 },
  wrapCallable('getMyAccount', getMyAccountHandler),
);

export const saveMyAccount = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('saveMyAccount', saveMyAccountHandler),
);
