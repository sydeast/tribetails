import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { resolveRecipients } from '../src/notifications/recipientResolver';
import type { NotificationDef } from '../src/notifications/types';

function def(resolver: NotificationDef['recipientResolver']): NotificationDef {
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
    recipientResolver: resolver,
    templates: { email: 't' },
    description: 'test',
  };
}

describe('resolveRecipients', () => {
  it('kinfolkAcct returns supplied uid + clients collection', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await resolveRecipients(def('kinfolkAcct'), {
      key: 't.k',
      recipientUid: 'u1',
      data: {},
    });
    expect(res).toEqual([{ uid: 'u1', collection: 'clients' }]);
  });

  it('throws if recipientUid missing for kinfolkAcct', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      resolveRecipients(def('kinfolkAcct'), { key: 't.k', data: {} }),
    ).rejects.toThrow(/recipientUid required/);
  });

  it('businessAdmins returns every uid from businessSettings/admins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1', 'admin2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await resolveRecipients(def('businessAdmins'), { key: 't.k', data: {} });
    expect(res).toEqual([
      { uid: 'admin1', collection: 'staff' },
      { uid: 'admin2', collection: 'staff' },
    ]);
  });

  it('businessAdmins throws when admin list empty', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveRecipients(def('businessAdmins'), { key: 't.k', data: {} }),
    ).rejects.toThrow(/admins.uids is empty/);
  });

  it('auntieAssignedToKincare uses data.assignedAuntieUid', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await resolveRecipients(def('auntieAssignedToKincare'), {
      key: 't.k',
      data: { assignedAuntieUid: 'auntieX' },
    });
    expect(res).toEqual([{ uid: 'auntieX', collection: 'staff' }]);
  });
});
