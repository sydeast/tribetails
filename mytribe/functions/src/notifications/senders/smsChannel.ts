import { db } from '../../lib/firestoreAdmin';
import { getTwilio, getTwilioFromNumber } from '../../lib/twilio';
import { describeProviderFailure } from '../../lib/providerFailure';
import { redactRecipient } from '../../lib/suppressions';
import { logEvent } from '../../lib/logger';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  householdSms,
  kinForStoredTemplate,
  renderPlainText,
  templateRenderFailure,
} from '../templateParsers';
import { keepWholeMessage } from './pushChannel';
import { AUNTIE_SCHEDULE_URL as ADMIN_URL, PORTAL_URL } from '../visitDates';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/** What comes before the AuntieOS link on an office or Auntie text (#2487). */
export const OFFICE_SMS_LINK_LABEL = 'Open in AuntieOS:';

/**
 * SMS channel sender (Twilio). Looks up `smsTemplates/{key}` for a `text`
 * Handlebars template, resolves recipient phone from clients/ or staff/,
 * sends via Twilio Messages API, returns provider message SID.
 *
 * Fails loud if:
 *   - the catalog row has no sms template id (a misconfigured row)
 *   - Twilio rejects. The rethrown error's message names Twilio and carries the
 *     HTTP status and error code (#1524, lib/providerFailure.ts), because the
 *     outer wrapTrigger logs the message alone; `status` and `code` stay on the
 *     error as fields and the original is its `cause` for Sentry.
 * Soft-skips (returns { skipped }) if:
 *   - `smsTemplates/{id}` is missing or has no text. Unlike email and push there
 *     is NO generic fallback here: a segment costs money and content-free text
 *     is not worth paying for (operator ruling 2026-08-23). See
 *     notifications/fallbackTemplate.ts.
 *   - the recipient has no phone on file. A household that never gave us a
 *     number is a normal data state, not a fault, and it is the same PERMANENT
 *     undeliverable condition `emailChannel` already skips on for a missing
 *     email (MYTRIBE-FUNCTIONS-8). Throwing turned every such notification into
 *     a Sentry issue nobody can act on (MYTRIBE-FUNCTIONS-C, 19 events) and
 *     stamped the channel row `failed`, which reads as a delivery fault rather
 *     than a household we have no number for.
 *
 * A HOUSEHOLD'S COPY IS SHORT AND CARRIES A LINK (#2280, operator ruling
 * 2026-11-14): the rendered text is cut to a short line and ends with a link to
 * MyTribe, where the notifications list holds the whole message. See
 * `householdSms` in templateParsers.ts. The link opens the notice's own entry
 * on that list, and a message that was cut is kept whole on that entry (#2371).
 *
 * Phone format expectation: E.164 (`+15551234567`). Documents missing the
 * leading `+` are passed through to Twilio which will reject with a 21211
 * "Invalid 'To' Phone Number", surfaced rather than silently fixed so the
 * source-of-truth phone capture flow gets corrected upstream.
 */
export async function sendSmsChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data, stream, open } = args;
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

  // #2251: wording stored with an unclosed {{#if}} (imported before the
  // importer refused one) used to throw here on every send. Still no generic
  // text, by the same ruling: a visible skip the Activity Log names, and an
  // `error` line naming the template so the office can fix it.
  const textData = { ...kinForStoredTemplate(data, [tpl.text]), recipientUid, notificationKey: def.key };
  const failure = templateRenderFailure([tpl.text], textData);
  if (failure !== null) {
    logEvent({
      severity: 'error',
      function: 'smsChannel',
      event: 'notification.template.broken',
      uid: recipientUid,
      extra: {
        key: def.key,
        channel: 'sms',
        templateId,
        reason: failure,
        action: 'skipped the text message; open this template in the Template Bank and fix its text message wording',
      },
    });
    return { skipped: true, skipReason: 'template_broken' };
  }

  const phone = await lookupRecipientPhone(recipientUid);
  if (!phone) {
    // Fail-soft: undeliverable, not an error. Do NOT throw (no Sentry, and the
    // row is not stamped `failed`). The fan-out handler stamps
    // `status: 'skipped'` with this reason on the channel subdoc and logs a
    // warning, so the office can still see this household is unreachable by SMS.
    return { skipped: true, skipReason: 'recipient_no_phone' };
  }

  // #2321: a text message is plain text, so nothing is escaped for a web page.
  // #2093: a template stored before the quote wording changed still reads whole.
  const rendered = renderPlainText(tpl.text, textData);
  // #2280: a household's text message is short and links into MyTribe, where
  // the whole message is.
  // #2371: the link opens this notice's entry, and a cut message is written
  // onto it first, so the rest is there when the link is followed.
  // #2487: the link goes to the item the notice is about (that visit, that
  // KinTale, that invoice), the way a tap on its push does. Only a message that
  // was cut, or that carries the office's note, links to its entry on the
  // notifications list instead, because the whole message is there.
  let body = rendered;
  if (stream === 'kinfolk') {
    const entry = open?.readInList;
    const entryRoute = entry?.route ?? HOUSEHOLD_NOTICE_ROUTE;
    let sms = householdSms(rendered, PORTAL_URL, open?.officeNote === true ? entryRoute : (open?.route ?? entryRoute));
    if (sms.cut && open?.route && open.route !== entryRoute) sms = householdSms(rendered, PORTAL_URL, entryRoute);
    if (sms.cut && entry?.entryId) await keepWholeMessage('sms', entry.entryId, rendered, def.key);
    body = sms.text;
  } else if (stream === 'business' || stream === 'staff') {
    // #2487: an office or Auntie text says where the item is in AuntieOS. A
    // text that already carries an AuntieOS link (`{{link}}`, or an older
    // stored template's schedule link) is sent as written, never with two.
    const link = typeof data['link'] === 'string' ? data['link'].trim() : '';
    if (link !== '' && rendered.trim() !== '' && !rendered.includes(ADMIN_URL)) {
      body = `${rendered.trim()} ${OFFICE_SMS_LINK_LABEL} ${link}`;
    }
  }
  const twilio = await getTwilio();
  let message: { sid: string };
  try {
    message = await twilio.messages.create({
      from: getTwilioFromNumber(),
      to: phone,
      body,
    });
  } catch (err) {
    // #1524: wrapTrigger logs the thrown error's message and nothing else of
    // it, so Twilio's `status` and `code` have to be in the message for the
    // real-services classifier to tell a 5xx from a refusal. The rethrown
    // error keeps both as fields and the original as `cause` for Sentry, and
    // the number is masked out of Twilio's text.
    throw describeProviderFailure('Twilio', err, { plain: phone, masked: redactRecipient('sms', phone) });
  }

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
