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
  type FanoutState,
} from '../lib/sendIdempotency';
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
   */
  pending: boolean;
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
    pending: stored['fanoutState'] !== 'complete',
  };
}

export async function scheduleMarketingBlastHandler(
  req: CallableRequest<unknown>,
): Promise<ScheduleMarketingBlastResult> {
  initSentry();
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
    createdAtMs: Date.now(),
    createdAt: FieldValue.serverTimestamp(),
    // #814. 'running' until the loop below finishes. A row still saying
    // 'running' after the invocation ended is a fan-out that was killed
    // part-way, which is a different fact from a blast that queued nothing.
    fanoutState: 'running' satisfies FanoutState,
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

  let dispatched = 0;
  let suppressed = 0;
  let failed = 0;
  for (const uid of audience.uids) {
    try {
      const ids = await enqueueNotification({
        key: args.key,
        recipientUid: uid,
        // `blastId` is what `cancelMarketingBlast` queries on, and `audienceUid`
        // is kept from the original shape so nothing downstream that read it
        // starts seeing undefined.
        data: { ...args.data, audienceUid: uid, blastId: ref.id },
        fireAtMs: args.fireAtMs,
        actorUid,
      });
      if (ids.length === 0) suppressed += 1;
      else dispatched += 1;
    } catch (err) {
      failed += 1;
      logEvent({
        severity: 'warn',
        function: 'scheduleMarketingBlast',
        event: 'notification.dispatch.failed',
        uid: actorUid,
        extra: { key: args.key, blastId: ref.id, recipientUid: uid, err: (err as Error)?.message },
      });
    }
  }

  await ref.set(
    { dispatched, suppressed, failed, fanoutState: 'complete' satisfies FanoutState },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MARKETING_BLAST_SCHEDULED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    targetCollection: BLASTS_COLLECTION,
    description: `Marketing blast scheduled: ${args.key} to ${audience.description} (${dispatched} scheduled, ${suppressed} suppressed)`,
    payload: {
      blastId: ref.id,
      key: args.key,
      fireAtMs: args.fireAtMs,
      matched: audience.matched,
      dispatched,
      suppressed,
      failed,
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
    pending: false,
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
