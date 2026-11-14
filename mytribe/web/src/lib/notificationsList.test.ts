import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { ListMyNotificationsResult, NotificationItemDto } from '../api/notificationsApi';
import { bellAccessibleName, markReadInPages, notificationTarget, notificationWhen, unreadBadgeLabel } from './notificationsList';

/** #1316: the pure rules behind the bell badge and the notifications list. */

function item(overrides: Partial<NotificationItemDto> = {}): NotificationItemDto {
  return {
    id: 'n1',
    key: 'invoice.new',
    category: 'invoice',
    title: 'New invoice',
    description: 'An invoice is ready.',
    actorName: '',
    actorPhotoUrl: '',
    targetType: 'invoice',
    targetId: 'inv-1',
    visitId: null,
    batchId: null,
    createdAt: '2026-11-01T12:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('unreadBadgeLabel', () => {
  it('draws nothing at 0, for a missing count, and for junk', () => {
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(undefined)).toBeNull();
    expect(unreadBadgeLabel(null)).toBeNull();
    expect(unreadBadgeLabel(-2)).toBeNull();
    expect(unreadBadgeLabel(Number.NaN)).toBeNull();
  });

  it('draws the number up to 99, then 99+', () => {
    expect(unreadBadgeLabel(1)).toBe('1');
    expect(unreadBadgeLabel(99)).toBe('99');
    expect(unreadBadgeLabel(100)).toBe('99+');
    expect(unreadBadgeLabel(1500)).toBe('99+');
  });
});

describe('bellAccessibleName', () => {
  it('is plain Notifications whenever no badge is drawn', () => {
    expect(bellAccessibleName(0)).toBe('Notifications');
    expect(bellAccessibleName(undefined)).toBe('Notifications');
    expect(bellAccessibleName(null)).toBe('Notifications');
    expect(bellAccessibleName(-1)).toBe('Notifications');
  });

  it('speaks the exact count above 0, past the 99+ the badge draws', () => {
    expect(bellAccessibleName(1)).toBe('Notifications, 1 unread');
    expect(bellAccessibleName(3)).toBe('Notifications, 3 unread');
    expect(bellAccessibleName(150)).toBe('Notifications, 150 unread');
  });
});

describe('notificationTarget', () => {
  it('opens the visit when a booking row names one', () => {
    expect(notificationTarget(item({ targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1' }))).toEqual({
      kind: 'visit',
      visitId: 'v1',
    });
  });

  it('lands on Schedule for a row about a whole booking request, whose targetId is a batch', () => {
    expect(notificationTarget(item({ targetType: 'booking', targetId: 'b1', visitId: null, batchId: 'b1' }))).toEqual({
      kind: 'schedule',
    });
  });

  it('lands on Schedule rather than guessing when a booking row carries no visit id', () => {
    expect(notificationTarget(item({ targetType: 'booking', targetId: 'x', visitId: null, batchId: null }))).toEqual({
      kind: 'schedule',
    });
    expect(notificationTarget(item({ targetType: 'booking', targetId: 'x', visitId: '  ', batchId: null }))).toEqual({
      kind: 'schedule',
    });
  });

  it('opens the invoice and the tale by targetId', () => {
    expect(notificationTarget(item({ targetType: 'invoice', targetId: 'inv-9' }))).toEqual({ kind: 'invoice', invoiceId: 'inv-9' });
    expect(notificationTarget(item({ targetType: 'kintale', targetId: 'tale-2' }))).toEqual({ kind: 'tale', taleId: 'tale-2' });
  });

  it('#1898: a KinTale row with no id opens the KinTales list', () => {
    expect(notificationTarget(item({ targetType: 'kintale', targetId: '' }))).toEqual({ kind: 'tales' });
  });
  it('#1913: a Kin row opens the Kin, or the Kin list when it names none', () => {
    expect(notificationTarget(item({ targetType: 'kin', targetId: 'kin-2' }))).toEqual({ kind: 'kin', kinId: 'kin-2' });
    expect(notificationTarget(item({ targetType: 'kin', targetId: ' ' }))).toEqual({ kind: 'kinList' });
  });
  it('a household profile row opens Tribe', () => {
    expect(notificationTarget(item({ targetType: 'household', targetId: '' }))).toEqual({ kind: 'household' });
  });
  it('#1874: opens Messages for a reply from the office', () => {
    expect(notificationTarget(item({ targetType: 'conversation', targetId: 'fam1' }))).toEqual({ kind: 'messages' });
  });
  it('opens nothing for a household row, an unresolved row, or a row with no id', () => {
    expect(notificationTarget(item({ targetType: 'kinfolk', targetId: 'fam1' }))).toEqual({ kind: 'none' });
    expect(notificationTarget(item({ targetType: '', targetId: '' }))).toEqual({ kind: 'none' });
    expect(notificationTarget(item({ targetType: 'invoice', targetId: '' }))).toEqual({ kind: 'none' });
    expect(notificationTarget(item({ targetType: 'something-new', targetId: 'z' }))).toEqual({ kind: 'none' });
  });
});

describe('notificationWhen', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says Just now inside a minute, then minutes, hours and days', () => {
    expect(notificationWhen(ago(10_000), now)).toBe('Just now');
    expect(notificationWhen(ago(5 * 60_000), now)).toBe('5m ago');
    expect(notificationWhen(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(notificationWhen(ago(2 * 86_400_000), now)).toBe('2d ago');
    expect(notificationWhen(ago(6 * 86_400_000), now)).toBe('6d ago');
  });

  it('falls back to a short date past a week, with the year once it is not this year', () => {
    const d = new Date(now - 10 * 86_400_000);
    expect(notificationWhen(d.toISOString(), now)).toBe(`Oct ${d.getDate()}`);
    const lastYear = new Date(Date.UTC(2025, 2, 14, 12));
    expect(notificationWhen(lastYear.toISOString(), now)).toBe(`Mar ${lastYear.getDate()}, 2025`);
  });

  it('shows no time for a row with none, or an unreadable one', () => {
    expect(notificationWhen(null, now)).toBe('');
    expect(notificationWhen('', now)).toBe('');
    expect(notificationWhen('not a date', now)).toBe('');
  });
});

describe('markReadInPages', () => {
  function pages(): InfiniteData<ListMyNotificationsResult> {
    return {
      pageParams: [undefined, 1000],
      pages: [
        { items: [item({ id: 'a' }), item({ id: 'b', readAt: '2026-11-01T11:00:00.000Z' })], unreadCount: 3, hasMore: true, nextBefore: 1000 },
        { items: [item({ id: 'c' })], unreadCount: 3, hasMore: false, nextBefore: null },
      ],
    };
  }

  it('stamps the row read and drops the first pages unreadCount by one, wherever the row sits', () => {
    const data = pages();
    const out = markReadInPages(data, 'c', '2026-11-01T12:00:00.000Z');
    expect(out).not.toBe(data);
    expect(out.pages[1]?.items[0]?.readAt).toBe('2026-11-01T12:00:00.000Z');
    expect(out.pages[0]?.unreadCount).toBe(2);
    expect(out.pages[1]?.unreadCount).toBe(3);
    // Untouched rows are the same objects, so nothing else re-renders.
    expect(out.pages[0]?.items[0]).toBe(data.pages[0]?.items[0]);
    expect(out.pages[0]?.items[1]).toBe(data.pages[0]?.items[1]);
  });

  it('returns the same data when the row is already read or not present', () => {
    const data = pages();
    expect(markReadInPages(data, 'b', '2026-11-01T12:00:00.000Z')).toBe(data);
    expect(markReadInPages(data, 'ghost', '2026-11-01T12:00:00.000Z')).toBe(data);
  });

  it('never takes unreadCount below zero', () => {
    const data = pages();
    data.pages[0]!.unreadCount = 0;
    expect(markReadInPages(data, 'a', '2026-11-01T12:00:00.000Z').pages[0]?.unreadCount).toBe(0);
  });
});
