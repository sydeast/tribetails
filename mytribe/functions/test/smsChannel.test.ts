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

  it('throws if template missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { phone: '+15555551111' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/smsTemplates\/t.k missing/);
  });

  it('throws if phone missing from both clients/ and staff/', async () => {
    const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: 'hi' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/no phone on file/);
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
