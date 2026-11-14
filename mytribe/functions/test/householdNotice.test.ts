import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import {
  householdNoticeFromOutcome,
  previewHouseholdNotice,
  sendHouseholdNotice,
  type HouseholdNoticeKey,
} from '../src/notifications/householdNotice';

/**
 * #1816, #1838, #2027, #1841: the confirm's prediction and the send's result
 * come from ONE code path (the dispatcher's `copyDecision` and gate), so each
 * case below runs BOTH against the same fixture and asserts they agree. The
 * two earlier fixes for the clock taps (#1805, #2108) each held for the case
 * they tested and broke on one they did not: a stored login that is not a
 * member, and the KinTale send, which had no prediction at all.
 */

type Docs = Record<string, Record<string, unknown> | null>;

/** A household whose stored login is an ACTIVE member, named on its client record. */
function claimed(extra: Docs = {}): Docs {
  return {
    'kinfolk/fam1': { uid: 'kinUid', kinfolkName: 'The Easts' },
    'families/fam1/members/kinUid': { status: 'ACTIVE', role: 'PRIMARY' },
    'clients/kinUid': { displayName: 'Dre East' },
    ...extra,
  };
}

async function both(docs: Docs, key = 'kincare.booking.cancel') {
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: { ...docs } }).db);
  const preview = await previewHouseholdNotice('fam1', key);
  const ctx = buildDbMock({ docs: { ...docs }, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  const result = await sendHouseholdNotice(
    'fam1',
    // The send takes only the admin-action keys; the clock key below proves the
    // all-channels-off case on a key whose channels a household can switch off.
    { key: key as HouseholdNoticeKey, data: { kinfolkId: 'fam1', bookingId: 'v1', visitId: 'v1' }, targetType: 'booking', targetId: 'v1' },
    'test',
  );
  const householdRecords = ctx.writes.filter(
    (w) => w.path.startsWith('notifications/') && (w.data as { recipientUid?: string }).recipientUid === 'kinUid',
  );
  return { preview, result, householdRecords };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('preview and send agree on who is told and how', () => {
  it('HAPPY: a member login with email on: "Dre East will get an email", and they were sent one', async () => {
    const { preview, result, householdRecords } = await both(claimed());
    expect(preview).toEqual({ willNotify: true, reason: null, name: 'Dre East', channels: ['email'] });
    expect(result).toEqual({ told: true, reason: null, name: 'Dre East', channels: ['email'] });
    expect(householdRecords).toHaveLength(1);
  });

  it('HAPPY: the channels the household chose are the channels named', async () => {
    const prefs = { 'clients/kinUid': { displayName: 'Dre East', notificationPrefs: { byKey: { 'kincare.booking.cancel': { email: true, sms: true, push: true } } } } };
    const { preview, result } = await both(claimed(prefs));
    expect(preview.channels).toEqual(result.channels);
    expect(result.channels).toEqual(['email', 'sms', 'push']);
  });

  it('SAD: household notices off in Settings: nobody will be told, and nobody was', async () => {
    const { preview, result, householdRecords } = await both(
      claimed({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } }),
    );
    expect(preview).toMatchObject({ willNotify: false, reason: 'household_notices_off', name: 'Dre East' });
    expect(result).toMatchObject({ told: false, reason: 'household_notices_off', name: 'Dre East' });
    expect(householdRecords).toHaveLength(0);
  });

  it('SAD: the notice turned off for the household (operator override): named as turned off', async () => {
    const off = { 'businessSettings/notifications': { byKey: { 'kincare.booking.cancel': { enabled: false } } } };
    const { preview, result, householdRecords } = await both(claimed(off));
    expect(preview.reason).toBe('household_prefs_suppressed');
    expect(result.reason).toBe('household_prefs_suppressed');
    expect(householdRecords).toHaveLength(0);
  });

  it('SAD: every channel off: told in the notifications list only, both sides', async () => {
    const allOff = {
      'clients/kinUid': {
        displayName: 'Dre East',
        notificationPrefs: { byKey: { 'kincare.auntie.on_my_way': { email: false, sms: false, push: false } } },
      },
    };
    const { preview, result, householdRecords } = await both(claimed(allOff), 'kincare.auntie.on_my_way');
    expect(preview).toEqual({ willNotify: true, reason: null, name: 'Dre East', channels: [] });
    expect(result).toEqual({ told: true, reason: null, name: 'Dre East', channels: [] });
    expect(householdRecords).toHaveLength(1);
  });

  it('NEGATIVE: a stored login that is not an active member is nobody, before the switch is even read', async () => {
    const docs = {
      'kinfolk/fam1': { uid: 'uid_admin', kinfolkName: 'The Easts' },
      'families/fam1/members/uid_admin': { status: 'REMOVED' },
      'clients/uid_admin': { displayName: 'The Admin' },
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    };
    const { preview, result } = await both(docs);
    expect(preview).toMatchObject({ willNotify: false, reason: 'household_has_no_portal_account', name: 'The Easts' });
    expect(result).toMatchObject({ told: false, reason: 'household_has_no_portal_account', name: 'The Easts' });
  });

  it('NEGATIVE: a key that never reaches a household (a staff visit note) says so, never "no account"', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: claimed() }).db);
    expect(await previewHouseholdNotice('fam1', 'kincare.note.auntie')).toEqual({
      willNotify: false,
      reason: 'not_a_household_notice',
      name: 'The Easts',
      channels: [],
    });
  });

  it('NEGATIVE: an email is never the name: the household name stands in', async () => {
    const { preview } = await both(claimed({ 'clients/kinUid': { displayName: 'catch@hanasamku.com' } }));
    expect(preview.name).toBe('The Easts');
  });
});

describe('householdNoticeFromOutcome reads only the household copy', () => {
  it('the office copy of a both-key is not the household being told', () => {
    expect(
      householdNoticeFromOutcome(
        {
          written: ['office1'],
          suppressed: [{ recipientUid: 'kinUid', reason: 'gate' }],
          channelsByRecipient: { adminUid: ['email'] },
        },
        'kinUid',
        'Dre East',
      ),
    ).toEqual({ told: false, reason: 'household_notices_off', name: 'Dre East', channels: [] });
  });

  it('a duplicate is "already told", not a fresh send', () => {
    expect(
      householdNoticeFromOutcome({ written: [], suppressed: [{ recipientUid: 'kinUid', reason: 'duplicate' }] }, 'kinUid', null)
        .reason,
    ).toBe('already_notified');
  });
});

describe('sendHouseholdNotice never throws', () => {
  it('ERROR: a failed send is dispatch_failed', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => {
        throw new Error('firestore down');
      },
      doc: () => {
        throw new Error('firestore down');
      },
    });
    const res = await sendHouseholdNotice(
      'fam1',
      { key: 'kincare.booking.cancel', data: {}, targetType: 'booking', targetId: 'v1' },
      'test',
    );
    expect(res).toEqual({ told: false, reason: 'dispatch_failed', name: null, channels: [] });
  });
});
