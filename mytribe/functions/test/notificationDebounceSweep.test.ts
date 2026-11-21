import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { DEBOUNCE_HELD_JOB, drainPendingNotifications } from '../src/scheduled/notificationDebounceSweep';

/**
 * #2478: THE DEBOUNCE QUEUE ASKS THE SEND SWITCH AGAIN AT EACH COPY'S SEND TIME.
 *
 * `pendingNotifications` holds a copy for up to 30 minutes after its last
 * change. Today both debounced keys go to the office only, so nothing here is
 * held in production; these pin that a household copy that lands in this
 * queue is held like the scheduled and batched ones, and that the office's
 * copies are untouched. Driven against the in-memory Firestore and the real
 * Activity Log writer.
 */
const NOW = Date.UTC(2026, 10, 21, 15, 0, 0);

type Docs = Record<string, Record<string, unknown> | null>;
type Write = { path: string; data: Record<string, unknown> };

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  recipientUid: 'kin1',
  stream: 'kinfolk',
  status: 'pending',
  mode: 'debounced',
  fireAfterMs: NOW - 60_000,
  channels: ['email'],
  data: { kinfolkId: 'fam1' },
  ...over,
});

function pendingDb(live: boolean, rows: Docs) {
  const docs: Docs = {
    [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: live },
    ...rows,
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return Object.assign(ctx, { docs });
}
const queued = (docs: Docs) => Object.keys(docs).filter((k) => k.startsWith('pendingNotifications/') && docs[k]);
const sends = (writes: Write[]) =>
  writes.filter((w) => w.path.startsWith('notifications/') || w.path.startsWith('notificationDispatch/'));
const notSent = (writes: Write[]) =>
  writes.filter((w) => w.path.startsWith('activity_log/') && w.data.actionType === 'NOTIFICATION_NOT_SENT').map((w) => w.data);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2478 notificationDebounceSweep at the send time', () => {
  it("the office's copies are promoted with notices to households off, as before", async () => {
    const ctx = pendingDb(false, {
      'pendingNotifications/admin1_pets.updated': row('pets.updated', { recipientUid: 'admin1', stream: 'business' }),
      'pendingNotifications/staff1_profile.updated': row('profile.updated', { recipientUid: 'staff1', stream: 'staff' }),
    });
    expect(await drainPendingNotifications(NOW)).toEqual({ promoted: 2, held: 0, skipped: 0 });
    expect(queued(ctx.docs)).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'))).toHaveLength(2);
    expect(notSent(ctx.writes)).toEqual([]);
  });

  it('a household copy with notices off is taken off the queue, never sent, and counted on one line', async () => {
    const ctx = pendingDb(false, {
      'pendingNotifications/kin1_pets.updated': row('pets.updated'),
      'pendingNotifications/kin2_pets.updated': row('pets.updated', { recipientUid: 'kin2' }),
    });
    expect(await drainPendingNotifications(NOW)).toEqual({ promoted: 0, held: 2, skipped: 0 });
    expect(queued(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
    const lines = notSent(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'NOT_SENT',
      actorRole: 'SYSTEM',
      payload: { outcome: 'held', summary: true, job: DEBOUNCE_HELD_JOB, count: 2 },
    });
    expect(String(lines[0]?.description)).toMatch(/^Held back 2 .*notices to households are turned off\. They will not be sent later$/);

    // On again: nothing comes back.
    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: true };
    expect(await drainPendingNotifications(NOW + 60_000)).toEqual({ promoted: 0, held: 0, skipped: 0 });
  });

  it('a household copy with notices on is promoted', async () => {
    const ctx = pendingDb(true, { 'pendingNotifications/kin1_pets.updated': row('pets.updated') });
    expect(await drainPendingNotifications(NOW)).toEqual({ promoted: 1, held: 0, skipped: 0 });
    expect(ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'))).toHaveLength(1);
    expect(notSent(ctx.writes)).toEqual([]);
  });

  it('ERROR: a switch that cannot be read leaves the household copy queued; the office copy still goes', async () => {
    const ctx = pendingDb(true, {
      'pendingNotifications/kin1_pets.updated': row('pets.updated'),
      'pendingNotifications/admin1_pets.updated': row('pets.updated', { recipientUid: 'admin1', stream: 'business' }),
    });
    const realDoc = ctx.db.doc.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, 'doc').mockImplementation(((path: string) =>
      path.startsWith('business_settings/')
        ? { get: () => Promise.reject(new Error('unavailable')) }
        : realDoc(path)) as any);
    expect(await drainPendingNotifications(NOW)).toEqual({ promoted: 1, held: 0, skipped: 1 });
    expect(queued(ctx.docs)).toEqual(['pendingNotifications/kin1_pets.updated']);
    expect(notSent(ctx.writes)).toEqual([]);

    spy.mockRestore();
    expect(await drainPendingNotifications(NOW + 60_000)).toEqual({ promoted: 1, held: 0, skipped: 0 });
    expect(queued(ctx.docs)).toEqual([]);
  });
});
