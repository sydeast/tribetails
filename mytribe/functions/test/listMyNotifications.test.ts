import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1316: the notifications list behind the portal bell.
 *
 * The rows are the dispatcher's `notifications/{id}` documents. What these
 * specs pin is the reading of them: the caller's own rows only, newest first,
 * archived rows and another tribe's rows left out, "unread" meaning the row
 * LACKS `readAt`, and the booking ids a tap needs to land on the right screen.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { listMyNotificationsHandler, toNotificationListItem } from '../src/portal/listMyNotifications';
import {
  countUnreadNotifications,
  isForTribe,
  isUnreadNotification,
  isVisibleNotification,
  toIsoOrNull,
} from '../src/lib/recipientNotifications';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01T12:00:00Z
const at = (minutesAgo: number) => Timestamp.fromMillis(T0 - minutesAgo * 60_000);

function req(data: unknown, uid: string | null = 'kin1', token: Record<string, unknown> = {}): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token } : undefined,
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Nine rows for kin1, one for somebody else. Every row carries `createdAt`: the mock drops a row without it, as Firestore does. */
function rows() {
  return [
    // Newest. Per-visit event: targetId is the visit, data names visit + batch.
    {
      id: 'n-visit',
      data: {
        recipientUid: 'kin1',
        key: 'kincare.booking.confirm',
        category: 'visit',
        title: 'Visit confirmed',
        description: 'Your visit is on the calendar.',
        actorName: 'Auntie Sam',
        actorPhotoUrl: 'https://cdn/sam.jpg',
        data: { kinfolkId: 'fam1', batchId: 'batch-1', bookingId: 'visit-1', visitId: 'visit-1' },
        targetType: 'booking',
        targetId: 'visit-1',
        detail: { kinName: 'Buddy', bookingDate: 'Mon, Nov 2' },
        createdAt: at(1),
      },
    },
    // Whole-request event: targetId is the batch, no visitId in data.
    {
      id: 'n-batch',
      data: {
        recipientUid: 'kin1',
        key: 'kincare.requested',
        category: 'visit',
        title: 'Booking requested',
        description: 'We got your request.',
        actorName: '',
        actorPhotoUrl: '',
        data: { kinfolkId: 'fam1', batchId: 'batch-2', bookingId: 'batch-2' },
        targetType: 'booking',
        targetId: 'batch-2',
        createdAt: at(2),
      },
    },
    // Read already.
    {
      id: 'n-read',
      data: {
        recipientUid: 'kin1',
        key: 'invoice.new',
        category: 'invoice',
        title: 'New invoice',
        description: 'An invoice is ready.',
        data: { kinfolkId: 'fam1', invoiceId: 'inv-9' },
        targetType: 'invoice',
        targetId: 'inv-9',
        createdAt: at(3),
        readAt: at(2),
        viewedAt: at(2),
        viewedByUid: 'kin1',
      },
    },
    // Archived: stamped by archiveNotification.
    {
      id: 'n-archived',
      data: {
        recipientUid: 'kin1',
        key: 'kintale.posted',
        category: 'kintale',
        title: 'New KinTale',
        description: 'A tale was posted.',
        data: { kinfolkId: 'fam1', taleId: 'tale-1' },
        targetType: 'kintale',
        targetId: 'tale-1',
        createdAt: at(4),
        archivedAt: at(1),
        archivedByUid: 'kin1',
      },
    },
    // Restored: unarchiveNotification writes null, which is active again.
    {
      id: 'n-restored',
      data: {
        recipientUid: 'kin1',
        key: 'kintale.posted',
        category: 'kintale',
        title: 'New KinTale',
        description: 'A tale was posted.',
        data: { kinfolkId: 'fam1', taleId: 'tale-2' },
        targetType: 'kintale',
        targetId: 'tale-2',
        createdAt: at(5),
        archivedAt: null,
        archivedByUid: 'kin1',
      },
    },
    // Another tribe this kinfolk also holds.
    {
      id: 'n-other-tribe',
      data: {
        recipientUid: 'kin1',
        key: 'invoice.new',
        category: 'invoice',
        title: 'New invoice',
        description: 'An invoice is ready.',
        data: { kinfolkId: 'fam2', invoiceId: 'inv-2' },
        targetType: 'invoice',
        targetId: 'inv-2',
        createdAt: at(6),
      },
    },
    // Older spelling of the household key.
    {
      id: 'n-family-id',
      data: {
        recipientUid: 'kin1',
        key: 'kinfolk.updated',
        category: 'account',
        title: 'Profile updated',
        description: 'Your profile changed.',
        data: { familyId: 'fam1' },
        targetType: 'kinfolk',
        targetId: 'fam1',
        createdAt: at(7),
      },
    },
    // Names no household at all: shown under every tribe.
    {
      id: 'n-untagged',
      data: {
        recipientUid: 'kin1',
        key: 'account.welcome',
        category: 'account',
        title: 'Welcome',
        description: 'Your portal is ready.',
        data: {},
        targetType: '',
        targetId: '',
        createdAt: at(8),
      },
    },
    // Somebody else's row: the query predicate keeps it out.
    {
      id: 'n-stranger',
      data: {
        recipientUid: 'kin2',
        key: 'invoice.new',
        category: 'invoice',
        title: 'New invoice',
        description: 'An invoice is ready.',
        data: { kinfolkId: 'fam1', invoiceId: 'inv-7' },
        targetType: 'invoice',
        targetId: 'inv-7',
        createdAt: at(0),
      },
    },
  ];
}

function seed(notifications = rows()) {
  return buildDbMock({
    docs: {
      'clients/kin1': { kinfolkIds: ['fam1', 'fam2'] },
      'clients/solo': { kinfolkIds: ['fam1'] },
    },
    queryDocs: { notifications },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('listMyNotifications gate', () => {
  it('refuses a signed-out caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listMyNotificationsHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a caretaker account: an Auntie never reads a household list', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listMyNotificationsHandler(req({ kinfolkId: 'fam1' }, 'auntie-1', { staffRole: 'auntie' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('refuses a tribe the caller does not hold', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listMyNotificationsHandler(req({ kinfolkId: 'fam9' }, 'solo'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('refuses a bad page size with invalid-argument', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 0 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 2.5 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

describe('listMyNotifications rows', () => {
  it('lists the callers own rows for the tribe, newest first, leaving out archived and other-tribe rows', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam1' }));
    expect(res.items.map((i) => i.id)).toEqual(['n-visit', 'n-batch', 'n-read', 'n-restored', 'n-family-id', 'n-untagged']);
    expect(res.hasMore).toBe(false);
    expect(res.nextBefore).toBeNull();
  });

  it('shows the other tribes rows under that tribe, and the untagged ones under both', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam2' }));
    expect(res.items.map((i) => i.id)).toEqual(['n-other-tribe', 'n-untagged']);
    expect(res.unreadCount).toBe(2);
  });

  it('reads unread as the absence of readAt and counts only visible rows', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam1' }));
    const read = res.items.find((i) => i.id === 'n-read');
    expect(read?.readAt).toBe(new Date(T0 - 2 * 60_000).toISOString());
    expect(res.items.filter((i) => i.readAt === null).map((i) => i.id)).toEqual([
      'n-visit',
      'n-batch',
      'n-restored',
      'n-family-id',
      'n-untagged',
    ]);
    // Five unread and visible. The archived tale and fam2's invoice are unread
    // too, and must not be counted on fam1's bell.
    expect(res.unreadCount).toBe(5);
  });

  it('carries what a row needs to draw itself and what a tap needs to open the thing', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam1' }));
    const visit = res.items.find((i) => i.id === 'n-visit');
    expect(visit).toEqual({
      id: 'n-visit',
      key: 'kincare.booking.confirm',
      category: 'visit',
      title: 'Visit confirmed',
      description: 'Your visit is on the calendar.',
      actorName: 'Auntie Sam',
      actorPhotoUrl: 'https://cdn/sam.jpg',
      targetType: 'booking',
      targetId: 'visit-1',
      visitId: 'visit-1',
      batchId: 'batch-1',
      createdAt: new Date(T0 - 60_000).toISOString(),
      readAt: null,
      detail: { kinName: 'Buddy', bookingDate: 'Mon, Nov 2' },
    });
  });

  it('tells a whole-request booking row apart from a per-visit one by visitId', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam1' }));
    const batch = res.items.find((i) => i.id === 'n-batch');
    expect(batch?.targetType).toBe('booking');
    expect(batch?.targetId).toBe('batch-2');
    expect(batch?.visitId).toBeNull();
    expect(batch?.batchId).toBe('batch-2');
    // No `detail` key at all when the dispatcher resolved none, so a client can
    // tell "nothing resolved" from "resolved with every field blank".
    expect(batch).not.toHaveProperty('detail');
  });

  it('never leaks the raw data bag or the delivery fields onto the wire', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({ kinfolkId: 'fam1' }));
    for (const item of res.items) {
      expect(item).not.toHaveProperty('data');
      expect(item).not.toHaveProperty('recipientUid');
      expect(item).not.toHaveProperty('viewedByUid');
      expect(item).not.toHaveProperty('archivedByUid');
    }
  });

  it('defaults to the first tribe when none is named and the caller holds one', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listMyNotificationsHandler(req({}, 'solo'));
    // `solo` has no rows of their own; the point is that the call resolves.
    expect(res.items).toEqual([]);
    expect(res.unreadCount).toBe(0);
  });
});

describe('listMyNotifications paging', () => {
  it('pages newest first, and nextBefore is the oldest RAW row on the page even when it was filtered out', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    // The three newest raw rows for kin1 are n-visit, n-batch, n-read; a fourth
    // (n-archived) exists, so hasMore. Page two starts strictly before n-read.
    const page1 = await listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 3 }));
    expect(page1.items.map((i) => i.id)).toEqual(['n-visit', 'n-batch', 'n-read']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBefore).toBe(T0 - 3 * 60_000);

    // Page two: n-archived (hidden), n-restored, n-other-tribe (hidden for fam1).
    // The cursor still moves to n-other-tribe's time, not to n-restored's.
    const page2 = await listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 3, before: page1.nextBefore! }));
    expect(page2.items.map((i) => i.id)).toEqual(['n-restored']);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextBefore).toBe(T0 - 6 * 60_000);

    const page3 = await listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 3, before: page2.nextBefore! }));
    expect(page3.items.map((i) => i.id)).toEqual(['n-family-id', 'n-untagged']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextBefore).toBeNull();
  });

  it('reports the same unreadCount on every page', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const page1 = await listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 2 }));
    const page2 = await listMyNotificationsHandler(req({ kinfolkId: 'fam1', limit: 2, before: page1.nextBefore! }));
    expect(page1.unreadCount).toBe(5);
    expect(page2.unreadCount).toBe(5);
  });
});

describe('recipientNotifications helpers', () => {
  it('isUnreadNotification: absent or null readAt is unread, a stamp is read', () => {
    expect(isUnreadNotification({})).toBe(true);
    expect(isUnreadNotification({ readAt: null })).toBe(true);
    expect(isUnreadNotification({ readAt: at(1) })).toBe(false);
  });

  it('isVisibleNotification: archivedAt with a value hides, null or absent shows', () => {
    expect(isVisibleNotification({ archivedAt: at(1) }, 'fam1')).toBe(false);
    expect(isVisibleNotification({ archivedAt: null }, 'fam1')).toBe(true);
    expect(isVisibleNotification({}, 'fam1')).toBe(true);
  });

  it('isForTribe: a named household must match; none named matches every tribe; a numeric id reads as its digits', () => {
    expect(isForTribe({ data: { kinfolkId: 'fam1' } }, 'fam1')).toBe(true);
    expect(isForTribe({ data: { kinfolkId: 'fam2' } }, 'fam1')).toBe(false);
    expect(isForTribe({ data: { familyId: 'fam1' } }, 'fam1')).toBe(true);
    expect(isForTribe({ data: {} }, 'fam1')).toBe(true);
    expect(isForTribe({}, 'fam1')).toBe(true);
    expect(isForTribe({ data: { kinfolkId: 42 } }, '42')).toBe(true);
    expect(isForTribe({ data: { kinfolkId: '' } }, 'fam1')).toBe(true);
  });

  it('toIsoOrNull reads a Timestamp, a Date and a millis number, and nothing else', () => {
    const iso = new Date(T0).toISOString();
    expect(toIsoOrNull(Timestamp.fromMillis(T0))).toBe(iso);
    expect(toIsoOrNull(new Date(T0))).toBe(iso);
    expect(toIsoOrNull(T0)).toBe(iso);
    expect(toIsoOrNull('2026-11-01')).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull(null)).toBeNull();
  });

  it('countUnreadNotifications looks at the newest 100 rows only', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      id: `n-${i}`,
      data: { recipientUid: 'kin1', key: 'k', data: { kinfolkId: 'fam1' }, createdAt: at(i) },
    }));
    const ctx = buildDbMock({ queryDocs: { notifications: many } });
    expect(await countUnreadNotifications(ctx.db, 'kin1', 'fam1')).toBe(100);
  });

  it('toNotificationListItem fills blanks for a sparse row rather than throwing', () => {
    const item = toNotificationListItem('x', { createdAt: at(1) });
    expect(item).toEqual({
      id: 'x',
      key: '',
      category: '',
      title: '',
      description: '',
      actorName: '',
      actorPhotoUrl: '',
      targetType: '',
      targetId: '',
      visitId: null,
      batchId: null,
      createdAt: new Date(T0 - 60_000).toISOString(),
      readAt: null,
    });
  });
});
