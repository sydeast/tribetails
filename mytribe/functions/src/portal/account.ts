import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, auth as authAdmin } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { normalizeE164 } from '../lib/phoneNormalize';
import { initSentry } from '../lib/sentry';
import { isStaff } from '../lib/staffGate';
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
  /**
   * True when an OPERATOR (admin claim) is viewing a household that is not one
   * of their own. In that case this DTO describes the impersonated household's
   * primary account, not the signed-in operator, and the portal renders it
   * read-only. False for a normal kinfolk viewing their own account.
   */
  impersonated: boolean;
}

const GetAccountArgs = z.object({ kinfolkId: z.string().min(1).max(200).optional() });

/** Maps a `clients/{uid}` doc + Auth user onto the wire DTO. */
function toAccountDto(
  uid: string,
  data: Record<string, unknown>,
  authUser: { email?: string; displayName?: string; phoneNumber?: string; photoURL?: string } | null,
  impersonated: boolean,
): AccountDto {
  const ts = data['updatedAt'];
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
    updatedAtMs: ts instanceof Timestamp ? ts.toMillis() : null,
    impersonated,
  };
}

export async function getMyAccountHandler(req: CallableRequest<unknown>): Promise<AccountDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const requestedKinfolkId = GetAccountArgs.parse(req.data ?? {}).kinfolkId;
  // Must go through isStaff, exactly like getMyAccess and resolveKinfolkAccess.
  // This read `req.auth?.token?.admin === true` directly, which re-opened the
  // CWE-863 split that lib/staffGate.ts exists to close: an operator on the
  // AUNTIE_OPERATOR_UIDS allowlist without the admin claim passed every other
  // gate, picked a household, and then got impersonated:false here. The screen
  // derives its read-only state from that flag, so they were handed an EDITABLE
  // form holding their own name, phone and backup contacts, captioned as the
  // household they had stepped into, and Save wrote to the operator's record.
  const isOperator = isStaff(uid, req.auth?.token?.admin === true, 'getMyAccount');
  const firestore = db();

  // Always read the caller's own client doc first so we know which households
  // are genuinely theirs. A kinfolk viewing their own account, or an operator
  // whose own household happens to be the active pick, follows the normal path.
  const ownSnap = await firestore.collection('clients').doc(uid).get();
  const ownData = (ownSnap.data() ?? {}) as Record<string, unknown>;
  const ownKinfolkIds = Array.isArray(ownData['kinfolkIds']) ? (ownData['kinfolkIds'] as string[]) : [];

  // Impersonation is ONLY for an operator (admin claim) viewing a household that
  // is not their own. A non-operator passing someone else's kinfolkId is ignored
  // (falls through to their own account) so a kinfolk can never read another
  // household's contact details.
  const impersonating = !!requestedKinfolkId && isOperator && !ownKinfolkIds.includes(requestedKinfolkId);

  if (impersonating) {
    const ownerSnap = await firestore
      .collection('clients')
      .where('kinfolkIds', 'array-contains', requestedKinfolkId)
      .limit(1)
      .get();
    if (ownerSnap.docs.length === 0) {
      // Household has no linked portal account yet. Return an empty impersonated
      // record (not the operator's own) so the profile still reflects "the
      // household being viewed", not the admin. The display name is filled by the
      // screen from getMyHome, which does not depend on a client account existing.
      return {
        uid: '', email: null, displayName: null, phone: null, photoUrl: null,
        backupEmail: null, backupPhone: null, kinfolkIds: [requestedKinfolkId],
        hasPaymentMethod: false, updatedAtMs: null, impersonated: true,
      };
    }
    const ownerDoc = ownerSnap.docs[0];
    const ownerUid = ownerDoc.id;
    const ownerData = (ownerDoc.data() ?? {}) as Record<string, unknown>;
    const ownerAuth = await authAdmin().getUser(ownerUid).catch(() => null);
    return toAccountDto(ownerUid, ownerData, ownerAuth, true);
  }

  const authUser = await authAdmin().getUser(uid).catch(() => null);
  return toAccountDto(uid, ownData, authUser, false);
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
  // AUNTIE_OPERATOR_UIDS is required because isStaff reads it. Binding it is not
  // optional: without it the allowlist arm of isStaff silently evaluates false,
  // which is the exact operator this handler's impersonation branch is for.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'], minInstances: 1 },
  wrapCallable('getMyAccount', getMyAccountHandler),
);

export const saveMyAccount = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('saveMyAccount', saveMyAccountHandler),
);
