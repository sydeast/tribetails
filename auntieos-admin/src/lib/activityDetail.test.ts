import { describe, it, expect } from 'vitest';
import type { ActivityLogEntry } from '../api/activityLog';
import {
  activityChainRows,
  activityDetailRows,
  activityMatchesQuery,
  activityMatchesStatus,
  activityPayloadRows,
} from './activityDetail';

function entry(over: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return {
    _id: 'a1',
    timestamp: '2026-08-03T14:02:11.482Z',
    actionType: 'NOTIFICATION_RECEIVED',
    description: 'Notification kincare.booking.confirm delivered via email',
    status: 'SUCCESS',
    actorId: '',
    seq: 1482,
    ...over,
  };
}

/**
 * R5 on the Activity Log: "the Activity Log is seriously lacking, cant see shit
 * or what the fuck actually happened."
 *
 * Every field these selectors read has been on the document since 2026-05-19;
 * `writeAuditEntry` calls them "retained for forensic value ... surfaced in
 * detail views" and no detail view existed. So these tests are about DISCLOSURE,
 * not about new data.
 */
describe('activityDetailRows', () => {
  it('leads with the FULL timestamp, which is the part the collapsed row truncates', () => {
    const rows = activityDetailRows(entry());
    expect(rows[0]).toEqual({ label: 'When', value: '2026-08-03T14:02:11.482Z' });
  });

  it('surfaces the provenance fields the row never showed', () => {
    const rows = activityDetailRows(
      entry({
        severity: 'info',
        actorRole: 'SYSTEM',
        familyId: 'fam1',
        requestId: 'req-9',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      }),
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('Severity');
    expect(labels).toContain('Actor role');
    expect(labels).toContain('Household');
    expect(labels).toContain('Request');
    expect(labels).toContain('IP');
    expect(labels).toContain('User agent');
  });

  it('renders the target as a path, never a fabricated link', () => {
    const rows = activityDetailRows(entry({ targetCollection: 'notifications', targetId: 'n1' }));
    expect(rows).toContainEqual({ label: 'Target', value: 'notifications/n1' });
  });

  it('falls back to a generic collection segment rather than dropping a bare target id', () => {
    const rows = activityDetailRows(entry({ targetId: 'n1' }));
    expect(rows).toContainEqual({ label: 'Target', value: 'target/n1' });
  });

  it('omits fields the writer did not record', () => {
    const labels = activityDetailRows(entry()).map((r) => r.label);
    expect(labels).not.toContain('IP');
    expect(labels).not.toContain('Target');
  });
});

describe('activityPayloadRows', () => {
  /**
   * THE FIELD THAT ANSWERS THE COMPLAINT. The description says a notification
   * was delivered via email; the payload says to whom, for which notification,
   * and with which provider message id, and it was rendered nowhere in the
   * product.
   */
  it('flattens the payload that says what actually happened', () => {
    const rows = activityPayloadRows(
      entry({
        payload: {
          notificationId: 'n1',
          key: 'kincare.booking.confirm',
          channel: 'email',
          recipientUid: 'u1',
          providerMessageId: 'sg-88',
        },
      }),
    );
    expect(rows).toEqual([
      { label: 'channel', value: 'email' },
      { label: 'key', value: 'kincare.booking.confirm' },
      { label: 'notificationId', value: 'n1' },
      { label: 'providerMessageId', value: 'sg-88' },
      { label: 'recipientUid', value: 'u1' },
    ]);
  });

  it('sorts keys, so two entries of the same type are comparable by eye', () => {
    expect(activityPayloadRows(entry({ payload: { z: 1, a: 2 } })).map((r) => r.label)).toEqual([
      'a',
      'z',
    ]);
  });

  it('flattens nested maps to dotted paths rather than dumping JSON', () => {
    const rows = activityPayloadRows(entry({ payload: { result: { split: 3, scanned: 40 } } }));
    expect(rows).toEqual([
      { label: 'result.scanned', value: '40' },
      { label: 'result.split', value: '3' },
    ]);
  });

  it('keeps an array on one line, because it is one field', () => {
    expect(activityPayloadRows(entry({ payload: { channels: ['email', 'sms'] } }))).toEqual([
      { label: 'channels', value: 'email, sms' },
    ]);
  });

  /**
   * A recorded null is a decision the writer made. Blanking it would hide that,
   * and in an audit trail "the writer recorded null here" is evidence.
   */
  it('prints a recorded null as null, and an empty map as {}', () => {
    expect(activityPayloadRows(entry({ payload: { providerMessageId: null } }))).toEqual([
      { label: 'providerMessageId', value: 'null' },
    ]);
    expect(activityPayloadRows(entry({ payload: { extra: {} } }))).toEqual([
      { label: 'extra', value: '{}' },
    ]);
  });

  it('is empty for an entry written with no payload, and for a malformed one', () => {
    expect(activityPayloadRows(entry())).toEqual([]);
    expect(activityPayloadRows(entry({ payload: 'nope' }))).toEqual([]);
    expect(activityPayloadRows(entry({ payload: null }))).toEqual([]);
  });
});

describe('activityChainRows', () => {
  /**
   * FULL hashes. The collapsed row abbreviates to eight characters because it
   * has one line; an opened entry is where someone verifies a hash by eye
   * against verifyActivityLogChain, and a truncated hash verifies nothing.
   */
  it('shows the sequence and the full hashes, never a prefix', () => {
    const full = 'a'.repeat(64);
    const prev = 'b'.repeat(64);
    expect(activityChainRows(entry({ entryHash: full, prevHash: prev }))).toEqual([
      { label: 'Sequence', value: '#1482' },
      { label: 'Entry hash', value: full },
      { label: 'Previous hash', value: prev },
    ]);
  });

  it('is empty for a legacy pre-chain entry, so the screen can say so', () => {
    const { seq: _dropped, ...legacy } = entry();
    expect(activityChainRows(legacy)).toEqual([]);
  });

  it('still reports the sequence for an entry that has one but no hashes', () => {
    expect(activityChainRows(entry())).toEqual([{ label: 'Sequence', value: '#1482' }]);
  });
});

describe('activityMatchesQuery', () => {
  it('matches the visible fields', () => {
    expect(activityMatchesQuery(entry(), 'notification_received')).toBe(true);
    expect(activityMatchesQuery(entry(), 'delivered via email')).toBe(true);
  });

  /**
   * The reason search is worth having: "which entry mentions this booking id"
   * is the real operator question, and the id is almost always in the payload
   * rather than in the description.
   */
  it('matches inside the payload, which is where the ids actually are', () => {
    expect(activityMatchesQuery(entry({ payload: { bookingId: 'b_7fJ2' } }), 'b_7fj2')).toBe(true);
  });

  it('is case-insensitive and treats an empty query as no filter', () => {
    expect(activityMatchesQuery(entry(), 'NOTIFICATION')).toBe(true);
    expect(activityMatchesQuery(entry(), '   ')).toBe(true);
  });

  it('answers false rather than falling back to everything on no match', () => {
    expect(activityMatchesQuery(entry(), 'zzzz')).toBe(false);
  });
});

describe('activityMatchesStatus', () => {
  it('folds FAILURE and the legacy ERROR spelling into one Problems bucket', () => {
    expect(activityMatchesStatus(entry({ status: 'FAILURE' }), 'problems')).toBe(true);
    expect(activityMatchesStatus(entry({ status: 'ERROR' }), 'problems')).toBe(true);
    expect(activityMatchesStatus(entry({ status: 'SUCCESS' }), 'problems')).toBe(false);
  });

  it('passes everything through on All', () => {
    expect(activityMatchesStatus(entry({ status: '' }), 'all')).toBe(true);
  });

  it('matches success and pending exactly, whatever the casing on the wire', () => {
    expect(activityMatchesStatus(entry({ status: ' success ' }), 'success')).toBe(true);
    expect(activityMatchesStatus(entry({ status: 'PENDING' }), 'pending')).toBe(true);
    expect(activityMatchesStatus(entry({ status: 'PENDING' }), 'success')).toBe(false);
  });

  it('does not bucket a row with no status anywhere but All', () => {
    const { status: _dropped, ...noStatus } = entry();
    expect(activityMatchesStatus(noStatus, 'all')).toBe(true);
    expect(activityMatchesStatus(noStatus, 'success')).toBe(false);
    expect(activityMatchesStatus(noStatus, 'problems')).toBe(false);
  });
});
