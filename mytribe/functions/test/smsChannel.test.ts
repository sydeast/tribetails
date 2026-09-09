import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  twilioFn: vi.fn(),
  fromNumber: vi.fn(() => '+15555550000'),
  messagesCreate: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: () => ({ messages: { create: mocks.messagesCreate } }),
  getTwilioFromNumber: mocks.fromNumber,
}));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.messagesCreate.mockReset();
});

import { sendSmsChannel } from '../src/notifications/senders/smsChannel';
import type { NotificationDef } from '../src/notifications/types';

function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['sms'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { sms: 't.k' },
    description: 'test',
    ...overrides,
  };
}

describe('sendSmsChannel', () => {
  it('renders + sends via Twilio with rendered body + provider sid', async () => {
    const ctx = buildDbMock({
      docs: {
        'smsTemplates/t.k': { text: 'Hi {{kinfolkFirstName}}, code {{code}}' },
        'clients/u1': { phone: '+15555551111' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.messagesCreate.mockResolvedValue({ sid: 'SM_xyz' });

    const res = await sendSmsChannel({
      def: def(),
      recipientUid: 'u1',
      data: { kinfolkFirstName: 'Sam', code: 'A4' },
    });

    expect(res.providerMessageId).toBe('SM_xyz');
    expect(mocks.messagesCreate).toHaveBeenCalledWith({
      from: '+15555550000',
      to: '+15555551111',
      body: 'Hi Sam, code A4',
    });
  });

  it('SKIPS rather than throwing when the template is not authored yet', async () => {
    // Operator ruling 2026-08-23: SMS gets no generic fallback, because a
    // segment costs money and "there's an update, sign in" is not worth paying
    // for. Email carries the generic copy instead. Skipped, not thrown, because
    // unauthored copy is a content gap no retry can fix.
    const ctx = buildDbMock({ docs: { 'clients/u1': { phone: '+15555551111' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'template_missing' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it('SKIPS when the template exists but its text is empty', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { phone: '+15555551111' }, 'smsTemplates/t.k': { text: '' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'template_text_empty' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it('still THROWS when the catalog row has no sms template id at all', async () => {
    // A misconfigured catalog row is a developer bug, not a content gap. No
    // amount of authoring fixes it, so it must stay loud.
    const ctx = buildDbMock({ docs: { 'clients/u1': { phone: '+15555551111' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendSmsChannel({
        def: def({ templates: {} as never }),
        recipientUid: 'u1',
        data: {},
      }),
    ).rejects.toThrow(/catalog has no sms template id/);
  });

  it('SKIPS rather than throwing when phone is missing from both clients/ and staff/', async () => {
    // MYTRIBE-FUNCTIONS-C: a household that never gave us a number is a normal
    // data state. This used to throw, which raised 19 Sentry events and had
    // Cloud Functions retry something no retry can fix. Same fail-soft shape
    // emailChannel uses for a recipient with no email.
    const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: 'hi' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'recipient_no_phone' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });

  it('falls back to staff/ when clients/ has no phone', async () => {
    const ctx = buildDbMock({
      docs: {
        'smsTemplates/t.k': { text: 'hello {{name}}' },
        'staff/u1': { phone: '+15555552222' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.messagesCreate.mockResolvedValue({ sid: 'SM_y' });
    await sendSmsChannel({ def: def(), recipientUid: 'u1', data: { name: 'A' } });
    expect(mocks.messagesCreate.mock.calls[0]![0].to).toBe('+15555552222');
  });
});
