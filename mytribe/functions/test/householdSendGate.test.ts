import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn(), sentryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: mocks.sentryFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.sentryFn.mockReset();
});

import { enqueueNotificationDetailed } from '../src/notifications/dispatcher';
import {
  HOUSEHOLD_SEND_GATE_FIELD,
  loadHouseholdSendGate,
  resolveHouseholdSendGate,
} from '../src/notifications/householdSendGate';
import { processOverdueInvoice } from '../src/scheduled/invoiceRemindersCron';

/**
 * THE PRE-LAUNCH HOUSEHOLD SEND GATE.
 *
 * The product is not live and production data is about to be deleted and
 * re-uploaded. These tests hold the two halves of the promise made to the
 * operator: no household hears anything until they switch it on, and the
 * operator's own alerts keep working the whole time.
 *
 * Every test here was watched fail against the un-gated dispatcher before it
 * was believed. The flip-on test at the bottom was also watched fail against a
 * gate placed one line lower, after `routeByDeliveryMode`, which is the mistake
 * that would quietly have cost the launch its whole invoice backlog.
 */

const SETTINGS_PATH = 'business_settings/business_settings';
const LEGACY_SETTINGS_PATH = 'business_settings/singleton';

/** The settings document with the gate in a named state. */
function settings(live: boolean | undefined): Record<string, unknown> {
  return { timeZone: 'America/Chicago', ...(live === undefined ? {} : { [HOUSEHOLD_SEND_GATE_FIELD]: live }) };
}

const events = (): string[] => mocks.logEventFn.mock.calls.map((c) => c[0].event);
const logFor = (event: string) => mocks.logEventFn.mock.calls.map((c) => c[0]).find((f) => f.event === event);

describe('householdSendGate: the flag itself', () => {
  it('only the literal boolean true opens it; absent and every near-miss stay shut', () => {
    expect(resolveHouseholdSendGate({ [HOUSEHOLD_SEND_GATE_FIELD]: true })).toBe('live');
    expect(resolveHouseholdSendGate({})).toBe('absent');
    expect(resolveHouseholdSendGate(null)).toBe('absent');
    expect(resolveHouseholdSendGate({ [HOUSEHOLD_SEND_GATE_FIELD]: false })).toBe('off');
    // A hand-edit or a half-typed client is not a decision to go live.
    for (const near of ['true', 1, 'yes', {}, []]) {
      expect(resolveHouseholdSendGate({ [HOUSEHOLD_SEND_GATE_FIELD]: near })).toBe('off');
    }
  });

  /**
   * `buildDbMock` seeds the modern settings document with the gate OPEN, because
   * every suite older than the gate describes a running business. These cases
   * are about the document itself, so each one passes `null` for the modern id,
   * which the mock reads as "this document does not exist" and, being present as
   * a key, is left exactly as written.
   */
  it('reads the modern settings id, and falls back to the legacy singleton', async () => {
    const modern = buildDbMock({ docs: { [SETTINGS_PATH]: settings(true) } });
    expect(await loadHouseholdSendGate(modern.db)).toEqual({ live: true, state: 'live' });

    const legacy = buildDbMock({
      docs: { [SETTINGS_PATH]: null, [LEGACY_SETTINGS_PATH]: settings(true) },
    });
    expect(await loadHouseholdSendGate(legacy.db)).toEqual({ live: true, state: 'live' });

    const neither = buildDbMock({ docs: { [SETTINGS_PATH]: null } });
    expect(await loadHouseholdSendGate(neither.db)).toEqual({ live: false, state: 'absent' });

    // The legacy document is consulted only when the modern one is missing, and
    // a legacy document that says nothing is still off.
    const legacySilent = buildDbMock({
      docs: { [SETTINGS_PATH]: null, [LEGACY_SETTINGS_PATH]: settings(undefined) },
    });
    expect(await loadHouseholdSendGate(legacySilent.db)).toEqual({ live: false, state: 'absent' });
  });

  it('a FAILED read is off, and says so at critical', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: null } });
    ctx.db.doc(SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

    expect(await loadHouseholdSendGate(ctx.db)).toEqual({ live: false, state: 'read-failed' });

    const logged = logFor('household.send.gate.read.failed');
    expect(logged, 'the failure is logged, not swallowed').toBeTruthy();
    expect(logged.severity).toBe('critical');
    expect(logged.errorMessage).toContain('DEADLINE_EXCEEDED');
  });
});

describe('householdSendGate: the dispatcher chokepoint', () => {
  /**
   * `invoice.overdue` is kinfolk-only. Nothing may be written: not the inbox
   * doc, not the work order, and above all not the `notificationDedupe` ledger,
   * which is what a later run would read back as "already delivered".
   */
  it('GATE OFF: a household notification is suppressed and nothing is written', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: settings(false) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', invoiceId: 'inv1' },
    });

    expect(outcome.written).toEqual([]);
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
    expect(ctx.writes.map((w) => w.path), 'no notification, no work order, NO dedupe ledger').toEqual([]);
    expect(events()).toContain('notification.gated.household');
  });

  it('GATE ABSENT: the same, because absent is the pre-launch default', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: settings(undefined) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', invoiceId: 'inv1' },
    });

    expect(outcome.suppressed[0]).toMatchObject({ reason: 'gate', gateState: 'absent' });
    expect(ctx.writes).toEqual([]);
  });

  /**
   * #876's lockout alert, the one that must keep working. `auth.account.locked`
   * goes to the household and `security.account.locked.operator` goes to the
   * business admin roster, from the same code in `loginSecurity.ts`. Gating a
   * whole sweep would have silenced both; gating by recipient type silences one.
   */
  it('GATE OFF: the #876 operator lockout alert still sends', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: settings(false), 'businessSettings/admins': { uids: ['op1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'security.account.locked.operator',
      data: { email: 'a@b.test', lockStartedAtMs: 1 },
    });

    expect(outcome.written).toHaveLength(1);
    expect(outcome.suppressed).toEqual([]);
    // A `trigger` key, so the operator's copy lands in the inbox immediately.
    expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(true);
    expect(events()).not.toContain('notification.gated.household');
  });

  it('GATE OFF: the household half of a both-audience key waits, the operator half goes', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: settings(false), 'businessSettings/admins': { uids: ['op1', 'op2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1', kinfolkId: 'kf1' },
    });

    expect(outcome.written, 'both admins, and not the household').toHaveLength(2);
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
    const summary = logFor('notification.gated.household.summary');
    expect(summary.extra.suppressedCount, 'the operator can see what was held back').toBe(1);
    expect(summary.extra.deliveredCount).toBe(2);
    expect(summary.extra.key).toBe('kincare.booking.confirm');
  });

  it('GATE ON: the household notification sends normally', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: settings(true) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', invoiceId: 'inv1' },
    });

    expect(outcome.written).toHaveLength(1);
    expect(outcome.suppressed).toEqual([]);
    // `invoice.overdue` is a `scheduled` key, so its delivery row is the queue
    // doc the scheduled sweep promotes, not a `notifications/` doc.
    expect(ctx.writes.some((w) => w.path.startsWith('scheduledNotifications/'))).toBe(true);
    expect(events()).not.toContain('notification.gated.household');
  });

  it('a FAILED settings read suppresses the household copy and logs critical', async () => {
    const ctx = buildDbMock({ docs: { [SETTINGS_PATH]: settings(true) } });
    ctx.db.doc(SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', invoiceId: 'inv1' },
    });

    expect(outcome.suppressed[0]).toMatchObject({ reason: 'gate', gateState: 'read-failed' });
    expect(ctx.writes).toEqual([]);
    expect(logFor('household.send.gate.read.failed').severity).toBe('critical');
  });

  it('the gate is read ONCE per enqueue, and not at all for a staff-only key', async () => {
    const ctx = buildDbMock({
      docs: { [SETTINGS_PATH]: settings(false), 'businessSettings/admins': { uids: ['op1', 'op2'] } },
    });
    const settingsRef = ctx.db.doc(SETTINGS_PATH);
    const reads = vi.spyOn(settingsRef, 'get');
    mocks.dbFn.mockReturnValue(ctx.db);

    await enqueueNotificationDetailed({
      key: 'security.account.locked.operator',
      data: { email: 'a@b.test' },
    });
    expect(reads.mock.calls.length, 'staff-only keys never touch the settings doc').toBe(0);

    await enqueueNotificationDetailed({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1', kinfolkId: 'kf1' },
    });
    expect(reads.mock.calls.length, 'one read for the whole fan-out').toBe(1);
  });
});

/**
 * THE TEST THAT PROTECTS THE LAUNCH.
 *
 * `invoiceOverdueCron` writes `overdueNotifiedAtMs` and `:279` skips forever on
 * it. If a gated send caused that stamp, the day the operator opens the product
 * every invoice that existed while the gate was shut would be silently skipped,
 * and nobody would ever find out, because a skipped invoice produces no log,
 * no error and no missing document. It just never gets chased.
 *
 * The second run is deliberately 24 hours later: past
 * OVERDUE_SUPPRESSED_RETRY_MS (20h) so the invoice is retried at all, and WELL
 * INSIDE OVERDUE_DEDUPE_WINDOW_MS (7 days) so the dispatcher's ledger is still
 * being consulted. That is what makes the test discriminating. A gate placed
 * after `routeByDeliveryMode` would have written the ledger on the gated run,
 * and this second run would come back `duplicate` and stamp `overdueNotifiedAtMs`
 * from the ledger's timestamp without sending anything. Re-running at +8 days
 * instead would pass against that broken placement and prove nothing.
 */
describe('householdSendGate: flipping it on after a spell off', () => {
  it('an invoice suppressed for a day still gets its overdue notice when the gate opens', async () => {
    const now = Date.parse('2026-09-22T14:00:00Z');
    const docs: Record<string, Record<string, unknown> | null> = {
      [SETTINGS_PATH]: settings(false),
      'invoices/inv1': {
        status: 'open',
        dueDate: '2026-08-01',
        amountDue: 120,
        amountMinor: 12000,
        currency: 'usd',
        kinfolkId: 'kf1',
      },
      'kinfolk/kf1': { uid: 'kinUid' },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    const invoiceSnap = () => {
      const ref = ctx.db.doc('invoices/inv1');
      return { id: 'inv1', ref, data: () => docs['invoices/inv1'] } as never;
    };

    // ── Run 1: the gate is shut. ────────────────────────────────────────────
    expect(await processOverdueInvoice(invoiceSnap(), now, '2026-09-22')).toBe(false);

    const afterShut = docs['invoices/inv1'] as Record<string, unknown>;
    expect(afterShut.overdueNotifiedAtMs, 'NOTHING may look like a delivery').toBeUndefined();
    expect(afterShut.overdueSuppressedAtMs, 'only the soft retry backoff').toBe(now);
    expect(
      ctx.writes.filter((w) => w.path.startsWith('notificationDedupe/')),
      'no ledger entry, so the next run is not told it already sent',
    ).toEqual([]);
    expect(ctx.writes.some((w) => w.path.startsWith('scheduledNotifications/'))).toBe(false);

    // ── The operator flips it on. ───────────────────────────────────────────
    docs[SETTINGS_PATH] = settings(true);
    const later = now + 24 * 60 * 60 * 1000;

    // ── Run 2: the backlog goes out. ────────────────────────────────────────
    expect(await processOverdueInvoice(invoiceSnap(), later, '2026-09-23')).toBe(true);

    const afterOpen = docs['invoices/inv1'] as Record<string, unknown>;
    expect(afterOpen.overdueNotifiedAtMs, 'stamped only now, with THIS run time').toBe(later);
    expect(
      ctx.writes.some((w) => w.path.startsWith('scheduledNotifications/')),
      'a real notice, queued for the scheduled sweep',
    ).toBe(true);
    expect(ctx.writes.some((w) => w.path.startsWith('notificationDedupe/'))).toBe(true);
  });
});
