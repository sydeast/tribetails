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
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' } };
});

import {
  markNotificationReadHandler,
  markNotificationUnreadHandler,
} from '../src/portal/markNotificationRead';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

/**
 * #1837. `readAt` lives on the one `notifications/{id}` doc the recipient's own
 * list reads. These pin that only the recipient can set or clear it: an admin,
 * an Auntie and a Kinfolk from another household are all refused, and nothing
 * is written when they try.
 */

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

const KINFOLK = {};
const ADMIN = { admin: true };
const AUNTIE = { staffRole: 'auntie' };

function req(
  data: unknown,
  uid: string | null,
  token: Record<string, unknown> = KINFOLK,
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed() {
  return buildDbMock({
    docs: {
      'notifications/house-a': { recipientUid: 'kin-a', key: 'kincare.auntie.arrived' },
      'notifications/house-b': { recipientUid: 'kin-b', key: 'kintale.published' },
      'notifications/staff': { recipientUid: 'admin1', key: 'kincare.requested' },
      'notifications/orphan': { key: 'no-recipient' },
    },
  });
}

const HANDLERS = [
  ['markNotificationRead', markNotificationReadHandler],
  ['markNotificationUnread', markNotificationUnreadHandler],
] as const;

describe.each(HANDLERS)('%s: only the recipient', (_name, handler) => {
  it('refuses an admin on a household notification and writes nothing', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'house-a' }, 'admin1', ADMIN)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an Auntie on a household notification and writes nothing', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'house-a' }, 'auntie1', AUNTIE)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses an Auntie on a notification addressed to the admin', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'staff' }, 'auntie1', AUNTIE)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a Kinfolk on another households notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'house-b' }, 'kin-a')))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a Kinfolk on a notification addressed to the admin', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'staff' }, 'kin-a')))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses a signed-out caller before reading anything', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'house-a' }, null)))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toEqual([]);
  });

  it('answers not-found for an id that does not exist', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'missing' }, 'kin-a')))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a doc with no recipient, for an admin too', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: 'orphan' }, 'admin1', ADMIN)))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toEqual([]);
  });

  it('rejects a blank id', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(handler(req({ notificationId: '' }, 'kin-a'))).rejects.toThrow();
    expect(ctx.writes).toEqual([]);
  });
});

describe('markNotificationRead: the recipient', () => {
  it('a Kinfolk marks their own notification read', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markNotificationReadHandler(req({ notificationId: 'house-a' }, 'kin-a')))
      .resolves.toEqual({ ok: true });
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.writes[0]).toMatchObject({
      path: 'notifications/house-a',
      merge: true,
      data: { readAt: '__TS__', viewedAt: '__TS__', viewedByUid: 'kin-a' },
    });
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'NOTIFICATION_VIEWED', actorRole: 'PRIMARY', actorUid: 'kin-a' }),
    );
  });

  it('an admin marks a notification addressed to them, and the audit line names them as staff', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markNotificationReadHandler(req({ notificationId: 'staff' }, 'admin1', ADMIN)))
      .resolves.toEqual({ ok: true });
    expect(ctx.writes.map((w) => w.path)).toEqual(['notifications/staff']);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: 'AUNTIE', actorUid: 'admin1' }),
    );
  });

  it('an Auntie marks a notification addressed to her', async () => {
    const ctx = buildDbMock({
      docs: { 'notifications/hers': { recipientUid: 'auntie1', key: 'kincare.requested' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markNotificationReadHandler(req({ notificationId: 'hers' }, 'auntie1', AUNTIE)))
      .resolves.toEqual({ ok: true });
    expect(ctx.writes.map((w) => w.path)).toEqual(['notifications/hers']);
  });
});

describe('markNotificationUnread: the recipient', () => {
  it('a Kinfolk clears the read marks on their own notification', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markNotificationUnreadHandler(req({ notificationId: 'house-a' }, 'kin-a')))
      .resolves.toEqual({ ok: true });
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.writes[0]).toMatchObject({
      path: 'notifications/house-a',
      merge: true,
      data: { readAt: '__DEL__', viewedAt: '__DEL__', viewedByUid: '__DEL__' },
    });
  });

  it('an admin clears the read marks on a notification addressed to them', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markNotificationUnreadHandler(req({ notificationId: 'staff' }, 'admin1', ADMIN)))
      .resolves.toEqual({ ok: true });
    expect(ctx.writes.map((w) => w.path)).toEqual(['notifications/staff']);
  });
});
