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

import {
  archiveNotificationHandler,
  bulkArchiveNotificationsHandler,
  unarchiveNotificationHandler,
  bulkUnarchiveNotificationsHandler,
} from '../src/portal/archiveNotification';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'kin1', admin = false): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: (admin ? { admin: true } : {}) as any } as any) : undefined,
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
    },
  });
}

describe('archiveNotification (single) happy path', () => {
  it('archives the callers own notification and stamps archivedAt + archivedByUid', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await archiveNotificationHandler(req({ id: 'n1' }));
    expect(res).toEqual({ archived: 1 });
    const w = ctx.writes.find((w) => w.path === 'notifications/n1');
    expect(w?.merge).toBe(true);
    expect(w?.data.archivedAt).toBe('__TS__');
    expect(w?.data.archivedByUid).toBe('kin1');
  });

  it('admin may archive any recipients notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await archiveNotificationHandler(req({ id: 'n3' }, 'admin1', true));
    expect(res.archived).toBe(1);
  });

  it('writes a NOTIFICATIONS_ARCHIVE audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await archiveNotificationHandler(req({ id: 'n1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'NOTIFICATIONS_ARCHIVE', actorUid: 'kin1' }),
    );
  });
});

describe('archiveNotification (single) recipient-negative + missing', () => {
  it('skips another recipients notification (archived 0, no write)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await archiveNotificationHandler(req({ id: 'n3' }));
    expect(res.archived).toBe(0);
    expect(ctx.writes.find((w) => w.path === 'notifications/n3')).toBeUndefined();
  });

  it('skips a missing notification (archived 0)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await archiveNotificationHandler(req({ id: 'ghost' }));
    expect(res.archived).toBe(0);
  });

  it('skips a doc with no recipientUid (archived 0)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await archiveNotificationHandler(req({ id: 'n4' }));
    expect(res.archived).toBe(0);
  });
});

describe('archiveNotification (single) validation + auth', () => {
  it('rejects blank id (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(archiveNotificationHandler(req({ id: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing id (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(archiveNotificationHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(archiveNotificationHandler(req({ id: 'n1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('bulkArchiveNotifications happy path', () => {
  it('archives the callers own notifications and returns the count', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkArchiveNotificationsHandler(req({ ids: ['n1', 'n2'] }));
    expect(res).toEqual({ archived: 2 });
    const w1 = ctx.writes.find((w) => w.path === 'notifications/n1');
    expect(w1?.data.archivedAt).toBe('__TS__');
    expect(w1?.data.archivedByUid).toBe('kin1');
  });

  it('skips notifications belonging to another recipient (not counted, no write)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkArchiveNotificationsHandler(req({ ids: ['n1', 'n3'] }));
    expect(res.archived).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'notifications/n3')).toBeUndefined();
  });

  it('admin may archive any recipients notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkArchiveNotificationsHandler(req({ ids: ['n1', 'n3'] }, 'admin1', true));
    expect(res.archived).toBe(2);
  });

  it('skips missing ids and docs with no recipientUid', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkArchiveNotificationsHandler(req({ ids: ['n1', 'n4', 'ghost'] }));
    expect(res.archived).toBe(1);
  });

  it('writes a NOTIFICATIONS_ARCHIVE audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await bulkArchiveNotificationsHandler(req({ ids: ['n1', 'n2'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'NOTIFICATIONS_ARCHIVE', actorUid: 'kin1' }),
    );
  });
});

describe('bulkArchiveNotifications validation + auth', () => {
  it('rejects empty ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkArchiveNotificationsHandler(req({ ids: [] }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects over-200 ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
    await expect(bulkArchiveNotificationsHandler(req({ ids }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkArchiveNotificationsHandler(req({ ids: ['n1'] }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
// ─────────────────────── restore (unarchive) ───────────────────────
//
// Every case below is the mirror of an archive case above, plus the two that
// only exist on this side: the write is `archivedAt: null` rather than a
// timestamp (an absent field is unreachable by any future Firestore predicate,
// see the handler's note), and `archivedByUid` is deliberately NOT cleared.
describe('unarchiveNotification (single) happy path', () => {
  it('clears archivedAt to null on the callers own notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unarchiveNotificationHandler(req({ id: 'n1' }));
    expect(res).toEqual({ unarchived: 1 });
    const w = ctx.writes.find((w) => w.path === 'notifications/n1');
    expect(w?.merge).toBe(true);
    expect(w?.data.archivedAt).toBeNull();
  });
  it('does not clear archivedByUid: who filed the row away stays true after a restore', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await unarchiveNotificationHandler(req({ id: 'n1' }));
    const w = ctx.writes.find((w) => w.path === 'notifications/n1');
    expect(w?.data).not.toHaveProperty('archivedByUid');
  });
  it('admin may restore any recipients notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unarchiveNotificationHandler(req({ id: 'n3' }, 'admin1', true));
    expect(res.unarchived).toBe(1);
  });
  it('writes a NOTIFICATIONS_UNARCHIVE audit entry with an explicit SUCCESS status', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await unarchiveNotificationHandler(req({ id: 'n1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'NOTIFICATIONS_UNARCHIVE',
        status: 'SUCCESS',
        actorUid: 'kin1',
        targetCollection: 'notifications',
      }),
    );
  });
  it('does not reuse the archive event, so the trail can still be filtered by intent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await unarchiveNotificationHandler(req({ id: 'n1' }));
    expect(writeAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'NOTIFICATIONS_ARCHIVE' }),
    );
  });
});
describe('unarchiveNotification (single) recipient-negative + missing', () => {
  it('skips another recipients notification (unarchived 0, no write)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unarchiveNotificationHandler(req({ id: 'n3' }));
    expect(res.unarchived).toBe(0);
    expect(ctx.writes.find((w) => w.path === 'notifications/n3')).toBeUndefined();
  });
  it('skips a missing notification (unarchived 0)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unarchiveNotificationHandler(req({ id: 'ghost' }));
    expect(res.unarchived).toBe(0);
  });
  it('skips a doc with no recipientUid (unarchived 0)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unarchiveNotificationHandler(req({ id: 'n4' }));
    expect(res.unarchived).toBe(0);
  });
  it('still audits a refused restore, so a zero is evidence rather than silence', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await unarchiveNotificationHandler(req({ id: 'n3' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'NOTIFICATIONS_UNARCHIVE',
        payload: expect.objectContaining({ unarchived: 0 }),
      }),
    );
  });
});
describe('unarchiveNotification (single) validation + auth', () => {
  it('rejects blank id (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(unarchiveNotificationHandler(req({ id: '' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('rejects missing id (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(unarchiveNotificationHandler(req({}))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('rejects an over-length id (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      unarchiveNotificationHandler(req({ id: 'x'.repeat(201) })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(unarchiveNotificationHandler(req({ id: 'n1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
describe('bulkUnarchiveNotifications happy path', () => {
  it('restores the callers own notifications and returns the count', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n2'] }));
    expect(res).toEqual({ unarchived: 2 });
    expect(ctx.writes.find((w) => w.path === 'notifications/n1')?.data.archivedAt).toBeNull();
    expect(ctx.writes.find((w) => w.path === 'notifications/n2')?.data.archivedAt).toBeNull();
  });
  it('de-duplicates repeated ids so the count is notifications, not requests', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n1', 'n1'] }));
    expect(res.unarchived).toBe(1);
  });
  it('skips notifications belonging to another recipient (not counted, no write)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n3'] }));
    expect(res.unarchived).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'notifications/n3')).toBeUndefined();
  });
  it('admin may restore any recipients notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n3'] }, 'admin1', true));
    expect(res.unarchived).toBe(2);
  });
  it('skips missing ids and docs with no recipientUid, and reports the real number', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n4', 'ghost'] }));
    expect(res.unarchived).toBe(1);
  });
  it('audits the requested-versus-restored split', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await bulkUnarchiveNotificationsHandler(req({ ids: ['n1', 'n3'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'NOTIFICATIONS_UNARCHIVE',
        status: 'SUCCESS',
        payload: expect.objectContaining({ requested: 2, unarchived: 1 }),
      }),
    );
  });
});
describe('bulkUnarchiveNotifications validation + auth', () => {
  it('rejects empty ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkUnarchiveNotificationsHandler(req({ ids: [] }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('rejects over-200 ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
    await expect(bulkUnarchiveNotificationsHandler(req({ ids }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('rejects a non-array ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(bulkUnarchiveNotificationsHandler(req({ ids: 'n1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      bulkUnarchiveNotificationsHandler(req({ ids: ['n1'] }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
