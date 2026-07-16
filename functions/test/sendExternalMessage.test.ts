import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  twilioCreate: vi.fn(),
  getTwilio: vi.fn(),
  getTwilioFromNumber: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: mocks.getTwilio,
  getTwilioFromNumber: mocks.getTwilioFromNumber,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  sendExternalMessageHandler,
  suppressExternalRecipientHandler,
  redactRecipient,
  normalizeRecipient,
  UNSUBSCRIBE_FOOTER,
} from '../src/admin/sendExternalMessage';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('sg-msg-1');
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SM123' });
  mocks.getTwilio.mockReset().mockReturnValue({ messages: { create: mocks.twilioCreate } });
  mocks.getTwilioFromNumber.mockReset().mockReturnValue('+15550000000');
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** db mock with no suppression docs (nothing opted out). */
function cleanDb() {
  return buildDbMock({ docs: {} });
}

describe('sendExternalMessage happy paths', () => {
  it('sends an email, appends unsubscribe footer, returns ok + redacted recipient', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendExternalMessageHandler(
      req({ channel: 'email', to: 'Jane@Example.com', subject: 'Hello', body: 'Hi there' }),
    );
    expect(res).toEqual({
      ok: true,
      channel: 'email',
      providerMessageId: 'sg-msg-1',
      recipientRedacted: 'j***@example.com',
    });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    const sgArgs = mocks.sendTemplatedEmail.mock.calls[0][0];
    expect(sgArgs.bodyTemplate.endsWith(UNSUBSCRIBE_FOOTER)).toBe(true);
    expect(sgArgs.bodyTemplate.startsWith('Hi there')).toBe(true);
    expect(sgArgs.subjectTemplate).toBe('Hello');
  });

  it('sends an SMS via Twilio with normalized E.164 to and returns the sid', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: '(415) 555-2671', body: 'Yo' }),
    );
    expect(res.providerMessageId).toBe('SM123');
    expect(res.channel).toBe('sms');
    expect(mocks.twilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: '+15550000000', to: '+14155552671', body: 'Yo' }),
    );
    // SMS body must NOT carry the email-style footer.
    expect(mocks.twilioCreate.mock.calls[0][0].body).toBe('Yo');
  });

  it('records the send in external_messages with a redacted recipient', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendExternalMessageHandler(
      req({ channel: 'email', to: 'jane@example.com', subject: 'S', body: 'B' }),
    );
    const add = ctx.adds.find((a) => a.collection === 'external_messages');
    expect(add).toBeTruthy();
    expect(add?.data.recipientRedacted).toBe('j***@example.com');
    // plaintext recipient must never be stored
    expect(JSON.stringify(add?.data)).not.toContain('jane@example.com');
  });

  it('emits an EXTERNAL_MESSAGE_SENT audit with redacted recipient (no plaintext)', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendExternalMessageHandler(
      req({ channel: 'sms', to: '+14155552671', body: 'B' }),
    );
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EXTERNAL_MESSAGE_SENT',
        actorUid: 'admin1',
        payload: expect.objectContaining({ channel: 'sms', recipientRedacted: '+1******2671' }),
      }),
    );
  });
});

describe('sendExternalMessage validation + sad paths', () => {
  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'email', to: 'a@b.com', subject: 'x', body: 'y' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a malformed email address (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'email', to: 'not-an-email', subject: 'x', body: 'y' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects email with missing subject (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'email', to: 'a@b.com', body: 'y' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an invalid phone for sms (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '12', body: 'y' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects empty body (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: '' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('does not send when subject is missing (no provider call)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await sendExternalMessageHandler(
      req({ channel: 'email', to: 'a@b.com', body: 'y' }),
    ).catch(() => undefined);
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
});

describe('sendExternalMessage suppression gate', () => {
  it('blocks send (failed-precondition recipient_opted_out) when suppressed (email)', async () => {
    const id = encodeURIComponent('jane@example.com');
    const ctx = buildDbMock({ docs: { [`message_suppressions/${id}`]: { channel: 'email' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'email', to: 'Jane@Example.com', subject: 's', body: 'b' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'recipient_opted_out' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('blocks send when suppressed (sms, normalized key)', async () => {
    const id = encodeURIComponent('+14155552671');
    const ctx = buildDbMock({ docs: { [`message_suppressions/${id}`]: { channel: 'sms' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '(415) 555-2671', body: 'b' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
  });
});

describe('sendExternalMessage provider failure (fail loud)', () => {
  it('surfaces SendGrid failure as unavailable with the provider error', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.sendTemplatedEmail.mockRejectedValueOnce(new Error('SG 401 unauthorized'));
    await expect(
      sendExternalMessageHandler(req({ channel: 'email', to: 'a@b.com', subject: 's', body: 'b' })),
    ).rejects.toMatchObject({ code: 'unavailable' });
    // and it must NOT have recorded a send
    expect(ctx.adds.find((a) => a.collection === 'external_messages')).toBeUndefined();
  });

  it('surfaces Twilio failure as unavailable', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.twilioCreate.mockRejectedValueOnce(new Error('Twilio 21211 invalid To'));
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: 'b' })),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('redactRecipient helper', () => {
  it('masks email local-part keeping first char + full domain', () => {
    expect(redactRecipient('email', 'jane.doe@example.com')).toBe('j***@example.com');
  });
  it('masks phone middle digits keeping country + last 4', () => {
    expect(redactRecipient('sms', '+14155552671')).toBe('+1******2671');
  });
  it('normalizeRecipient lowercases email and E.164-normalizes phone', () => {
    expect(normalizeRecipient('email', '  Jane@Example.COM ')).toBe('jane@example.com');
    expect(normalizeRecipient('sms', '(415) 555-2671')).toBe('+14155552671');
  });
});

describe('suppressExternalRecipient', () => {
  it('writes a message_suppressions doc and audits EXTERNAL_SUPPRESSION_ADDED', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await suppressExternalRecipientHandler(req({ channel: 'email', to: 'Jane@Example.com' }));
    expect(res).toEqual({ ok: true, channel: 'email', recipientRedacted: 'j***@example.com' });
    const write = ctx.writes.find((w) => w.path === `message_suppressions/${encodeURIComponent('jane@example.com')}`);
    expect(write).toBeTruthy();
    expect(write?.data.recipientRedacted).toBe('j***@example.com');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'EXTERNAL_SUPPRESSION_ADDED', actorUid: 'admin1' }),
    );
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      suppressExternalRecipientHandler(req({ channel: 'email', to: 'a@b.com' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects invalid phone (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(cleanDb().db);
    await expect(
      suppressExternalRecipientHandler(req({ channel: 'sms', to: 'xx' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('sendExternalMessage transactional flag (1:1 inbox reply)', () => {
  it('default (no flag) still blocks a suppressed recipient', async () => {
    const id = encodeURIComponent('+14155552671');
    const ctx = buildDbMock({ docs: { [`message_suppressions/${id}`]: { channel: 'sms' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: 'hi' })),
    ).rejects.toMatchObject({ message: 'recipient_opted_out' });
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
  });

  it('transactional=true sends to a suppressed recipient (1:1 reply bypasses marketing opt-out)', async () => {
    const id = encodeURIComponent('+14155552671');
    const ctx = buildDbMock({ docs: { [`message_suppressions/${id}`]: { channel: 'sms' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: '+14155552671', body: 'hi', transactional: true }),
    );
    expect(res.providerMessageId).toBe('SM123');
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
  });

  it('records the transactional classification on the external_messages doc', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: 'hi', transactional: true }));
    const added = ctx.adds.find((a) => a.collection === 'external_messages');
    expect(added?.data).toMatchObject({ transactional: true });
  });

  it('transactional email omits the marketing unsubscribe footer', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendExternalMessageHandler(
      req({ channel: 'email', to: 'jane@example.com', subject: 'Re: your booking', body: 'See you at 3pm', transactional: true }),
    );
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    const sgArgs = mocks.sendTemplatedEmail.mock.calls[0][0];
    expect(sgArgs.bodyTemplate).toBe('See you at 3pm');
    expect(sgArgs.bodyTemplate.includes(UNSUBSCRIBE_FOOTER)).toBe(false);
  });
});
