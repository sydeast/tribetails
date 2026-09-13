import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { enqueueNotification } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import {
  BlastIdempotencyKeyArg,
  assertSameCaller,
  claimIdempotentRow,
  storedCount,
} from '../lib/sendIdempotency';
import {
  INLINE_FANOUT_BUDGET_MS,
  LEASE_MS,
  releaseFanoutLease,
  runFanout,
  writeFanoutRoster,
  type FanoutState,
  type RecipientOutcome,
} from '../lib/fanoutResume';
import {
  AudienceArgsShape,
  MAX_AUDIENCE,
  assertAudienceUsable,
  refineAudience,
  resolveMarketingAudience,
} from './marketingAudience';

export const BLASTS_COLLECTION = 'marketingBlasts';

/**
 * The three marketing-class catalog rows this callable can schedule.
 *
 * Kept in THIS file, next to the `enqueueNotification` call, rather than beside
 * the audience resolver they are validated with: `notifications/provenance.ts`
 * names `src/admin/scheduleMarketingBlast.ts` as the emitter of all three, and
 * its guard checks the key literals really do appear in the file that claims to
 * send them. An emitter whose keys live somewhere else is exactly the drift
 * that guard exists to catch.
 */
export const MARKETING_KEYS = ['newsletter.announcement', 'survey.event', 'marketing.optin'] as const;
export type MarketingKey = (typeof MARKETING_KEYS)[number];

/**
 * Admin-only callable. Schedules a marketing-class notification (newsletter /
 * survey / marketing.optin) to an audience at `fireAtMs`.
 *
 * One scheduled notification per recipient uid. The 5-minute
 * `notificationScheduledSweep` promotes each one into a real notification plus
 * its dispatch work order at fire time. Each recipient still passes through
 * their `marketingOptIn[<category>]` check via `resolveChannels`, so an
 * opted-out household is suppressed by the dispatcher and counted here.
 *
 * ── THE 2026-09-12 CRITERIA CHANGE ──────────────────────────────────────────
 * The audience is no longer a bare uid array. It is `segmentId` | `criteria` |
 * `audienceUids`, exactly one, resolved by `marketingAudience.ts` against the
 * same `CriteriaSchema` `broadcastMessage` and `saveAudienceSegment` use. The
 * old shape survives as the third path, so an existing caller is unaffected and
 * the "Pick uids" mode in the mock has a home.
 *
 * ── WHY THE BLAST ROW IS WRITTEN FIRST ──────────────────────────────────────
 * The `marketingBlasts/{id}` row is created BEFORE the fan-out, and its id
 * rides along on every scheduled notification as `data.blastId`. That is what
 * makes a blast cancellable: `cancelMarketingBlast` finds the pending
 * `scheduledNotifications` by that field and deletes them. Writing the row
 * afterwards (as this callable used to) left every scheduled copy anonymous,
 * so nothing could ever be called back once it was queued.
 *
 * The row is also the list screen's only source. It carries the audience
 * selection and its description so "who did this go to" survives the send,
 * which a bare uid array never did.
 *
 * ── AND WHY IT IS ALSO THE IDEMPOTENCY RECORD (#814) ────────────────────────
 * Because it is written first, it is the only thing a second attempt at one
 * submission can collide with. `idempotencyKey` becomes its document id, so a
 * retry names the blast the first attempt made and is answered from the stored
 * row instead of fanning out a second set of scheduled notifications. The
 * failure that guards against is outbound marketing email reaching a household
 * twice, which cannot be recalled.
 *
 * See `lib/sendIdempotency.ts` for why the claim is a `create()` rather than a
 * read-then-write, and `#644` / `#646` for the booking-create precedent this
 * copies.
 *
 * ── AND WHY THE FAN-OUT NO LONGER LIVES IN THIS INVOCATION (#823) ───────────
 * `timeoutSeconds` is 540, the ceiling a 2nd-gen function may ask for, and
 * MAX_AUDIENCE is 5000 at five to six sequential Firestore round trips each.
 * Twenty minutes of work against a nine-minute wall: a blast to a large
 * audience could not finish here, and nothing resumed it.
 *
 * So the roster is now FROZEN into `{blast}/fanoutChunks` before anything is
 * queued, this invocation walks it for [INLINE_FANOUT_BUDGET_MS], and
 * `scheduled/outboundFanoutSweep.ts` finishes whatever is left. One recipient
 * is reached exactly once across every worker that ever touches the blast,
 * because each is claimed with a `create()` on `{blast}/fanoutRecipients/{id}` ,
 * the same server-refereed write this file's own idempotency key uses, one
 * level down. `lib/fanoutResume.ts` has the whole argument, including why a
 * cron sweep rather than Cloud Tasks and what that costs in vCPU.
 */
export const Args = z
  .object({
    key: z.enum(MARKETING_KEYS),
    fireAtMs: z.number().int().positive(),
    ...AudienceArgsShape,
    data: z.record(z.string(), z.unknown()),
    /** Operator's own name for this campaign, shown in the list. Optional; the key is the fallback. */
    title: z.string().min(1).max(200).optional(),
    /**
     * #814. One key per SUBMISSION, held across every attempt at it. Optional:
     * without one this callable behaves exactly as it did before, server-minted
     * id and no dedupe, which is what lets each client adopt it separately.
     */
    idempotencyKey: BlastIdempotencyKeyArg,
  })
  .superRefine((val, ctx) => refineAudience(val, ctx));

type ParsedArgs = z.infer<typeof Args>;

export interface ScheduleMarketingBlastResult {
  ok: true;
  blastId: string;
  key: MarketingKey;
  /** Households (or named accounts) the audience selection matched. */
  matched: number;
  /** Matched households with no linked MyTribe account, so nothing could be scheduled. */
  noLinkedAccount: number;
  /** Recipients a scheduled notification was written for. */
  dispatched: number;
  /** Recipients the dispatcher suppressed (marketing opt-in absent, or the operator's gate is off). */
  suppressed: number;
  /** Recipients whose enqueue threw. Never folded into `suppressed`: they are a different fact. */
  failed: number;
  /**
   * #814. True when this reply describes a blast an EARLIER attempt with the
   * same `idempotencyKey` already created. Nothing was scheduled by this call.
   */
  deduped: boolean;
  /**
   * #814. True when the fan-out for this blast has not finished, either the
   * first attempt is still running (the usual case for a retry that beat it) or
   * it died part-way. The counts are then what is stored so far, not a total,
   * and the screen must not report them as one.
   *
   * #823 made this a state with a way out rather than only a warning: a pending
   * fan-out is resumed by `outboundFanoutSweep`, and `queued` / `audienceSize`
   * below say how far it has got.
   */
  pending: boolean;
  /**
   * #823. Recipients accounted for so far, out of [audienceSize]. Equal when the
   * fan-out is finished. These are what the "Sending, N of M" line on both
   * screens is drawn from.
   */
  queued: number;
  /** #823. The frozen roster's size: every recipient this blast will reach. */
  audienceSize: number;
}


/**
 * Answers a retry from the row the first attempt already wrote.
 *
 * Deliberately returns the STORED facts rather than recomputing them: the point
 * of a replayed reply is that it describes what exists, and re-resolving the
 * audience a minute later can legitimately return a different number.
 */
function replayBlast(
  blastId: string,
  stored: Record<string, unknown>,
  actorUid: string,
): ScheduleMarketingBlastResult {
  assertSameCaller(stored, actorUid, 'scheduledByUid');
  const storedKey = stored['key'];
  if (!(MARKETING_KEYS as readonly string[]).includes(storedKey as string)) {
    // Only this handler writes these rows, so an unrecognised campaign key means
    // the document is not what it claims to be. Reported rather than papered
    // over with whichever key happens to be first in the enum.
    throw new HttpsError('internal', `marketingBlasts/${blastId} carries an unknown campaign key.`);
  }
  return {
    ok: true,
    blastId,
    key: storedKey as MarketingKey,
    matched: storedCount(stored, 'matched'),
    noLinkedAccount: storedCount(stored, 'noLinkedAccount'),
    dispatched: storedCount(stored, 'dispatched'),
    suppressed: storedCount(stored, 'suppressed'),
    failed: storedCount(stored, 'failed'),
    deduped: true,
    // `=== 'running'`, not `!== 'complete'`, since #823 added 'cancelled' to the
    // domain. A cancelled fan-out is FINISHED, and calling it pending would tell
    // the operator to keep waiting for counts that will never move again.
    pending: stored['fanoutState'] === 'running',
    queued: storedCount(stored, 'fanoutProcessed'),
    audienceSize: storedCount(stored, 'fanoutTotal'),
  };
}

/**
 * The per-recipient send, and it stays in THIS file on purpose.
 *
 * `test/notificationProvenance.test.ts` asserts that the set of files calling
 * `enqueueNotification` is exactly the set named in `notifications/provenance.ts`,
 * and that a file claiming to emit a key contains that key literally. Both
 * hold only while the dispatch call and the `MARKETING_KEYS` literals live
 * here. The resumable fan-out in `lib/fanoutResume.ts` therefore takes this
 * closure as an argument rather than importing the dispatcher itself.
 */
export function blastSender(ctx: {
  blastId: string;
  key: MarketingKey;
  data: Record<string, unknown>;
  fireAtMs: number;
  actorUid: string;
}): (uid: string) => Promise<RecipientOutcome> {
  return async (uid: string): Promise<RecipientOutcome> => {
    try {
      const ids = await enqueueNotification({
        key: ctx.key,
        recipientUid: uid,
        // `blastId` is what `cancelMarketingBlast` queries on, and `audienceUid`
        // is kept from the original shape so nothing downstream that read it
        // starts seeing undefined.
        data: { ...ctx.data, audienceUid: uid, blastId: ctx.blastId },
        fireAtMs: ctx.fireAtMs,
        actorUid: ctx.actorUid,
      });
      return ids.length === 0 ? 'suppressed' : 'sent';
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'scheduleMarketingBlast',
        event: 'notification.dispatch.failed',
        uid: ctx.actorUid,
        extra: {
          key: ctx.key,
          blastId: ctx.blastId,
          recipientUid: uid,
          err: (err as Error)?.message,
        },
      });
      return 'failed';
    }
  };
}

/**
 * Resumes a blast the sweep found mid-fan-out.
 *
 * Lives here rather than in the sweep for the provenance reason above: the
 * dispatch call and the campaign-key literals must stay in the file
 * `notifications/provenance.ts` names as their emitter, and the sweep is not
 * that file.
 */
export async function resumeBlastFanout(opts: {
  blastId: string;
  row: Record<string, unknown>;
  workerId: string;
  deadlineMs: number;
}): Promise<{ ran: boolean; complete: boolean; processed: number; total: number; cancelled: boolean }> {
  const { blastId, row, workerId, deadlineMs } = opts;
  const ref = db().collection(BLASTS_COLLECTION).doc(blastId);
  const key = row['key'];
  if (!(MARKETING_KEYS as readonly string[]).includes(key as string)) {
    throw new Error(`marketingBlasts/${blastId} carries an unknown campaign key.`);
  }
  const run = await runFanout({
    ref,
    workerId,
    deadlineMs,
    sendOne: blastSender({
      blastId,
      key: key as MarketingKey,
      data: (row['data'] ?? {}) as Record<string, unknown>,
      fireAtMs: storedCount(row, 'fireAtMs'),
      actorUid: typeof row['scheduledByUid'] === 'string' ? row['scheduledByUid'] : '',
    }),
    fnName: 'outboundFanoutSweep',
  });
  if (run.ran) {
    await releaseFanoutLease({
      ref,
      workerId,
      patch: run.complete ? { fanoutState: 'complete' satisfies FanoutState } : {},
      fnName: 'outboundFanoutSweep',
    });
  }
  return {
    ran: run.ran,
    complete: run.complete,
    processed: run.processed,
    total: run.total,
    cancelled: run.cancelled,
  };
}

export async function scheduleMarketingBlastHandler(
  req: CallableRequest<unknown>,
): Promise<ScheduleMarketingBlastResult> {
  initSentry();
  /**
   * #823. The fan-out's deadline is measured from HERE, not from the moment the
   * roster is armed.
   *
   * What the operator's client is waiting on is the whole request, and the
   * audience resolve ahead of the fan-out is a scan of the entire kinfolk
   * collection, which is seconds at five thousand rows. A budget started after
   * it would let the reply land at resolve + 15s + release + audit, which is
   * within a whisker of the client's own 20-second ceiling, and blowing that
   * puts the operator back on the timeout / retry / dedupe-replay path this
   * whole change exists to keep them off.
   */
  const enteredAtMs = Date.now();
  const actorUid = req.auth?.uid;
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: ParsedArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'scheduleMarketingBlast validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const blasts = db().collection(BLASTS_COLLECTION);

  /**
   * THE FAST PATH (#814), and it sits above the `fireAtMs` guard on purpose.
   *
   * This is the same reasoning `lookupIdempotentEnvelope` gives for bookings: a
   * retry re-runs the create-time guards, and a guard can legitimately change
   * its mind between attempts. An operator who schedules a blast for "now",
   * sees a timeout and presses Schedule again ninety seconds later would be
   * refused `fireAtMs is in the past`, for a blast that is already stored and
   * already queued. Answering from the row first makes the retry deterministic.
   *
   * This is not the safety mechanism. The `create()` claim below is, and it is
   * what makes two SIMULTANEOUS attempts safe.
   */
  if (args.idempotencyKey) {
    const existing = await blasts.doc(args.idempotencyKey).get();
    if (existing.exists) {
      return replayBlast(args.idempotencyKey, existing.data() ?? {}, actorUid);
    }
  }

  if (args.fireAtMs < Date.now() - 60_000) {
    throw new HttpsError('invalid-argument', 'fireAtMs is in the past');
  }

  const audience = await resolveMarketingAudience(args);
  assertAudienceUsable(audience);

  // The row goes first so its id can ride on every scheduled copy (see the
  // header docstring). `status` is not stored: it is derived on read from
  // fireAtMs and cancelledAt, because a stored status would go stale the moment
  // the sweep fires and nothing would be there to correct it.
  const ref = args.idempotencyKey ? blasts.doc(args.idempotencyKey) : blasts.doc();
  const startedAtMs = Date.now();
  // #823. This invocation's own name, so the lease it takes below is its own
  // and `releaseFanoutLease` cannot evict a successor that legitimately took
  // over. Random rather than derived from the request: two attempts at one
  // submission must not look like the same worker.
  const workerId = `callable-${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const row = {
    key: args.key,
    title: args.title?.trim() ?? '',
    fireAtMs: args.fireAtMs,
    audienceDescription: audience.description,
    ...(args.segmentId ? { segmentId: args.segmentId } : {}),
    ...(args.criteria ? { criteria: args.criteria } : {}),
    ...(args.audienceUids ? { explicitUidCount: audience.uids.length } : {}),
    matched: audience.matched,
    noLinkedAccount: audience.noLinkedAccount,
    data: args.data,
    scheduledByUid: actorUid,
    cancelledAt: null,
    createdAtMs: startedAtMs,
    createdAt: FieldValue.serverTimestamp(),
    // #814. 'running' until the fan-out finishes. #823 made that a state the
    // system can act on rather than only report: a row still saying 'running'
    // is a fan-out the sweep will pick up and finish.
    fanoutState: 'running' satisfies FanoutState,
    cancelRequestedAtMs: null,
    // #823. The lease is taken HERE, in the claim itself, rather than after the
    // roster is written. Otherwise there is a window in which the row says
    // 'running', the roster is half-written, and the sweep is entitled to walk
    // it. `fanoutRosterReady` closes the other half of that window.
    fanoutLeaseOwner: workerId,
    fanoutLeaseExpiresAtMs: startedAtMs + LEASE_MS,
    fanoutUpdatedAtMs: startedAtMs,
    fanoutRosterReady: false,
    fanoutTotal: audience.uids.length,
    fanoutProcessed: 0,
    dispatched: 0,
    suppressed: 0,
    failed: 0,
  };

  if (args.idempotencyKey) {
    // THE CLAIM. `create()` fails if the id is taken, so of two attempts racing
    // each other exactly one fans out and the other is answered from the row.
    const claim = await claimIdempotentRow({
      ref,
      row,
      actorUid,
      actorField: 'scheduledByUid',
    });
    if (!claim.claimed) return replayBlast(ref.id, claim.stored, actorUid);
  } else {
    await ref.set(row);
  }

  // #823. The roster is frozen into `{blast}/fanoutChunks` BEFORE anything is
  // queued, and it is what a resume walks. The lease was taken in the row above,
  // so the sweep cannot pick this blast up while this invocation is on it.
  const roster = await writeFanoutRoster({
    ref,
    attempt: 0,
    recipientIds: audience.uids,
    nowMs: startedAtMs,
  });
  await ref.set(roster.fields, { merge: true });

  const run = await runFanout({
    ref,
    workerId,
    armed: { row: { ...row, ...roster.fields }, chunks: roster.chunks },
    // THE INLINE BUDGET, measured against the CLIENT's, not the platform's, and
    // from the REQUEST's start rather than the fan-out's. See `enteredAtMs`.
    deadlineMs: enteredAtMs + INLINE_FANOUT_BUDGET_MS,
    sendOne: blastSender({ blastId: ref.id, key: args.key, data: args.data, fireAtMs: args.fireAtMs, actorUid }),
    fnName: 'scheduleMarketingBlast',
    leaseHeld: true,
  });

  await releaseFanoutLease({
    ref,
    workerId,
    patch: run.complete ? { fanoutState: 'complete' satisfies FanoutState } : {},
    fnName: 'scheduleMarketingBlast',
  });

  const dispatched = run.totals.sent;
  const suppressed = run.totals.suppressed;
  const failed = run.totals.failed + run.totals.abandoned;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MARKETING_BLAST_SCHEDULED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    targetCollection: BLASTS_COLLECTION,
    // The audit sentence says whether the fan-out FINISHED, because "412
    // scheduled" and "412 of 5000 scheduled so far, the sweep has the rest" are
    // different facts and the first one read alone would be a lie about the
    // second (#823).
    description: run.complete
      ? `Marketing blast scheduled: ${args.key} to ${audience.description} (${dispatched} scheduled, ${suppressed} suppressed)`
      : `Marketing blast scheduled: ${args.key} to ${audience.description}, fan-out handed to outboundFanoutSweep at ${run.processed} of ${run.total} (${dispatched} scheduled, ${suppressed} suppressed so far)`,
    payload: {
      blastId: ref.id,
      key: args.key,
      fireAtMs: args.fireAtMs,
      matched: audience.matched,
      dispatched,
      suppressed,
      failed,
      fanoutComplete: run.complete,
      fanoutProcessed: run.processed,
      fanoutTotal: run.total,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'scheduleMarketingBlast',
      event: 'audit.write.failed',
      uid: actorUid,
      errorMessage: (err as Error)?.message,
    });
  });

  return {
    ok: true,
    blastId: ref.id,
    key: args.key,
    matched: audience.matched,
    noLinkedAccount: audience.noLinkedAccount,
    dispatched,
    suppressed,
    failed,
    deduped: false,
    // #823. Honest about what this invocation actually finished. `false` means
    // the roster is exhausted; `true` means the sweep has the rest, and the
    // two counts below say how much of it.
    pending: !run.complete,
    queued: run.processed,
    audienceSize: run.total,
  };
}

export const scheduleMarketingBlast = onCall(
  // A one-shot operator bulk action that fans out up to MAX_AUDIENCE enqueues in
  // a single invocation, which is exactly what FULL_CPU_SERIAL is for: a full
  // vCPU so the loop is not starved, and a 2-instance cap so two copies of the
  // same blast cannot race.
  //
  // `timeoutSeconds: 540` (#814), matching `broadcastMessage`, which already
  // carries it for the same reason. The CLIENT gives this call 20 seconds
  // (`auntieos-admin/src/lib/fns.ts`) but a client that gives up does not stop
  // the container: Cloud Run runs the handler to completion or to ITS timeout.
  // At the default 60s a five-thousand-household fan-out was killed part-way
  // with no way to tell, which is a worse failure than the timeout the operator
  // sees. 540 is the ceiling the platform allows; past it the fan-out has to
  // leave the request path entirely, and the row's `fanoutState` is what makes
  // that visible when it happens.
  //
  // #823 IS THAT "past it". The handler now stops fanning out after 15 seconds
  // and hands the remainder to `outboundFanoutSweep`, so 540 is no longer the
  // budget it spends, it is headroom for the audience resolve, the roster
  // commit and an unlucky burst of slow round trips. It is kept rather than
  // lowered because a timeout is a hard kill and there is nothing to gain from
  // making one more likely.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
    timeoutSeconds: 540,
    ...FULL_CPU_SERIAL,
  },
  wrapAdminCallable('scheduleMarketingBlast', scheduleMarketingBlastHandler),
);

export { MAX_AUDIENCE };
