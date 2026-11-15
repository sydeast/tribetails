import { describe, it, expect } from 'vitest';
import type { ActivityLogEntry } from '../api/activityLog';
import {
  NOTICE_NOT_SENT_TITLE,
  NOT_SENT_STATUS_WORDS,
  activityDetailRows,
  activityEntryDescription,
  activityEntryShowsCode,
  activityEntryTitle,
  activityIsFailure,
  activityIsNoticeNotSent,
  activityMatchesQuery,
  activityMatchesStatus,
  activityRowShowsTarget,
  activityStatusWords,
} from './activityDetail';
import { noticeNotSentWords } from './activityWords';

/**
 * #1819, #1905: A NOTICE THAT DID NOT GO OUT, AS THE ACTIVITY LOG READS IT.
 *
 * The walk's row, exactly as it was stored: "Notification dispatched", status
 * SUCCESS, description `NOTIFICATION_DISPATCHED uid=<28 characters>`, and the
 * truth only in the opened payload as stored keys. Stored rows are evidence and
 * are never rewritten, so these pin what the row SAYS about one.
 */
function entry(over: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return { _id: 'a1', timestamp: '2026-11-10T23:14:00.000Z', actorId: '', seq: 9, ...over };
}

/** The row #1819 found, after the "OMW" tap with household notices off. */
const HELD_AS_STORED = entry({
  actionType: 'NOTIFICATION_DISPATCHED',
  description: 'NOTIFICATION_DISPATCHED uid=AbCdEfGhIjKlMnOpQrStUvWxYz12',
  status: 'SUCCESS',
  actorId: 'AbCdEfGhIjKlMnOpQrStUvWxYz12',
  payload: {
    key: 'kincare.auntie.on_my_way',
    event: 'on_my_way',
    batchId: 'b1',
    visitId: 'v1',
    dispatchIds: [],
    reason: 'household_notices_off',
  },
});

/** What the server writes now. */
const HELD_NOW = entry({
  actionType: 'NOTIFICATION_NOT_SENT',
  description: 'Held back "Your Auntie is on the way" for Dre East: notices to households are turned off',
  status: 'NOT_SENT',
  payload: { key: 'kincare.auntie.on_my_way', outcome: 'held', channels: [], recipientUid: 'u1' },
});

const SENT = entry({
  actionType: 'NOTIFICATION_DISPATCHED',
  description: 'Sending "Your Auntie is on the way" to Dre East by email',
  status: 'SUCCESS',
  targetId: 'n1',
  targetCollection: 'notifications',
  payload: { key: 'kincare.auntie.on_my_way', channels: ['email'], notificationId: 'n1', mode: 'trigger' },
});

describe('#1819 a held notice stored as "dispatched"', () => {
  it('reads as not sent: title, sentence and status', () => {
    expect(activityIsNoticeNotSent(HELD_AS_STORED)).toBe(true);
    expect(activityEntryTitle(HELD_AS_STORED)).toBe(NOTICE_NOT_SENT_TITLE);
    expect(activityEntryTitle(HELD_AS_STORED)).toBe('Notification not sent');
    expect(activityEntryDescription(HELD_AS_STORED)).toBe(
      'Held back "Kincare auntie on my way": notices to households are turned off',
    );
    expect(activityStatusWords(HELD_AS_STORED)).toBe(NOT_SENT_STATUS_WORDS);
  });

  it('prints no stored key beside a title that contradicts it, and no id in the sentence', () => {
    expect(activityEntryShowsCode(HELD_AS_STORED)).toBe(false);
    expect(activityEntryDescription(HELD_AS_STORED)).not.toMatch(/uid=|AbCdEf|household_notices_off|NOTIFICATION_/);
  });

  it('the opened entry says "Not sent", never SUCCESS', () => {
    const rows = activityDetailRows(HELD_AS_STORED);
    expect(rows).toContainEqual({ label: 'Status', value: 'Not sent' });
    expect(rows).not.toContainEqual({ label: 'Status', value: 'SUCCESS' });
    // The stored key stays on the opened record: it is the evidence.
    expect(rows).toContainEqual({ label: 'Action', value: 'NOTIFICATION_DISPATCHED' });
  });

  it('is not a success under the status filter, and not a problem either', () => {
    expect(activityMatchesStatus(HELD_AS_STORED, 'success')).toBe(false);
    expect(activityMatchesStatus(HELD_AS_STORED, 'problems')).toBe(false);
    expect(activityMatchesStatus(HELD_AS_STORED, 'pending')).toBe(false);
    expect(activityMatchesStatus(HELD_AS_STORED, 'all')).toBe(true);
    expect(activityIsFailure(HELD_AS_STORED)).toBe(false);
  });

  it('is found by the words the row shows', () => {
    expect(activityMatchesQuery(HELD_AS_STORED, 'not sent')).toBe(true);
    expect(activityMatchesQuery(HELD_AS_STORED, 'held back')).toBe(true);
    expect(activityMatchesQuery(HELD_AS_STORED, 'turned off')).toBe(true);
  });

  it('each stored reason has its words, and an unknown one is not printed as a key', () => {
    expect(noticeNotSentWords('kincare.auntie.arrived', 'household_prefs_suppressed')).toBe(
      'Did not send "Kincare auntie arrived": this notification is turned off in Settings',
    );
    expect(noticeNotSentWords('kincare.auntie.arrived', 'household_has_no_portal_account')).toBe(
      'Did not send "Kincare auntie arrived": nobody in the household has a MyTribe sign-in',
    );
    expect(noticeNotSentWords('kincare.auntie.arrived', 'no_recipient')).toBe(
      'Did not send "Kincare auntie arrived": there was nobody to send it to',
    );
    expect(noticeNotSentWords('kincare.auntie.arrived', 'some_new_reason')).toBe('Did not send "Kincare auntie arrived"');
    expect(noticeNotSentWords('', 'household_notices_off')).toBe(
      'Held back a notification: notices to households are turned off',
    );
  });
});

describe('#1819 the line the server writes now', () => {
  it('shows the server sentence as written, with status "Not sent"', () => {
    expect(activityIsNoticeNotSent(HELD_NOW)).toBe(true);
    expect(activityEntryTitle(HELD_NOW)).toBe('Notification not sent');
    expect(activityEntryDescription(HELD_NOW)).toBe(
      'Held back "Your Auntie is on the way" for Dre East: notices to households are turned off',
    );
    expect(activityStatusWords(HELD_NOW)).toBe('Not sent');
    expect(activityMatchesStatus(HELD_NOW, 'success')).toBe(false);
    expect(activityMatchesStatus(HELD_NOW, 'problems')).toBe(false);
  });

  it('a send that failed is a problem, and keeps its own status', () => {
    const failed = entry({
      actionType: 'NOTIFICATION_NOT_SENT',
      description: 'Could not send "Invoice sent" to Dre East by email: the send failed',
      status: 'FAILURE',
    });
    expect(activityIsFailure(failed)).toBe(true);
    expect(activityMatchesStatus(failed, 'problems')).toBe(true);
    expect(activityMatchesStatus(failed, 'success')).toBe(false);
    expect(activityStatusWords(failed)).toBe('FAILURE');
  });
});

describe('a notice that did go out is untouched', () => {
  it('keeps its title, its sentence, its code and its status', () => {
    expect(activityIsNoticeNotSent(SENT)).toBe(false);
    expect(activityEntryTitle(SENT)).toBe('Notification dispatched');
    expect(activityEntryShowsCode(SENT)).toBe(true);
    expect(activityEntryDescription(SENT)).toBe('Sending "Your Auntie is on the way" to Dre East by email');
    expect(activityStatusWords(SENT)).toBe('SUCCESS');
    expect(activityMatchesStatus(SENT, 'success')).toBe(true);
  });

  it('a dispatched row with ids, or with no reason, is never read as held', () => {
    const withIds = entry({
      actionType: 'NOTIFICATION_DISPATCHED',
      status: 'SUCCESS',
      payload: { dispatchIds: ['n1'], reason: null },
    });
    expect(activityIsNoticeNotSent(withIds)).toBe(false);
    // A reason beside ids that did go out is not a held notice.
    expect(
      activityIsNoticeNotSent(entry({ actionType: 'NOTIFICATION_DISPATCHED', payload: { dispatchIds: ['n1'], reason: 'x' } })),
    ).toBe(false);
    // The fan-out line has no dispatchIds at all.
    expect(activityIsNoticeNotSent(SENT)).toBe(false);
    // Another kind with the same payload shape is not a notice.
    expect(
      activityIsNoticeNotSent(entry({ actionType: 'VISIT_ARRIVED', payload: { dispatchIds: [], reason: 'household_notices_off' } })),
    ).toBe(false);
    // A payload that is not a map never throws.
    expect(activityIsNoticeNotSent(entry({ actionType: 'NOTIFICATION_DISPATCHED', payload: 'oops' }))).toBe(false);
    expect(activityIsNoticeNotSent(entry({ actionType: 'NOTIFICATION_DISPATCHED' }))).toBe(false);
  });
});

describe('#1905 a notification row does not end in a database path', () => {
  it('drops the target from the row for every notification kind, and keeps it for the rest', () => {
    for (const actionType of ['NOTIFICATION_DISPATCHED', 'NOTIFICATION_RECEIVED', 'NOTIFICATION_NOT_SENT', 'NOTIFICATION_VIEWED']) {
      expect(activityRowShowsTarget(entry({ actionType }))).toBe(false);
    }
    expect(activityRowShowsTarget(entry({ actionType: 'VISIT_ARRIVED' }))).toBe(true);
    expect(activityRowShowsTarget(entry({ actionType: 'BILLING_INVOICE_PAID' }))).toBe(true);
  });

  it('the opened entry still carries the target', () => {
    expect(activityDetailRows(SENT)).toContainEqual({ label: 'Target', value: 'notifications/n1' });
  });
});
