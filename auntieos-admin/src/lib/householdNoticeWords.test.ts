import { describe, it, expect } from 'vitest';
import {
  channelWords,
  householdNoticeConfirmLine,
  householdNoticeOf,
  householdNoticeResultLine,
  withHouseholdLine,
  type HouseholdNoticePreview,
} from './householdNoticeWords';

/**
 * #1816, #1838, #2027, #1841: the sentences every admin client uses for a
 * household notice. Android (`HouseholdNoticeWordsTest`) and the desktop
 * console (`HouseholdNoticeWordsTest`) assert the same strings.
 */
describe('channelWords', () => {
  it('names each channel the way a person would', () => {
    expect(channelWords(['email'])).toBe('an email');
    expect(channelWords(['email', 'sms'])).toBe('an email and a text');
    expect(channelWords(['email', 'sms', 'push'])).toBe('an email, a text and a phone notification');
    expect(channelWords([])).toBe('');
    expect(channelWords(['fax'])).toBe('');
  });
});

describe('householdNoticeConfirmLine (before the action)', () => {
  const ready = (
    over: Partial<{ willNotify: boolean; reason: string | null; name: string | null; channels: string[] }>,
  ): HouseholdNoticePreview => ({ status: 'ready', willNotify: true, reason: null, name: 'Dre East', channels: ['email'], ...over });

  it('HAPPY: who and how', () => {
    expect(householdNoticeConfirmLine(ready({}), 'The Easts')).toBe('Dre East will get an email.');
    expect(householdNoticeConfirmLine(ready({ channels: [] }), 'The Easts')).toBe(
      'Dre East will see it in their notifications list only.',
    );
  });

  it('SAD: each reason nobody will be told, in plain words', () => {
    const line = (reason: string) => householdNoticeConfirmLine(ready({ willNotify: false, reason, channels: [] }), '');
    expect(line('household_has_no_portal_account')).toBe('Nobody will be told: Dre East has no portal account.');
    expect(line('household_prefs_suppressed')).toBe('Nobody will be told: this notice is turned off for Dre East.');
    expect(line('household_notices_off')).toBe('Nobody will be told: notices to households are off in Settings.');
    expect(line('not_a_household_notice')).toBe('No notice goes to Dre East for this.');
  });

  it('NEGATIVE: an Auntie is never sent to Settings (#2185)', () => {
    const line = householdNoticeConfirmLine(ready({ willNotify: false, reason: 'household_notices_off' }), '', true);
    expect(line).toBe('Nobody will be told: the owner has notices to households turned off.');
    expect(line).not.toMatch(/Settings/);
  });

  it('NEGATIVE: no server name falls back to the screen, then to "the household"', () => {
    expect(householdNoticeConfirmLine(ready({ name: null }), 'The Easts')).toBe('The Easts will get an email.');
    expect(householdNoticeConfirmLine(ready({ name: null }), '')).toBe('The household will get an email.');
  });

  it('ERROR: checking says so; no answer or an unknown reason says nothing', () => {
    expect(householdNoticeConfirmLine({ status: 'checking' }, 'x')).toBe('Checking who will be told.');
    expect(householdNoticeConfirmLine({ status: 'unknown' }, 'x')).toBeNull();
    expect(householdNoticeConfirmLine(ready({ willNotify: false, reason: 'something_new' }), 'x')).toBeNull();
  });
});

describe('householdNoticeResultLine (after the action, from the server)', () => {
  const told = { told: true, reason: null, name: 'Dre East', channels: ['email', 'push'] };
  it('HAPPY: who was sent what', () => {
    expect(householdNoticeResultLine(told, '')).toBe('Dre East was sent an email and a phone notification.');
    expect(householdNoticeResultLine({ ...told, channels: [] }, '')).toBe(
      'Dre East was told in their notifications list only.',
    );
  });
  it('SAD: every reason nobody was told', () => {
    const line = (reason: string) => householdNoticeResultLine({ told: false, reason, name: 'Dre East', channels: [] }, '');
    expect(line('household_notices_off')).toBe('Nobody was told: notices to households are off in Settings.');
    expect(line('household_has_no_portal_account')).toBe('Nobody was told: Dre East has no portal account.');
    expect(line('already_notified')).toBe('Dre East was already told about this.');
    expect(line('not_requested')).toBe('No confirmation was sent.');
    expect(line('dispatch_failed')).toBe('The notice to Dre East could not be sent.');
    expect(line('session_has_no_routing_ids')).toBe('Nobody was told: this visit is not linked to a booking.');
    expect(line('no_recipient')).toBe('Nobody was told.');
  });
  it('ERROR: no notice at all (an older server) claims nothing', () => {
    expect(householdNoticeResultLine(null, 'x')).toBe('');
    expect(householdNoticeResultLine(undefined, 'x')).toBe('');
    expect(withHouseholdLine('Done.', '')).toBe('Done.');
    expect(withHouseholdLine('Done.', 'Nobody was told.')).toBe('Done. Nobody was told.');
  });
});

describe('householdNoticeOf', () => {
  it('reads the wire shape, and refuses anything without a told flag', () => {
    expect(householdNoticeOf({ told: true, reason: null, name: 'Dre East', channels: ['email', 3] })).toEqual({
      told: true,
      reason: null,
      name: 'Dre East',
      channels: ['email'],
    });
    expect(householdNoticeOf(undefined)).toBeNull();
    expect(householdNoticeOf({ reason: 'x' })).toBeNull();
  });
});
