import { describe, it, expect } from 'vitest';
import {
  isUnreadNotification,
  isVisibleNotification,
  UNREAD_SCAN_CAP,
} from '../src/lib/recipientNotifications';

/**
 * #1833: the portal's bell now counts live, on each client, from the same rows
 * `countUnreadNotifications` scans. This is the case table the two clients are
 * tested against (mytribe/web/src/lib/unreadBadge.test.ts and the Android
 * app's UnreadBadgeTest.kt), run here against the server's own predicates, so
 * a change to what "unread" or "visible" means on one side fails a test until
 * the other two follow.
 */

type Data = Record<string, unknown>;
const stamp = { seconds: 1 };

/** [name, document fields, counted on fam1's bell?] */
const CASES: [string, Data, boolean][] = [
  ['no readAt, no archivedAt, names fam1', { data: { kinfolkId: 'fam1' } }, true],
  ['readAt null', { readAt: null, data: { kinfolkId: 'fam1' } }, true],
  ['readAt set', { readAt: stamp, data: { kinfolkId: 'fam1' } }, false],
  ['archivedAt null (restored)', { archivedAt: null, data: { kinfolkId: 'fam1' } }, true],
  ['archivedAt set', { archivedAt: stamp, data: { kinfolkId: 'fam1' } }, false],
  ['archived and read', { archivedAt: stamp, readAt: stamp, data: { kinfolkId: 'fam1' } }, false],
  ['names another household', { data: { kinfolkId: 'fam2' } }, false],
  ['older spelling familyId, this household', { data: { familyId: 'fam1' } }, true],
  ['older spelling familyId, another household', { data: { familyId: 'fam2' } }, false],
  ['kinfolkId wins over familyId', { data: { kinfolkId: 'fam1', familyId: 'fam2' } }, true],
  ['a blank kinfolkId falls through to familyId', { data: { kinfolkId: '  ', familyId: 'fam2' } }, false],
  ['a numeric household id', { data: { kinfolkId: 42 } }, false],
  ['names no household', { data: {} }, true],
  ['has no data bag at all', {}, true],
  ['data is not an object', { data: 'x' }, true],
];

describe('what the bell counts, the case table shared with both portal clients (#1833)', () => {
  it.each(CASES)('%s', (_name, data, counted) => {
    expect(isVisibleNotification(data, 'fam1') && isUnreadNotification(data)).toBe(counted);
  });

  it('a numeric household id matches its digits', () => {
    expect(isVisibleNotification({ data: { kinfolkId: 42 } }, '42')).toBe(true);
  });

  it('looks at the newest 100 rows, the number both clients listen to', () => {
    expect(UNREAD_SCAN_CAP).toBe(100);
  });
});
