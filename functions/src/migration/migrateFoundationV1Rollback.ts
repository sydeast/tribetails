import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ familyId: z.string().min(1) });

export async function migrateFoundationV1RollbackHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const { familyId } = Args.parse(req.data);
  const familyRef = db().doc(`families/${familyId}`);
  const snap = await familyRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'family not found');
  const membersSnap = await db().collection(`families/${familyId}/members`).get();
  await db().runTransaction(async (tx) => {
    for (const d of membersSnap.docs) {
      const data = d.data() as { role?: string };
      if (data.role === 'PRIMARY') {
        tx.set(d.ref, { role: 'ADMIN', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      tx.update(d.ref, {
        secondaryLabel: FieldValue.delete(),
        permissions: FieldValue.delete(),
        status: FieldValue.delete(),
      });
    }
    tx.update(familyRef, {
      displayName: FieldValue.delete(),
      primaryUid: FieldValue.delete(),
      themeConfigRef: FieldValue.delete(),
      'flags.foundationV1MigratedAt': FieldValue.delete(),
    });
  });
  await writeAuditEntry({
    event: AUDIT_EVENTS.MEMBERSHIP_TRIBE_MIGRATED_V1,
    severity: 'critical',
    actorRole: 'AUNTIE', actorUid: req.auth!.uid,
    familyId,
    payload: { rollback: true },
  });
  return { ok: true };
}

export const migrateFoundationV1Rollback = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, timeoutSeconds: 540, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('migrateFoundationV1Rollback', migrateFoundationV1RollbackHandler),
);
