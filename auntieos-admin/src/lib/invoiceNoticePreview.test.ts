import { describe, it, expect } from 'vitest';
import type { PreviewInvoiceNoticeResult } from '../contracts/invoiceContracts.generated';
import { noticePreviewSentence } from './invoiceNoticePreview';

function preview(over: Partial<PreviewInvoiceNoticeResult> = {}): PreviewInvoiceNoticeResult {
  return {
    ok: true,
    key: 'invoice.reminder',
    hasRecipient: true,
    recipientName: 'Robin Wren',
    email: { on: true, address: 'catch@hanasamku.com' },
    sms: { on: false, address: '' },
    push: { on: false },
    disabled: null,
    householdGateLive: true,
    ...over,
  };
}

/** #1609: the confirm names the person and the channel. */
describe('noticePreviewSentence', () => {
  it('names the person and each channel with its address', () => {
    expect(noticePreviewSentence(preview({ push: { on: true } }))).toBe(
      'Goes to Robin Wren by email to catch@hanasamku.com and a phone notification, and in their notifications list.',
    );
  });
  it('names a channel that is on but has no address as missing, not as a send', () => {
    expect(noticePreviewSentence(preview({ sms: { on: true, address: '' } }))).toBe(
      'Goes to Robin Wren by email to catch@hanasamku.com, and in their notifications list. Their account has no phone number on file.',
    );
  });
  it('says when nothing will reach them', () => {
    expect(noticePreviewSentence(preview({ householdGateLive: false }))).toBe(
      'Household notices are paused before launch, so Robin Wren will not hear about this yet.',
    );
    expect(noticePreviewSentence(preview({ hasRecipient: false }))).toBe(
      'No one in this household can receive billing notices, so nobody will be told.',
    );
    expect(noticePreviewSentence(preview({ disabled: 'operator' }))).toBe(
      'This notice is turned off in Settings, so Robin Wren will not get it.',
    );
    expect(noticePreviewSentence(preview({ email: { on: false, address: 'catch@hanasamku.com' } }))).toBe(
      'Robin Wren has no way to be reached for this notice, so it will show only in their notifications list in the app.',
    );
  });
});
