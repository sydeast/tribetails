import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import { BLASTS_COLLECTION, MARKETING_KEYS } from './scheduleMarketingBlast';
import {
  AudienceArgsShape,
  countMarketingReach,
  refineAudience,
  resolveMarketingAudience,
  type MarketingReach,
} from './marketingAudience';

/**
 * The read and cancel half of Marketing blasts, alongside
 * `scheduleMarketingBlast`'s write half.
 *
 * Three callables, all admin-gated, all shipped so the Marketing blasts screen
 * (React admin `src/screens/MarketingBlasts.tsx`, AuntieOS Android
 * `ui/marketing/`) can do what the mock asks for and nothing it cannot back:
 *
 *   previewMarketingBlastAudience  who this reaches, before committing
 *   listMarketingBlasts            scheduled + sent campaigns
 *   cancelMarketingBlast           call a queued campaign back
 *
 * ── WHAT THE MOCK ASKS FOR THAT IS NOT HERE ─────────────────────────────────
 * The mock draws a "Sending" progress bar and an open rate per sent campaign.
 * Neither has a source: a blast is promoted by a 5-minute cron, so there is no
 * in-flight state to report, and nothing in this codebase records an email
 * open. Both are left out rather than rendered from a number we would have had
 * to invent.
 */

// ---------------------------------------------------------------------------
// previewMarketingBlastAudience: who a blast would reach, before scheduling it.
// ---------------------------------------------------------------------------

const PreviewArgs = z
  .object({
    key: z.enum(MARKETING_KEYS),
    ...AudienceArgsShape,
  })
  .superRefine((val, ctx) => refineAudience(val, ctx));

/**
 * Reports the reach of an audience selection WITHOUT writing anything.
 *
 * Deliberately does not throw on an empty audience the way scheduling does:
 * "this selection reaches nobody" is the single most useful thing a preview can
 * tell an operator, and it can only tell them by returning. The screen blocks
 * the schedule button on `reachable === 0`; the callable blocks the schedule
 * itself.
 */
export async function previewMarketingBlastAudienceHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; description: string } & MarketingReach> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof PreviewArgs>;
  try {
    args = PreviewArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'previewMarketingBlastAudience validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const audience = await resolveMarketingAudience(args);
  const reach = await countMarketingReach(args.key, audience);
  return { ok: true, description: audience.description, ...reach };
}

export const previewMarketingBlastAudience = onCall(
  // Walks the whole kinfolk collection and then one prefs document per matched
  // household, the same shape of work the send does, so it takes the same
  // sizing rather than the fleet default.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU_SERIAL },
  wrapAdminCallable('previewMarketingBlastAudience', previewMarketingBlastAudienceHandler),
);

// ---------------------------------------------------------------------------
// listMarketingBlasts: scheduled and sent campaigns, newest first.
// ---------------------------------------------------------------------------

const ListArgs = z.object({ limit: z.number().int().min(1).max(200).optional() });

/**
 * Derived, never stored (see `scheduleMarketingBlast`'s docstring). A stored
 * status would be wrong from the moment the sweep fired, and nothing runs after
 * a blast to correct it.
 */
export type BlastStatus = 'scheduled' | 'sent' | 'cancelled';

export function blastStatus(fireAtMs: number, cancelledAtMs: number | null, nowMs: number): BlastStatus {
  if (cancelledAtMs !== null) return 'cancelled';
  return fireAtMs > nowMs ? 'scheduled' : 'sent';
}

export interface BlastRecord {
  id: string;
  key: string;
  title: string;
  fireAtMs: number;
  status: BlastStatus;
  audienceDescription: string;
  matched: number;
  noLinkedAccount: number;
  dispatched: number;
  suppressed: number;
  failed: number;
  cancelledAtMs: number | null;
  createdAtMs: number;
}

/** Defensive number read: a row written by an older deploy must not become NaN in a total. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function listMarketingBlastsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; blasts: BlastRecord[] }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ListArgs.parse(req.data ?? {});

  const snap = await db()
    .collection(BLASTS_COLLECTION)
    .orderBy('fireAtMs', 'desc')
    .limit(args.limit ?? 100)
    .get();

  const now = Date.now();
  const blasts: BlastRecord[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const cancelledAtMs = typeof data.cancelledAt === 'number' ? data.cancelledAt : null;
    const fireAtMs = num(data.fireAtMs);
    return {
      id: d.id,
      key: typeof data.key === 'string' ? data.key : '',
      title: typeof data.title === 'string' ? data.title : '',
      fireAtMs,
      status: blastStatus(fireAtMs, cancelledAtMs, now),
      audienceDescription: typeof data.audienceDescription === 'string' ? data.audienceDescription : '',
      // `audienceCount` is the pre-criteria field name. Read as a fallback so a
      // row written before this change still reports a matched count instead of
      // a confident zero.
      matched: typeof data.matched === 'number' ? data.matched : num(data.audienceCount),
      noLinkedAccount: num(data.noLinkedAccount),
      dispatched: num(data.dispatched),
      suppressed: num(data.suppressed),
      failed: num(data.failed),
      cancelledAtMs,
      createdAtMs: num(data.createdAtMs),
    };
  });

  return { ok: true, blasts };
}

export const listMarketingBlasts = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listMarketingBlasts', listMarketingBlastsHandler),
);

// ---------------------------------------------------------------------------
// cancelMarketingBlast: delete the queued copies of a blast that has not fired.
// ---------------------------------------------------------------------------

const CancelArgs = z.object({ blastId: z.string().min(1).max(200) });

/**
 * Cancels a scheduled blast by deleting every pending `scheduledNotifications`
 * copy carrying its `data.blastId`, then stamping `cancelledAt` on the row.
 *
 * Equality on a nested field is served by Firestore's automatic single-field
 * index, so this needs no `firestore.indexes.json` entry.
 *
 * A blast whose fire time has passed cannot be cancelled: the sweep has already
 * promoted its copies into real notifications and, for anything the dispatcher
 * put on a channel, into sent email or push. Refusing loudly is the honest
 * answer; silently stamping a row "cancelled" over messages that went out would
 * be the dishonest one. The deletes run in batches rather than one transaction
 * because a 5000-recipient blast is far past Firestore's 500-write limit.
 */
export async function cancelMarketingBlastHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; blastId: string; cancelled: number }> {
  initSentry();
  const actorUid = req.auth?.uid;
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof CancelArgs>;
  try {
    args = CancelArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'cancelMarketingBlast validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection(BLASTS_COLLECTION).doc(args.blastId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Marketing blast ${args.blastId} does not exist.`);
  }
  const data = snap.data() as Record<string, unknown>;
  if (typeof data.cancelledAt === 'number') {
    throw new HttpsError('failed-precondition', 'already_cancelled');
  }
  const fireAtMs = typeof data.fireAtMs === 'number' ? data.fireAtMs : 0;
  if (fireAtMs <= Date.now()) {
    throw new HttpsError('failed-precondition', 'already_fired');
  }

  const queued = await db()
    .collection('scheduledNotifications')
    .where('data.blastId', '==', args.blastId)
    .get();

  let cancelled = 0;
  const CHUNK = 400;
  for (let i = 0; i < queued.docs.length; i += CHUNK) {
    const batch = db().batch();
    for (const doc of queued.docs.slice(i, i + CHUNK)) batch.delete(doc.ref);
    await batch.commit();
    cancelled += queued.docs.slice(i, i + CHUNK).length;
  }

  const cancelledAt = Date.now();
  await ref.set({ cancelledAt, cancelledByUid: actorUid, cancelledCount: cancelled }, { merge: true });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MARKETING_BLAST_CANCELLED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    targetCollection: BLASTS_COLLECTION,
    description: `Marketing blast cancelled: ${String(data.key ?? '')} (${cancelled} queued notifications removed)`,
    payload: { blastId: args.blastId, key: data.key ?? null, cancelled },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'cancelMarketingBlast',
      event: 'audit.write.failed',
      uid: actorUid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, blastId: args.blastId, cancelled };
}

export const cancelMarketingBlast = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU_SERIAL },
  wrapAdminCallable('cancelMarketingBlast', cancelMarketingBlastHandler),
);
