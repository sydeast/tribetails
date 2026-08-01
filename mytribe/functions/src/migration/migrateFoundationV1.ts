import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { computeFamilyDiff, type FamilyDiff } from './migrationDiff';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().optional(),
  dryRun: z.boolean().default(true),
  force: z.boolean().default(false),
});

async function migrateOne(fid: string, dryRun: boolean, force: boolean): Promise<FamilyDiff> {
  const familySnap = await db().doc(`families/${fid}`).get();
  if (!familySnap.exists) throw new HttpsError('not-found', `family ${fid} not found`);
  const family = familySnap.data() as never;
  if (!force && (family as any).flags?.foundationV1MigratedAt) {
    return { skipped: true, familyUpdates: {}, memberUpdates: [] };
  }
  const membersSnap = await db().collection(`families/${fid}/members`).get();
  const members = membersSnap.docs.map((d) => ({ id: d.id, data: d.data() as never }));
  const diff = computeFamilyDiff(fid, family as never, members);
  if (dryRun) {
    await db().collection('migrationReports').add({
      tribeId: fid,
      kind: 'foundationV1.dryRun',
      diff,
      generatedAt: FieldValue.serverTimestamp(),
    });
    return diff;
  }
  await db().runTransaction(async (tx) => {
    tx.set(db().doc(`families/${fid}`), { ...diff.familyUpdates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (diff.themeConfigStub) {
      tx.set(db().doc(`families/${fid}/themeConfig/active`), {
        ...diff.themeConfigStub, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    for (const m of diff.memberUpdates) {
      tx.set(db().doc(`families/${fid}/members/${m.uid}`), {
        ...m, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.update(db().doc(`families/${fid}`), {
      'flags.foundationV1MigratedAt': FieldValue.serverTimestamp(),
    });
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEMBERSHIP_TRIBE_MIGRATED_V1,
    severity: 'info',
    actorRole: 'AUNTIE',
    familyId: fid,
    payload: { dryRun: false, memberCount: diff.memberUpdates.length },
  });
  return diff;
}

export async function migrateFoundationV1Handler(req: CallableRequest<unknown>): Promise<{ migrated: string[]; dryRun: boolean }> {
  const args = Args.parse(req.data);
  const ids: string[] = [];
  if (args.familyId) {
    await migrateOne(args.familyId, args.dryRun, args.force);
    ids.push(args.familyId);
  } else {
    const snap = await db().collection('families').get();
    for (const d of snap.docs) {
      try { await migrateOne(d.id, args.dryRun, args.force); ids.push(d.id); }
      catch (err) {
        await writeAuditEntry({
          status: 'FAILURE',
          event: AUDIT_EVENTS.ERROR_FUNCTION_FAILURE,
          severity: 'critical', actorRole: 'AUNTIE', familyId: d.id,
          payload: { function: 'migrateFoundationV1', message: (err as Error).message },
        });
      }
    }
  }
  return { migrated: ids, dryRun: args.dryRun };
}

export const migrateFoundationV1 = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, timeoutSeconds: 540, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('migrateFoundationV1', migrateFoundationV1Handler),
);
