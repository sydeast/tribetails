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
import { normalizeE164, isValidPhone } from '../lib/phoneNormalize';
import { zeroCounters } from '../lib/engagement';

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
 *   - Every email body gets an unsubscribe footer appended.
 *   - Every send is recorded in `external_messages` AND writeAuditEntry
 *     EXTERNAL_MESSAGE_SENT, with the recipient REDACTED (masked local-part /
 *     middle digits) so the activity_log never holds a plaintext one-off contact.
 *
 * On provider failure we throw 'unavailable' with the provider error surfaced
 * (fail loud), never a silent success.
 */

// Plain functional unsubscribe footer. No marketing copy (operator authors all
// customer-facing words elsewhere); this is the legally-required functional line
// only. Appended to every outbound email body.
export const UNSUBSCRIBE_FOOTER =
  '\n\n---\nTo stop receiving these messages, reply STOP or contact Tribe Tails to be removed from this list.';

const Args = z
  .object({
    channel: z.enum(['email', 'sms']),
    to: z.string().min(1).max(320),
    subject: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(5000),
    transactional: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
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

/**
 * Canonical id / suppression key for a recipient. Email lowercased+trimmed;
 * phone normalized to E.164. Used both as the suppression doc id and the
 * external_messages target. Throws (caller maps to invalid-argument) if a phone
 * cannot be normalized; that should not happen post-validation but we stay
 * fail-loud rather than writing a malformed key.
 */
export function normalizeRecipient(channel: 'email' | 'sms', to: string): string {
  const trimmed = to.trim();
  if (channel === 'email') return trimmed.toLowerCase();
  const e164 = normalizeE164(trimmed);
  if (!e164) throw new Error(`sendExternalMessage: could not normalize phone '${trimmed}'`);
  return e164;
}

/**
 * Firestore doc ids cannot contain '/'. Recipient keys (email/E.164) never
 * contain '/', but encode defensively so an unexpected value cannot escape the
 * collection path.
 */
export function suppressionDocId(normalized: string): string {
  return encodeURIComponent(normalized);
}

/**
 * Mask a recipient for audit storage. Email: keep first char of local-part +
 * full domain (`j***@example.com`). Phone: keep country/last-4, mask middle
 * (`+1******7890`). Never store the plaintext contact in activity_log.
 */
export function redactRecipient(channel: 'email' | 'sms', normalized: string): string {
  if (channel === 'email') {
    const at = normalized.indexOf('@');
    if (at <= 0) return '***';
    const local = normalized.slice(0, at);
    const domain = normalized.slice(at); // includes '@'
    const head = local.slice(0, 1);
    return `${head}***${domain}`;
  }
  // phone (E.164): + then digits
  const plus = normalized.startsWith('+') ? '+' : '';
  const digits = normalized.replace(/[^\d]/g, '');
  if (digits.length <= 4) return `${plus}${'*'.repeat(digits.length)}`;
  const cc = digits.slice(0, 1);
  const last4 = digits.slice(-4);
  const masked = '*'.repeat(Math.max(0, digits.length - 5));
  return `${plus}${cc}${masked}${last4}`;
}

export async function sendExternalMessageHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; channel: 'email' | 'sms'; providerMessageId: string; recipientRedacted: string }> {
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
  if (!args.transactional) {
    const suppressionRef = db().collection('message_suppressions').doc(suppressionDocId(normalized));
    const suppressionSnap = await suppressionRef.get();
    if (suppressionSnap.exists) {
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
      const message = await getTwilio().messages.create({
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
    event: AUDIT_EVENTS.EXTERNAL_MESSAGE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'external_messages',
    description: `External ${args.channel} sent to ${recipientRedacted}`,
    payload: { channel: args.channel, recipientRedacted, providerMessageId, transactional: args.transactional },
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
    extra: { channel: args.channel, recipientRedacted, providerMessageId },
  });

  return { ok: true, channel: args.channel, providerMessageId, recipientRedacted };
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
