import { db } from '../../lib/firestoreAdmin';
import { sendFromTemplate } from '../../lib/sendFromTemplate';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/**
 * Email channel sender, reads recipient email from clients/{uid} or
 * staff/{uid}, looks up template via def.templates.email, renders, sends
 * via SendGrid (existing sendFromTemplate wrapper).
 *
 * Throws if:
 *   - template missing
 *   - SendGrid send fails
 * Soft-skips (returns { skipped } instead of throwing) if:
 *   - recipient has no email on file — a PERMANENT, undeliverable condition, not
 *     an infrastructure error. Throwing here would Sentry-capture + retry an
 *     unfixable case (e.g. MYTRIBE-FUNCTIONS-8: invoice.reminder to a kinfolk
 *     with no email). The fan-out handler records status 'skipped' + a warning
 *     so it is visible, never silently swallowed.
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

  const providerMessageId = await sendFromTemplate(templateId, email, {
    ...data,
    recipientUid,
    notificationKey: def.key,
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
