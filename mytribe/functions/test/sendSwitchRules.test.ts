import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

import {
  BROADCAST_HELD_TOKENS,
  BROADCAST_KEYS,
  ONE_HOUSEHOLD_MESSAGE_KEYS,
  broadcastHeldError,
  broadcastHoldReason,
  isBroadcastKey,
  passesHouseholdSendSwitch,
} from '../src/notifications/sendSwitchRules';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
import { MARKETING_KEYS } from '../src/admin/scheduleMarketingBlast';
import { BROADCAST_NOTIFICATION_KEY } from '../src/admin/broadcastMessage';
import { HOUSEHOLD_PUSH_NOTIFICATION_KEY } from '../src/admin/sendHouseholdPush';
import { enqueueNotificationDetailed, previewHouseholdCopy } from '../src/notifications/dispatcher';
import { broadcastHeldWords } from '../src/lib/activityWords';

/**
 * #1834 (operator ruling, 2026-11-20): with notices to households switched
 * off, broadcasts are held and single messages to one household still go.
 */

const OFF = { [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } };
const ON = { [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: true } };

function seed(docs: Record<string, unknown>) {
  const ctx = buildDbMock({ docs: { ...docs } as any, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

describe('the key lists', () => {
  it('the broadcast keys are the Communicate broadcast plus every marketing blast campaign', () => {
    expect([...BROADCAST_KEYS].sort()).toEqual([BROADCAST_NOTIFICATION_KEY, ...MARKETING_KEYS].sort());
    for (const k of BROADCAST_KEYS) expect(isBroadcastKey(k)).toBe(true);
    expect(isBroadcastKey('invoice.overdue')).toBe(false);
  });

  it('the single-message key is the reply/push key, a household row in the catalog', () => {
    expect(ONE_HOUSEHOLD_MESSAGE_KEYS).toEqual([HOUSEHOLD_PUSH_NOTIFICATION_KEY]);
    for (const k of ONE_HOUSEHOLD_MESSAGE_KEYS) {
      expect(NOTIFICATION_CATALOG[k]?.audiences.kinfolk, k).toBe(true);
      expect(passesHouseholdSendSwitch(k)).toBe(true);
    }
  });

  it('NEGATIVE: no broadcast key and no automatic notice passes the switch', () => {
    for (const k of BROADCAST_KEYS) expect(passesHouseholdSendSwitch(k), k).toBe(false);
    // The KinTale notice too: its triggers also fire for every re-uploaded report.
    for (const k of ['kintale.published', 'invoice.overdue', 'invoice.reminder', 'kincare.auntie.arrived', 'kincare.upcoming.reminder']) {
      expect(passesHouseholdSendSwitch(k), k).toBe(false);
    }
  });

  it('the refusal carries a token per reason, and no two share one', () => {
    expect(new Set(Object.values(BROADCAST_HELD_TOKENS)).size).toBe(3);
    const err = broadcastHeldError('off', 'test');
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('held_household_notices_off');
    expect(err.details).toEqual({ held: 'off' });
  });
});

describe('broadcastHoldReason', () => {
  it('switched off, and absent (the pre-launch default), are "off"', async () => {
    seed(OFF);
    expect(await broadcastHoldReason('broadcast.message')).toBe('off');
    seed({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { businessName: 'The Office' } });
    expect(await broadcastHoldReason('newsletter.announcement')).toBe('off');
  });

  it('switched on with nothing turned off: not held', async () => {
    seed(ON);
    expect(await broadcastHoldReason('broadcast.message')).toBeNull();
    // A marketing key with no household opted in is still not held as a whole:
    // opt-in is decided per household by the dispatcher.
    expect(await broadcastHoldReason('newsletter.announcement')).toBeNull();
  });

  it('the notification turned off in Settings is "turnedOff"', async () => {
    seed({ ...ON, 'businessSettings/notifications': { byKey: { 'survey.event': { enabled: false } } } });
    expect(await broadcastHoldReason('survey.event')).toBe('turnedOff');
    expect(await broadcastHoldReason('broadcast.message')).toBeNull();
  });

  it('the switch first: both off reads as notices off', async () => {
    seed({ ...OFF, 'businessSettings/notifications': { byKey: { 'broadcast.message': { enabled: false } } } });
    expect(await broadcastHoldReason('broadcast.message')).toBe('off');
  });

  it('ERROR: a settings read that fails is "unreadable", and held (fail closed)', async () => {
    const ctx = seed(ON);
    const realDoc = ctx.db.doc.bind(ctx.db);
    vi.spyOn(ctx.db, 'doc').mockImplementation(((path: string) =>
      path.startsWith('business_settings/')
        ? { get: () => Promise.reject(new Error('unavailable')) }
        : realDoc(path)) as any);
    expect(await broadcastHoldReason('broadcast.message')).toBe('unreadable');
  });
});

describe('the Activity Log words', () => {
  it('says what was held, for how many households, and that it will not go later', () => {
    expect(broadcastHeldWords('a broadcast', 1, 'off')).toBe(
      'Held back a broadcast to 1 household: notices to households are turned off. It will not be sent later',
    );
    expect(broadcastHeldWords('a marketing blast', 0, 'unreadable')).toBe(
      'Held back a marketing blast: the setting for notices to households could not be read. It will not be sent later',
    );
  });
});

describe('the dispatcher lets a single message through with notices off', () => {
  const HOUSEHOLD = {
    'kinfolk/kf1': { firstName: 'Test', lastName: 'One', uid: 'kinUid' },
    'families/kf1/members/kinUid': { role: 'PRIMARY', status: 'ACTIVE' },
  };

  it('an inbox reply notice (message.reply) is written', async () => {
    const ctx = seed({ ...OFF, ...HOUSEHOLD });
    const out = await enqueueNotificationDetailed({
      key: 'message.reply',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', kinfolkName: 'Test One', messageId: 'm1', preview: 'Hello' },
      targetType: 'conversation',
      targetId: 'kf1',
      dedupeKey: 'message:m1',
    });
    expect(out.written).toHaveLength(1);
    expect(out.suppressed).toEqual([]);
    expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(true);
  });

  it('NEGATIVE: a KinTale notice (kintale.published) is still held, so a re-upload announces nothing', async () => {
    seed({ ...OFF, ...HOUSEHOLD });
    const out = await enqueueNotificationDetailed({
      key: 'kintale.published',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', taleId: 't1', authorDisplayName: null },
      targetType: 'kintale',
      targetId: 't1',
    });
    expect(out.written).toEqual([]);
    expect(out.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
  });

  it('NEGATIVE: an automatic notice (invoice.overdue) is still held', async () => {
    seed({ ...OFF, ...HOUSEHOLD });
    const out = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', invoiceId: 'inv1' },
    });
    expect(out.written).toEqual([]);
    expect(out.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
  });

  it('the operator turning the notice off still holds a single message', async () => {
    seed({ ...OFF, ...HOUSEHOLD, 'businessSettings/notifications': { byKey: { 'message.reply': { enabled: false } } } });
    const out = await enqueueNotificationDetailed({
      key: 'message.reply',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', messageId: 'm2', preview: 'Hi' },
      dedupeKey: 'message:m2',
    });
    expect(out.written).toEqual([]);
    expect(out.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'prefs' }]);
  });

  it('the dry run agrees with the send: a single message reads "send", the rest "gate"', async () => {
    seed({ ...OFF, ...HOUSEHOLD });
    expect((await previewHouseholdCopy('message.reply', 'kinUid')).kind).toBe('send');
    expect((await previewHouseholdCopy('kintale.published', 'kinUid')).kind).toBe('gate');
    expect((await previewHouseholdCopy('kincare.auntie.arrived', 'kinUid')).kind).toBe('gate');
  });
});
