import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ISSUE #519: `business_settings.enableAutoReminder24h` was decoded by three
 * admin models, editable on none of them, and read by nothing at all —
 * `kincareReminderCron` enqueued `kincare.upcoming.reminder` for every booking
 * in its 24-48h window whatever the field said.
 *
 * These cases are written to FAIL against that code: on the unfixed cron,
 * "false stops the scan" enqueues anyway, because nothing reads the switch.
 * They are the "a test that fails when the value changes and the behavior does
 * not" the issue's acceptance asks for.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: mocks.enqueue,
}));

import { isAutoReminder24hEnabled } from '../src/lib/autoReminder';
import { runKincareReminderScan } from '../src/scheduled/kincareReminderCron';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid');
  // The kincare scan reads the outcome, so the mock answers in that shape.
  mocks.enqueue.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  mocks.logEvent.mockReset();
});

const NOW = 1_000_000_000_000;

/** One confirmed booking sitting squarely inside the 24-48h reminder window. */
function dueBookingRow() {
  const startMs = NOW + 30 * 60 * 60 * 1000;
  const ref: any = {
    id: 'bk1',
    parent: { parent: { id: 'fam1' } },
    set: vi.fn(async () => undefined),
  };
  return {
    id: 'bk1',
    ref,
    data: () => ({ status: 'confirmed', serviceName: 'Drop-in', startTime: { toMillis: () => startMs } }),
  };
}

/** A db whose bookings collection-group holds one due booking and whose settings doc holds `settings`. */
function dbWith(settings: Record<string, unknown> | undefined) {
  const row = dueBookingRow();
  const query: any = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    startAfter: vi.fn(() => ({ ...query, get: vi.fn(async () => ({ docs: [] })) })),
    get: vi.fn(async () => ({ docs: [row] })),
  };
  return {
    collectionGroup: vi.fn(() => query),
    doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => settings })) })),
  };
}

describe('isAutoReminder24hEnabled', () => {
  it('reads an explicit false as OFF', async () => {
    const fs = { doc: () => ({ get: async () => ({ data: () => ({ enableAutoReminder24h: false }) }) }) };
    expect(await isAutoReminder24hEnabled(fs as never)).toBe(false);
  });

  it('reads an explicit true as ON', async () => {
    const fs = { doc: () => ({ get: async () => ({ data: () => ({ enableAutoReminder24h: true }) }) }) };
    expect(await isAutoReminder24hEnabled(fs as never)).toBe(true);
  });

  it('reads an ABSENT key as ON, so the deploy that added this gate reminds exactly as before', async () => {
    const fs = { doc: () => ({ get: async () => ({ data: () => ({}) }) }) };
    expect(await isAutoReminder24hEnabled(fs as never)).toBe(true);
  });

  it('reads a missing settings document as ON', async () => {
    const fs = { doc: () => ({ get: async () => ({ data: () => undefined }) }) };
    expect(await isAutoReminder24hEnabled(fs as never)).toBe(true);
  });

  it('reads a settings-read failure as ON rather than cancelling every reminder that hour', async () => {
    const fs = { doc: () => ({ get: async () => { throw new Error('offline'); } }) };
    expect(await isAutoReminder24hEnabled(fs as never)).toBe(true);
  });
});

describe('runKincareReminderScan honours the switch', () => {
  it('enqueues the due reminder when the key is absent', async () => {
    mocks.dbFn.mockReturnValue(dbWith({}));
    expect(await runKincareReminderScan(NOW)).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]?.[0]?.key).toBe('kincare.upcoming.reminder');
  });

  it('enqueues the due reminder when the switch is explicitly on', async () => {
    mocks.dbFn.mockReturnValue(dbWith({ enableAutoReminder24h: true }));
    expect(await runKincareReminderScan(NOW)).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues nothing, and does not even scan, when the switch is off', async () => {
    const db = dbWith({ enableAutoReminder24h: false });
    mocks.dbFn.mockReturnValue(db);

    expect(await runKincareReminderScan(NOW)).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // Not scanned at all: no pagination, so no booking gets an
    // `upcomingReminderNotifiedAtMs` stamp it would be skipped by later.
    expect(db.collectionGroup).not.toHaveBeenCalled();
    const off = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'kincare.reminder.disabled');
    expect(off).toBeDefined();
  });
});
