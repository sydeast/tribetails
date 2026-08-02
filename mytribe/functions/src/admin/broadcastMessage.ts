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

/**
 * Stage 2 step 6 (Communicate broadcast). Admin sends one admin-authored message
 * to a saved audience segment (or inline criteria) across one or more channels:
 *
 *   - inapp -> writes a `notifications/{id}` doc per kinfolk that has a linked
 *              MyTribe uid. channels:[] so onNotificationCreate marks it
 *              'no-channels' (no per-channel email/sms duplicate); the MyTribe
 *              app renders the in-app entry from the title/body on the doc.
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
 */

export const BROADCASTS_COLLECTION = 'broadcasts';
const KINFOLK_COLLECTION = 'kinfolk';

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

export async function broadcastMessageHandler(
  req: CallableRequest<unknown>,
): Promise<{
  ok: true;
  broadcastId: string;
  recipientCount: number;
  perChannel: Record<BroadcastChannel, ChannelCounts>;
}> {
  initSentry();
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

  const perChannel: Record<BroadcastChannel, ChannelCounts> = {
    inapp: emptyCounts(),
    email: emptyCounts(),
    sms: emptyCounts(),
    push: emptyCounts(),
  };
  const subject = args.subject?.trim() ?? '';
  const body = args.body;

  for (const k of recipients) {
    // ---- in-app -------------------------------------------------------------
    if (channels.includes('inapp')) {
      const c = perChannel.inapp;
      if (!k.uid) {
        c.skipped += 1; // no linked MyTribe install -> cannot target an in-app inbox.
      } else {
        try {
          await db().collection('notifications').doc().set({
            key: 'broadcast.message',
            category: 'broadcast',
            recipientUid: k.uid,
            actorUid: uid,
            data: { kinfolkId: k.id },
            // channels:[] -> onNotificationCreate stamps 'no-channels' (the
            // email/sms/push surfaces are handled directly below, not via the
            // catalog fan-out which has no template for ad-hoc broadcast copy).
            channels: [],
            title: subject,
            body,
            broadcast: true,
            targetType: 'kinfolk',
            targetId: k.id,
            status: 'pending',
            mode: 'broadcast',
            createdAt: FieldValue.serverTimestamp(),
          });
          c.sent += 1;
        } catch (err) {
          c.failed += 1;
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'inapp.write.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- email --------------------------------------------------------------
    if (channels.includes('email')) {
      const c = perChannel.email;
      const email = (k.email ?? '').trim();
      if (!email) {
        c.skipped += 1;
      } else if (await isSuppressed(email.toLowerCase())) {
        c.skipped += 1;
      } else {
        try {
          await sendTemplatedEmail({
            to: email,
            subjectTemplate: subject,
            bodyTemplate: `${body}${UNSUBSCRIBE_FOOTER}`,
            data: {},
          });
          c.sent += 1;
        } catch (err) {
          c.failed += 1;
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'email.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- sms ----------------------------------------------------------------
    if (channels.includes('sms')) {
      const c = perChannel.sms;
      const e164 = normalizeE164((k.phoneNumber ?? '').trim());
      if (!e164) {
        c.skipped += 1;
      } else if (await isSuppressed(e164)) {
        c.skipped += 1;
      } else {
        try {
          await getTwilio().messages.create({ from: getTwilioFromNumber(), to: e164, body });
          c.sent += 1;
        } catch (err) {
          c.failed += 1;
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'sms.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }

    // ---- push ---------------------------------------------------------------
    if (channels.includes('push')) {
      const c = perChannel.push;
      if (!k.uid) {
        c.skipped += 1;
      } else {
        try {
          const tokensSnap = await db().collection('fcm_tokens').where('uid', '==', k.uid).get();
          const tokens = tokensSnap.docs.map((d) => d.id);
          if (tokens.length === 0) {
            c.skipped += 1;
          } else {
            const resp = await getAdmin()
              .messaging()
              .sendEachForMulticast({
                tokens,
                notification: { title: subject || 'Tribe Tails', body },
                data: { notificationKey: 'broadcast.message' },
              });
            // Counts are per-RECIPIENT-reached (consistent with email/sms/in-app
            // where one recipient == one send), not per-token. A kinfolk with
            // several devices counts once if any token took the push.
            if (resp.successCount > 0) c.sent += 1;
            else c.failed += 1;
          }
        } catch (err) {
          c.failed += 1;
          logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'push.send.failed', uid, extra: { kinfolkId: k.id, err: (err as Error)?.message } });
        }
      }
    }
  }

  // If every attempted send across every channel failed (and nothing sent /
  // nothing legitimately skipped), surface it loud rather than reporting "done".
  const totalSent = channels.reduce((n, ch) => n + perChannel[ch].sent, 0);
  const totalFailed = channels.reduce((n, ch) => n + perChannel[ch].failed, 0);
  const totalSkipped = channels.reduce((n, ch) => n + perChannel[ch].skipped, 0);
  if (totalSent === 0 && totalSkipped === 0 && totalFailed > 0) {
    throw new HttpsError('unavailable', 'broadcast_all_failed', { perChannel });
  }

  const now = Date.now();
  const description = describeCriteria(criteria);
  const ref = await db()
    .collection(BROADCASTS_COLLECTION)
    .add({
      segmentId: args.segmentId ?? null,
      criteria,
      criteriaDescription: description,
      channels,
      subject: subject || null,
      bodyLength: body.length,
      recipientCount: recipients.length,
      perChannel,
      totals: { sent: totalSent, skipped: totalSkipped, failed: totalFailed },
      actorUid: uid,
      sentAtMs: now,
      createdAt: FieldValue.serverTimestamp(),
    });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BROADCAST_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: BROADCASTS_COLLECTION,
    description: `Broadcast to ${recipients.length} kinfolk (${description}) via ${channels.join(', ')}: ${totalSent} sent, ${totalSkipped} skipped, ${totalFailed} failed`,
    payload: { broadcastId: ref.id, channels, recipientCount: recipients.length, perChannel },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'broadcastMessage', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  logEvent({
    severity: 'info',
    function: 'broadcastMessage',
    event: 'admin.broadcast.sent',
    uid,
    extra: { broadcastId: ref.id, channels, recipientCount: recipients.length, totalSent, totalSkipped, totalFailed },
  });

  return { ok: true, broadcastId: ref.id, recipientCount: recipients.length, perChannel };
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
