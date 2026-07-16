import { db } from '../../lib/firestoreAdmin';
import { sendFromTemplate } from '../../lib/sendFromTemplate';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/**
 * Email channel sender, reads recipient email from clients/{uid} or
 * staff/{uid}, looks up template via def.templates.email, renders, sends
 * via SendGrid (existing sendFromTemplate wrapper).
 *
 * Throws if:
 *   - recipient record missing
 *   - recipient has no email on file
 *   - template missing
 *   - SendGrid send fails
 * Outer trigger wrap captures to Sentry per fail-loud policy.
 */
export async function sendEmailChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data } = args;
  const templateId = def.templates.email;
  if (!templateId) {
    throw new Error(`emailChannel(${def.key}): catalog has no email template id`);
  }

  const email = await lookupRecipientEmail(recipientUid);
  if (!email) {
    throw new Error(`emailChannel(${def.key}): recipient ${recipientUid} has no email on file`);
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
