import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityLogEntry } from '../api/activityLog';
import {
  activityCategoryOf,
  actorRoleFor,
  actorRoleLabel,
  activityChainRows,
  activityDayLabel,
  activityDetailRows,
  activityIsFailure,
  activityMatchesCategory,
  activityMatchesQuery,
  activityMatchesStatus,
  activityPayloadRows,
  humanizeAction,
  localDayKey,
  activityWhen,
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
  it('names the actor and keeps the uid beside the name on the opened record (#1592)', () => {
    const rows = activityDetailRows(entry({ actorId: 'u1' }), 'America/Chicago', new Map([['u1', 'Syd East']]));
    expect(rows).toContainEqual({ label: 'Actor', value: 'Syd East' });
    expect(rows).toContainEqual({ label: 'Actor id', value: 'u1' });
  });

  it('shows an unknown actor uid as it is, with no second id row', () => {
    const rows = activityDetailRows(entry({ actorId: 'u9' }), 'America/Chicago', new Map());
    expect(rows).toContainEqual({ label: 'Actor', value: 'u9' });
    expect(rows.some((r) => r.label === 'Actor id')).toBe(false);
  });

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

  /**
   * #1592. The server's audit vocabulary writes actorRole AUNTIE for ANY staff
   * caller, the owner included, so an admin sign-in read "AUNTIE". The row says
   * what the role is in words; the stored value is unchanged.
   */
  it('names the actor role in words, never the stored constant', () => {
    const role = (actorRole: string) =>
      activityDetailRows(entry({ actorRole })).find((r) => r.label === 'Actor role')?.value;
    expect(role('AUNTIE')).toBe('Staff');
    expect(role('PRIMARY')).toBe('Primary kinfolk');
    expect(role('SECONDARY')).toBe('Secondary kinfolk');
    expect(role('SYSTEM')).toBe('System');
    expect(actorRoleLabel('auntie')).toBe('Staff');
    // A role this list does not know yet still reads as a word.
    expect(actorRoleLabel('SOME_NEW_ROLE')).toBe('Some new role');
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
   * so it stays on the list, but as a word the operator reads (#1592), not the
   * programming literal "null".
   */
  it('prints a recorded null as none, and an empty map as {}', () => {
    expect(activityPayloadRows(entry({ payload: { providerMessageId: null } }))).toEqual([
      { label: 'providerMessageId', value: 'none' },
    ]);
    expect(activityPayloadRows(entry({ payload: { ids: ['a', null] } }))).toEqual([
      { label: 'ids', value: 'a, none' },
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

/**
 * Issue #755: the mock's six category chips, the same predicates Android's
 * `ActivityFilter.matches` applies, so an entry lands under the same chip on
 * both clients.
 */
describe('activityMatchesCategory', () => {
  it('passes everything through on All', () => {
    expect(activityMatchesCategory(entry({ actionType: '' }), 'all')).toBe(true);
  });

  it('buckets by the Android prefix rules', () => {
    expect(activityMatchesCategory(entry({ actionType: 'AUTH_LOGIN_SUCCESS' }), 'auth')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'LOGIN' }), 'auth')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'BOOKING_SUBMITTED' }), 'bookings')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'KINCARE_ARRIVED' }), 'bookings')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'DRAFT_APPROVED' }), 'kintales')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'NOTIFICATION_VIEWED' }), 'notifications')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'UPDATE_SETTINGS' }), 'admin')).toBe(true);
    expect(activityMatchesCategory(entry({ actionType: 'LOGIN' }), 'bookings')).toBe(false);
  });

  it('files every action under exactly one chip (#1613)', () => {
    const triage = entry({ actionType: 'ADMIN_TRIAGE_ORPHAN_REPORT' });
    expect(activityMatchesCategory(triage, 'admin')).toBe(true);
    expect(activityMatchesCategory(triage, 'kintales')).toBe(false);
    expect(activityCategoryOf(triage)).toBe('admin');
  });
  it('puts billing events under Billing, not KinTales or Bookings (#1613)', () => {
    for (const a of ['BILLING_DRAFT_INVOICE_SENT', 'BILLING_SESSION_DO_NOT_INVOICE_SET', 'BILLING_PAYMENT_RECORDED', 'BILLING_QUOTE_ACCEPTED', 'EXPENSE_LOGGED']) {
      expect(activityCategoryOf(entry({ actionType: a })), a).toBe('billing');
      expect(activityMatchesCategory(entry({ actionType: a }), 'kintales'), a).toBe(false);
    }
  });
  it('gives Admin the settings, membership, permission and retention events it never matched (#1613)', () => {
    for (const a of ['THEME_BRAND_TOKENS_UPDATED', 'MEMBERSHIP_INVITE_SENT', 'PERM_GRANTED', 'RETENTION_DRAFTS_PURGED', 'ADMIN_FEATURE_FLAGS_UPDATED', 'SAVE_FORM_SCHEMA', 'CREATE_KINFOLK', 'INTEGRATION_CALENDAR_PUSH', 'VET_CLINIC_UPDATED']) {
      expect(activityCategoryOf(entry({ actionType: a })), a).toBe('admin');
    }
  });
  it('keeps the other chips on their own events', () => {
    const cat = (a: string) => activityCategoryOf(entry({ actionType: a }));
    expect(cat('SECRETS_TRIBEPIN_SET')).toBe('auth');
    expect(cat('KINCARE_ARRIVED')).toBe('bookings');
    expect(cat('RESCHEDULE_BOOKING')).toBe('bookings');
    expect(cat('CREATE_BLOCKED_TIME_SLOT')).toBe('bookings');
    expect(cat('CONTENT_KINTALE_PHOTO_UPLOADED')).toBe('kintales');
    expect(cat('AI_TALE_TITLES_APPLIED')).toBe('kintales');
    expect(cat('MEDIA_FILE_DELETED')).toBe('kintales');
    expect(cat('BROADCAST_SENT')).toBe('notifications');
    expect(cat('CONVERSATION_REPLIED')).toBe('notifications');
  });
  it('claims every action type the server writes (guard against a new event with no chip)', () => {
    const src = readFileSync(resolve(__dirname, '../../../mytribe/functions/src/lib/auditEvents.ts'), 'utf8');
    const events = [...src.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(events.length).toBeGreaterThan(100);
    const unclaimed = events.filter((e) => activityCategoryOf(entry({ actionType: e })) === null);
    expect(unclaimed).toEqual([]);
  });
  it('#1820: files the keys declared ahead of their writers, and takes nothing from Bookings', () => {
    const cat = (a: string) => activityCategoryOf(entry({ actionType: a }));
    for (const a of [
      'UPDATE_KINFOLK', 'UPDATE_KINFOLK_TAGS', 'ARCHIVE_KINFOLK', 'RESTORE_KINFOLK', 'CREATE_KIN', 'UPDATE_KIN',
      'UPDATE_KIN_TAGS', 'SECONDARY_KINFOLK_SAVED', 'SECONDARY_KINFOLK_REMOVED', 'HOUSEHOLD_DATA_SAVED',
      'TEMPLATE_CREATED', 'TEMPLATE_SAVED', 'TEMPLATE_DELETED', 'TEMPLATE_ASSIGNED', 'TEMPLATE_UNASSIGNED', 'TEMPLATE_CONVERTED',
    ]) {
      expect(cat(a), a).toBe('admin');
    }
    for (const a of ['CONTENT_KINTALE_SENT', 'KINTALE_TEMPLATE_CREATED', 'KINTALE_TEMPLATE_SAVED', 'KINTALE_TEMPLATE_DELETED']) {
      expect(cat(a), a).toBe('kintales');
    }
    for (const a of ['VISIT_ON_MY_WAY', 'VISIT_ARRIVED', 'VISIT_DEPARTED', 'VISIT_UNDO_ARRIVAL']) {
      expect(cat(a), a).toBe('bookings');
    }
    expect(cat('NOTIFICATION_NOT_SENT')).toBe('notifications');
    expect(cat('NOTIFICATION_MARKED_UNREAD')).toBe('notifications');
    expect(cat('BILLING_PAYMENT_PARTIAL')).toBe('billing');
    // CREATE_KIN and UPDATE_KIN are exact: a visit is still a Bookings line.
    expect(cat('CREATE_KINCARE_SESSION')).toBe('bookings');
    expect(cat('UPDATE_KINCARE_SESSION')).toBe('bookings');
  });
  it('claims nothing for an action no chip recognises', () => {
    expect(activityCategoryOf(entry({ actionType: 'RECONCILE_RUN' }))).toBeNull();
  });
});

describe('the collapsed row, per the mock', () => {
  it('humanises the action code the way Android does', () => {
    expect(humanizeAction('KINCARE_ARRIVED')).toBe('Kincare arrived');
    expect(humanizeAction('LOGIN')).toBe('Login');
    expect(humanizeAction('')).toBe('Event');
  });

  it('reads FAILURE and the legacy ERROR spelling as failure, in any casing', () => {
    expect(activityIsFailure(entry({ status: 'FAILURE' }))).toBe(true);
    expect(activityIsFailure(entry({ status: 'error' }))).toBe(true);
    expect(activityIsFailure(entry({ status: 'SUCCESS' }))).toBe(false);
    expect(activityIsFailure(entry({ status: '' }))).toBe(false);
  });

  it('labels the day as Today, Yesterday, then the short date', () => {
    expect(activityDayLabel('2026-05-27', '2026-05-27')).toBe('Today · May 27');
    expect(activityDayLabel('2026-05-26', '2026-05-27')).toBe('Yesterday · May 26');
    expect(activityDayLabel('2026-05-04', '2026-05-27')).toBe('May 4');
  });

  it('finds yesterday across a month and a year boundary', () => {
    expect(activityDayLabel('2026-04-30', '2026-05-01')).toBe('Yesterday · Apr 30');
    expect(activityDayLabel('2025-12-31', '2026-01-01')).toBe('Yesterday · Dec 31');
  });

  it('passes a non-date key through untouched', () => {
    expect(activityDayLabel('Undated', '2026-05-27')).toBe('Undated');
  });

  it('keys a Date in local time, the shape the label compares against', () => {
    expect(localDayKey(new Date(2026, 4, 7, 23, 30))).toBe('2026-05-07');
  });
});

describe('activityWhen (#1585)', () => {
  it('reads a UTC stamp on the Chicago clock, standard time', () => {
    expect(activityWhen('2026-11-04T21:34:00Z', 'America/Chicago')).toEqual({ dayKey: '2026-11-04', clock: '3:34p' });
  });
  it('reads it in daylight time too', () => {
    expect(activityWhen('2026-07-16T21:34:00Z', 'America/Chicago')).toEqual({ dayKey: '2026-07-16', clock: '4:34p' });
  });
  it('moves the day back when UTC has already rolled over', () => {
    expect(activityWhen('2026-11-05T02:34:00.123Z', 'America/Chicago')).toEqual({ dayKey: '2026-11-04', clock: '8:34p' });
  });
  it('moves the day forward when the zone is ahead of UTC', () => {
    expect(activityWhen('2026-11-04T23:30:00Z', 'Asia/Tokyo')).toEqual({ dayKey: '2026-11-05', clock: '8:30a' });
  });
  it('defaults to America/Chicago when no zone is given', () => {
    expect(activityWhen('2026-11-04T21:34:00Z')?.clock).toBe('3:34p');
  });
  it('reads a stamp with an offset as the instant it names', () => {
    expect(activityWhen('2026-11-04T16:34:00-05:00', 'America/Chicago')?.clock).toBe('3:34p');
  });
  it('keeps a zone-less stamp as the business wall clock', () => {
    expect(activityWhen('2026-11-04T09:00:00', 'America/Chicago')).toEqual({ dayKey: '2026-11-04', clock: '9:00a' });
  });
  it('returns null for a stamp with no readable time', () => {
    expect(activityWhen('')).toBeNull();
    expect(activityWhen('2026-11-04')).toBeNull();
    expect(activityWhen('not a date')).toBeNull();
  });
  it('adds the business reading beside the raw stamp in the opened entry', () => {
    const rows = activityDetailRows(entry({ timestamp: '2026-11-04T21:34:00Z' }), 'America/Chicago');
    expect(rows[0]).toEqual({ label: 'When', value: '2026-11-04T21:34:00Z' });
    expect(rows[1]).toEqual({ label: 'Business time', value: '2026-11-04 3:34p' });
  });
});
// #1049: saveEmergencyContacts audits every refused save. The Activity Log has no
// per-event formatter; this pins that the generic one reads the new event well.
describe('EMERGENCY_CONTACT_SAVE_REFUSED (#1049)', () => {
  const refused = entry({
    actionType: 'EMERGENCY_CONTACT_SAVE_REFUSED',
    description: 'Emergency Contact not saved: An Emergency Contact has to be someone outside the household.',
    status: 'FAILURE',
    payload: { kinfolkId: 'fam1', code: 'failed-precondition', reason: 'An Emergency Contact has to be someone outside the household.' },
  });
  it('reads as a sentence, counts as a problem, and shows the household, the code and the reason', () => {
    expect(humanizeAction('EMERGENCY_CONTACT_SAVE_REFUSED')).toBe('Emergency contact save refused');
    expect(activityIsFailure(refused)).toBe(true);
    expect(activityMatchesStatus(refused, 'problems')).toBe(true);
    expect(activityPayloadRows(refused)).toEqual([
      { label: 'code', value: 'failed-precondition' },
      { label: 'kinfolkId', value: 'fam1' },
      { label: 'reason', value: 'An Emergency Contact has to be someone outside the household.' },
    ]);
  });
});

/**
 * #1820. One signed-in owner read "Primary kinfolk" on the lines her own taps
 * wrote, "Staff" on the lines the server wrote, and "Operator" in the header.
 */
describe('actorRoleFor (#1820)', () => {
  const roster = new Map<string, 'owner' | 'auntie'>([
    ['owner-uid', 'owner'],
    ['auntie-uid', 'auntie'],
  ]);
  const role = (over: Partial<ActivityLogEntry>, roles = roster) =>
    actorRoleFor({ _id: 'e', actorId: 'owner-uid', ...over }, roles);

  it('corrects a line already stored with a household role, from the roster', () => {
    expect(role({ actorRole: 'PRIMARY' })).toBe('Operator');
    expect(role({ actorRole: 'PRIMARY', actorId: 'auntie-uid' })).toBe('Auntie');
    expect(role({ actorRole: 'SECONDARY', actorId: 'auntie-uid' })).toBe('Auntie');
  });

  it('tells the owner from an Auntie on a staff line', () => {
    expect(role({ actorRole: 'AUNTIE' })).toBe('Operator');
    expect(role({ actorRole: 'AUNTIE', actorId: 'auntie-uid' })).toBe('Auntie');
  });

  it('reads the role the server stamped on the line before it reads the roster', () => {
    // She was an Auntie when she tapped, whatever the roster says today.
    expect(role({ actorRole: 'AUNTIE', payload: { admin: false, staffRole: 'auntie' } })).toBe('Auntie');
    expect(role({ actorRole: 'AUNTIE', actorId: 'gone', payload: { admin: true, staffRole: null } })).toBe('Operator');
    // Both stamps on one line is the Auntie, as every gate treats that account.
    expect(role({ actorRole: 'AUNTIE', actorId: 'x', payload: { admin: true, staffRole: 'auntie' } })).toBe('Auntie');
  });

  it('never reads a stamp off a household line', () => {
    expect(role({ actorRole: 'PRIMARY', actorId: 'kf-uid', payload: { admin: true } })).toBe('Primary kinfolk');
  });

  it('keeps a Kinfolk as a Kinfolk', () => {
    expect(role({ actorRole: 'PRIMARY', actorId: 'kf-uid' })).toBe('Primary kinfolk');
    expect(role({ actorRole: 'SECONDARY', actorId: 'sk-uid' })).toBe('Secondary kinfolk');
  });

  it('never relabels a System line, even when its actor is on the roster', () => {
    expect(role({ actorRole: 'SYSTEM' })).toBe('System');
  });

  it('guesses nothing when the roster has not answered or does not hold the actor', () => {
    expect(role({ actorRole: 'AUNTIE' }, new Map())).toBe('Staff');
    expect(role({ actorRole: 'AUNTIE', actorId: 'gone' })).toBe('Staff');
    expect(role({ actorRole: 'PRIMARY' }, new Map())).toBe('Primary kinfolk');
    expect(role({ actorRole: '' }, new Map())).toBe('');
  });

  it('is what the opened row shows', () => {
    const rows = activityDetailRows({ _id: 'e', actorId: 'owner-uid', actorRole: 'PRIMARY' }, undefined, new Map(), roster);
    expect(rows).toContainEqual({ label: 'Actor role', value: 'Operator' });
  });
});
