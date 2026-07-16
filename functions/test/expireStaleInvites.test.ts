import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  docsHolder: { docs: [] as Array<{ id: string; data: () => Record<string, unknown>; ref: { update: (u: Record<string, unknown>) => Promise<void> } }> },
  updates: [] as Array<{ id: string; u: Record<string, unknown> }>,
}));

vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: h.enqueue }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue({ id: 'a' }) }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    collection: () => {
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.get = async () => h.docsHolder;
      return chain;
    },
  }),
}));

function inviteDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    data: () => data,
    ref: { update: async (u: Record<string, unknown>) => { h.updates.push({ id, u }); } },
  };
}

import { expireStaleInvitesCore } from '../src/scheduled/expireStaleInvites';

beforeEach(() => {
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue(['n1']);
  h.updates.length = 0;
  h.docsHolder.docs = [];
});

describe('expireStaleInvitesCore', () => {
  it('HAPPY: marks each stale invite EXPIRED and emits invite.expired (Business)', async () => {
    h.docsHolder.docs = [
      inviteDoc('i1', { tribeId: 't1', invitedEmail: 'a@b' }),
      inviteDoc('i2', { tribeId: 't2' }),
    ];
    const r = await expireStaleInvitesCore(new Date());
    expect(r.expired).toBe(2);
    expect(h.updates.map((u) => u.u.status)).toEqual(['EXPIRED', 'EXPIRED']);
    const keys = h.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toEqual(['invite.expired', 'invite.expired']);
    expect((h.enqueue.mock.calls[0][0] as { data: unknown }).data).toMatchObject({
      kinfolkId: 't1', inviteId: 'i1', invitedEmail: 'a@b',
    });
  });

  it('SAD: a dispatch failure does not stop the rest of the sweep', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('boom'));
    h.docsHolder.docs = [inviteDoc('i1', { tribeId: 't1' }), inviteDoc('i2', { tribeId: 't2' })];
    const r = await expireStaleInvitesCore(new Date());
    expect(r.expired).toBe(2); // both processed despite i1's dispatch error
    expect(h.updates.length).toBe(2);
  });

  it('NEGATIVE: no stale invites -> nothing emitted', async () => {
    h.docsHolder.docs = [];
    const r = await expireStaleInvitesCore(new Date());
    expect(r.expired).toBe(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
