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
import { fanoutProgressState, type FanoutProgressState } from '../lib/fanoutResume';
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
 * The mock draws an open rate per sent campaign. Nothing in this codebase
 * records an email open, so it is left out rather than rendered from a number
 * we would have had to invent.
 *
 * THE MOCK'S "Sending" GROUP AND ITS PROGRESS BAR ARE NOW REAL (#823). They
 * were left out when this screen was built, on the stated grounds that "a blast
 * is promoted by a 5-minute cron, so there is no in-flight state to report".
 * That was true of the PROMOTION and was never true of the FAN-OUT, and since
 * #823 the fan-out is an interruptible walk over a frozen roster that can span
 * several invocations and several minutes. `fanoutState`, `fanoutProcessed` and
 * `fanoutTotal` on the row are precisely the mock's "256 of 410 dispatched", so
 * `listMarketingBlasts` returns them and both screens render the group.
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
 *
 * #823 ADDED TWO, AND THEY ARE DERIVED FOR THE SAME REASON:
 *
 *   sending     the fan-out is still walking the roster. Precedes 'scheduled'
 *               in precedence because it is the more urgent fact: a campaign
 *               that has not finished being queued is not simply "scheduled",
 *               and it is the state the mock draws a progress bar for.
 *   cancelling  a cancel was asked for while the fan-out was running, and the
 *               sweep has not yet confirmed the worker stopped. See
 *               `cancelMarketingBlastHandler` for why that is two steps.
 *   failed      the fan-out never armed, so nothing was queued and nothing ever
 *               will be. Its own word rather than 'scheduled', which is what it
 *               read as before and which came with a Cancel button for a
 *               campaign there was nothing to cancel.
 *
 * A `stalled` fan-out is NOT another status. It is the same 'sending' campaign
 * with `fanoutState: 'stalled'` beside it, because "the queueing has stopped
 * moving" is a fact about the fan-out, not about the campaign's place in the
 * list, and an operator sorting by status should still find it under Sending.
 */
export type BlastStatus = 'scheduled' | 'sending' | 'sent' | 'cancelling' | 'cancelled' | 'failed';

export function blastStatus(
  fireAtMs: number,
  cancelledAtMs: number | null,
  nowMs: number,
  fanout?: FanoutProgressState,
  cancelRequested?: boolean,
): BlastStatus {
  if (cancelledAtMs !== null) return 'cancelled';
  if (fanout === 'failed') return 'failed';
  if (cancelRequested === true) return 'cancelling';
  if (fanout === 'running' || fanout === 'stalled') return 'sending';
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
  /**
   * #823. How the fan-out itself is doing, derived from the lease and the last
   * progress write. `'stalled'` is the state the issue asks for by name: still
   * `running`, lease long gone, nothing moving.
   */
  fanoutState: FanoutProgressState;
  /** #823. Recipients accounted for, out of [audienceSize]. The mock's "256 of 410". */
  queued: number;
  /** #823. The frozen roster's size. 0 on a row written before this change. */
  audienceSize: number;
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
    // A row written before #823 carries no `fanoutState` at all. It reads as
    // 'complete' rather than as 'running', which is the right default: it was
    // written by a build whose fan-out finished or died inside one invocation,
    // and calling it in-flight would put a permanent progress bar on history.
    const fanout = data.fanoutState === undefined ? 'complete' : fanoutProgressState(data, now);
    return {
      id: d.id,
      key: typeof data.key === 'string' ? data.key : '',
      title: typeof data.title === 'string' ? data.title : '',
      fireAtMs,
      status: blastStatus(
        fireAtMs,
        cancelledAtMs,
        now,
        fanout,
        typeof data.cancelRequestedAtMs === 'number',
      ),
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
      fanoutState: fanout,
      queued: num(data.fanoutProcessed),
      audienceSize: num(data.fanoutTotal),
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
 * Deletes every pending `scheduledNotifications` copy carrying `data.blastId`.
 *
 * Equality on a nested field is served by Firestore's automatic single-field
 * index, so this needs no `firestore.indexes.json` entry. The deletes run in
 * batches rather than one transaction because a 5000-recipient blast is far
 * past Firestore's 500-write limit.
 *
 * Exported because a cancel that lands mid-fan-out finishes in TWO places: here
 * and again in `outboundFanoutSweep`, once the worker has actually stopped. See
 * `cancelMarketingBlastHandler`.
 */
export async function deleteQueuedBlastCopies(blastId: string): Promise<number> {
  const queued = await db()
    .collection('scheduledNotifications')
    .where('data.blastId', '==', blastId)
    .get();

  let cancelled = 0;
  const CHUNK = 400;
  for (let i = 0; i < queued.docs.length; i += CHUNK) {
    const slice = queued.docs.slice(i, i + CHUNK);
    const batch = db().batch();
    for (const doc of slice) batch.delete(doc.ref);
    await batch.commit();
    cancelled += slice.length;
  }
  return cancelled;
}

/**
 * Cancels a blast: stops the fan-out if one is running, deletes every queued
 * copy, and stamps `cancelledAt` on the row.
 *
 * ── WHAT THIS COVERED BEFORE #823, WHICH IS THE THING THE ISSUE ASKS ────────
 * The query is on `data.blastId`, so it always covered a PARTIALLY sent blast's
 * queued copies: it deleted whatever the fan-out had written so far. What it did
 * not do was STOP the fan-out. A cancel that landed while the loop was still
 * running deleted the copies that existed, stamped the row "cancelled" with a
 * `cancelledCount`, and then the loop carried on writing more copies behind it.
 * The row said cancelled and the campaign kept queueing. That is the dishonest
 * half, and it is what this now closes.
 *
 * And `fireAtMs <= now` used to refuse EVERYTHING with `already_fired`. That is
 * honest about copies the promotion sweep has already turned into real
 * notifications, and it was wrong about a fan-out still running past its own
 * fire time, which #823 makes an ordinary occurrence: there the un-queued
 * remainder is genuinely still stoppable and the operator had no way to stop it.
 * The refusal is narrowed to "there is nothing left to stop": fired AND the
 * fan-out is finished.
 *
 * ── WHY A MID-FAN-OUT CANCEL IS TWO STEPS ───────────────────────────────────
 * A client-side stamp cannot abort a worker that is already inside a Firestore
 * round trip, and after the 540s request timeout Cloud Run throttles a container
 * rather than killing it, so no wait here can PROVE the worker stopped. Rather
 * than block the operator on a poll that cannot be conclusive, the cancel:
 *
 *   1. stamps `cancelRequestedAtMs`. The fan-out re-reads the row every 25
 *      recipients and stops on it, so a live worker notices within seconds.
 *   2. deletes what is queued now, and reports `stopped: false` when the row was
 *      still mid-fan-out, because a straggler copy may land after the delete.
 *   3. leaves `cancelledAt` unstamped in that case, so the row reads 'cancelling'
 *      on both screens rather than claiming a finality it does not have.
 *
 * `outboundFanoutSweep` finishes it on its next tick: it re-deletes any
 * stragglers, stamps `fanoutState: 'cancelled'` and `cancelledAt`, and the row
 * becomes 'cancelled'. A cancel therefore always converges, whatever the worker
 * was doing, within a minute.
 */
export async function cancelMarketingBlastHandler(
  req: CallableRequest<unknown>,
): Promise<{
  ok: true;
  blastId: string;
  cancelled: number;
  /** #823. True when the fan-out was already finished, so no copy can arrive after this. */
  stopped: boolean;
  /** #823. Recipients the frozen roster still holds that were never queued at all. */
  neverQueued: number;
}> {
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
  const now = Date.now();
  const fireAtMs = typeof data.fireAtMs === 'number' ? data.fireAtMs : 0;
  // A row written before #823 has no `fanoutState`; treat it as finished, which
  // is what it is, and keep the original refusal exactly as it was for it.
  const running = data.fanoutState === 'running';
  if (fireAtMs <= now && !running) {
    // Nothing left to stop: the promotion sweep has turned every copy into a
    // real notification and, for anything the dispatcher put on a channel, into
    // sent email or push. Refusing loudly is the honest answer; stamping a row
    // "cancelled" over messages that went out would be the dishonest one.
    throw new HttpsError('failed-precondition', 'already_fired');
  }

  // Step 1: ask the fan-out to stop. The worker re-reads this every 25
  // recipients, so a live one notices within a few seconds; it is stamped
  // BEFORE the delete so nothing new is queued behind the delete's back.
  if (running) {
    await ref.set({ cancelRequestedAtMs: now, cancelRequestedByUid: actorUid }, { merge: true });
  }

  // Step 2: remove what is queued now.
  const cancelled = await deleteQueuedBlastCopies(args.blastId);

  const total = num(data.fanoutTotal);
  const processed = num(data.fanoutProcessed);
  const neverQueued = Math.max(0, total - processed);

  // Step 3: only a blast that was NOT mid fan-out is finished here. For one that
  // was, `outboundFanoutSweep` stamps `cancelledAt` once the worker has actually
  // stopped, and the row reads 'cancelling' until it does.
  if (!running) {
    await ref.set(
      { cancelledAt: now, cancelledByUid: actorUid, cancelledCount: cancelled },
      { merge: true },
    );
  } else {
    await ref.set({ cancelledCount: cancelled }, { merge: true });
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MARKETING_BLAST_CANCELLED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    targetCollection: BLASTS_COLLECTION,
    description: running
      ? `Marketing blast cancel requested mid fan-out: ${String(data.key ?? '')} (${cancelled} queued notifications removed, ${neverQueued} never queued; outboundFanoutSweep will confirm the stop)`
      : `Marketing blast cancelled: ${String(data.key ?? '')} (${cancelled} queued notifications removed)`,
    payload: {
      blastId: args.blastId,
      key: data.key ?? null,
      cancelled,
      neverQueued,
      midFanout: running,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'cancelMarketingBlast',
      event: 'audit.write.failed',
      uid: actorUid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, blastId: args.blastId, cancelled, stopped: !running, neverQueued };
}

/**
 * The second half of a mid-fan-out cancel, run by `outboundFanoutSweep` once
 * the worker has stopped (or its lease has expired, which proves it has).
 *
 * Re-runs the delete because a worker can queue one more copy between the
 * callable's delete and its own next heartbeat, then stamps the row cancelled
 * for good. Idempotent: a second pass deletes nothing and writes the same
 * fields.
 */
export async function finishBlastCancellation(blastId: string): Promise<number> {
  const ref = db().collection(BLASTS_COLLECTION).doc(blastId);
  const snap = await ref.get();
  if (!snap.exists) return 0;
  const data = snap.data() as Record<string, unknown>;
  const stragglers = await deleteQueuedBlastCopies(blastId);
  await ref.set(
    {
      fanoutState: 'cancelled',
      cancelledAt: typeof data.cancelledAt === 'number' ? data.cancelledAt : Date.now(),
      cancelledByUid: data.cancelRequestedByUid ?? data.cancelledByUid ?? null,
      cancelledCount: num(data.cancelledCount) + stragglers,
      fanoutLeaseOwner: null,
      fanoutLeaseExpiresAtMs: 0,
      fanoutUpdatedAtMs: Date.now(),
    },
    { merge: true },
  );
  return stragglers;
}

export const cancelMarketingBlast = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU_SERIAL },
  wrapAdminCallable('cancelMarketingBlast', cancelMarketingBlastHandler),
);
