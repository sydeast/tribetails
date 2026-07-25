import { describe, it, expect, vi } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import { sendExternalMessage, suppressExternalRecipient } from './externalSend';

// NOTE: `callMock.mockReset()` runs at the top of EACH test body below, not in a
// shared `beforeEach`. Same deliberate deviation `api/invoicesWrite.test.ts`
// documents: resetting a `vi.hoisted` mock of a `vi.mock`'d LOCAL module from
// inside a `beforeEach`, in a test that both configures a rejection AND awaits
// it, makes Vitest misreport the genuinely-caught rejection as an unhandled
// error and fail a correct assertion. Moving the reset inline removes the
// trigger with no loss of isolation, since every test sets its own return value
// immediately after.


describe('sendExternalMessage', () => {
  it('sends an email with its subject, trimmed', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'p1', recipientRedacted: 'd***@example.com' });

    const res = await sendExternalMessage({
      channel: 'email',
      to: '  dana@example.com ',
      subject: '  Nova  ',
      body: '  She had a big day.  ',
      transactional: true,
    });

    expect(callMock).toHaveBeenCalledWith('sendExternalMessage', {
      channel: 'email',
      to: 'dana@example.com',
      subject: 'Nova',
      body: 'She had a big day.',
      transactional: true,
    });
    expect(res).toEqual({ ok: true, channel: 'email', providerMessageId: 'p1', recipientRedacted: 'd***@example.com' });
  });

  it('omits subject entirely on a text, which has no subject line', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1', recipientRedacted: '+1****0123' });
    await sendExternalMessage({ channel: 'sms', to: '+15125550123', subject: 'ignored', body: 'hi', transactional: true });
    expect('subject' in (callMock.mock.calls[0]?.[1] as Record<string, unknown>)).toBe(false);
  });

  it('defaults transactional to true, so a 1:1 note cannot be dropped by a marketing opt-out', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1', recipientRedacted: '+1****0123' });
    await sendExternalMessage({ channel: 'sms', to: '+15125550123', body: 'hi' });
    expect((callMock.mock.calls[0]?.[1] as Record<string, unknown>)['transactional']).toBe(true);
  });

  it('honors an explicit transactional:false for a genuinely marketing send', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1', recipientRedacted: '+1****0123' });
    await sendExternalMessage({ channel: 'sms', to: '+15125550123', body: 'hi', transactional: false });
    expect((callMock.mock.calls[0]?.[1] as Record<string, unknown>)['transactional']).toBe(false);
  });

  it('reads a missing providerMessageId as null rather than inventing an empty id', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', recipientRedacted: '+1****0123' });
    expect((await sendExternalMessage({ channel: 'sms', to: '+15125550123', body: 'hi' })).providerMessageId).toBeNull();
  });

  it('never swallows the opt-out refusal', async () => {
    callMock.mockReset();
    callMock.mockImplementation(() => Promise.reject(new Error('FAILED_PRECONDITION: recipient_opted_out')));
    await expect(sendExternalMessage({ channel: 'sms', to: '+15125550123', body: 'hi' })).rejects.toThrow(
      /recipient_opted_out/,
    );
  });
});

describe('suppressExternalRecipient', () => {
  it('sends the channel and the trimmed recipient', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'email', recipientRedacted: 'd***@example.com' });
    const res = await suppressExternalRecipient({ channel: 'email', to: ' dana@example.com ' });
    expect(callMock).toHaveBeenCalledWith('suppressExternalRecipient', { channel: 'email', to: 'dana@example.com' });
    expect(res.recipientRedacted).toBe('d***@example.com');
  });

  it('reads a missing redaction as empty rather than as the word undefined', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'email' });
    expect((await suppressExternalRecipient({ channel: 'email', to: 'dana@example.com' })).recipientRedacted).toBe('');
  });
});
