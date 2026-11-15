import { beforeEach, describe, expect, it } from 'vitest';
import {
  badgeRowFromDoc,
  bellCount,
  confirmLocalRead,
  countUnreadRows,
  liveUnreadOf,
  markReadLocally,
  resetUnreadBadge,
  setLiveRows,
  setUnreadFeedFailed,
  undoLocalRead,
  UNREAD_SCAN_CAP,
  type BadgeRow,
} from './unreadBadge';

/**
 * #1833: the bell's live count. The case table below is the same one the
 * server's count is tested with (functions/test/recipientNotifications.test.ts)
 * and the Android app's (UnreadBadgeTest.kt), so the three cannot drift apart
 * without a test saying so.
 */

const NONE = new Set<string>();
const row = (id: string, data: Record<string, unknown>) => badgeRowFromDoc(id, { recipientUid: 'u1', ...data });

/** [name, document fields, counted on fam1's bell?] */
const CASES: [string, Record<string, unknown>, boolean][] = [
  ['no readAt, no archivedAt, names fam1', { data: { kinfolkId: 'fam1' } }, true],
  ['readAt null', { readAt: null, data: { kinfolkId: 'fam1' } }, true],
  ['readAt set', { readAt: { seconds: 1 }, data: { kinfolkId: 'fam1' } }, false],
  ['archivedAt null (restored)', { archivedAt: null, data: { kinfolkId: 'fam1' } }, true],
  ['archivedAt set', { archivedAt: { seconds: 1 }, data: { kinfolkId: 'fam1' } }, false],
  ['archived and read', { archivedAt: { seconds: 1 }, readAt: { seconds: 2 }, data: { kinfolkId: 'fam1' } }, false],
  ['names another household', { data: { kinfolkId: 'fam2' } }, false],
  ['older spelling familyId, this household', { data: { familyId: 'fam1' } }, true],
  ['older spelling familyId, another household', { data: { familyId: 'fam2' } }, false],
  ['kinfolkId wins over familyId', { data: { kinfolkId: 'fam1', familyId: 'fam2' } }, true],
  ['a blank kinfolkId falls through to familyId', { data: { kinfolkId: '  ', familyId: 'fam2' } }, false],
  ['a numeric household id', { data: { kinfolkId: 42 } }, false],
  ['names no household', { data: {} }, true],
  ['has no data bag at all', {}, true],
  ['data is not an object', { data: 'x' }, true],
  // #2038: "Undo arrived" withdraws the arrival notice it was wrong about.
  ['withdrawn by the office', { archivedAt: { seconds: 1 }, withdrawnAt: { seconds: 1 }, data: { kinfolkId: 'fam1' } }, false],
  ['withdrawn, its archive stamp cleared', { archivedAt: null, withdrawnAt: { seconds: 1 }, data: { kinfolkId: 'fam1' } }, false],
  ['withdrawn after it was read', { readAt: { seconds: 1 }, archivedAt: { seconds: 2 }, withdrawnAt: { seconds: 2 }, data: { kinfolkId: 'fam1' } }, false],
  ['withdrawnAt null', { withdrawnAt: null, data: { kinfolkId: 'fam1' } }, true],
];

describe('countUnreadRows, the shared case table (#1833)', () => {
  it.each(CASES)('%s', (_name, data, counted) => {
    expect(countUnreadRows([row('n1', data)], 'fam1', NONE)).toBe(counted ? 1 : 0);
  });

  it('counts the table as a whole the way the server does', () => {
    const rows = CASES.map(([, data], i) => row(`n${i}`, data));
    expect(countUnreadRows(rows, 'fam1', NONE)).toBe(CASES.filter(([, , counted]) => counted).length);
  });

  it('a numeric household id matches its digits', () => {
    expect(countUnreadRows([row('n1', { data: { kinfolkId: 42 } })], '42', NONE)).toBe(1);
  });

  it('leaves out a row tapped here, and only that row', () => {
    const rows = [row('a', {}), row('b', {}), row('c', {})];
    expect(countUnreadRows(rows, 'fam1', new Set(['b']))).toBe(2);
    expect(countUnreadRows(rows, 'fam1', new Set(['zzz']))).toBe(3);
  });

  it('looks at the same number of rows as the server', () => {
    expect(UNREAD_SCAN_CAP).toBe(100);
  });
});

describe('the bell store (#1833)', () => {
  const unread = (id: string, tribeId = 'fam1'): BadgeRow => ({ id, unread: true, archived: false, tribeId });
  const read = (id: string): BadgeRow => ({ id, unread: false, archived: false, tribeId: 'fam1' });

  beforeEach(() => resetUnreadBadge());

  it('waits until the first snapshot, then is live', () => {
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
    setLiveRows([unread('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });

  it('goes up when a notice arrives, with no reload', () => {
    setLiveRows([unread('a')]);
    setLiveRows([unread('new'), unread('a')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });

  it('goes down when one is read somewhere else, and to nothing when all are', () => {
    setLiveRows([unread('a'), unread('b'), unread('c')]);
    setLiveRows([unread('a'), read('b'), unread('c')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
    setLiveRows([read('a'), read('b'), read('c')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 0 });
  });

  // #2038: "Undo arrived" withdraws the arrival notice. The snapshot that
  // carries the stamp is what moves the bell, with no reload.
  it('goes down when the office withdraws an arrival notice, read or unread', () => {
    const doc = (id: string, extra: Record<string, unknown> = {}) =>
      badgeRowFromDoc(id, { recipientUid: 'u1', data: { kinfolkId: 'fam1' }, ...extra });
    setLiveRows([doc('arrived'), doc('invoice'), doc('seen', { readAt: { seconds: 1 } })]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });

    const stamp = { seconds: 2 };
    setLiveRows([
      doc('arrived', { archivedAt: stamp, withdrawnAt: stamp, withdrawnReason: 'arrival_undone' }),
      doc('invoice'),
      doc('seen', { readAt: { seconds: 1 }, archivedAt: stamp, withdrawnAt: stamp }),
    ]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });

  it('a withdrawn row tapped a moment before is not counted twice or held back', () => {
    const doc = (id: string, extra: Record<string, unknown> = {}) =>
      badgeRowFromDoc(id, { recipientUid: 'u1', data: { kinfolkId: 'fam1' }, ...extra });
    setLiveRows([doc('arrived'), doc('invoice')]);
    markReadLocally('arrived');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    setLiveRows([doc('arrived', { archivedAt: { seconds: 2 }, withdrawnAt: { seconds: 2 } }), doc('invoice')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });

  it('goes back up when the office marks one unread again', () => {
    setLiveRows([read('a')]);
    setLiveRows([unread('a')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });

  it('a tap counts at once and is not counted twice when its snapshot lands', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    // A notice arriving before the server has answered the tap: one more, not
    // a jump back to what the tap had already taken off.
    setLiveRows([unread('new'), unread('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
    setLiveRows([unread('new'), read('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });

  it('forgets a tap once the server has answered it, so a later Mark unread counts', () => {
    setLiveRows([unread('a')]);
    markReadLocally('a');
    setLiveRows([read('a')]);
    setLiveRows([unread('a')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });

  it('puts the row back on the bell when the read was refused', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    undoLocalRead('a');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });

  it('counts each tribe under that tribe', () => {
    setLiveRows([unread('a', 'fam1'), unread('b', 'fam2'), unread('c', '')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
    expect(liveUnreadOf('fam2')).toEqual({ kind: 'live', count: 2 });
  });

  it('with no tribe to count for it keeps waiting, it does not guess', () => {
    setLiveRows([unread('a')]);
    expect(liveUnreadOf(undefined)).toEqual({ kind: 'waiting' });
  });

  it('a failed listener is an error for every tribe until the next sign-in', () => {
    setLiveRows([unread('a')]);
    setUnreadFeedFailed();
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'error' });
    expect(liveUnreadOf(undefined)).toEqual({ kind: 'error' });
    resetUnreadBadge();
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
  });

  it('keeps nothing of the last session after a reset', () => {
    setLiveRows([unread('a')]);
    markReadLocally('a');
    resetUnreadBadge();
    setLiveRows([unread('a')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });
});

/**
 * #2329: the bell undercounted by one until a reload when the office put a
 * tapped notice back on the list before the read reached this browser (the
 * listener only ever saw the row unread, so the tap kept subtracting), and an
 * offline start drew 0 from the empty cache over the count the portal opened
 * with.
 */
describe('the bell store, a tap the office answered first, and the cache (#2329)', () => {
  const unread = (id: string, issuedAtMs: number | null = 100): BadgeRow => ({ id, unread: true, archived: false, tribeId: 'fam1', issuedAtMs });
  const read = (id: string, issuedAtMs: number | null = 100): BadgeRow => ({ id, unread: false, archived: false, tribeId: 'fam1', issuedAtMs });
  beforeEach(() => resetUnreadBadge());
  it('reads the issue time off createdAt, a Timestamp or a number, and null when there is none', () => {
    expect(badgeRowFromDoc('a', { createdAt: { toMillis: () => 1_700_000_000_123 } }).issuedAtMs).toBe(1_700_000_000_123);
    expect(badgeRowFromDoc('a', { createdAt: 42 }).issuedAtMs).toBe(42);
    expect(badgeRowFromDoc('a', {}).issuedAtMs).toBeNull();
    expect(badgeRowFromDoc('a', { createdAt: 'yesterday' }).issuedAtMs).toBeNull();
  });
  it('a tap and then its read: one less, and no jump in between', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    setLiveRows([read('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    confirmLocalRead('a');
    setLiveRows([read('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });
  it('a tap the server took, and then a snapshot that still reads unread, counts the row again', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    confirmLocalRead('a');
    // The office marked it unread again before this browser saw the read.
    setLiveRows([unread('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });
  it('a tap the server has not answered stays off the bell while the row still reads unread', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    setLiveRows([unread('new'), unread('a'), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });
  it('the office issuing the notice again counts it at once, even before the server answers the tap', () => {
    setLiveRows([unread('arrived', 100), unread('b')]);
    markReadLocally('arrived');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    // A real arrival after an undone one: unread again, stamped again.
    setLiveRows([unread('arrived', 900), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
    // The read the tap sent lands afterwards: nothing is taken off twice.
    confirmLocalRead('arrived');
    setLiveRows([read('arrived', 900), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });
  it('a tap before the feed held the row takes the issue from the first snapshot that does', () => {
    markReadLocally('a');
    setLiveRows([unread('a', 100), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    setLiveRows([unread('a', 900), unread('b')]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });
  it('a refused read still puts the row back, answered or not', () => {
    setLiveRows([unread('a'), unread('b')]);
    markReadLocally('a');
    undoLocalRead('a');
    confirmLocalRead('a');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });
  it('an empty snapshot from the cache before the server has answered is not taken: the bell keeps its opening count', () => {
    expect(setLiveRows([], { fromCache: true })).toBe(false);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
    expect(bellCount(liveUnreadOf('fam1'), 6)).toBe(6);
    // Back online: the server's answer is taken, whatever it says.
    expect(setLiveRows([unread('a'), unread('b')])).toBe(true);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });
  it('the server answering with nothing unread is taken, and is 0', () => {
    setLiveRows([], { fromCache: true });
    setLiveRows([]);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 0 });
  });
  it('once the server has answered, a snapshot from the cache (the connection dropped) is taken', () => {
    setLiveRows([unread('a'), unread('b')]);
    expect(setLiveRows([unread('a'), read('b')], { fromCache: true })).toBe(true);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
  });
  it('a new sign-in waits for the server again', () => {
    setLiveRows([unread('a')]);
    resetUnreadBadge();
    expect(setLiveRows([], { fromCache: true })).toBe(false);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
  });
});
describe('bellCount (#1833)', () => {
  it('is the live count once there is one, 0 included', () => {
    expect(bellCount({ kind: 'live', count: 7 }, 6)).toBe(7);
    expect(bellCount({ kind: 'live', count: 0 }, 6)).toBe(0);
  });
  it('is the count the portal opened with while waiting', () => {
    expect(bellCount({ kind: 'waiting' }, 6)).toBe(6);
    expect(bellCount({ kind: 'waiting' }, undefined)).toBeUndefined();
  });
  it('is nothing after a failed listener, never the old number', () => {
    expect(bellCount({ kind: 'error' }, 6)).toBeUndefined();
  });
});
