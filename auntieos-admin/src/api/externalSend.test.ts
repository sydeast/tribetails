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
    expect(res).toEqual({
      ok: true,
      channel: 'email',
      providerMessageId: 'p1',
      recipientRedacted: 'd***@example.com',
      // An email is never mirrored, and a server that says nothing about it must
      // read as "not mirrored" rather than leaving the field undefined.
      mirrored: false,
      mirrorSkippedReason: 'not_requested',
    });
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
/**
 * The mirror is the field that decides whether the recipient's number is stored
 * in the CLEAR in `sms_messages`. The wire must never overclaim it: a banner
 * that says a reply is in the thread when no row was written sends the operator
 * looking for something that is not there.
 */
describe('sendExternalMessage outbound mirror wire', () => {
  it('asks for the mirror only when told to, and only on a text', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1', mirrored: true });
    await sendExternalMessage({ channel: 'sms', to: '+14155552671', body: 'hi', mirrorToChannel: true });
    expect(callMock.mock.calls[0]?.[1]).toMatchObject({ mirrorToChannel: true });
  });
  it('NEVER sends mirrorToChannel on email, which the server rejects outright', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'p1' });
    await sendExternalMessage({
      channel: 'email',
      to: 'dana@example.com',
      subject: 'Hi',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(callMock.mock.calls[0]?.[1]).not.toHaveProperty('mirrorToChannel');
  });
  it('omits the key entirely when not asked, so a legacy server sees the payload it knows', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1' });
    await sendExternalMessage({ channel: 'sms', to: '+14155552671', body: 'hi' });
    expect(callMock.mock.calls[0]?.[1]).not.toHaveProperty('mirrorToChannel');
  });
  it('reads a server that says nothing about mirroring as NOT mirrored', async () => {
    // A deployed function predating this field returns neither key. Understating
    // is the only safe direction: the banner keeps telling the old truth.
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'p1' });
    const res = await sendExternalMessage({
      channel: 'sms',
      to: '+14155552671',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(res.mirrored).toBe(false);
    expect(res.mirrorSkippedReason).toBe('not_requested');
  });
  it('passes the server reason through so the banner can be specific', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      channel: 'sms',
      providerMessageId: 'p1',
      mirrored: false,
      mirrorSkippedReason: 'no_existing_thread',
    });
    const res = await sendExternalMessage({
      channel: 'sms',
      to: '+14155552671',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(res.mirrorSkippedReason).toBe('no_existing_thread');
  });
  it('refuses to report a reason alongside a successful mirror', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      channel: 'sms',
      providerMessageId: 'p1',
      mirrored: true,
      mirrorSkippedReason: 'write_failed',
    });
    const res = await sendExternalMessage({
      channel: 'sms',
      to: '+14155552671',
      body: 'hi',
      mirrorToChannel: true,
    });
    expect(res.mirrored).toBe(true);
    expect(res.mirrorSkippedReason).toBeNull();
  });
});
