import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { countOf, fanoutProgressState, type FanoutProgressState } from '../lib/fanoutResume';
import { BROADCASTS_COLLECTION } from './broadcastMessage';

/**
 * #823. The read and the brake for a broadcast that is still sending.
 *
 * `broadcastMessage` fans out for fifteen seconds and hands the rest to
 * `outboundFanoutSweep`, so an operator who broadcasts to a large segment now
 * gets `pending: true` and a send that keeps going for minutes after the reply.
 * Without these two callables that is exactly the complaint #823 makes about
 * blasts, moved one screen over: a state the operator can reach and cannot act
 * on.
 *
 * ── WHY THIS IS NOT `listBroadcasts` ────────────────────────────────────────
 * There is no broadcast history screen and this does not invent one. Communicate
 * composes and sends; what it lacks is a way to watch the send it JUST started,
 * which is one id it already holds. So the read takes that id and nothing else.
 * A list would be a new surface with no mock behind it.
 *
 * ── WHAT STOPPING ACTUALLY STOPS, AND WHAT IT CANNOT ────────────────────────
 * Email and SMS that have already left cannot be recalled, and this does not
 * pretend otherwise: there is no refund, no retraction, no deletion of what was
 * sent. `stopBroadcast` stops the REMAINDER, the households the roster still
 * holds and the fan-out has not reached. The reply says so in numbers rather
 * than in a word: `sent` is what went out, `neverSent` is what will not.
 *
 * That asymmetry is the difference from `cancelMarketingBlast`, which really can
 * take a blast back, because a blast's copies sit in `scheduledNotifications`
 * until their fire time and can be deleted. Nothing here deletes anything.
 */

const BroadcastIdArgs = z.object({ broadcastId: z.string().min(1).max(200) });

export interface BroadcastProgress {
  ok: true;
  broadcastId: string;
  /** How the fan-out is doing. `'stalled'` is running with a long-dead lease. */
  fanoutState: FanoutProgressState;
  /** Households the send has reached a verdict on. */
  sent: number;
  /** The frozen roster's size. */
  audienceSize: number;
  /** Households that received it on at least one channel. */
  reached: number;
  /** Households whose channels all resolved OFF, so nothing was attempted. */
  suppressedByPrefs: number;
  /** The operator's own words for this send, so the screen can name what it is watching. */
  subject: string;
  /** True when a stop has been asked for and the fan-out has not confirmed it yet. */
  stopRequested: boolean;
}

function parse(data: unknown, fn: string): z.infer<typeof BroadcastIdArgs> {
  try {
    return BroadcastIdArgs.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${fn} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

export async function getBroadcastProgressHandler(
  req: CallableRequest<unknown>,
): Promise<BroadcastProgress> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(req.data, 'getBroadcastProgress');

  const snap = await db().collection(BROADCASTS_COLLECTION).doc(args.broadcastId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Broadcast ${args.broadcastId} does not exist.`);
  }
  const data = snap.data() as Record<string, unknown>;
  const reach = (data['reach'] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    broadcastId: args.broadcastId,
    // A row written before #823 carries no `fanoutState`, and reads as finished
    // rather than as in-flight: it was written by a build whose send ended with
    // its invocation, so a progress bar over it would never move.
    fanoutState: data['fanoutState'] === undefined ? 'complete' : fanoutProgressState(data, Date.now()),
    sent: countOf(data, 'fanoutProcessed'),
    audienceSize: countOf(data, 'fanoutTotal'),
    reached: countOf(reach, 'reached'),
    suppressedByPrefs: countOf(reach, 'suppressedByPrefs'),
    subject: typeof data['subject'] === 'string' ? data['subject'] : '',
    stopRequested: typeof data['cancelRequestedAtMs'] === 'number',
  };
}

export const getBroadcastProgress = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getBroadcastProgress', getBroadcastProgressHandler),
);

export interface StopBroadcastResult {
  ok: true;
  broadcastId: string;
  /** Households the send had already reached a verdict on. Unaffected by the stop. */
  sent: number;
  /** Households the roster still held. These will not be contacted. */
  neverSent: number;
}

/**
 * Asks a running broadcast to stop after the households it has already reached.
 *
 * ONE WRITE, and it is a request rather than a kill: the fan-out re-reads the
 * row every 25 recipients and stops on this stamp, so a live worker notices
 * within a few seconds, and a dead one is stopped by never resuming (the sweep
 * refuses to lease a row carrying it). Nothing here can abort a send already
 * inside a provider call, which is why the reply counts rather than promises.
 */
export async function stopBroadcastHandler(
  req: CallableRequest<unknown>,
): Promise<StopBroadcastResult> {
  initSentry();
  const actorUid = req.auth?.uid;
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(req.data, 'stopBroadcast');

  const ref = db().collection(BROADCASTS_COLLECTION).doc(args.broadcastId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Broadcast ${args.broadcastId} does not exist.`);
  }
  const data = snap.data() as Record<string, unknown>;
  if (data['fanoutState'] !== 'running') {
    // Nothing left to stop. Refused loudly rather than answered with a cheerful
    // zero, which would read as "stopped it in time" for a send that finished.
    throw new HttpsError('failed-precondition', 'already_finished');
  }
  if (typeof data['cancelRequestedAtMs'] === 'number') {
    throw new HttpsError('failed-precondition', 'already_stopping');
  }

  const sent = countOf(data, 'fanoutProcessed');
  const neverSent = Math.max(0, countOf(data, 'fanoutTotal') - sent);
  await ref.set(
    { cancelRequestedAtMs: Date.now(), cancelRequestedByUid: actorUid },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BROADCAST_STOPPED,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid,
    targetCollection: BROADCASTS_COLLECTION,
    description: `Broadcast stopped part-way: ${sent} households already contacted, ${neverSent} will not be. Nothing already sent can be recalled.`,
    payload: { broadcastId: args.broadcastId, sent, neverSent },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'stopBroadcast',
      event: 'audit.write.failed',
      uid: actorUid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, broadcastId: args.broadcastId, sent, neverSent };
}

export const stopBroadcast = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('stopBroadcast', stopBroadcastHandler),
);
