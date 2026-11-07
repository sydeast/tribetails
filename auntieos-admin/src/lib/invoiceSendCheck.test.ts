import { describe, expect, it } from 'vitest';
import { sendLanded, sendMarksOf, sendOutcomeAfterSilence, type SendMarks } from './invoiceSendCheck';
const draft: SendMarks = sendMarksOf({ status: 'draft' });
describe('sendMarksOf', () => {
  it('reads status case-blind and every stamp shape the invoice doc carries', () => {
    const marks = sendMarksOf({
      status: ' Open ',
      reminderNotifiedAtMs: 1_700_000_000_000,
      receiptIssuedAt: { toMillis: () => 1_700_000_000_500 },
      quoteResentAt: { seconds: 1_700_000_001, nanoseconds: 250_000_000 },
    });
    expect(marks).toEqual({
      status: 'open',
      reminderNotifiedAtMs: 1_700_000_000_000,
      receiptIssuedAtMs: 1_700_000_000_500,
      quoteResentAtMs: 1_700_000_001_250,
    });
  });
  it('reads an absent or unreadable stamp as no stamp', () => {
    expect(sendMarksOf({ status: 7, receiptIssuedAt: 'yesterday' })).toEqual({
      status: '',
      reminderNotifiedAtMs: null,
      receiptIssuedAtMs: null,
      quoteResentAtMs: null,
    });
  });
});
describe('sendLanded', () => {
  it('a draft send landed when the invoice is no longer a draft', () => {
    expect(sendLanded('reviewSend', draft, sendMarksOf({ status: 'open' }))).toBe(true);
    expect(sendLanded('reviewSend', draft, draft)).toBe(false);
    // An unreadable status is not evidence of a send.
    expect(sendLanded('reviewSend', draft, sendMarksOf({}))).toBe(false);
  });
  it('a reminder, receipt or quote resend landed only when its own stamp moved', () => {
    const before = sendMarksOf({ status: 'open', reminderNotifiedAtMs: 100 });
    expect(sendLanded('reminder', before, sendMarksOf({ reminderNotifiedAtMs: 100 }))).toBe(false);
    expect(sendLanded('reminder', before, sendMarksOf({ reminderNotifiedAtMs: 200 }))).toBe(true);
    expect(sendLanded('receipt', before, sendMarksOf({ receiptIssuedAt: 5 }))).toBe(true);
    expect(sendLanded('receipt', before, before)).toBe(false);
    expect(sendLanded('resendQuote', before, sendMarksOf({ quoteResentAt: 9 }))).toBe(true);
    expect(sendLanded('resendQuote', before, before)).toBe(false);
  });
});
describe('sendOutcomeAfterSilence', () => {
  it('reports a send that landed as sent, and says how it knows', () => {
    const out = sendOutcomeAfterSilence('reviewSend', 70, draft, sendMarksOf({ status: 'open' }));
    expect(out.kind).toBe('sent');
    expect(out.message).toMatch(/^Draft sent\./);
    expect(out.message).toMatch(/re-reading the invoice/);
  });
  it('reports a draft that is still a draft as not sent, and never as failed', () => {
    const out = sendOutcomeAfterSilence('reviewSend', 70, draft, draft);
    expect(out.kind).toBe('not-sent');
    expect(out.message).toContain('70 seconds');
    expect(out.message).toContain('still a draft');
    expect(out.message).not.toMatch(/fail/i);
  });
  it('says it cannot tell when the re-read failed, and names what to check', () => {
    const out = sendOutcomeAfterSilence('reminder', 70, draft, null);
    expect(out.kind).toBe('unknown');
    expect(out.message).toContain('no way to tell from here');
    expect(out.message).toContain('Last reminder');
  });
});
