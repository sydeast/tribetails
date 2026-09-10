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

  // ISSUE #706. `kincare.requested` ("Kinfolk requested a KinCare visit",
  // mytribe/functions/src/notifications/catalog.ts) is the ONE catalog key that
  // fires when a booking is freshly asked for and nothing has ruled on it yet
  // (onBookingEnvelopeCreate.ts, fired once per request). That is the pendency
  // signal: the notification doc carries no live visit status to re-check, so
  // Approve/Deny is scoped to the event that means "this needs a decision"
  // rather than to every booking-flavoured row. batchUpdateBookings APPROVE/
  // REJECT is also the wrong callable for a reschedule ask (resolved through
  // resolveBookingRescheduleRequest) or a cancellation ask (resolved through
  // the #438 accept/decline path), so those two keys are excluded even though
  // they are also booking-targeted and also pending an answer. A stale
  // Approve/Deny on an already-decided request still fails loud: `bookingAction`
  // in Notifications.tsx surfaces batchUpdateBookings' `failed[]` / `updated
  // === 0` in the error banner rather than pretending the click worked.
  describe('Approve/Deny (bookingId)', () => {
    it.each([
      ['kincare.requested', 'booking', 'b1', 'b1'],
      ['kincare.reschedule.requested', 'booking', 'b1', ''],
      ['kincare.cancel.requested', 'booking', 'b1', ''],
      ['kincare.request.declined', 'booking', 'b1', ''],
      ['kincare.booking.confirm', 'booking', 'b1', ''],
      ['kincare.booking.cancel', 'booking', 'b1', ''],
      ['kincare.requested', 'invoice', 'i1', ''],
      [undefined, 'booking', 'b1', ''],
    ])('key %s + targetType %s -> bookingId %j', (key, targetType, targetId, expected) => {
      expect(applicableNotificationActions(entry({ key, targetType, targetId })).bookingId).toBe(expected);
    });

    it('offers nothing for a pending booking request with a blank targetId', () => {
      expect(
        applicableNotificationActions(entry({ key: 'kincare.requested', targetType: 'booking', targetId: '' }))
          .bookingId,
      ).toBe('');
    });
  });

  // Create quote: "a quote, or a booking request that has no invoice" (operator
  // reading, issue #706). `quote.denied` is the household turning a quote down,
  // where a new quote is the natural follow-up; `quote.accepted` is excluded
  // because that quote already became the bill. `kincare.requested` is a fresh
  // ask with nothing billed yet, so it qualifies UNLESS the entry already
  // references an invoice (targetType 'invoice', or `data.invoiceId`), in which
  // case a quote already exists for it. Every case still needs an identifiable
  // household, same as before.
  describe('Create quote', () => {
    it.each([
      ['quote.denied', 'invoice', 'i1', { kinfolkId: 'k9' }, true],
      ['quote.accepted', 'invoice', 'i1', { kinfolkId: 'k9' }, false],
      ['kincare.requested', 'booking', 'b1', { kinfolkId: 'k9' }, true],
      ['kincare.request.declined', 'booking', 'b1', { kinfolkId: 'k9' }, false],
      ['invoice.new', 'invoice', 'i1', { kinfolkId: 'k9' }, false],
      ['assignment.changed', 'kinfolk', 'k9', undefined, false],
      ['kincare.booking.confirm', 'booking', 'b1', { kinfolkId: 'k9' }, false],
    ])('key %s + targetType %s -> quote offered: %s', (key, targetType, targetId, data, offered) => {
      const actions = applicableNotificationActions(entry({ key, targetType, targetId, data }));
      if (offered) {
        expect(actions.quote).toEqual({ to: '/invoices', search: { composeQuoteForKinfolkId: 'k9' } });
      } else {
        expect(actions.quote).toBeNull();
      }
    });

    it('never offers Create quote without an identifiable household, even on a qualifying key', () => {
      expect(
        applicableNotificationActions(entry({ key: 'quote.denied', targetType: 'invoice', targetId: 'i1' }))
          .quote,
      ).toBeNull();
    });

    it('excludes a booking request that already carries an invoice reference in data', () => {
      expect(
        applicableNotificationActions(
          entry({
            key: 'kincare.requested',
            targetType: 'booking',
            targetId: 'b1',
            data: { kinfolkId: 'k9', invoiceId: 'inv_1' },
          }),
        ).quote,
      ).toBeNull();
    });
  });
});
