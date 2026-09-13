import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db, getAdmin } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sendTemplatedEmail } from '../lib/email';
import { getTwilio, getTwilioFromNumber } from '../lib/twilio';
import { normalizeE164 } from '../lib/phoneNormalize';
import {
  CriteriaSchema,
  describeCriteria,
  resolveRecipientsFromKinfolk,
  type Criteria,
  type KinfolkLike,
} from './audienceCriteria';
import { SEGMENTS_COLLECTION } from './audienceSegments';
import { UNSUBSCRIBE_FOOTER, suppressionDocId } from './sendExternalMessage';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import {
  BroadcastIdempotencyKeyArg,
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
import { getNotificationDef } from '../notifications/catalog';
import { loadBusinessOverride, loadUserPrefs, resolveChannels, streamForRecipient } from '../notifications/prefs';
import type { ResolvedChannels, UserNotificationPrefs } from '../notifications/types';

/**
 * Stage 2 step 6 (Communicate broadcast). Admin sends one admin-authored message
 * to a saved audience segment (or inline criteria) across one or more channels:
 *
 *   - inapp -> writes a `notifications/{id}` doc per kinfolk that has a linked
 *              MyTribe uid, and NO `notificationDispatch/{id}` work order, so
 *              the catalog fan-out never runs for it (R5, 2026-08-03). It used
 *              to write `channels: []` onto the notification and lean on
 *              onNotificationCreate to stamp it 'no-channels'; with delivery
 *              state off the inbox document, "there is no work order" says the
 *              same thing without putting pipeline state on a card. The
 *              email/sms/push surfaces below are sent directly, not via the
 *              catalog, because there is no template for ad-hoc broadcast copy.
 *   - email -> SendGrid per kinfolk with an email on file, honoring opt-outs.
 *   - sms   -> Twilio per kinfolk with a phone on file, honoring opt-outs.
 *   - push  -> FCM multicast to the kinfolk's `fcm_tokens` (resolved via uid).
 *
 * Fan-out semantics are honest partial-success: a kinfolk missing a channel's
 * contact (no email / no phone / no uid / no tokens) or opted-out is COUNTED as
 * skipped (with a reason tally), a provider error on one recipient is counted as
 * failed, and the rest still send. We only THROW when the whole thing is a no-op:
 *   - the segment resolves to zero kinfolk        -> failed-precondition no_recipients
 *   - every attempted send on every channel failed -> unavailable broadcast_all_failed
 * Per project policy we never silently fake success: the returned per-channel
 * {sent, skipped, failed} counts are recorded in `broadcasts` and the audit log.
 *
 * Compliance: email/sms honor `message_suppressions` exactly like
 * sendExternalMessage; email bodies get the shared unsubscribe footer; no
 * plaintext recipient is stored (only aggregate counts).
 *
 * PREFERENCES (#386, 2026-08-18). A broadcast is a notification like any other,
 * so every recipient is resolved through `resolveChannels` against the
 * `broadcast.message` catalog row BEFORE any channel is attempted:
 *
 *   - the operator's business gate for the row (Settings -> Notification gate,
 *     kinfolk stream) can disable the whole thing, disable a channel, or LOCK a
 *     channel on for everyone;
 *   - the household's own notification settings then choose within what the
 *     gate still offers (email defaults on; SMS and push default off until the
 *     household opts in, the platform-wide default, now applied here too);
 *   - `message_suppressions` is checked ON TOP of that, not instead of it, so an
 *     unsubscribe still wins even on a channel prefs left on.
 *
 * In-app rides on the same gate rather than on a channel of its own: prefs only
 * model email/sms/push, so a recipient whose channels all resolve OFF gets no
 * inbox card either, exactly as `enqueueNotification` skips the notification doc
 * when `hasAnyChannel` is false. A fully-muted household hears nothing, which is
 * what "muted" has to mean for the setting to be worth anything.
 *
 * Reach is reported, never assumed: the returned `reach` says how many
 * households were targeted, how many actually received something, and how many
 * were silenced by their preferences, and the same numbers land in the
 * `broadcasts` doc and the audit entry.
 *
 * IDEMPOTENCY (#814, 2026-09-12). The `broadcasts/{id}` row is now written
 * BEFORE the fan-out rather than after it, and an optional `idempotencyKey`
 * becomes its id. That is what lets a second attempt at one submission be
 * recognised while the first one is still sending, the window a duplicate is
 * most likely to arrive in, because it is when the client's 20-second budget
 * expires and the operator presses Send again. Without it a retry re-ran the
 * whole fan-out, and this callable sends real email and SMS, which cannot be
 * recalled. `lib/sendIdempotency.ts` has the mechanism; #644 / #646 have the
 * booking-create precedent it copies.
 *
 * Two consequences of writing the row first, both deliberate: a broadcast that
 * dies mid-send now leaves a row stamped `fanoutState: 'running'` where it used
 * to leave nothing, and an all-failed broadcast leaves one stamped 'failed'.
 * Both are more honest than the silence they replace, and the second is what a
 * same-key retry is permitted to re-run from.
 */

export const BROADCASTS_COLLECTION = 'broadcasts';
const KINFOLK_COLLECTION = 'kinfolk';

/** The catalog row that governs broadcasts (see notifications/catalog.ts). */
export const BROADCAST_NOTIFICATION_KEY = 'broadcast.message';

export const ALL_BROADCAST_CHANNELS = ['inapp', 'email', 'sms', 'push'] as const;
export type BroadcastChannel = (typeof ALL_BROADCAST_CHANNELS)[number];

// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z
  .object({
    segmentId: z.string().min(1).max(200).optional(),
    criteria: CriteriaSchema.optional(),
    channels: z.array(z.enum(ALL_BROADCAST_CHANNELS)).min(1).max(4),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(5000),
    /**
     * #814. One key per SUBMISSION, held across every attempt at it, so a
     * dropped reply can be retried without sending the whole audience a second
     * copy. Optional: without one this callable behaves exactly as it did
     * before, server-minted id and no dedupe.
     */
    idempotencyKey: BroadcastIdempotencyKeyArg,
  })
  .superRefine((val, ctx) => {
    if (!val.segmentId && !val.criteria) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segmentId'], message: 'provide a segmentId or inline criteria' });
    }
    // De-dupe channels: at least one distinct channel.
    const distinct = new Set(val.channels);
    if (distinct.size === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channels'], message: 'pick at least one channel' });
    }
    if (val.channels.includes('email') && (!val.subject || val.subject.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'subject required when email is a channel' });
    }
    if (val.channels.includes('inapp') && (!val.subject || val.subject.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'subject (title) required when in-app is a channel' });
    }
  });

type ParsedArgs = z.infer<typeof Args>;

/** Per-channel tally returned to the caller and stored in `broadcasts`. */
export interface ChannelCounts {
  sent: number;
  skipped: number;
  failed: number;
}

const emptyCounts = (): ChannelCounts => ({ sent: 0, skipped: 0, failed: 0 });

/**
 * How far the broadcast actually got, counted per HOUSEHOLD rather than per
 * channel, so the operator learns the reach of what they just sent instead of
 * assuming it hit everyone (#386).
 *
 * `targeted - reached` is every household that heard nothing, for any reason
 * (no contact details, unsubscribed, provider failure, preferences);
 * `suppressedByPrefs` names the subset that heard nothing because the gate or
 * their own settings said not to.
 */
export interface BroadcastReach {
  /** Households the segment resolved to. */
  targeted: number;
  /** Households that received the broadcast on at least one channel. */
  reached: number;
  /** Households whose channels all resolved OFF, so nothing was attempted. */
  suppressedByPrefs: number;
}

/** True when preference resolution left the recipient with nothing on. */
function allChannelsOff(c: ResolvedChannels): boolean {
  return !c.email && !c.sms && !c.push;
}

/** Reads a kinfolk doc into the resolver's minimal shape. */
function toKinfolkLike(id: string, data: Record<string, unknown>): KinfolkLike {
  return {
    id,
    status: typeof data.status === 'string' ? data.status : '',
    tags: Array.isArray(data.tags) ? (data.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    email: typeof data.email === 'string' ? data.email : '',
    phoneNumber: typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
    uid: typeof data.uid === 'string' ? data.uid : '',
  };
}

/** Loads the segment criteria, from the saved doc or the inline arg. */
async function loadCriteria(args: ParsedArgs): Promise<Criteria> {
  if (args.criteria) return args.criteria;
  const snap = await db().collection(SEGMENTS_COLLECTION).doc(args.segmentId as string).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Audience segment ${args.segmentId} does not exist.`);
  }
  const raw = snap.data()?.criteria;
  const parsed = CriteriaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpsError('failed-precondition', `Audience segment ${args.segmentId} has invalid stored criteria.`);
  }
  return parsed.data;
}

/** True if the (normalized) recipient is opted out for the given channel surface. */
async function isSuppressed(normalized: string): Promise<boolean> {
  const snap = await db().collection('message_suppressions').doc(suppressionDocId(normalized)).get();
  return snap.exists;
}

export interface BroadcastMessageResult {
  ok: true;
  broadcastId: string;
  recipientCount: number;
  perChannel: Record<BroadcastChannel, ChannelCounts>;
  reach: BroadcastReach;
  /**
   * #814. True when this reply describes a broadcast an EARLIER attempt with
   * the same `idempotencyKey` already sent. Nothing left the building on this
   * call.
   */
  deduped: boolean;
  /**
   * #814. True when that earlier attempt's fan-out has not finished. The counts
   * are what is stored so far, not a total.
   *
   * #823 made this a state with a way out rather than only a warning: a pending
   * fan-out is resumed by `outboundFanoutSweep`, and the two counts below say
   * how far it has got.
   */
  pending: boolean;
  /** #823. Households the send has reached a verdict on, out of [audienceSize]. */
  sent: number;
  /** #823. The frozen roster's size. */
  audienceSize: number;
}

/** Reads a stored `perChannel` map back for a replayed reply. */
function storedPerChannel(stored: Record<string, unknown>): Record<BroadcastChannel, ChannelCounts> {
  const raw = (stored['perChannel'] ?? {}) as Record<string, Record<string, unknown>>;
  const out = {} as Record<BroadcastChannel, ChannelCounts>;
  for (const ch of ALL_BROADCAST_CHANNELS) {
    const c = (raw[ch] ?? {}) as Record<string, unknown>;
    out[ch] = {
      sent: storedCount(c, 'sent'),
      skipped: storedCount(c, 'skipped'),
      failed: storedCount(c, 'failed'),
    };
  }
  return out;
}

/**
 * Answers a retry from the row the first attempt already claimed.
 *
 * Unlike the blast, the send itself is not recoverable: this reply exists so
 * the operator learns the broadcast went out, not so they can be told it did
 * not. When the first attempt is still fanning out, `pending` says so and the
 * counts are a snapshot rather than a total.
 */
function replayBroadcast(
  broadcastId: string,
  stored: Record<string, unknown>,
  actorUid: string,
): BroadcastMessageResult {
  assertSameCaller(stored, actorUid, 'actorUid');
  const reach = (stored['reach'] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    broadcastId,
    recipientCount: storedCount(stored, 'recipientCount'),
    perChannel: storedPerChannel(stored),
    reach: {
      targeted: storedCount(reach, 'targeted'),
      reached: storedCount(reach, 'reached'),
      suppressedByPrefs: storedCount(reach, 'suppressedByPrefs'),
    },
    deduped: true,
    // `=== 'running'`, not `!== 'complete'`, since #823 added 'cancelled' to the
    // domain and kept 'failed' in it. Neither is pending: nothing more is going
    // to happen, and telling the operator to keep waiting would be wrong in both
    // cases. (A 'failed' row reaches here only when the retry path above did not
    // claim it, which is the unkeyed call, it has no key to retry with.)
    pending: stored['fanoutState'] === 'running',
    sent: storedCount(stored, 'fanoutProcessed'),
    audienceSize: storedCount(stored, 'fanoutTotal'),
  };
}

/**
 * What one recipient's marker records, beyond the coarse outcome the fan-out
 * engine tallies.
 *
 * Per-CHANNEL, because the broadcast's report is per channel and the engine's
 * sent/suppressed/failed cannot carry it. Written on the marker rather than
 * kept in the worker's memory so a resume does not lose the channels a dead
 * worker had already counted (#823).
 */
type ChannelResult = 'sent' | 'skipped' | 'failed';

/** The per-recipient detail folded into the row when a chunk closes. */
interface RecipientDetail extends Record<string, unknown> {
  channelResults: Partial<Record<BroadcastChannel, ChannelResult>>;
  reached: boolean;
  suppressedByPrefs: boolean;
}

/**
 * Folds a closed chunk's markers into the row's `perChannel` and `reach`.
 *
 * Derived entirely from the markers and the row the transaction read, never
 * from a counter this process happens to hold, which is what makes it correct
 * across a hand-off AND idempotent if the transaction retries. See
 * `lib/fanoutResume.ts#ChunkRowFields`.
 */
export function broadcastChunkRowFields(
  row: Record<string, unknown>,
  markers: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const perChannel = storedPerChannel(row);
  const reach = (row['reach'] ?? {}) as Record<string, unknown>;
  let reached = storedCount(reach, 'reached');
  let suppressedByPrefs = storedCount(reach, 'suppressedByPrefs');

  for (const marker of markers) {
    const results = (marker['channelResults'] ?? {}) as Record<string, unknown>;
    for (const ch of ALL_BROADCAST_CHANNELS) {
      const r = results[ch];
      if (r === 'sent') perChannel[ch].sent += 1;
      else if (r === 'skipped') perChannel[ch].skipped += 1;
      else if (r === 'failed') perChannel[ch].failed += 1;
    }
    if (marker['reached'] === true) reached += 1;
    if (marker['suppressedByPrefs'] === true) suppressedByPrefs += 1;
  }

  const totals = ALL_BROADCAST_CHANNELS.reduce(
    (acc, ch) => ({
      sent: acc.sent + perChannel[ch].sent,
      skipped: acc.skipped + perChannel[ch].skipped,
      failed: acc.failed + perChannel[ch].failed,
    }),
    { sent: 0, skipped: 0, failed: 0 },
  );

  return {
    perChannel,
    reach: { targeted: storedCount(reach, 'targeted'), reached, suppressedByPrefs },
    totals,
  };
}

/**
 * Sends one broadcast to one household, and it stays in THIS file on purpose.
 *
 * `test/notificationProvenance.test.ts` asserts that the set of files calling
 * `resolveChannels` is exactly the set named in `notifications/provenance.ts`,
 * so that a dispatch path cannot land undocumented. That holds only while the
 * gate resolution stays at its own call site, which is why `runFanout` takes
 * this closure as an argument rather than importing the gate itself.
 *
 * THE HOUSEHOLD IS RE-READ HERE, NOT CARRIED ON THE ROSTER. The frozen roster
 * holds kinfolk IDS only: this callable's contract is "no plaintext recipient is
 * stored (only aggregate counts)", and a roster of email addresses and phone
 * numbers stored under `broadcasts/{id}` would quietly break it. One extra read
 * per recipient, with the side benefit that a corrected address is the one used.
 */
export function broadcastSender(ctx: {
  actorUid: string;
  channels: BroadcastChannel[];
  subject: string;
  body: string;
  def: ReturnType<typeof getNotificationDef>;
  businessOverride: Awaited<ReturnType<typeof loadBusinessOverride>>;
  stream: ReturnType<typeof streamForRecipient>;
  /**
   * The households this caller ALREADY holds, by id.
   *
   * The inline leg resolved the whole audience a moment ago and has them all in
   * memory, so re-reading each one would be 5,000 round trips to learn what it
   * just read. A RESUME has none of that and passes nothing, which is the case
   * the read below exists for.
   */
  known?: Map<string, KinfolkLike>;
}): (kinfolkId: string) => Promise<{ outcome: RecipientOutcome; detail: RecipientDetail }> {
  const { actorUid: uid, channels, subject, body, def, businessOverride, stream, known } = ctx;

  return async (kinfolkId: string) => {
    const detail: RecipientDetail = {
      channelResults: {},
      reached: false,
      suppressedByPrefs: false,
    };
    const mark = (ch: BroadcastChannel, r: ChannelResult): void => {
      detail.channelResults[ch] = r;
    };

    let k = known?.get(kinfolkId);
    if (!k) {
      const snap = await db().collection(KINFOLK_COLLECTION).doc(kinfolkId).get();
      if (!snap.exists) {
        // The household left the roster between send and resume. Nothing can be
        // delivered and nothing was, so every chosen channel is skipped rather
        // than failed: failed would read as "we tried and the provider refused".
        for (const ch of channels) mark(ch, 'skipped');
        return { outcome: 'suppressed' as RecipientOutcome, detail };
      }
      k = toKinfolkLike(kinfolkId, snap.data() as Record<string, unknown>);
    }

    // Preference resolution, identical to the dispatcher's: the operator's gate
    // for this row, then the household's own choice within it. A kinfolk with no
    // linked MyTribe account has no prefs document to read, so they resolve to
    // the catalog defaults, still gated by the operator's override.
    const userPrefs: UserNotificationPrefs = k.uid ? await loadUserPrefs(k.uid, 'clients') : {};
    const allowed = resolveChannels(def, userPrefs, businessOverride, stream);

    if (allChannelsOff(allowed)) {
      // Nothing is attempted for this household on ANY surface, in-app included
      // (see the header docstring). Counted, logged, and reported back: a
      // suppressed recipient is a fact about the broadcast's reach, not a silent
      // no-op.
      detail.suppressedByPrefs = true;
      for (const ch of channels) mark(ch, 'skipped');
      logEvent({
        severity: 'info',
        function: 'broadcastMessage',
        event: 'recipient.suppressed',
        uid,
        extra: { kinfolkId: k.id, reason: 'no-channels-after-prefs' },
      });
      return { outcome: 'suppressed' as RecipientOutcome, detail };
    }

    // ---- in-app -------------------------------------------------------------
    if (channels.includes('inapp')) {
      if (!k.uid) {
        mark('inapp', 'skipped'); // no linked MyTribe install -> cannot target an in-app inbox.
      } else {
        try {
          await db().collection('notifications').doc().set({
            key: BROADCAST_NOTIFICATION_KEY,
            // The CATALOG row's category (#386). It used to say 'broadcast',
            // a bucket in no catalog, so every catalog-driven surface filed
            // broadcasts under a category it had never heard of. `title` and
            // `description` below stay the operator's own words rather than the
            // catalog label/description, because the copy is authored per send.
            category: def.category,
            recipientUid: k.uid,
            actorUid: uid,
            data: { kinfolkId: k.id },
            title: subject,
            // `description` is the field every card renderer already reads for
            // the second line (it carries the catalog description on dispatched
            // notifications). `body` alone was written by nothing else and read
            // by nothing, so a broadcast landed in the inbox as a bare subject.
            description: body,
            body,
            broadcast: true,
            targetType: 'kinfolk',
            targetId: k.id,
            createdAt: FieldValue.serverTimestamp(),
          });
          mark('inapp', 'sent');
          detail.reached = true;
        } catch (err) {
          mark('inapp', 'failed');
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'inapp.write.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- email --------------------------------------------------------------
    if (channels.includes('email')) {
      const email = (k.email ?? '').trim();
      if (!allowed.email) {
        mark('email', 'skipped'); // gate or household preference says no email.
      } else if (!email) {
        mark('email', 'skipped');
      } else if (await isSuppressed(email.toLowerCase())) {
        mark('email', 'skipped');
      } else {
        try {
          await sendTemplatedEmail({
            to: email,
            subjectTemplate: subject,
            bodyTemplate: `${body}${UNSUBSCRIBE_FOOTER}`,
            data: {},
          });
          mark('email', 'sent');
          detail.reached = true;
        } catch (err) {
          mark('email', 'failed');
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'email.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- sms ----------------------------------------------------------------
    if (channels.includes('sms')) {
      const e164 = normalizeE164((k.phoneNumber ?? '').trim());
      if (!allowed.sms) {
        mark('sms', 'skipped'); // gate or household preference says no SMS.
      } else if (!e164) {
        mark('sms', 'skipped');
      } else if (await isSuppressed(e164)) {
        mark('sms', 'skipped');
      } else {
        try {
          const twilio = await getTwilio();
          await twilio.messages.create({ from: getTwilioFromNumber(), to: e164, body });
          mark('sms', 'sent');
          detail.reached = true;
        } catch (err) {
          mark('sms', 'failed');
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'sms.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- push ---------------------------------------------------------------
    if (channels.includes('push')) {
      if (!allowed.push) {
        mark('push', 'skipped'); // gate or household preference says no push.
      } else if (!k.uid) {
        mark('push', 'skipped');
      } else {
        try {
          const tokensSnap = await db().collection('fcm_tokens').where('uid', '==', k.uid).get();
          const tokens = tokensSnap.docs.map((d) => d.id);
          if (tokens.length === 0) {
            mark('push', 'skipped');
          } else {
            const resp = await getAdmin()
              .messaging()
              .sendEachForMulticast({
                tokens,
                notification: { title: subject || 'Tribe Tails', body },
                data: { notificationKey: BROADCAST_NOTIFICATION_KEY },
              });
            // Counts are per-RECIPIENT-reached (consistent with email/sms/in-app
            // where one recipient == one send), not per-token. A kinfolk with
            // several devices counts once if any token took the push.
            if (resp.successCount > 0) {
              mark('push', 'sent');
              detail.reached = true;
            } else {
              mark('push', 'failed');
            }
          }
        } catch (err) {
          mark('push', 'failed');
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'push.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // The engine's coarse word for this household. `failed` only when every
    // chosen channel failed: a broadcast that reached the household on one
    // channel and lost another is a partial success, not a failure, and the
    // per-channel detail above is where that shows.
    const results = channels.map((ch) => detail.channelResults[ch]);
    const outcome: RecipientOutcome = detail.reached
      ? 'sent'
      : results.every((r) => r === 'failed')
        ? 'failed'
        : 'suppressed';
    return { outcome, detail };
  };
}

/**
 * Resumes a broadcast the sweep found mid-fan-out. Here rather than in the
 * sweep for the provenance reason on [broadcastSender].
 */
export async function resumeBroadcastFanout(opts: {
  broadcastId: string;
  row: Record<string, unknown>;
  workerId: string;
  deadlineMs: number;
}): Promise<{ ran: boolean; complete: boolean; processed: number; total: number; cancelled: boolean }> {
  const { broadcastId, row, workerId, deadlineMs } = opts;
  const ref = db().collection(BROADCASTS_COLLECTION).doc(broadcastId);
  const channels = (Array.isArray(row['channels']) ? row['channels'] : []).filter(
    (c): c is BroadcastChannel => (ALL_BROADCAST_CHANNELS as readonly string[]).includes(c as string),
  );
  const def = getNotificationDef(BROADCAST_NOTIFICATION_KEY);
  const businessOverride = await loadBusinessOverride(BROADCAST_NOTIFICATION_KEY);
  const run = await runFanout({
    ref,
    workerId,
    deadlineMs,
    fnName: 'outboundFanoutSweep',
    chunkRowFields: broadcastChunkRowFields,
    sendOne: broadcastSender({
      actorUid: typeof row['actorUid'] === 'string' ? row['actorUid'] : '',
      channels,
      subject: typeof row['subject'] === 'string' ? row['subject'] : '',
      // The body is stored for the resume (see the handler): a broadcast that
      // cannot be finished without it is not resumable at all.
      body: typeof row['body'] === 'string' ? row['body'] : '',
      def,
      businessOverride,
      stream: streamForRecipient(def, 'clients'),
    }),
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

export async function broadcastMessageHandler(
  req: CallableRequest<unknown>,
): Promise<BroadcastMessageResult> {
  initSentry();
  // #823. The fan-out's deadline is measured from the REQUEST's start, not from
  // the moment the roster is armed: the audience resolve ahead of it scans the
  // whole kinfolk collection, and a budget started after that would let the
  // reply land past the client's own 20-second ceiling. Same reasoning, and the
  // same field name, as `scheduleMarketingBlast`.
  const enteredAtMs = Date.now();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: ParsedArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'broadcastMessage validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const criteria = await loadCriteria(args);
  const channels = Array.from(new Set(args.channels)) as BroadcastChannel[];

  // Resolve recipients from the kinfolk collection (CRM-sized: fetch + filter
  // in memory so tag match modes need no composite index).
  const kinfolkSnap = await db().collection(KINFOLK_COLLECTION).get();
  const allKinfolk = kinfolkSnap.docs.map((d) => toKinfolkLike(d.id, d.data() as Record<string, unknown>));
  const recipients = resolveRecipientsFromKinfolk(allKinfolk, criteria);

  if (recipients.length === 0) {
    throw new HttpsError('failed-precondition', 'no_recipients');
  }

  /**
   * THE ROW NOW GOES FIRST (#814).
   *
   * It used to be written after the fan-out, which meant there was nothing for
   * a second attempt to collide with while the first one was still sending,
   * the window in which a duplicate is most likely, because it is exactly when
   * the client's 20-second budget expires and the operator clicks again. A row
   * written first is the claim, and `create()` referees it.
   *
   * Written after `no_recipients` deliberately: resolving the audience is a
   * read, so a broadcast that reaches nobody still burns no id and the operator
   * can fix the criteria and send again with the same key.
   */
  const subject = args.subject?.trim() ?? '';
  const body = args.body;
  const description = describeCriteria(criteria);
  const startedAtMs = Date.now();
  // #823. This invocation's own name, so the lease it takes is its own and its
  // release cannot evict a successor that legitimately took over.
  const workerId = `callable-${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const broadcasts = db().collection(BROADCASTS_COLLECTION);
  const ref = args.idempotencyKey ? broadcasts.doc(args.idempotencyKey) : broadcasts.doc();
  const row = {
    segmentId: args.segmentId ?? null,
    criteria,
    criteriaDescription: description,
    channels,
    subject: subject || null,
    bodyLength: body.length,
    recipientCount: recipients.length,
    actorUid: uid,
    sentAtMs: startedAtMs,
    createdAt: FieldValue.serverTimestamp(),
    fanoutState: 'running' satisfies FanoutState,
    /**
     * #823. THE BODY IS NOW STORED, and `bodyLength` above is kept beside it
     * rather than replaced.
     *
     * A broadcast that cannot be finished without its own copy is not resumable,
     * and the sweep has nothing else to render from: the copy is authored per
     * send and there is no `emailTemplates/{key}` behind it (that is the whole
     * difference between this callable and a marketing blast). The subject was
     * already stored for the same reason.
     *
     * This is admin-authored copy to a whole audience, not a recipient's data,
     * so the "no plaintext recipient is stored" rule in the header is untouched:
     * the roster holds kinfolk IDS and the marker holds per-channel outcomes.
     */
    body,
    cancelRequestedAtMs: null,
    // The lease is taken in the claim itself. See the same field on the blast
    // row for why it cannot wait until the roster is written.
    fanoutLeaseOwner: workerId,
    fanoutLeaseExpiresAtMs: startedAtMs + LEASE_MS,
    fanoutUpdatedAtMs: startedAtMs,
    fanoutRosterReady: false,
    fanoutTotal: recipients.length,
    fanoutProcessed: 0,
    perChannel: {
      inapp: emptyCounts(),
      email: emptyCounts(),
      sms: emptyCounts(),
      push: emptyCounts(),
    },
    reach: { targeted: recipients.length, reached: 0, suppressedByPrefs: 0 },
    dispatched: 0,
    suppressed: 0,
    failed: 0,
  };

  // #823. Which attempt's chunk and marker ids this run owns. Bumped only on the
  // retry-after-failure path below, so that path is not silently no-opped by the
  // first attempt's markers, which is exactly what would have happened with one
  // id space, and would have turned #822's deliberate "a failed send may be
  // re-run" into a reply that claimed success and sent nothing.
  let attempt = 0;

  if (args.idempotencyKey) {
    const claim = await claimIdempotentRow({ ref, row, actorUid: uid, actorField: 'actorUid' });
    if (!claim.claimed) {
      /**
       * A CLAIM LEFT AT 'failed' MAY BE RE-RUN, and only that one.
       *
       * `broadcast_all_failed` is thrown when every attempted send failed and
       * nothing was even skipped, nobody heard anything, so re-running under
       * the same key cannot duplicate a delivery. Refusing it instead would
       * leave the operator holding a key that can never succeed, and the only
       * way out would be a new key, which is the unguarded path this whole
       * change exists to close.
       */
      if (claim.stored['fanoutState'] !== 'failed') {
        return replayBroadcast(ref.id, claim.stored, uid);
      }
      attempt = storedCount(claim.stored, 'fanoutAttempt') + 1;
      await ref.set(
        { ...row, fanoutAttempt: attempt, retriedAfterFailureAtMs: startedAtMs },
        { merge: true },
      );
    }
  } else {
    await ref.set(row);
  }

  // #823. The roster is frozen into `{broadcast}/fanoutChunks` before anything
  // is sent, and it is what a resume walks. IDs only: see `broadcastSender`.
  const roster = await writeFanoutRoster({
    ref,
    attempt,
    recipientIds: recipients.map((k) => k.id),
    nowMs: startedAtMs,
  });
  await ref.set(roster.fields, { merge: true });

  // The gate row is ONE document for the whole business (businessSettings/
  // notifications), so it is read once here rather than once per recipient. A
  // broadcast walks the entire audience.
  const def = getNotificationDef(BROADCAST_NOTIFICATION_KEY);
  const businessOverride = await loadBusinessOverride(BROADCAST_NOTIFICATION_KEY);
  const stream = streamForRecipient(def, 'clients');

  const run = await runFanout({
    ref,
    workerId,
    // The same 15-second inline budget the blast takes, from the same point and
    // for the same reason. See `enteredAtMs`.
    deadlineMs: enteredAtMs + INLINE_FANOUT_BUDGET_MS,
    fnName: 'broadcastMessage',
    leaseHeld: true,
    armed: { row: { ...row, ...roster.fields, fanoutAttempt: attempt }, chunks: roster.chunks },
    chunkRowFields: broadcastChunkRowFields,
    sendOne: broadcastSender({
      actorUid: uid,
      channels,
      subject,
      body,
      def,
      businessOverride,
      stream,
      known: new Map(recipients.map((k) => [k.id, k])),
    }),
  });

  // From what the run last WROTE, not from a fresh read of a document this
  // invocation wrote a moment ago. `broadcastChunkRowFields` computed these
  // inside the closing transaction from the chunk's markers, so they are the
  // durable numbers and they already include anything a previous leg did.
  const perChannel = storedPerChannel(run.rowFields);
  const storedReach = (run.rowFields['reach'] ?? {}) as Record<string, unknown>;
  const reach: BroadcastReach = {
    targeted: recipients.length,
    reached: storedCount(storedReach, 'reached'),
    suppressedByPrefs: storedCount(storedReach, 'suppressedByPrefs'),
  };


  // If every attempted send across every channel failed (and nothing sent /
  // nothing legitimately skipped), surface it loud rather than reporting "done".
  const totalSent = channels.reduce((n, ch) => n + perChannel[ch].sent, 0);
  const totalFailed = channels.reduce((n, ch) => n + perChannel[ch].failed, 0);
  const totalSkipped = channels.reduce((n, ch) => n + perChannel[ch].skipped, 0);
  // #823. Only asked of a fan-out that FINISHED. A run that handed off with
  // three failures and 4,900 recipients still to go has not failed, it has
  // barely started, and stamping it 'failed' would both lie and arm the
  // retry-after-failure path against a send that is still going.
  if (run.complete && totalSent === 0 && totalSkipped === 0 && totalFailed > 0) {
    // The counts are recorded before the throw, and the row is stamped 'failed'
    // rather than left at 'running': an all-failed attempt reached nobody, and
    // that is exactly the state a same-key retry is allowed to re-run from.
    await releaseFanoutLease({
      ref,
      workerId,
      patch: { fanoutState: 'failed' satisfies FanoutState },
      fnName: 'broadcastMessage',
    });
    throw new HttpsError('unavailable', 'broadcast_all_failed', { perChannel });
  }

  await releaseFanoutLease({
    ref,
    workerId,
    patch: run.complete ? { fanoutState: 'complete' satisfies FanoutState } : {},
    fnName: 'broadcastMessage',
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BROADCAST_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: BROADCASTS_COLLECTION,
    // Reach is in the audit sentence, not just the payload: "sent to 400
    // households" and "reached 120 of them, 280 have it switched off" are
    // different facts, and the operator should read the second one without
    // opening a payload.
    description:
      `Broadcast to ${recipients.length} kinfolk (${description}) via ${channels.join(', ')}: ${totalSent} sent, ${totalSkipped} skipped, ${totalFailed} failed; reached ${reach.reached} of ${reach.targeted} households, ${reach.suppressedByPrefs} silenced by notification preferences` +
      // #823. A handed-off send must not read as a finished one in the audit
      // trail, which is the one place the counts are quoted later.
      (run.complete
        ? ''
        : `. Still sending at ${run.processed} of ${run.total}, handed to outboundFanoutSweep`),
    payload: {
      broadcastId: ref.id,
      channels,
      recipientCount: recipients.length,
      perChannel,
      reach,
      fanoutComplete: run.complete,
      fanoutProcessed: run.processed,
      fanoutTotal: run.total,
    },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  logEvent({
    severity: 'info',
    function: 'broadcastMessage',
    event: 'admin.broadcast.sent',
    uid,
    extra: { broadcastId: ref.id, channels, recipientCount: recipients.length, totalSent, totalSkipped, totalFailed, reach },
  });

  return {
    ok: true,
    broadcastId: ref.id,
    recipientCount: recipients.length,
    perChannel,
    reach,
    deduped: false,
    // #823. Honest about what this invocation finished. `outboundFanoutSweep`
    // has the rest, and the two counts say how much.
    pending: !run.complete,
    sent: run.processed,
    audienceSize: run.total,
  };
}

export const broadcastMessage = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    // Fan-out is sequential per recipient per channel; a large segment across all
    // four channels can run past the 60s default. Raise the ceiling so a real
    // broadcast finishes rather than timing out mid-send (partial counts).
    timeoutSeconds: 540,
    // 9-minute fan-out over a whole audience. A second copy would double-send,
    // so the cap is about correctness as much as cost.
    ...FULL_CPU_SERIAL,
    secrets: [
      'SMTP2GO_API_KEY',
      'EMAIL_FROM',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'SENTRY_DSN',
    ],
  },
  wrapAdminCallable('broadcastMessage', broadcastMessageHandler),
);
