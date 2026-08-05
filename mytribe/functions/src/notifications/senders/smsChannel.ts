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
 *   - SMS template doc missing
 *   - recipient has no phone
 *   - Twilio rejects (will surface error.code + status; outer wrapTrigger
 *     captures to Sentry)
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
  if (!tplSnap.exists) {
    throw new Error(`smsChannel(${def.key}): smsTemplates/${templateId} missing`);
  }
  const tpl = tplSnap.data() as { text?: string };
  if (!tpl.text) {
    throw new Error(`smsChannel(${def.key}): smsTemplates/${templateId} has no .text field`);
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
