import { db } from '../../lib/firestoreAdmin';
import { loadEmailTemplate } from '../../lib/sendFromTemplate';
import { sendTemplatedEmail } from '../../lib/email';
import { sendPartsFor } from '../../lib/emailFrame';
import { loadEmailFrame } from '../../lib/emailFrameStore';
import { logEvent } from '../../lib/logger';
import { isEmailHardBounced } from '../../lib/suppressions';
import { fallbackEmail } from '../fallbackTemplate';
import { kinForStoredTemplate, templateRenderFailure } from '../templateParsers';
import { businessLabel, loadBusinessName } from '../../lib/businessName';
import { businessNoticeRecipients, readBusinessAdmins } from '../../lib/businessAdmins';
import type { ChannelSendArgs, ChannelSendResult } from './index';

/**
 * Email channel sender, reads recipient email from clients/{uid} or
 * staff/{uid}, looks up template via def.templates.email, renders, sends
 * via smtp2go (lib/email.ts).
 *
 * BUSINESS EMAIL GOES TO THE BUSINESS CONTACT EMAIL (#1564). Operator ruling,
 * 2026-11-05 docket: "every business email goes to the business contact email
 * in business settings (`businessEmail`), not to a staff record." A copy that
 * reached a staff uid through the `businessAdmins` resolver is a business
 * email, so it is sent to `business_settings/business_settings.businessEmail`,
 * whatever the staff record says. A blank `businessEmail` skips the send
 * (`business_email_unset`) and logs at warn; Settings says the same thing
 * beside the field. Staff copies from any other resolver (an assigned Auntie's
 * `assignment.*` mail) still read `staff/{uid}.email`.
 *
 * Throws if:
 *   - the catalog row has no email template id (a misconfigured row, which no
 *     operator action can fix)
 *   - the send itself fails. No catch here: `lib/email.ts` already throws an
 *     error whose message names smtp2go with the HTTP status, or the network
 *     code and a timeout word (#1535, lib/providerFailure.ts), so the outer
 *     wrapTrigger's one-line log classifies the way the SMS channel's does.
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

  const target = await lookupRecipientEmail(def, recipientUid);
  if (target.kind === 'business-unset') {
    logEvent({
      severity: 'warn',
      function: 'emailChannel',
      event: 'notification.businessEmail.unset',
      uid: recipientUid,
      extra: {
        key: def.key,
        action: 'skipped; set the business contact email in Settings > Business',
      },
    });
    return { skipped: true, skipReason: 'business_email_unset' };
  }
  const email = target.kind === 'address' ? target.email : null;
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

  const sendGeneric = async (event: string, action: string, reason?: string): Promise<ChannelSendResult> => {
    const businessName = await loadBusinessName('emailChannel');
    const link = (renderData as Record<string, unknown>)['link'];
    const generic = fallbackEmail(def, businessName, { hasLink: typeof link === 'string' && link.trim() !== '' });
    logEvent({
      severity: 'error',
      function: 'emailChannel',
      event,
      extra: { key: def.key, channel: 'email', templateId, ...(reason ? { reason } : {}), action },
    });
    const providerMessageId = await sendTemplatedEmail({
      to: email,
      subjectTemplate: generic.subject,
      bodyTemplate: generic.body,
      data: { ...renderData, businessLabel: businessLabel(businessName) },
      templateKey: def.key,
    });
    return { providerMessageId, usedFallback: true, fallbackReason: `emailTemplates/${templateId}` };
  };

  if (!tpl) {
    return sendGeneric(
      'notification.template.missing',
      'sent generic wording; author this template in the Template Bank',
    );
  }

  // #957: the operator's frame, read once for this send. Never throws.
  const frame = await loadEmailFrame('emailChannel');
  // #2251: a stored template the renderer cannot fill in (an unclosed {{#if}}
  // saved before the save refused it, or imported before the importer did)
  // used to throw here on every send, so the household heard nothing. It now
  // gets the disclosed fallback a missing template already gets: the generic
  // wording goes out, logged at `error` with the template id, and the channel
  // row is stamped `usedFallback`. Only the render is guarded; a provider
  // failure below still throws and retries as before.
  let parts: ReturnType<typeof sendPartsFor>;
  let failure: string | null;
  try {
    parts = sendPartsFor(tpl, frame);
    failure = null;
  } catch (err) {
    // A document marked visual with no headline or content: nothing to fill in.
    parts = { subjectTemplate: '', bodyTemplate: '' };
    failure = err instanceof Error ? err.message : String(err);
  }
  // #2093: a template stored before the quote wording changed still reads whole.
  const sendData = kinForStoredTemplate(renderData, [parts.subjectTemplate, parts.bodyTemplate, parts.htmlTemplate]);
  failure ??= templateRenderFailure([parts.subjectTemplate, parts.bodyTemplate, parts.htmlTemplate], sendData);
  if (failure !== null) {
    return sendGeneric(
      'notification.template.broken',
      'sent generic wording; open this template in the Template Bank and fix it',
      failure,
    );
  }
  const providerMessageId = await sendTemplatedEmail({
    to: email,
    data: sendData,
    templateKey: def.key,
    ...parts,
  });
  return { providerMessageId };
}

type EmailTarget =
  | { kind: 'address'; email: string }
  | { kind: 'none' }
  /** A business email, and `businessEmail` in settings is blank. */
  | { kind: 'business-unset' };

/**
 * Does this copy belong to the business roster? Only a key that names the
 * `businessAdmins` resolver can produce one, and only for a uid that is on the
 * roster (or, while the roster is empty, the operator allowlist the dispatch
 * path seeds it from). The roster check keeps a household uid with no
 * `clients/` document from being mailed to the business by mistake.
 *
 * #2223: the same owner-only recipients the dispatcher resolved, so an Auntie
 * left on the list is not treated as a business copy, and the allowlist owner
 * the dispatcher fell back to (a list holding only an Auntie) is.
 */
async function isBusinessRosterCopy(def: ChannelSendArgs['def'], uid: string): Promise<boolean> {
  if (def.recipientResolver !== 'businessAdmins' && def.secondaryResolver !== 'businessAdmins') return false;
  const { uids } = await businessNoticeRecipients(await readBusinessAdmins(), 'emailChannel');
  return uids.includes(uid);
}

/**
 * `business_settings/business_settings.businessEmail`, trimmed. '' when unset.
 * A failed read throws: that is retryable, and skipping would lose the email.
 */
async function loadBusinessEmail(): Promise<string> {
  const snap = await db().collection('business_settings').doc('business_settings').get();
  const raw = snap.data()?.['businessEmail'];
  return typeof raw === 'string' ? raw.trim() : '';
}

async function lookupRecipientEmail(def: ChannelSendArgs['def'], uid: string): Promise<EmailTarget> {
  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  if (clientSnap.exists) {
    const email = clientSnap.data()?.['email'];
    return typeof email === 'string' && email.length > 0 ? { kind: 'address', email } : { kind: 'none' };
  }
  if (await isBusinessRosterCopy(def, uid)) {
    const businessEmail = await loadBusinessEmail();
    return businessEmail ? { kind: 'address', email: businessEmail } : { kind: 'business-unset' };
  }
  const staffSnap = await firestore.collection('staff').doc(uid).get();
  if (staffSnap.exists) {
    const email = staffSnap.data()?.['email'];
    if (typeof email === 'string' && email.length > 0) return { kind: 'address', email };
  }
  return { kind: 'none' };
}
