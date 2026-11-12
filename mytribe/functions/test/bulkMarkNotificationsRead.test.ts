import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { bulkMarkNotificationsReadHandler } from '../src/portal/bulkMarkNotificationsRead';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(
  data: unknown,
  uid: string | null = 'kin1',
  admin = false,
  token?: Record<string, unknown>,
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: (token ?? (admin ? { admin: true } : {})) as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed() {
  return buildDbMock({
    docs: {
      'notifications/n1': { recipientUid: 'kin1', key: 'invoice.new' },
      'notifications/n2': { recipientUid: 'kin1', key: 'invoice.reminder' },
      'notifications/n3': { recipientUid: 'other', key: 'invoice.overdue' },
      'notifications/n4': { key: 'no-recipient' },
      'notifications/n5': { recipientUid: 'admin1', key: 'kincare.requested' },
    },
  });
}

describe('bulkMarkNotificationsRead happy path', () => {
  it('marks the callers own notifications read and returns the count', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(req({ ids: ['n1', 'n2'] }));
    expect(res).toEqual({ ok: true, marked: 2 });
    const w1 = ctx.writes.find((w) => w.path === 'notifications/n1');
    expect(w1?.data.readAt).toBe('__TS__');
    expect(w1?.data.viewedByUid).toBe('kin1');
  });

  it('skips notifications belonging to another recipient (not counted, no write)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(req({ ids: ['n1', 'n3'] }));
    expect(res.marked).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'notifications/n3')).toBeUndefined();
  });

  // #1837: `readAt` sits on the doc the recipient's own list reads, so no role
  // may set it on somebody else's notification.
  it('an admin marks only their own rows out of a mixed selection', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(req({ ids: ['n1', 'n3', 'n5'] }, 'admin1', true));
    expect(res.marked).toBe(1);
    expect(ctx.writes.map((w) => w.path)).toEqual(['notifications/n5']);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: 'AUNTIE', actorUid: 'admin1' }),
    );
  });
  it('an Auntie marks nothing that is not addressed to her', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(
      req({ ids: ['n1', 'n3', 'n5'] }, 'auntie1', false, { staffRole: 'auntie' }),
    );
    expect(res.marked).toBe(0);
    expect(ctx.writes).toEqual([]);
  });
  it('a Kinfolk cannot mark another households or an admins notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(req({ ids: ['n3', 'n5'] }));
    expect(res.marked).toBe(0);
    expect(ctx.writes).toEqual([]);
  });

  it('skips missing ids and docs with no recipientUid', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkMarkNotificationsReadHandler(req({ ids: ['n1', 'n4', 'ghost'] }));
    expect(res.marked).toBe(1);
  });

  it('writes a NOTIFICATIONS_BULK_READ audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await bulkMarkNotificationsReadHandler(req({ ids: ['n1', 'n2'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'NOTIFICATIONS_BULK_READ', actorUid: 'kin1' }),
    );
  });
});

describe('bulkMarkNotificationsRead validation + auth', () => {
  it('rejects empty ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkMarkNotificationsReadHandler(req({ ids: [] }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects over-200 ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
    await expect(bulkMarkNotificationsReadHandler(req({ ids }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkMarkNotificationsReadHandler(req({ ids: ['n1'] }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
