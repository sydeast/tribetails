import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sendTemplatedEmail } from '../lib/email';
import { getTwilio, getTwilioFromNumber } from '../lib/twilio';
import { isValidPhone } from '../lib/phoneNormalize';
import {
  isHardBounced,
  normalizeRecipient,
  redactRecipient,
  suppressionDocId,
  RECIPIENT_HARD_BOUNCED,
} from '../lib/suppressions';
import { zeroCounters } from '../lib/engagement';
import {
  MIRROR_SKIPPED,
  findExistingThread,
  writeOutboundMirror,
  type MirrorSkippedReason,
} from '../lib/smsChannelMirror';

/**
 * Stage 2 step 5 (Communicate external send). Admin sends a one-off email or
 * SMS to an arbitrary recipient straight from the AuntieOS Communicate surface.
 * This is the server-bound vertical-slice backend: validation + consent gate +
 * audit + provider send, fail-loud throughout.
 *
 * Reuses the existing provider wrappers verbatim (no new SDK plumbing):
 *   - email: src/lib/email.ts `sendTemplatedEmail` (subject/body are passed
 *     as literal templates with an empty data map, so no Handlebars interpolation
 *     happens on admin-authored copy; needs SMTP2GO_API_KEY + EMAIL_FROM)
 *   - sms:   src/lib/twilio.ts `getTwilio` + `getTwilioFromNumber`
 *            (needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER)
 *
 * Compliance:
 *   - Before sending we check `message_suppressions/{normalizedRecipient}` for an
 *     opt-out. If present we throw failed-precondition 'recipient_opted_out' and
 *     send nothing (CAN-SPAM / CASL honor-the-opt-out).
 *   - An email address smtp2go reported as a HARD BOUNCE (#1077, reason
 *     `hard_bounce`) is refused with 'recipient_hard_bounced', even for a
 *     transactional reply. See lib/suppressions.ts.
 *   - Every email body gets an unsubscribe footer appended.
 *   - Every send is recorded in `external_messages` AND writeAuditEntry
 *     EXTERNAL_MESSAGE_SENT, with the recipient REDACTED (masked local-part /
 *     middle digits) so the activity_log never holds a plaintext one-off contact.
 *
 * On provider failure we throw 'unavailable' with the provider error surfaced
 * (fail loud), never a silent success.
 *
 * `mirrorToChannel` (opt-in, sms only) additionally mirrors the send into
 * `sms_messages` with `direction: 'outbound'`, so an Inbox Channels thread reads
 * as a conversation rather than one-sided. It is OFF by default, so the one-off
 * sends from ExternalSendPanel (people who are not kinfolk) never enter that
 * list. The redaction posture above is UNCHANGED by it: the audit entry and the
 * `external_messages` record still store only the masked recipient, and the
 * mirror is refused unless the number is already a known channel counterpart.
 * The full reasoning is in `src/lib/smsChannelMirror.ts` and is load-bearing.
 */

// Plain functional unsubscribe footer. No marketing copy (operator authors all
// customer-facing words elsewhere); this is the legally-required functional line
// only. Appended to every outbound email body.
export const UNSUBSCRIBE_FOOTER =
  '\n\n---\nTo stop receiving these messages, reply STOP or contact Tribe Tails to be removed from this list.';

export const Args = z
  .object({
    channel: z.enum(['email', 'sms']),
    to: z.string().min(1).max(320),
    subject: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(5000),
    transactional: z.boolean().default(false),
    /**
     * Opt-in: also record this send in `sms_messages` as an outbound row, so the
     * Inbox Channels thread shows the reply. Defaults FALSE, which is what keeps
     * ExternalSendPanel's non-kinfolk one-offs out of that list. Asking for it is
     * a request, not an instruction: the server still refuses unless the number
     * already has a row in that collection. See lib/smsChannelMirror.ts.
     */
    mirrorToChannel: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    // Refuse rather than silently ignore. `emails` is a different collection with
    // a different schema, and quietly dropping the flag would tell the operator's
    // banner a reply was mirrored when nothing was written.
    if (val.mirrorToChannel && val.channel !== 'sms') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mirrorToChannel'],
        message: 'mirrorToChannel is supported on the sms channel only',
      });
    }
    if (val.channel === 'email') {
      // RFC-ish email shape check; deliberately conservative (one @, dotted host).
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.to.trim());
      if (!emailOk) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'invalid email address' });
      }
      if (!val.subject || val.subject.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'subject required for email' });
      }
    } else {
      // SMS: require an E.164-ish phone. isValidPhone never throws.
      if (!isValidPhone(val.to.trim())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'invalid phone number (E.164 expected)' });
      }
    }
  });

type ParsedArgs = z.infer<typeof Args>;

// The recipient key helpers moved to lib/suppressions.ts (#1077) so the smtp2go
// webhook can key a hard bounce exactly as the send paths read it without
// importing this module's callable registrations. Re-exported for existing
// importers.
export { normalizeRecipient, suppressionDocId, redactRecipient };
export async function sendExternalMessageHandler(req: CallableRequest<unknown>): Promise<{
  ok: true;
  channel: 'email' | 'sms';
  providerMessageId: string;
  recipientRedacted: string;
  mirrored: boolean;
  mirrorSkippedReason: MirrorSkippedReason | null;
}> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: ParsedArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'sendExternalMessage validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  let normalized: string;
  try {
    normalized = normalizeRecipient(args.channel, args.to);
  } catch (err) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }
  const recipientRedacted = redactRecipient(args.channel, normalized);

  // Consent gate: refuse to send to a suppressed recipient. Skipped for a
  // transactional 1:1 reply (Inbox/Messaging): the recipient is an active
  // conversation, not marketing outreach, so the marketing opt-out does not
  // apply. Twilio still enforces a hard carrier-level STOP regardless.
  //
  // #1077: a HARD BOUNCE is refused even for a transactional reply. It is not a
  // preference the recipient expressed; the address does not exist, and every
  // further send bounces again and costs sender reputation.
  const suppressionSnap = await db().collection('message_suppressions').doc(suppressionDocId(normalized)).get();
  if (suppressionSnap.exists) {
    if (args.channel === 'email' && isHardBounced(suppressionSnap.data())) {
      throw new HttpsError('failed-precondition', RECIPIENT_HARD_BOUNCED);
    }
    if (!args.transactional) {
      throw new HttpsError('failed-precondition', 'recipient_opted_out');
    }
  }

  // Send via the existing provider wrapper. Fail loud on provider error.
  let providerMessageId: string;
  try {
    if (args.channel === 'email') {
      // The unsubscribe footer is the marketing/bulk-list functional line. A
      // transactional 1:1 reply is not bulk outreach, so it must not carry it.
      const emailBody = args.transactional ? args.body : `${args.body}${UNSUBSCRIBE_FOOTER}`;
      providerMessageId = await sendTemplatedEmail({
        to: args.to.trim(),
        // subject is guaranteed present for email by validation.
        subjectTemplate: args.subject as string,
        bodyTemplate: emailBody,
        // Empty data map: admin copy is literal, no interpolation expected.
        data: {},
      });
    } else {
      const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
      const twilio = await getTwilio();
      const message = await twilio.messages.create({
        from: getTwilioFromNumber(),
        to: normalized,
        body: args.body,
        // Engagement: Twilio POSTs delivery status to twilioStatusCallback when this
        // URL is set (operator config, post-deploy). Omitted when unset.
        ...(statusCallback ? { statusCallback } : {}),
      });
      providerMessageId = message.sid;
    }
  } catch (err) {
    const provider = args.channel === 'email' ? 'smtp2go' : 'Twilio';
    throw new HttpsError('unavailable', `${provider} send failed: ${(err as Error).message}`, {
      channel: args.channel,
      recipientRedacted,
    });
  }

  // Mirror into the Channels thread, if asked AND if the server agrees the number
  // is already a known counterpart. This runs AFTER a successful provider send
  // and can never fail the call: the text really did go out, and reporting a
  // failure to an operator who has already sent it is how the same text gets sent
  // twice. Same reasoning the Inbox uses for its voicemail reply stamp.
  let mirrored = false;
  let mirrorSkippedReason: MirrorSkippedReason | null = MIRROR_SKIPPED.NOT_REQUESTED;
  if (args.mirrorToChannel && args.channel === 'sms') {
    try {
      const thread = await findExistingThread(normalized);
      if (!thread) {
        // No prior row, so the plaintext number is genuinely new and the
        // redaction posture applies. Write nothing and say why.
        mirrorSkippedReason = MIRROR_SKIPPED.NO_EXISTING_THREAD;
      } else if (!providerMessageId) {
        // Without a SID there is no idempotent key, and a retry would duplicate
        // the reply in the operator's own thread.
        mirrorSkippedReason = MIRROR_SKIPPED.WRITE_FAILED;
      } else {
        await writeOutboundMirror({
          counterpartNumber: normalized,
          body: args.body,
          providerMessageId,
          actorUid: uid,
          thread,
          nowIso: new Date().toISOString(),
        });
        mirrored = true;
        mirrorSkippedReason = null;
      }
    } catch (err) {
      mirrorSkippedReason = MIRROR_SKIPPED.WRITE_FAILED;
      logEvent({
        severity: 'warn',
        function: 'sendExternalMessage',
        event: 'channel.mirror.failed',
        uid,
        errorMessage: (err as Error)?.message,
        extra: { recipientRedacted, providerMessageId },
      });
    }
  }

  const now = Date.now();
  // Record every send. Store redacted recipient in the audit-facing doc too so
  // a plaintext one-off contact never lands in long-lived logs.
  await db()
    .collection('external_messages')
    .add({
      channel: args.channel,
      transactional: args.transactional,
      recipientRedacted,
      subject: args.channel === 'email' ? args.subject : null,
      bodyLength: args.body.length,
      providerMessageId,
      actorUid: uid,
      sentAtMs: now,
      // Engagement counters, bumped by the provider webhooks (matched on providerMessageId).
      counts: zeroCounters(),
      lastEvent: null,
      createdAt: FieldValue.serverTimestamp(),
    });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.EXTERNAL_MESSAGE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'external_messages',
    description: `External ${args.channel} sent to ${recipientRedacted}`,
    // `mirrored` records that an outbound row was written, NOT who it went to.
    // The recipient stays redacted here exactly as before.
    payload: {
      channel: args.channel,
      recipientRedacted,
      providerMessageId,
      transactional: args.transactional,
      mirrored,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'sendExternalMessage',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'sendExternalMessage',
    event: 'admin.external.message.sent',
    uid,
    extra: { channel: args.channel, recipientRedacted, providerMessageId, mirrored, mirrorSkippedReason },
  });

  return { ok: true, channel: args.channel, providerMessageId, recipientRedacted, mirrored, mirrorSkippedReason };
}

export const sendExternalMessage = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [
      'SMTP2GO_API_KEY',
      'EMAIL_FROM',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'SENTRY_DSN',
    ],
  },
  wrapAdminCallable('sendExternalMessage', sendExternalMessageHandler),
);

// ---------------------------------------------------------------------------
// suppressExternalRecipient: admin records an opt-out so future sends to this
// recipient are blocked at the source by sendExternalMessage's consent gate.
// ---------------------------------------------------------------------------

const SuppressArgs = z
  .object({
    channel: z.enum(['email', 'sms']),
    to: z.string().min(1).max(320),
  })
  .superRefine((val, ctx) => {
    if (val.channel === 'email') {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.to.trim());
      if (!emailOk) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'invalid email address' });
      }
    } else if (!isValidPhone(val.to.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'invalid phone number (E.164 expected)' });
    }
  });

export async function suppressExternalRecipientHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; channel: 'email' | 'sms'; recipientRedacted: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof SuppressArgs>;
  try {
    args = SuppressArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'suppressExternalRecipient validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  let normalized: string;
  try {
    normalized = normalizeRecipient(args.channel, args.to);
  } catch (err) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }
  const recipientRedacted = redactRecipient(args.channel, normalized);

  const now = Date.now();
  await db()
    .collection('message_suppressions')
    .doc(suppressionDocId(normalized))
    .set(
      {
        channel: args.channel,
        recipientRedacted,
        suppressedAtMs: now,
        actorUid: uid,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.EXTERNAL_SUPPRESSION_ADDED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'message_suppressions',
    description: `External ${args.channel} suppression added for ${recipientRedacted}`,
    payload: { channel: args.channel, recipientRedacted },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'suppressExternalRecipient',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'suppressExternalRecipient',
    event: 'admin.external.suppression.added',
    uid,
    extra: { channel: args.channel, recipientRedacted },
  });

  return { ok: true, channel: args.channel, recipientRedacted };
}

export const suppressExternalRecipient = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('suppressExternalRecipient', suppressExternalRecipientHandler),
);
