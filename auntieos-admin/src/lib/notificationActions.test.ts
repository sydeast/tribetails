import { describe, it, expect } from 'vitest';
import {
  applicableNotificationActions,
  notificationQuoteRoute,
  notificationTargetRoute,
} from './notificationActions';
import { type NotificationEntry } from '../api/notifications';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', ...over };
}

describe('notificationTargetRoute', () => {
  it('routes an invoice notification to the Invoices detail', () => {
    expect(notificationTargetRoute('invoice', 'inv_1')).toEqual({
      to: '/invoices',
      search: { invoiceId: 'inv_1' },
    });
  });

  it('routes a kintale notification to the KinTale detail', () => {
    expect(notificationTargetRoute('kintale', 'tale_1')).toEqual({
      to: '/kintales',
      search: { kinTaleId: 'tale_1' },
    });
  });

  it('routes a kinfolk notification to /directory/{id}', () => {
    expect(notificationTargetRoute('kinfolk', 'k_1')).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'k_1' },
    });
  });

  // ISSUE #389, the booking half. This used to drop the id and land on the
  // Bookings LIST, on the reasoning that an envelope visit id and a flat session
  // id were unbridgeable. They are bridged deterministically: the session doc is
  // minted at `vis_{visitId}`.
  it('routes a booking notification to the booking itself, bridging the two id spaces', () => {
    expect(notificationTargetRoute('booking', 'b_1')).toEqual({
      to: '/bookings',
      search: { bookingId: 'vis_b_1' },
    });
  });

  it('leaves a targetId that is ALREADY a flat session id alone', () => {
    // The dispatcher's resolveTargetRef accepts `data.bookingId` as well as
    // `data.visitId`, and those are not always the same id space, so the
    // derivation has to be idempotent or it would double the prefix.
    expect(notificationTargetRoute('booking', 'vis_b_1')).toEqual({
      to: '/bookings',
      search: { bookingId: 'vis_b_1' },
    });
  });

  it('returns null for an UNKNOWN targetType, so no dead Open button is offered', () => {
    expect(notificationTargetRoute('payout', 'p_1')).toBeNull();
    expect(notificationTargetRoute('KINCARE', 'x_1')).toBeNull();
  });

  it('returns null for a missing targetType or a blank targetId', () => {
    expect(notificationTargetRoute('', 'x_1')).toBeNull();
    expect(notificationTargetRoute(undefined, 'x_1')).toBeNull();
    expect(notificationTargetRoute('invoice', '')).toBeNull();
    expect(notificationTargetRoute('invoice', '   ')).toBeNull();
    expect(notificationTargetRoute('invoice', undefined)).toBeNull();
  });
});

describe('notificationQuoteRoute', () => {
  it('seeds the Invoices quote composer with the household id', () => {
    expect(notificationQuoteRoute('k_1')).toEqual({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'k_1' },
    });
  });

  it('is null without a household, so the button is never offered', () => {
    expect(notificationQuoteRoute('')).toBeNull();
    expect(notificationQuoteRoute(undefined)).toBeNull();
  });
});

describe('applicableNotificationActions', () => {
  it('offers Open for each navigable target type', () => {
    for (const targetType of ['invoice', 'kintale', 'kinfolk', 'booking']) {
      expect(applicableNotificationActions(entry({ targetType, targetId: 't1' })).open).not.toBeNull();
    }
  });

  it('offers NO Open for an unknown targetType', () => {
    expect(applicableNotificationActions(entry({ targetType: 'payout', targetId: 'p1' })).open).toBeNull();
  });

  it('offers NO Open for a missing targetType', () => {
    expect(applicableNotificationActions(entry({ targetId: 'p1' })).open).toBeNull();
  });

  it('offers approve/deny ONLY for a booking target', () => {
    expect(applicableNotificationActions(entry({ targetType: 'booking', targetId: 'b1' })).bookingId).toBe(
      'b1',
    );
    expect(
      applicableNotificationActions(entry({ targetType: 'invoice', targetId: 'i1' })).bookingId,
    ).toBe('');
  });

  it('offers Create quote whenever a household is identifiable, by target OR by data', () => {
    expect(applicableNotificationActions(entry({ targetType: 'kinfolk', targetId: 'k1' })).quote).toEqual({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'k1' },
    });
    // An invoice notification that names its household still knows whom to quote.
    expect(
      applicableNotificationActions(entry({ targetType: 'invoice', targetId: 'i1', data: { kinfolkId: 'k9' } }))
        .quote,
    ).toEqual({ to: '/invoices', search: { composeQuoteForKinfolkId: 'k9' } });
  });

  it('offers NO Create quote when no household can be identified', () => {
    expect(applicableNotificationActions(entry({ targetType: 'kintale', targetId: 't1' })).quote).toBeNull();
  });
});
