import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import type { AuditEvent } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { auditActorPayload, resolveAuditActor } from '../lib/auditActor';
import { ActivityPayload, compactActivityPayload } from '../lib/activityPayload';

/**
 * Server callable that fronts every client-side audit emit. Pairs with the
 * 2026-05-26 SHA-256 hash chain in writeAuditEntry to close the C-A residual
 * gap: AuntieOS Android (`AuntieRepository.logActivity`) and AuntieOS Web
 * (`platformLogActivity` jsAddDoc("activity_log", ...)) used to write to
 * Firestore directly, bypassing writeAuditEntry and producing unchained
 * entries. Routing every write through this callable means every entry now
 * lands inside the chain transaction.
 *
 * Schema mirrors `ActivityLogEntry` shape on the clients (Android
 * AdminModels.kt + Web FirestoreClient.kt). The callable maps the canonical
 * client fields into writeAuditEntry args; the server fills in severity and
 * the actor.
 *
 * WHO DID IT IS THE SERVER'S ANSWER (#1820). This used to write
 * `actorRole: 'PRIMARY'` for every line, so the owner's clock taps read
 * "Primary kinfolk". `resolveAuditActor` now works the role out from the
 * caller's verified token and records. The schema has no role field and is
 * not strict, so a role (or any other unknown field) a client sends is
 * dropped unread; installed app builds that still send their old shape keep
 * logging.
 *
 * WHAT HAPPENED CAN CARRY FACTS. `payload` is the allow-listed, size-capped
 * object in `lib/activityPayload.ts`. The server then stamps `admin` and
 * `staffRole` over it, the same two keys the sign-in rows carry.
 *
 * Auth: wrapAdminCallable. The owner always may; an Auntie may because
 * `lib/auntieAccess.ts` lists this callable (her taps were refused, and so
 * left no line, until #1820), for the kinds of line `auntieMayLog` allows. The `actorId` field is informational only; the
 * actual actor uid comes from `req.auth.uid`, which is what writeAuditEntry
 * signs into the chain.
 */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;

/**
 * What an Auntie may NOT write a line about (#1820): money, sign-in and
 * secrets, permissions and membership, and business settings. Those are the
 * owner's side of the #944 split, and no screen an Auntie can reach logs one,
 * so a line of that kind under her name could only be a made-up one. Her own
 * lines are visits, KinTales, Kin and Kinfolk records, notes and photos.
 */
const AUNTIE_REFUSED_PREFIXES = [
  'BILLING_', 'EXPENSE_', 'AUTH', 'SECRETS_', 'PERM_', 'MEMBERSHIP_', 'ADMIN', 'OPERATOR_', 'BUSINESS_', 'THEME_',
  'RETENTION_',
];
const AUNTIE_REFUSED_WORDS = [
  'INVOICE', 'PAYMENT', 'QUOTE', 'RECEIPT', 'CREDIT', 'REFUND', 'PAYOUT', 'STRIPE', 'LOGIN', 'LOGOUT', 'PASSWORD',
  'CLAIM', 'SETTINGS',
];

export function auntieMayLog(actionType: string): boolean {
  return (
    !AUNTIE_REFUSED_PREFIXES.some((p) => actionType.startsWith(p)) &&
    !AUNTIE_REFUSED_WORDS.some((w) => actionType.includes(w))
  );
}

const Args = z.object({
  actionType: z.string().min(1).max(120).regex(SCREAMING_SNAKE, {
    message: 'actionType must be SCREAMING_SNAKE_CASE',
  }),
  description: z.string().max(2000).optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']).optional(),
  actorId: z.string().max(200).optional(),
  targetId: z.string().max(200).optional(),
  targetCollection: z.string().max(200).optional(),
  // #1747: the household the entry is about. Writers used to put its id in the
  // description, which the Activity Log shows as written.
  familyId: z.string().max(200).optional(),
  // #1820: the facts the sentence needs. See lib/activityPayload.ts.
  payload: ActivityPayload.optional(),
});

export async function logActivityHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; entryId: string }> {
  // The wrapper refuses this too. Kept here so the handler can never write a
  // line with no actor, whoever calls it.
  const authUid = req.auth?.uid;
  if (!authUid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError(
      'invalid-argument',
      `logActivity: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ')}`,
    );
  }
  const args = parsed.data;
  // We trust the auth uid as the actor, not the client-supplied actorId.
  // The latter is captured in the description as forensic info if it
  // diverges (e.g., system-impersonation pattern in MyTribe functions
  // already does the same for orphan triage callable).
  const suppliedActorId = args.actorId ?? '';
  const description =
    args.description ??
    (suppliedActorId && suppliedActorId !== authUid
      ? `${args.actionType} (client-actor=${suppliedActorId})`
      : args.actionType);
  const actor = await resolveAuditActor(req.auth, 'logActivity', args.familyId || undefined);
  if (actor.staffRole !== null && !auntieMayLog(args.actionType)) {
    throw new HttpsError('permission-denied', 'This is not available to caretaker accounts.');
  }

  const entryId = await writeAuditEntry({
    event: args.actionType as AuditEvent,
    severity: args.status === 'FAILURE' ? 'warn' : 'info',
    actorRole: actor.actorRole,
    actorUid: authUid,
    targetUid: args.targetId || undefined,
    targetCollection: args.targetCollection || undefined,
    familyId: args.familyId || undefined,
    description,
    // Client omits status on the common case (a completed action); default to
    // SUCCESS rather than letting writeAuditEntry guess from severity.
    status: args.status ?? 'SUCCESS',
    // The server's two keys go last, so nothing a client sent can stand in for them.
    payload: { ...compactActivityPayload(args.payload), ...auditActorPayload(actor) },
  });

  return { ok: true, entryId };
}

export const logActivity = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('logActivity', logActivityHandler),
);
