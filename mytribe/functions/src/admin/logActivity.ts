import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import type { AuditEvent } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

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
 * 7 client fields into writeAuditEntry args; the server fills in defaults
 * for severity/actorRole/payload (info / PRIMARY / {}) so all entries, no
 * matter the origin, produce uniform doc shape.
 *
 * Auth: wrapAdminCallable → admin custom claim required (matches H11). The
 * `actorId` field is informational only; the actual actor uid comes from
 * `req.auth.uid`, which is what writeAuditEntry signs into the chain.
 */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const Args = z.object({
  actionType: z.string().min(1).max(120).regex(SCREAMING_SNAKE, {
    message: 'actionType must be SCREAMING_SNAKE_CASE',
  }),
  description: z.string().max(2000).optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']).optional(),
  actorId: z.string().max(200).optional(),
  targetId: z.string().max(200).optional(),
  targetCollection: z.string().max(200).optional(),
});

export async function logActivityHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; entryId: string }> {
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError(
      'invalid-argument',
      `logActivity: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const args = parsed.data;
  const authUid = req.auth?.uid;
  // We trust the auth uid as the actor, not the client-supplied actorId.
  // The latter is captured in the description as forensic info if it
  // diverges (e.g., system-impersonation pattern in MyTribe functions
  // already does the same for orphan triage callable).
  const effectiveActorUid = authUid ?? '';
  const suppliedActorId = args.actorId ?? '';
  const description =
    args.description ??
    (suppliedActorId && suppliedActorId !== authUid
      ? `${args.actionType} (client-actor=${suppliedActorId})`
      : args.actionType);

  const entryId = await writeAuditEntry({
    event: args.actionType as AuditEvent,
    severity: args.status === 'FAILURE' ? 'warn' : 'info',
    actorRole: 'PRIMARY',
    actorUid: effectiveActorUid,
    targetUid: args.targetId || undefined,
    targetCollection: args.targetCollection || undefined,
    description,
    // Client omits status on the common case (a completed action); default to
    // SUCCESS rather than letting writeAuditEntry guess from severity.
    status: args.status ?? 'SUCCESS',
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
