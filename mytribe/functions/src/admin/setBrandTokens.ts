import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({ familyId: z.string().min(1), brandTokens: z.record(z.string(), z.unknown()) });

export async function setBrandTokensHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  await db().doc(`families/${args.familyId}/themeConfig/active`).set(
    { brandTokens: args.brandTokens, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.THEME_BRAND_TOKENS_UPDATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: { keys: Object.keys(args.brandTokens) },
  });
  return { ok: true };
}

export const setBrandTokens = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setBrandTokens', setBrandTokensHandler),
);
