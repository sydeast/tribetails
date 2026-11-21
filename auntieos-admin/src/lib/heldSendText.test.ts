import { describe, it, expect } from 'vitest';
import { blastCountsText, heldSendText } from './heldSendText';
import { friendlySendError } from '../screens/CommunicateCompose';

/**
 * #1834 (operator ruling, 2026-11-20): a broadcast or a marketing blast sent
 * while notices to households are switched off is held, and the owner reads
 * why in plain words. Same sentences on Android and the desktop console.
 */
describe('heldSendText', () => {
  it('switched off: not sent, will not go later, and how to send it', () => {
    expect(heldSendText('held_household_notices_off', 'broadcast')).toBe(
      'Held. Notices to households are switched off. This broadcast was not sent and will not go out later. To send it, switch on "Send notices to households" in Settings, under Notifications, then send it again.',
    );
    expect(heldSendText('held_household_notices_off', 'blast')).toBe(
      'Held. Notices to households are switched off. This blast was not scheduled and will not go out later. To send it, switch on "Send notices to households" in Settings, under Notifications, then schedule it again.',
    );
  });

  it('turned off and unreadable each have their own sentence', () => {
    expect(heldSendText('held_notice_turned_off', 'broadcast')).toBe(
      'Held. Broadcasts are turned off in Settings, under Notifications. This broadcast was not sent and will not go out later.',
    );
    expect(heldSendText('held_notice_turned_off', 'blast')).toBe(
      'Held. This campaign is turned off in Settings, under Notifications. This blast was not scheduled and will not go out later.',
    );
    expect(heldSendText('held_household_notices_unreadable', 'broadcast')).toBe(
      'Held. The setting for notices to households could not be read. This broadcast was not sent. Try again in a minute.',
    );
  });

  it('NEGATIVE: any other message is not a hold', () => {
    expect(heldSendText('no_recipients', 'broadcast')).toBeNull();
    expect(heldSendText('', 'blast')).toBeNull();
  });

  it('no sentence carries a token or an em dash', () => {
    for (const token of ['held_household_notices_off', 'held_notice_turned_off', 'held_household_notices_unreadable']) {
      for (const kind of ['broadcast', 'blast'] as const) {
        const s = heldSendText(token, kind) ?? '';
        expect(s).not.toContain('_');
        expect(s).not.toContain('—');
      }
    }
  });

  it('the broadcast error mapper answers a hold with the held sentence', () => {
    expect(friendlySendError(new Error('held_household_notices_off'))).toMatch(/^Held\. Notices to households are switched off\./);
    expect(friendlySendError(new Error('no_recipients'))).toBe('No kinfolk match this audience. Nothing was sent.');
  });
});

describe('blastCountsText', () => {
  it('takes copies held at the send time out of sent and names them', () => {
    expect(blastCountsText(3, 1, 0)).toBe('3 sent, 1 suppressed');
    expect(blastCountsText(3, 1, 2)).toBe('1 sent, 1 suppressed, 2 held and not sent');
    expect(blastCountsText(4, 0, 9)).toBe('0 sent, 0 suppressed, 9 held and not sent');
  });
});
