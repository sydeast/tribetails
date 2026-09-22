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
import { clientIpOf, ipRateLimitKey } from '../auth/loginSecurity';

const Args = z.object({
  familyId: z.string().min(1),
  contactMethod: z.enum(['email', 'phone']),
  newContact: z.string().min(3),
});

const RATE_KEY_PREFIX = 'recoveryRateLimit';
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
/** Per caller address per household, per hour. Unchanged since before #910. */
export const RECOVERY_PER_IP_FAMILY_LIMIT = 3;
/**
 * #910: per household per hour, across every address. Twice the per-address
 * limit, so two people on different networks can each use theirs, while an
 * attacker rotating addresses (or every caller sharing the `untrusted` bucket)
 * cannot flood one household's recovery queue and the operator's inbox.
 */
export const RECOVERY_PER_FAMILY_LIMIT = 6;

/**
 * A ledger doc id. Hashed because the IPv6 key is a /64 (`2001:db8::/64`) and a
 * familyId is caller input: either could carry a `/` into the document path.
 */
function recoveryRateDocId(parts: string): string {
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 40);
}

export async function requestPrimaryRecoveryHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  // #910: the entry Google appended to X-Forwarded-For (`clientIpOf`), never
  // `rawRequest.ip`, which under `trust proxy` is the caller's own first entry.
  // Called directly (no Hosting rewrite points here), so one trusted hop. It is
  // canonical, or the `untrusted` sentinel, and is what the audit row stores.
  const ip = clientIpOf(req.rawRequest);
  const ipFamilyRef = db().doc(`${RATE_KEY_PREFIX}/${recoveryRateDocId(`ip:${ipRateLimitKey(ip)}::${args.familyId}`)}`);
  const familyRef = db().doc(`${RATE_KEY_PREFIX}/${recoveryRateDocId(`family:${args.familyId}`)}`);
  const now = Date.now();
  await db().runTransaction(async (tx) => {
    const [ipFamilySnap, familySnap] = [await tx.get(ipFamilyRef), await tx.get(familyRef)];
    const recentOf = (snap: { data(): unknown }) =>
      ((snap.data() as { hits?: number[] } | undefined)?.hits ?? []).filter((t) => now - t < RECOVERY_WINDOW_MS);
    const ipFamilyHits = recentOf(ipFamilySnap);
    const familyHits = recentOf(familySnap);
    // One refusal for either limit: the same code and message, and neither
    // counter is spent, so a refusal reveals nothing about which bound it hit.
    if (ipFamilyHits.length >= RECOVERY_PER_IP_FAMILY_LIMIT || familyHits.length >= RECOVERY_PER_FAMILY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'rate-limited');
    }
    tx.set(ipFamilyRef, { hits: [...ipFamilyHits, now] });
    tx.set(familyRef, { hits: [...familyHits, now] });
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
