import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #1077: the dispatcher email channel skips an address smtp2go reported as a
 * hard bounce. A marketing opt-out does not silence a household's operational
 * notifications here; those are governed by notification preferences.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  loadEmailTemplate: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sendFromTemplate', () => ({ loadEmailTemplate: mocks.loadEmailTemplate }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import type { NotificationDef } from '../src/notifications/types';

const DEF: NotificationDef = {
  key: 'invoice.new',
  label: 'New invoice',
  audience: 'kinfolk',
  audiences: { kinfolk: true },
  category: 'visit',
  allowedChannels: ['email'],
  required: { email: true },
  alwaysEnabled: false,
  kinfolkFacing: true,
  deliveryMode: 'trigger',
  recipientResolver: 'kinfolkAcct',
  templates: { email: 'invoice.new' },
  description: 'test',
};

function dbWith(docs: Record<string, Record<string, unknown>>) {
  const docMock = (path: string) => ({
    get: vi.fn(async () => ({ exists: path in docs, data: () => docs[path] })),
  });
  return {
    doc: (path: string) => docMock(path),
    collection: (col: string) => ({ doc: (id: string) => docMock(`${col}/${id}`) }),
  };
}

const SUPP = `message_suppressions/${encodeURIComponent('kin@example.com')}`;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.loadEmailTemplate.mockReset().mockResolvedValue({ subject: 'S', body: 'B' });
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('msg-1');
  mocks.logEvent.mockReset();
});

describe('sendEmailChannel honours hard-bounce suppressions (#1077)', () => {
  it('skips a hard-bounced address without sending or throwing', async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({ 'clients/u1': { email: 'Kin@Example.com' }, [SUPP]: { reason: 'hard_bounce', channel: 'email' } }),
    );

    const res = await sendEmailChannel({ def: DEF, recipientUid: 'u1', data: {} });

    expect(res).toEqual({ skipped: true, skipReason: 'recipient_hard_bounced' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('sends normally when the address is not suppressed', async () => {
    mocks.dbFn.mockReturnValue(dbWith({ 'clients/u1': { email: 'kin@example.com' } }));

    const res = await sendEmailChannel({ def: DEF, recipientUid: 'u1', data: {} });

    expect(res.providerMessageId).toBe('msg-1');
  });

  it('still sends to an address that only opted out of one-off marketing messages', async () => {
    mocks.dbFn.mockReturnValue(
      dbWith({ 'clients/u1': { email: 'kin@example.com' }, [SUPP]: { channel: 'email', actorUid: 'admin1' } }),
    );

    const res = await sendEmailChannel({ def: DEF, recipientUid: 'u1', data: {} });

    expect(res.providerMessageId).toBe('msg-1');
  });
});
