import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every outbound SMS/email funnels through lib/twilio.ts (getTwilio) and
// lib/email.ts (sendTemplatedEmail). These tests pin the fail-open contract:
// prod (no env var) must behave EXACTLY as before, and SEND_SUPPRESS=1 must
// make it impossible to reach a real customer.

const fetchMock = vi.fn();
const messagesCreate = vi.fn();

vi.mock('twilio', () => ({
  default: vi.fn(() => ({ messages: { create: messagesCreate } })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  messagesCreate.mockReset();
  messagesCreate.mockResolvedValue({ sid: 'SM_real_123', status: 'queued' });
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_FROM_NUMBER = '+15550001111';
  process.env.SMTP2GO_API_KEY = 'api-test-key';
  process.env.EMAIL_FROM = 'auntie@tribetails.com';
  delete process.env.SEND_SUPPRESS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SEND_SUPPRESS;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.SMTP2GO_API_KEY;
  delete process.env.EMAIL_FROM;
});

function okEmailResponse(emailId = 'smtp2go-id-1') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { succeeded: 1, failed: 0, email_id: emailId } }),
  };
}

describe('sendGuard', () => {
  it('is inert unless SEND_SUPPRESS is exactly "1"', async () => {
    const { sendsAreSuppressed } = await import('../src/lib/sendGuard');
    expect(sendsAreSuppressed()).toBe(false);
    for (const v of ['0', 'true', 'yes', '', 'false']) {
      process.env.SEND_SUPPRESS = v;
      expect(sendsAreSuppressed()).toBe(false);
    }
    process.env.SEND_SUPPRESS = '1';
    expect(sendsAreSuppressed()).toBe(true);
  });

  it('marks suppressed ids so they cannot pass as provider ids', async () => {
    const { suppressedId, SUPPRESSED_ID_PREFIX } = await import('../src/lib/sendGuard');
    expect(suppressedId('sms')).toMatch(new RegExp(`^${SUPPRESSED_ID_PREFIX}sms_`));
    expect(suppressedId('email')).toMatch(new RegExp(`^${SUPPRESSED_ID_PREFIX}email_`));
    expect(suppressedId('sms')).not.toBe(suppressedId('sms'));
  });
});

describe('SMS suppression (lib/twilio.ts)', () => {
  it('PROD PARITY: with SEND_SUPPRESS unset, a real Twilio send happens', async () => {
    const { getTwilio } = await import('../src/lib/twilio');
    const res = await getTwilio().messages.create({
      from: '+15550001111',
      to: '+15559998888',
      body: 'real',
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(res.sid).toBe('SM_real_123');
  });

  it('with SEND_SUPPRESS=1, Twilio is NEVER contacted', async () => {
    process.env.SEND_SUPPRESS = '1';
    const { getTwilio } = await import('../src/lib/twilio');
    const res = await getTwilio().messages.create({
      from: '+15550001111',
      to: '+15559998888',
      body: 'should not send',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(res.sid).toMatch(/^SUPPRESSED_sms_/);
  });

  it('the suppressed client still satisfies the caller contract (sid + status)', async () => {
    process.env.SEND_SUPPRESS = '1';
    const { getTwilio } = await import('../src/lib/twilio');
    const res = await getTwilio().messages.create({ from: 'a', to: 'b', body: 'c' });
    // smsChannel.ts / sendExternalMessage.ts / broadcastMessage.ts read .sid,
    // and sendExternalMessage also reads .status for the engagement ledger.
    expect(typeof res.sid).toBe('string');
    expect(typeof res.status).toBe('string');
  });

  it('does not require real Twilio secrets when suppressed', async () => {
    process.env.SEND_SUPPRESS = '1';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    const { getTwilio } = await import('../src/lib/twilio');
    await expect(getTwilio().messages.create({ from: 'a', to: 'b', body: 'c' })).resolves.toBeDefined();
  });
});

describe('email suppression (lib/email.ts)', () => {
  it('PROD PARITY: with SEND_SUPPRESS unset, smtp2go is called', async () => {
    fetchMock.mockResolvedValue(okEmailResponse('real-email-id'));
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const id = await sendTemplatedEmail({
      to: 'client@example.com',
      subjectTemplate: 'Hi {{name}}',
      bodyTemplate: 'Body {{name}}',
      data: { name: 'Sam' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(id).toBe('real-email-id');
  });

  it('with SEND_SUPPRESS=1, smtp2go is NEVER contacted', async () => {
    process.env.SEND_SUPPRESS = '1';
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const id = await sendTemplatedEmail({
      to: 'client@example.com',
      subjectTemplate: 'Hi {{name}}',
      bodyTemplate: 'Body {{name}}',
      data: { name: 'Sam' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(id).toMatch(/^SUPPRESSED_email_/);
  });

  it('does not require real email secrets when suppressed', async () => {
    process.env.SEND_SUPPRESS = '1';
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.EMAIL_FROM;
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await expect(
      sendTemplatedEmail({ to: 'a@b.c', subjectTemplate: 's', bodyTemplate: 'b', data: {} }),
    ).resolves.toMatch(/^SUPPRESSED_email_/);
  });
});
