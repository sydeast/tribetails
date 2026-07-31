import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const h = vi.hoisted(() => ({ enqueue: vi.fn(), dbFn: vi.fn() }));

vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: h.enqueue }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue({ id: 'a' }) }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: h.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

import { expireStaleInvitesCore } from '../src/scheduled/expireStaleInvites';

const NOW = new Date('2026-07-30T02:00:00.000Z');
const PAST = new Date('2026-07-01T00:00:00.000Z');
const FUTURE = new Date('2026-08-30T00:00:00.000Z');

/**
 * `expireStaleInvitesCore` was extracted from the schedule wrapper so its one
 * query could be tested, and the old local double here replaced that query with
 * `chain.where = () => chain`, which erased the very thing the extraction was
 * for. The fixture below is a realistic mix: two invites the sweep MUST expire
 * and four it must leave alone. Under the no-op double all six came back from
 * `.get()`, so flipping `<` to `>` or dropping the status filter stayed green
 * while the nightly cron mass-expired accepted invites.
 */
function buildInvitesDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { inviteRequests: rows } });
}

const STALE_PENDING = {
  id: 'i1',
  data: { status: 'PENDING', tribeId: 't1', invitedEmail: 'a@b', expiresAt: PAST },
};
const STALE_EMAIL_SENT = {
  id: 'i2',
  data: { status: 'EMAIL_SENT', tribeId: 't2', expiresAt: PAST },
};
/** Already accepted. Expiring these fires invite.expired at live households. */
const ACCEPTED_PAST = {
  id: 'i3',
  data: { status: 'ACCEPTED', tribeId: 't3', expiresAt: PAST },
};
const ALREADY_EXPIRED = {
  id: 'i4',
  data: { status: 'EXPIRED', tribeId: 't4', expiresAt: PAST },
};
/** Still inside its window. */
const FRESH_PENDING = {
  id: 'i5',
  data: { status: 'PENDING', tribeId: 't5', expiresAt: FUTURE },
};
/** No expiry stamped, so Firestore's range filter never sees it. */
const NO_EXPIRES_AT = { id: 'i6', data: { status: 'PENDING', tribeId: 't6' } };

const FULL_SET = [
  STALE_PENDING,
  STALE_EMAIL_SENT,
  ACCEPTED_PAST,
  ALREADY_EXPIRED,
  FRESH_PENDING,
  NO_EXPIRES_AT,
];

beforeEach(() => {
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue(['n1']);
  h.dbFn.mockReset();
});

describe('expireStaleInvitesCore', () => {
  it('HAPPY: marks each stale invite EXPIRED and emits invite.expired (Business)', async () => {
    const ctx = buildInvitesDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await expireStaleInvitesCore(NOW);

    expect(r.expired).toBe(2);
    expect(ctx.writes.map((w) => w.path)).toEqual([
      'inviteRequests/i1',
      'inviteRequests/i2',
    ]);
    expect(ctx.writes.map((w) => w.data.status)).toEqual(['EXPIRED', 'EXPIRED']);
    const keys = h.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toEqual(['invite.expired', 'invite.expired']);
    expect((h.enqueue.mock.calls[0][0] as { data: unknown }).data).toMatchObject({
      kinfolkId: 't1', inviteId: 'i1', invitedEmail: 'a@b',
    });
  });

  it('STATE BOUNDARY: never touches accepted, already-expired, or unexpired invites', async () => {
    const ctx = buildInvitesDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    await expireStaleInvitesCore(NOW);

    const touched = ctx.writes.map((w) => w.path);
    for (const id of ['i3', 'i4', 'i5', 'i6']) {
      expect(touched, `invite ${id} must survive the sweep`).not.toContain(
        `inviteRequests/${id}`,
      );
    }
    const notified = h.enqueue.mock.calls.map(
      (c) => (c[0] as { data: { inviteId: string } }).data.inviteId,
    );
    expect(notified).toEqual(['i1', 'i2']);
  });

  it('SAD: a dispatch failure does not stop the rest of the sweep', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('boom'));
    const ctx = buildInvitesDb([STALE_PENDING, STALE_EMAIL_SENT]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await expireStaleInvitesCore(NOW);

    expect(r.expired).toBe(2); // both processed despite i1's dispatch error
    expect(ctx.writes).toHaveLength(2);
  });

  it('NEGATIVE: no stale invites -> nothing emitted', async () => {
    const ctx = buildInvitesDb([ACCEPTED_PAST, FRESH_PENDING]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await expireStaleInvitesCore(NOW);

    expect(r.expired).toBe(0);
    expect(ctx.writes).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('PAGE SIZE: one run drains at most the 500-doc page the query asks for', async () => {
    const rows = Array.from({ length: 620 }, (_, i) => ({
      id: `p${String(i).padStart(3, '0')}`,
      data: { status: 'PENDING', tribeId: `t${i}`, expiresAt: PAST },
    }));
    const ctx = buildInvitesDb(rows);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await expireStaleInvitesCore(NOW);

    expect(r.expired).toBe(500);
    expect(ctx.writes).toHaveLength(500);
  });
});
