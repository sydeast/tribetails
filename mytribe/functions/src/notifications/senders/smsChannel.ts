import Handlebars from 'handlebars';
import { db } from '../../lib/firestoreAdmin';
import { getTwilio, getTwilioFromNumber } from '../../lib/twilio';
import { stripUnresolvedTokens } from '../templateParsers';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/**
 * SMS channel sender (Twilio). Looks up `smsTemplates/{key}` for a `text`
 * Handlebars template, resolves recipient phone from clients/ or staff/,
 * sends via Twilio Messages API, returns provider message SID.
 *
 * Fails loud if:
 *   - the catalog row has no sms template id (a misconfigured row)
 *   - recipient has no phone
 *   - Twilio rejects (will surface error.code + status; outer wrapTrigger
 *     captures to Sentry)
 * Soft-skips (returns { skipped }) if:
 *   - `smsTemplates/{id}` is missing or has no text. Unlike email and push there
 *     is NO generic fallback here: a segment costs money and content-free text
 *     is not worth paying for (operator ruling 2026-08-23). See
 *     notifications/fallbackTemplate.ts.
 *
 * Phone format expectation: E.164 (`+15551234567`). Documents missing the
 * leading `+` are passed through to Twilio which will reject with a 21211
 * "Invalid 'To' Phone Number", surfaced rather than silently fixed so the
 * source-of-truth phone capture flow gets corrected upstream.
 */
export async function sendSmsChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data } = args;
  const templateId = def.templates.sms;
  if (!templateId) {
    throw new Error(`smsChannel(${def.key}): catalog has no sms template id`);
  }

  const tplSnap = await db().doc(`smsTemplates/${templateId}`).get();
  const tpl = tplSnap.exists ? (tplSnap.data() as { text?: string }) : null;
  if (!tpl?.text) {
    // SMS gets NO generic fallback, unlike email and push. Operator ruling
    // 2026-08-23: a segment costs money and "there's an update, sign in" is not
    // worth paying for. Email carries the generic copy instead, and it is the
    // channel `required.email` keeps on for almost every key.
    //
    // Skipped rather than thrown, because an unauthored template is a content
    // gap on the operator's schedule, not an infrastructure fault: throwing
    // would Sentry-capture and retry something no retry can fix. The fan-out
    // handler stamps the channel subdoc `status: 'skipped'` with this reason and
    // logs it, so it stays visible.
    return {
      skipped: true,
      skipReason: tplSnap.exists ? 'template_text_empty' : 'template_missing',
    };
  }

  const phone = await lookupRecipientPhone(recipientUid);
  if (!phone) {
    throw new Error(`smsChannel(${def.key}): recipient ${recipientUid} has no phone on file`);
  }

  const body = stripUnresolvedTokens(
    Handlebars.compile(tpl.text)({ ...data, recipientUid, notificationKey: def.key }),
  );
  const twilio = await getTwilio();
  const message = await twilio.messages.create({
    from: getTwilioFromNumber(),
    to: phone,
    body,
  });

  return { providerMessageId: message.sid };
}

async function lookupRecipientPhone(uid: string): Promise<string | null> {
  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  if (clientSnap.exists) {
    const phone = clientSnap.data()?.['phone'];
    if (typeof phone === 'string' && phone.length > 0) return phone;
  }
  const staffSnap = await firestore.collection('staff').doc(uid).get();
  if (staffSnap.exists) {
    const phone = staffSnap.data()?.['phone'];
    if (typeof phone === 'string' && phone.length > 0) return phone;
  }
  return null;
}
