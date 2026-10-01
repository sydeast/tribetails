import { db } from '../../lib/firestoreAdmin';
import { loadEmailTemplate } from '../../lib/sendFromTemplate';
import { sendTemplatedEmail } from '../../lib/email';
import { sendPartsFor } from '../../lib/emailFrame';
import { loadEmailFrame } from '../../lib/emailFrameStore';
import { logEvent } from '../../lib/logger';
import { isEmailHardBounced } from '../../lib/suppressions';
import { fallbackEmail } from '../fallbackTemplate';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/**
 * Email channel sender, reads recipient email from clients/{uid} or
 * staff/{uid}, looks up template via def.templates.email, renders, sends
 * via SendGrid (existing sendFromTemplate wrapper).
 *
 * Throws if:
 *   - the catalog row has no email template id (a misconfigured row, which no
 *     operator action can fix)
 *   - the send itself fails
 * Falls back to GENERIC wording (returns { usedFallback }) if:
 *   - `emailTemplates/{id}` does not exist. That means the operator has not
 *     authored the copy yet, which is a content gap on their schedule, not a
 *     fault. Throwing made a new notification key dead in prod until someone
 *     wrote public-facing text, and would have taken the whole system down the
 *     day the template set is mass-deleted and re-authored. Logged at `error`
 *     and stamped on the channel subdoc so it is disclosed, never silent.
 *     See notifications/fallbackTemplate.ts.
 * Soft-skips (returns { skipped } instead of throwing) if:
 *   - recipient has no email on file — a PERMANENT, undeliverable condition, not
 *     an infrastructure error. Throwing here would Sentry-capture + retry an
 *     unfixable case (e.g. MYTRIBE-FUNCTIONS-8: invoice.reminder to a kinfolk
 *     with no email). The fan-out handler records status 'skipped' + a warning
 *     so it is visible, never silently swallowed.
 *   - the address is suppressed as a hard bounce (#1077), equally permanent.
 * Outer trigger wrap captures genuine throws to Sentry per fail-loud policy.
 */
export async function sendEmailChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data } = args;
  const templateId = def.templates.email;
  if (!templateId) {
    throw new Error(`emailChannel(${def.key}): catalog has no email template id`);
  }

  const email = await lookupRecipientEmail(recipientUid);
  if (!email) {
    // Fail-soft: undeliverable, not an error. Do NOT throw (no Sentry, no retry).
    return { skipped: true, skipReason: 'recipient_no_email' };
  }
  // #1077: smtp2go reported this address as a hard bounce. Mailing it again
  // only bounces again and hurts the sender rating, and it is just as
  // permanent as having no address, so it soft-skips the same way. A marketing
  // opt-out is NOT consulted here: household notifications are governed by
  // notification preferences, not by a one-off message's unsubscribe.
  if (await isEmailHardBounced(email)) {
    return { skipped: true, skipReason: 'recipient_hard_bounced' };
  }

  const renderData = { ...data, recipientUid, notificationKey: def.key };
  const tpl = await loadEmailTemplate(templateId);

  if (!tpl) {
    const generic = fallbackEmail(def);
    logEvent({
      severity: 'error',
      function: 'emailChannel',
      event: 'notification.template.missing',
      extra: {
        key: def.key,
        channel: 'email',
        templateId,
        action: 'sent generic wording; author this template in the Template Bank',
      },
    });
    const providerMessageId = await sendTemplatedEmail({
      to: email,
      subjectTemplate: generic.subject,
      bodyTemplate: generic.body,
      data: renderData,
      templateKey: def.key,
    });
    return { providerMessageId, usedFallback: true, fallbackReason: `emailTemplates/${templateId}` };
  }

  // #957: the operator's frame, read once for this send. Never throws.
  const frame = await loadEmailFrame('emailChannel');
  const providerMessageId = await sendTemplatedEmail({
    to: email,
    data: renderData,
    templateKey: def.key,
    ...sendPartsFor(tpl, frame),
  });
  return { providerMessageId };
}

async function lookupRecipientEmail(uid: string): Promise<string | null> {
  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  if (clientSnap.exists) {
    const email = clientSnap.data()?.['email'];
    if (typeof email === 'string' && email.length > 0) return email;
  }
  const staffSnap = await firestore.collection('staff').doc(uid).get();
  if (staffSnap.exists) {
    const email = staffSnap.data()?.['email'];
    if (typeof email === 'string' && email.length > 0) return email;
  }
  return null;
}
