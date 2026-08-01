import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  requestId: z.string().min(1),
  newPlaintextPin: z.string().min(4).max(8),
});

export async function approveTribePinChangeHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  const familyRef = db().doc(`families/${args.familyId}`);
  const familySnap = await familyRef.get();
  if (!familySnap.exists) throw new HttpsError('not-found', 'family not found');
  const flags = (familySnap.data() as { flags?: { tribePinChangePending?: boolean } }).flags;
  if (!flags?.tribePinChangePending) {
    throw new HttpsError('failed-precondition', 'no pending tribePin change');
  }
  const pepper = process.env.TRIBE_PIN_PEPPER ?? '';
  const hash = await argon2.hash(args.newPlaintextPin + pepper, { type: argon2.argon2id });
  await db().runTransaction(async (tx) => {
    tx.set(db().doc(`families/${args.familyId}/secrets/tribePin`), {
      hash,
      lastChangedAt: FieldValue.serverTimestamp(),
      lastChangedBy: 'auntie',
    }, { merge: true });
    tx.update(familyRef, {
      'flags.tribePinSet': true,
      'flags.tribePinChangePending': false,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.SECRETS_TRIBEPIN_VALIDATED,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: { requestId: args.requestId },
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.SECRETS_TRIBEPIN_SET,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: { source: 'change-request', requestId: args.requestId },
  });
  return { ok: true };
}

export const approveTribePinChange = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['TRIBE_PIN_PEPPER', 'SENTRY_DSN'] },
  wrapAdminCallable('approveTribePinChange', approveTribePinChangeHandler),
);
