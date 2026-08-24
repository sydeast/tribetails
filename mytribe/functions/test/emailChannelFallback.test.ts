import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  loadEmailTemplate: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ loadEmailTemplate: mocks.loadEmailTemplate }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import type { NotificationDef } from '../src/notifications/types';

function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
  return {
    key: 'kincare.request.declined',
    label: 'Your care request was declined',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.request.declined' },
    description: 'test',
    ...overrides,
  };
}

/** clients/{uid} carries the address unless the test says otherwise. */
function dbWith(email: string | null) {
  const docMock = (path: string) => ({
    get: vi.fn(async () => ({
      exists: path === 'clients/u1' && email !== null,
      data: () => (path === 'clients/u1' && email !== null ? { email } : undefined),
    })),
  });
  return {
    doc: (path: string) => docMock(path),
    collection: (col: string) => ({ doc: (id: string) => docMock(`${col}/${id}`) }),
  };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.loadEmailTemplate.mockReset();
  mocks.sendTemplatedEmail.mockReset();
  mocks.logEvent.mockReset();
  mocks.dbFn.mockReturnValue(dbWith('kin@example.com'));
  mocks.sendTemplatedEmail.mockResolvedValue('msg-1');
});

/**
 * The operator must never be forced to author public-facing copy on an
 * engineer's schedule, and mass-deleting the template set must not take the
 * notification system down. Operator ruling 2026-08-23.
 */
describe('sendEmailChannel: generic fallback when copy is not authored', () => {
  it('sends the household the generic wording instead of throwing', async () => {
    mocks.loadEmailTemplate.mockResolvedValue(null);

    const res = await sendEmailChannel({ def: def(), recipientUid: 'u1', data: {} });

    expect(res.usedFallback).toBe(true);
    expect(res.fallbackReason).toBe('emailTemplates/kincare.request.declined');
    expect(res.providerMessageId).toBe('msg-1');

    const sent = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(sent.to).toBe('kin@example.com');
    expect(sent.subjectTemplate).toBe('An update about your care');
    expect(sent.bodyTemplate).toContain('kinfolk.tribetails.com');
    // Says nothing about WHAT happened: the same text serves a declined
    // request, a new invoice and a cancelled visit, so anything specific here
    // would eventually be a lie.
    expect(sent.bodyTemplate).not.toMatch(/declin/i);
  });

  it('points an office-facing key at AuntieOS, not the household portal', async () => {
    mocks.loadEmailTemplate.mockResolvedValue(null);

    await sendEmailChannel({
      def: def({ audience: 'business', audiences: { business: true }, kinfolkFacing: false }),
      recipientUid: 'u1',
      data: {},
    });

    const sent = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(sent.subjectTemplate).toBe('An update in AuntieOS');
    expect(sent.bodyTemplate).toContain('auntie.tribetails.com');
    expect(sent.bodyTemplate).not.toContain('kinfolk.tribetails.com');
  });

  it('logs at error naming the template to author, so it is disclosed not silent', async () => {
    mocks.loadEmailTemplate.mockResolvedValue(null);

    await sendEmailChannel({ def: def(), recipientUid: 'u1', data: {} });

    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const logged = mocks.logEvent.mock.calls[0]![0];
    expect(logged.severity).toBe('error');
    expect(logged.event).toBe('notification.template.missing');
    expect(logged.extra.templateId).toBe('kincare.request.declined');
    expect(logged.extra.channel).toBe('email');
  });

  it('uses the authored template, and flags no fallback, once it exists', async () => {
    mocks.loadEmailTemplate.mockResolvedValue({
      subject: 'About your care request',
      body: 'Hi {{kinfolkName}}',
      html: '<p>Hi</p>',
    });

    const res = await sendEmailChannel({
      def: def(),
      recipientUid: 'u1',
      data: { kinfolkName: 'The Rivera Home' },
    });

    expect(res.usedFallback).toBeUndefined();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    const sent = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(sent.subjectTemplate).toBe('About your care request');
    expect(sent.htmlTemplate).toBe('<p>Hi</p>');
    expect(sent.data.kinfolkName).toBe('The Rivera Home');
  });

  it('still THROWS when the catalog row has no email template id at all', async () => {
    // A misconfigured catalog row is a developer bug. No amount of authoring
    // fixes it, so hiding it behind generic wording would help nobody.
    await expect(
      sendEmailChannel({
        def: def({ templates: {} as never }),
        recipientUid: 'u1',
        data: {},
      }),
    ).rejects.toThrow(/catalog has no email template id/);
  });

  it('still soft-skips a recipient with no email, without reaching the template', async () => {
    mocks.dbFn.mockReturnValue(dbWith(null));
    mocks.loadEmailTemplate.mockResolvedValue(null);

    const res = await sendEmailChannel({ def: def(), recipientUid: 'u1', data: {} });

    expect(res).toEqual({ skipped: true, skipReason: 'recipient_no_email' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
});
