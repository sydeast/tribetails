import type { PreviewInvoiceNoticeResult } from '../contracts/invoiceContracts.generated';

/**
 * #1609: the confirm's sentence about WHO a send reaches and HOW, from the
 * `previewInvoiceNotice` callable (which reads the same recipient, prefs,
 * operator override and household gate the real send does).
 *
 * The walk's confirms said "the household on file" and nothing else. This names
 * the person and each channel with its address, and says plainly when nothing
 * will reach them: no billing recipient, the pre-launch household gate shut,
 * or the notice turned off. A channel that is on but has no address on file is
 * named as missing rather than counted as a send.
 *
 * Mirrored in admin Android (`domain/InvoiceNoticePreview.kt`) and the desktop
 * console (`data/InvoiceNoticePreview.kt`) with the same sentences.
 */
export function noticePreviewSentence(preview: PreviewInvoiceNoticeResult): string {
  if (!preview.hasRecipient) {
    return 'No one in this household can receive billing notices, so nobody will be told.';
  }
  const who = preview.recipientName.trim() === '' ? 'the household' : preview.recipientName.trim();
  if (!preview.householdGateLive) {
    return `Household notices are paused before launch, so ${who} will not hear about this yet.`;
  }
  if (preview.disabled === 'operator') {
    return `This notice is turned off in Settings, so ${who} will not get it.`;
  }
  if (preview.disabled === 'marketing') {
    return `${who} has not opted in to this notice, so they will not get it.`;
  }
  const ways: string[] = [];
  const missing: string[] = [];
  if (preview.email.on) {
    if (preview.email.address !== '') ways.push(`email to ${preview.email.address}`);
    else missing.push('no email address');
  }
  if (preview.sms.on) {
    if (preview.sms.address !== '') ways.push(`text to ${preview.sms.address}`);
    else missing.push('no phone number');
  }
  if (preview.push.on) ways.push('a phone notification');
  const gaps = missing.length === 0 ? '' : ` Their account has ${missing.join(' and ')} on file.`;
  if (ways.length === 0) {
    return `${who} has no way to be reached for this notice, so it will show only in their notifications list in the app.${gaps}`;
  }
  return `Goes to ${who} by ${joinWays(ways)}, and in their notifications list.${gaps}`;
}

function joinWays(ways: string[]): string {
  if (ways.length <= 1) return ways.join('');
  return `${ways.slice(0, -1).join(', ')} and ${ways[ways.length - 1]!}`;
}
