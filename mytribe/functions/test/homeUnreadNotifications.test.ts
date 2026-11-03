import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1316: the bell badge. `getMyHome.unreadNotifications` is how many of the
 * caller's newest notifications for this tribe have no `readAt`, read by the
 * same helper `listMyNotifications` uses, so the badge and the list agree.
 * A failed read costs the household the badge and nothing else.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { getMyHomeHandler } from '../src/portal/getMyHome';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const at = (minutesAgo: number) => Timestamp.fromMillis(T0 - minutesAgo * 60_000);

function req(uid: string, kinfolkId = 'fam1'): CallableRequest<{ kinfolkId?: string }> {
  return {
    data: { kinfolkId },
    auth: { uid, token: {} },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<{ kinfolkId?: string }>;
}

function seed() {
  return buildDbMock({
    docs: {
      'clients/kin1': { kinfolkIds: ['fam1', 'fam2'] },
      'families/fam1': { displayName: 'The Mercers' },
    },
    queryDocs: {
      invoices: [],
      notifications: [
        { id: 'a', data: { recipientUid: 'kin1', data: { kinfolkId: 'fam1' }, createdAt: at(1) } },
        { id: 'b', data: { recipientUid: 'kin1', data: { kinfolkId: 'fam1' }, createdAt: at(2) } },
        // Read: stamped by markNotificationRead.
        { id: 'c', data: { recipientUid: 'kin1', data: { kinfolkId: 'fam1' }, createdAt: at(3), readAt: at(2) } },
        // Archived: not on the bell.
        { id: 'd', data: { recipientUid: 'kin1', data: { kinfolkId: 'fam1' }, createdAt: at(4), archivedAt: at(1) } },
        // The other tribe this kinfolk holds: on fam2's bell, not fam1's.
        { id: 'e', data: { recipientUid: 'kin1', data: { kinfolkId: 'fam2' }, createdAt: at(5) } },
        // Names no household: on every tribe's bell.
        { id: 'f', data: { recipientUid: 'kin1', data: {}, createdAt: at(6) } },
        // Somebody else's: never.
        { id: 'g', data: { recipientUid: 'kin2', data: { kinfolkId: 'fam1' }, createdAt: at(0) } },
      ],
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('getMyHome.unreadNotifications (#1316)', () => {
  it('counts the unread rows visible under this tribe', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await getMyHomeHandler(req('kin1'));
    // a, b and the untagged f. Not c (read), d (archived), e (fam2), g (kin2).
    expect(res.unreadNotifications).toBe(3);
  });

  it('counts the other tribes rows under that tribe', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await getMyHomeHandler(req('kin1', 'fam2'));
    // e and the untagged f.
    expect(res.unreadNotifications).toBe(2);
  });

  it('is 0 with no notifications at all', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'clients/kin1': { kinfolkIds: ['fam1'] }, 'families/fam1': { displayName: 'The Mercers' } },
        queryDocs: { invoices: [] },
      }).db,
    );
    const res = await getMyHomeHandler(req('kin1'));
    expect(res.unreadNotifications).toBe(0);
  });

  it('is 0, and Home still answers, when the notifications read fails', async () => {
    const ctx = seed();
    const realCollection = ctx.db.collection.bind(ctx.db);
    ctx.db.collection = (path: string) => {
      if (path !== 'notifications') return realCollection(path);
      return {
        where: () => {
          throw new Error('FAILED_PRECONDITION: The query requires an index.');
        },
      };
    };
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getMyHomeHandler(req('kin1'));
    expect(res.displayName).toBe('The Mercers');
    expect(res.unreadNotifications).toBe(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'portal.home.unreadNotifications.failed' }),
    );
  });
});
