import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  contactMethod: z.enum(['email', 'phone']),
  newContact: z.string().min(3),
});

const RATE_KEY_PREFIX = 'recoveryRateLimit';

export async function requestPrimaryRecoveryHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  const ip = req.rawRequest.ip ?? 'unknown';
  const rateRef = db().doc(`${RATE_KEY_PREFIX}/${ip}::${args.familyId}`);
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const limit = 3;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(rateRef);
    const arr: number[] = (snap.data() as { hits?: number[] } | undefined)?.hits ?? [];
    const recent = arr.filter((t) => now - t < window);
    if (recent.length >= limit) throw new HttpsError('resource-exhausted', 'rate-limited');
    recent.push(now);
    tx.set(rateRef, { hits: recent });
  });
  // WARNING-20: hash the REAL requested contact so the operator can verify the
  // claimant against it during recovery review, instead of storing a constant
  // placeholder that matched every request. Never store the raw contact.
  const newContactHash = crypto
    .createHash('sha256')
    .update(args.newContact.trim().toLowerCase())
    .digest('hex');
  await db().collection('recoveryRequests').add({
    tribeId: args.familyId,
    method: args.contactMethod,
    newContactHash,
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
  });
  if (process.env.AUNTIE_NOTIFY_EMAIL) {
    await sendFromTemplate('recovery.requested', process.env.AUNTIE_NOTIFY_EMAIL, {
      tribeName: args.familyId,
      method: args.contactMethod,
    });
  }
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.AUTH_RECOVERY_REQUESTED,
    severity: 'warn',
    actorRole: 'SYSTEM',
    familyId: args.familyId,
    payload: { method: args.contactMethod, ip },
  });
  return { ok: true };
}

export const requestPrimaryRecovery = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapCallable('requestPrimaryRecovery', requestPrimaryRecoveryHandler),
);
