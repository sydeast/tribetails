import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  newEmail: z.string().email().optional(),
  newPhone: z.string().min(8).optional(),
}).refine((v) => v.newEmail || v.newPhone, { message: 'one of newEmail/newPhone required' });

export async function swapPrimaryContactHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  const ref = db().doc(`clients/${req.auth.uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'client not found');
  const data = snap.data() as { lastContactSwapAt?: { toMillis: () => number } };
  if (data.lastContactSwapAt && Date.now() - data.lastContactSwapAt.toMillis() < 86400000) {
    throw new HttpsError('resource-exhausted', 'too soon since last swap');
  }
  await ref.update({
    ...(args.newEmail && { email: args.newEmail }),
    ...(args.newPhone && { phone: args.newPhone }),
    lastContactSwapAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUTH_CONTACT_SWAPPED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    payload: { changedEmail: !!args.newEmail, changedPhone: !!args.newPhone },
  });
  return { ok: true };
}

export const swapPrimaryContact = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('swapPrimaryContact', swapPrimaryContactHandler),
);
