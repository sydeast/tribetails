import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1076: mail to a reserved or invented domain bounces, and bounces hurt the
 * sender reputation. `sendTemplatedEmail` is the only smtp2go caller, so it
 * refuses those recipients before any network call. A refusal resolves (it
 * never throws), so no caller counts it as a failure and nothing retries it.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), fetch: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { sendTemplatedEmail } from '../src/lib/email';
import { isReservedEmailDomain, REFUSED_ID_PREFIX } from '../src/lib/reservedEmailDomains';
import { sendFromTemplate } from '../src/lib/sendFromTemplate';
import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import type { NotificationDef } from '../src/notifications/types';

const REFUSED = [
  'pat@tribetails.test',
  'pat@x.example',
  'pat@nowhere.invalid',
  'pat@localhost',
  'pat@box.localhost',
  'pat@printer.local',
  'pat@example.com',
  'pat@example.net',
  'pat@example.org',
  'pat@mail.example.com',
  'pat@deep.sub.example.org',
];

const MIXED_FORMS = [
  'Pat@Tribetails.TEST',
  'pat@EXAMPLE.COM',
  'pat@example.com.',
  'pat@tribetails.test.',
  '  pat@example.org  ',
  ' Pat@Mail.Example.Net. ',
];

const SENDABLE = [
  'pat@tribetails.com',
  'pat@hanasamku.com',
  'pat@test.com',
  'pat@localhost.com',
  'pat@example.co.uk',
  'pat@myexample.com',
  'pat@example.com.au',
  'pat@local.tribetails.com',
];

function sendArgs(to: string) {
  return { to, subjectTemplate: 'Hi {{name}}', bodyTemplate: 'Body', data: { name: 'Pat' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMTP2GO_API_KEY', 'k');
  vi.stubEnv('EMAIL_FROM', 'auntie@tribetails.com');
  vi.stubEnv('SEND_SUPPRESS', '');
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { succeeded: 1, email_id: 'e1' } }),
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isReservedEmailDomain', () => {
  it.each(REFUSED)('refuses %s', (to) => {
    expect(isReservedEmailDomain(to)).toBe(true);
  });

  it.each(MIXED_FORMS)('refuses mixed case, trailing dot and padded form %j', (to) => {
    expect(isReservedEmailDomain(to)).toBe(true);
  });

  it.each(SENDABLE)('lets %s through', (to) => {
    expect(isReservedEmailDomain(to)).toBe(false);
  });

  it('leaves an address with no domain to the provider', () => {
    expect(isReservedEmailDomain('no-at-sign')).toBe(false);
    expect(isReservedEmailDomain('pat@')).toBe(false);
  });
});

describe('sendTemplatedEmail refuses reserved domains (#1076)', () => {
  it.each([...REFUSED, ...MIXED_FORMS])('never contacts smtp2go for %j', async (to) => {
    const id = await sendTemplatedEmail(sendArgs(to));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(id.startsWith(REFUSED_ID_PREFIX)).toBe(true);
  });

  it('needs no email credentials to refuse', async () => {
    vi.stubEnv('SMTP2GO_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
    await expect(sendTemplatedEmail(sendArgs('pat@tribetails.test'))).resolves.toMatch(
      /^REFUSED_email_/,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('logs the refusal once, with the template key and a redacted address', async () => {
    await sendTemplatedEmail({
      ...sendArgs('patricia@tribetails.test'),
      templateKey: 'invite.primary',
    });
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const fields = mocks.logEvent.mock.calls[0][0];
    expect(fields.event).toBe('email.send.refusedReservedDomain');
    expect(fields.extra.templateKey).toBe('invite.primary');
    expect(fields.extra.to).toBe('p***@tribetails.test');
    expect(JSON.stringify(fields)).not.toContain('patricia');
  });

  it('logs a subject preview when the caller has no template key', async () => {
    await sendTemplatedEmail(sendArgs('pat@example.com'));
    const fields = mocks.logEvent.mock.calls[0][0];
    expect(fields.extra.templateKey).toBeUndefined();
    expect(fields.extra.subjectPreview).toBe('Hi {{name}}');
  });

  it.each(['pat@tribetails.com', 'pat@hanasamku.com'])('still sends to %s', async (to) => {
    const id = await sendTemplatedEmail(sendArgs(to));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).to).toEqual([to]);
    expect(id).toBe('e1');
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe('a refused send is not a failure on the send routes', () => {
  const TEMPLATE = { subject: 'Hi', body: 'Body', html: null };

  function def(): NotificationDef {
    return {
      key: 'k',
      label: 'Test',
      audience: 'kinfolk',
      audiences: { kinfolk: true },
      category: 'visit',
      allowedChannels: ['email'],
      required: {},
      alwaysEnabled: false,
      kinfolkFacing: true,
      deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct',
      templates: { email: 'k' },
      description: 'test',
    };
  }

  it('sendFromTemplate (invites, recovery) resolves with a refused id and passes its key', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': TEMPLATE } }).db,
    );
    const id = await sendFromTemplate('k', 'pat@tribetails.test', {});
    expect(id).toMatch(/^REFUSED_email_/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const refusal = mocks.logEvent.mock.calls.find(
      ([f]) => f.event === 'email.send.refusedReservedDomain',
    );
    expect(refusal?.[0].extra.templateKey).toBe('k');
  });

  it('the dispatcher email channel resolves, so the dispatcher does not retry', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        writeThrough: true,
        docs: { 'emailTemplates/k': TEMPLATE, 'clients/u1': { email: 'pat@demo.example.com' } },
      }).db,
    );
    const result = await sendEmailChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(result.providerMessageId).toMatch(/^REFUSED_email_/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
