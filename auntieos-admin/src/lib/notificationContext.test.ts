import { describe, it, expect } from 'vitest';
import {
  normalizedTargetType,
  notificationKinfolkId,
  notificationKinfolkName,
  notificationTargetLabel,
} from './notificationContext';
import { type NotificationEntry } from '../api/notifications';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', ...over };
}

describe('normalizedTargetType', () => {
  it('accepts the four target types the dispatcher writes', () => {
    expect(normalizedTargetType('invoice')).toBe('invoice');
    expect(normalizedTargetType('kintale')).toBe('kintale');
    expect(normalizedTargetType('kinfolk')).toBe('kinfolk');
    expect(normalizedTargetType('booking')).toBe('booking');
  });

  it('trims and lowercases, matching the archive helper', () => {
    expect(normalizedTargetType('  Invoice ')).toBe('invoice');
  });

  it('rejects anything else, including the dispatcher blank and non-strings', () => {
    expect(normalizedTargetType('')).toBeNull();
    expect(normalizedTargetType('payout')).toBeNull();
    expect(normalizedTargetType(undefined)).toBeNull();
    expect(normalizedTargetType(42)).toBeNull();
  });
});

describe('notificationKinfolkId', () => {
  it('reads data.kinfolkId, the id emitters actually enqueue', () => {
    expect(notificationKinfolkId(entry({ data: { kinfolkId: 'k1' } }))).toBe('k1');
  });

  it('falls back to data.familyId, the dispatcher resolveTargetRef alias', () => {
    expect(notificationKinfolkId(entry({ data: { familyId: 'k2' } }))).toBe('k2');
  });

  it('falls back to targetId when the notification targets a household', () => {
    expect(notificationKinfolkId(entry({ targetType: 'kinfolk', targetId: 'k3' }))).toBe('k3');
  });

  it('does NOT read targetId for a non-kinfolk target', () => {
    expect(notificationKinfolkId(entry({ targetType: 'invoice', targetId: 'inv1' }))).toBe('');
  });

  it('survives a doc with no data object at all', () => {
    expect(notificationKinfolkId(entry())).toBe('');
    expect(notificationKinfolkId(entry({ data: 'not-an-object' as never }))).toBe('');
  });
});

describe('notificationKinfolkName', () => {
  const names = new Map([['k1', 'The Ruiz Household']]);

  it('prefers a name the emitter already put on the doc', () => {
    expect(notificationKinfolkName(entry({ data: { kinfolkName: 'Ruiz' } }), names)).toBe('Ruiz');
  });

  it('resolves the id against the streamed directory when the doc has only an id', () => {
    expect(notificationKinfolkName(entry({ data: { kinfolkId: 'k1' } }), names)).toBe(
      'The Ruiz Household',
    );
  });

  it('returns empty rather than inventing a name for an unresolvable id', () => {
    expect(notificationKinfolkName(entry({ data: { kinfolkId: 'gone' } }), names)).toBe('');
  });
});

describe('notificationTargetLabel', () => {
  it('names the linked entity in operator language', () => {
    expect(notificationTargetLabel(entry({ targetType: 'invoice', targetId: 'i1' }))).toBe('Invoice');
    expect(notificationTargetLabel(entry({ targetType: 'kintale', targetId: 't1' }))).toBe('KinTale');
    expect(notificationTargetLabel(entry({ targetType: 'kinfolk', targetId: 'k1' }))).toBe('Household');
    expect(notificationTargetLabel(entry({ targetType: 'booking', targetId: 'b1' }))).toBe('Booking');
  });

  it('is empty for an unknown or missing target, so no chip is rendered', () => {
    expect(notificationTargetLabel(entry({ targetType: 'payout', targetId: 'p1' }))).toBe('');
    expect(notificationTargetLabel(entry({ targetType: 'invoice', targetId: '' }))).toBe('');
    expect(notificationTargetLabel(entry())).toBe('');
  });
});
