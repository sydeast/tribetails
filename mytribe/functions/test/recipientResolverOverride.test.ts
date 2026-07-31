import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { resolveRecipients } from '../src/notifications/recipientResolver';
import type { NotificationDef } from '../src/notifications/types';

function def(primary: NotificationDef['recipientResolver']): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: primary,
    templates: { email: 't' },
    description: 'test',
  };
}

describe('resolveRecipients(resolverOverride) — multi-audience refactor #43', () => {
  it('HAPPY: override switches to businessAdmins despite primary=kinfolkAcct', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await resolveRecipients(
      def('kinfolkAcct'),
      { key: 't.k', recipientUid: 'u1', data: {} },
      'businessAdmins',
    );
    expect(res).toEqual([{ uid: 'admin1', collection: 'staff' }]);
  });

  it('HAPPY: omitted override falls back to def.recipientResolver', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await resolveRecipients(def('kinfolkAcct'), {
      key: 't.k',
      recipientUid: 'u1',
      data: {},
    });
    expect(res).toEqual([{ uid: 'u1', collection: 'clients' }]);
  });

  it('SAD: override resolver retains its own validation (specificUid still needs recipientUid)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      resolveRecipients(def('kinfolkAcct'), { key: 't.k', data: {} }, 'specificUid'),
    ).rejects.toThrow(/recipientUid required/);
  });
});
