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
