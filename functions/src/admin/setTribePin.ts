import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ familyId: z.string().min(1), plaintextPin: z.string().min(4).max(8) });

export async function setTribePinHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  const pepper = process.env.TRIBE_PIN_PEPPER ?? '';
  const hash = await argon2.hash(args.plaintextPin + pepper, { type: argon2.argon2id });
  await db().runTransaction(async (tx) => {
    tx.set(db().doc(`families/${args.familyId}/secrets/tribePin`), {
      hash, createdAt: FieldValue.serverTimestamp(), lastChangedAt: FieldValue.serverTimestamp(), lastChangedBy: 'auntie',
    });
    tx.update(db().doc(`families/${args.familyId}`), {
      'flags.tribePinSet': true, 'flags.tribePinChangePending': false, updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await writeAuditEntry({
    event: AUDIT_EVENTS.SECRETS_TRIBEPIN_SET,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: {},
  });
  return { ok: true };
}

export const setTribePin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['TRIBE_PIN_PEPPER', 'SENTRY_DSN'] },
  wrapAdminCallable('setTribePin', setTribePinHandler),
);
