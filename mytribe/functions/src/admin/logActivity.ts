import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { unauditedRefusal } from '../lib/wrapCallable';
import { isAuntieClaim } from '../lib/staffGate';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { isServerOnlyAuditEvent, SERVER_ONLY_EVENT_REFUSAL, type AuditEvent } from '../lib/auditEvents';
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
 * SOME LINES ONLY THE SERVER WRITES (#2162). A kind in
 * `SERVER_ONLY_AUDIT_EVENTS` (`lib/auditEvents.ts`) is refused from every
 * sign-in, the owner's included: the server writes those lines itself, so a
 * client copy could only claim something the server never did. Every other
 * kind stays open to the owner.
 *
 * Auth: wrapAdminCallable. The owner may write any other kind; an Auntie may because
 * `lib/auntieAccess.ts` lists this callable (her taps were refused, and so
 * left no line, until #1820), and only for the lines `AUNTIE_LOGGABLE_EVENTS`
 * lists. The `actorId` field is informational only; the
 * actual actor uid comes from `req.auth.uid`, which is what writeAuditEntry
 * signs into the chain.
 */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;

/**
 * The lines an Auntie may write (#1820). ABSENT MEANS REFUSED, the same rule
 * as `AUNTIE_ALLOWED_CALLABLES` in `lib/auntieAccess.ts`: a key nobody listed
 * here is refused, so a made-up key, a server-only line (a notice delivered,
 * a payment, a sign-in, a chain check) or an owner action cannot appear under
 * her name, whatever it is spelled.
 *
 * Each entry is a line an admin client writes for work her job covers and
 * the rules or the callable list already let her do: the in-visit clock and
 * its notes and photos, bookings she creates or moves (never delete, archive,
 * approve, force or batch), her own blocked time, KinTales and the drafts she
 * sends, and edits to a Kin or Kinfolk record (never archive). Money, sign-in,
 * permissions, membership, settings, pricing, templates and anything
 * destructive are left out on purpose (#944).
 *
 * To add one: a line here, and a test in `test/logActivity.test.ts`.
 */
export const AUNTIE_LOGGABLE_EVENTS: ReadonlySet<string> = new Set<string>([
  // The in-visit clock (web sessionsWrite, Android HomeViewModel, desktop sessions).
  'VISIT_ON_MY_WAY',
  'VISIT_ARRIVED',
  'VISIT_DEPARTED',
  'VISIT_UNDO_ARRIVAL',
  'VISIT_COMPLETED',
  'KINCARE_ARRIVED',
  'GPS_START',
  'GPS_STOP',
  'VISIT_NOTE_ADDED',
  'VISIT_PHOTO_ADDED',
  'SESSION_OFFICE_NOTE_ADDED',
  'ROUTE_SHARE_INITIATED',
  // Bookings she makes or moves (createKinCareSession / updateKinCareSession).
  // A moved visit is recorded by `rescheduleBooking` itself (#2162).
  'CREATE_BOOKING',
  'UPDATE_BOOKING',
  // Her own availability.
  'BLOCK_TIME_SLOT',
  'UNBLOCK_TIME_SLOT',
  // KinTales, and a generated draft she sends (publishGeneratedDraft).
  'CONTENT_KINTALE_SENT',
  'DRAFT_APPROVED',
  // The households she serves: record edits, never archive or delete.
  'UPDATE_KINFOLK',
  'UPDATE_KINFOLK_TAGS',
  'CREATE_KIN',
  'UPDATE_KIN',
  'UPDATE_KIN_TAGS',
  'SECONDARY_KINFOLK_SAVED',
  'HOUSEHOLD_DATA_SAVED',
]);

export function auntieMayLog(actionType: string): boolean {
  return AUNTIE_LOGGABLE_EVENTS.has(actionType);
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
  // #2162: a kind the server writes itself is refused from every sign-in, the
  // owner's included, before anything else is looked up.
  if (isServerOnlyAuditEvent(args.actionType)) {
    const caretaker = isAuntieClaim(req.auth?.token);
    logEvent({
      severity: 'warn',
      function: 'logActivity',
      event: 'logActivity.serverOnlyRefused',
      uid: authUid,
      extra: { actionType: args.actionType, caretaker },
    });
    const refusal = new HttpsError('permission-denied', SERVER_ONLY_EVENT_REFUSAL);
    // From the owner this is a copy of a line the server already wrote: an
    // older installed build still sends one after a form schema save, a visit
    // move or a series answer. Nothing failed, so it writes no failure line for
    // the daily error digest. An Auntie's apps never sent one, so hers keeps
    // the failure line.
    throw caretaker ? refusal : unauditedRefusal(refusal);
  }
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
