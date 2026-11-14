import { describe, it, expect } from 'vitest';
import {
  applicableNotificationActions,
  notificationRequestRoute,
  notificationOpenRoute,
  notificationQuoteRoute,
  notificationTargetRoute,
  requestOutcomeLabel,
} from './notificationActions';
import { type NotificationEntry } from '../api/notifications';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', ...over };
}

/**
 * #2069: the live queue of waiting booking requests. A request row is offered
 * as waiting only when this holds its household and batch, so the cases below
 * that mean "a request still waiting" pass one.
 */
const WAITING = new Set(['kf1/b1', 'kf1/req_1', 'k9/b1', 'k9/req_1']);

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
  // rather than to every booking-flavoured row. Since #1675 they answer the
  // whole request through manageBookingSeries, which is the wrong callable for
  // a reschedule ask (resolved through resolveBookingRescheduleRequest) or a
  // cancellation ask (resolved through the #438 accept/decline path), so those
  // two keys are excluded even though they are also booking-targeted and also
  // pending an answer. A refusal still fails loud: `bookingAction` in
  // Notifications.tsx shows the server's sentence in the error banner.
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
      // Every request row names its household (onBookingEnvelopeCreate writes data.kinfolkId).
      const data = { kinfolkId: 'kf1' };
      expect(
        applicableNotificationActions(entry({ key, targetType, targetId, data }), { pendingRequests: WAITING }).bookingId,
      ).toBe(expected);
    });
    // #1675: Approve/Deny answer the request through manageBookingSeries, which
    // needs the household as well as the request id.
    it('offers nothing for a waiting request that names no household', () => {
      expect(
        applicableNotificationActions(entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1' }))
          .bookingId,
      ).toBe('');
    });

    // #1647: the server stamps `requestResolution` on a request's rows once it
    // is booked or declined anywhere. An answered request offers no decision.
    it.each([['booked'], ['declined'], ['cancelled'], ['something-new']])(
      'offers no Approve/Deny once the request is answered (%s)',
      (requestResolution) => {
        expect(
          applicableNotificationActions(
            entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' }, requestResolution }),
            { pendingRequests: WAITING },
          ).bookingId,
        ).toBe('');
      },
    );
    it('a blank stamp is still waiting', () => {
      expect(
        applicableNotificationActions(
          entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' }, requestResolution: ' ' }),
          { pendingRequests: WAITING },
        ).bookingId,
      ).toBe('req_1');
    });
    it('offers nothing for a pending booking request with a blank targetId', () => {
      expect(
        applicableNotificationActions(entry({ key: 'kincare.requested', targetType: 'booking', targetId: '', data: { kinfolkId: 'kf1' } }))
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
      const actions = applicableNotificationActions(entry({ key, targetType, targetId, data }), {
        pendingRequests: WAITING,
      });
      if (offered) {
        expect(actions.quote).toEqual({ to: '/invoices', search: { composeQuoteForKinfolkId: 'k9' } });
      } else {
        expect(actions.quote).toBeNull();
      }
    });

    it('drops Create quote once the request is answered: it is no longer a fresh ask (#1647)', () => {
      expect(
        applicableNotificationActions(
          entry({
            key: 'kincare.requested',
            targetType: 'booking',
            targetId: 'req_1',
            data: { kinfolkId: 'k9' },
            requestResolution: 'booked',
          }),
        ).quote,
      ).toBeNull();
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

describe('notificationOpenRoute: invoice.payment.unapplied (#1003)', () => {
  const unapplied = (data: Record<string, unknown>) =>
    entry({ key: 'invoice.payment.unapplied', targetType: 'invoice', targetId: 'inv_9', data });

  it('opens the HOUSEHOLD profile on the decision list with the payment named', () => {
    const route = {
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'fam1' },
      search: { section: 'unapplied-payments', paymentId: 'evt_123' },
    };
    const e = unapplied({ kinfolkId: 'fam1', invoiceId: 'inv_9', stripeEventId: 'evt_123' });
    expect(notificationOpenRoute(e)).toEqual(route);
    expect(applicableNotificationActions(e).open).toEqual(route);
  });

  it('still opens the list when the notice carries no payment id', () => {
    expect(notificationOpenRoute(unapplied({ kinfolkId: 'fam1', invoiceId: 'inv_9' }))).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'fam1' },
      search: { section: 'unapplied-payments' },
    });
  });

  it('falls back to the invoice when no household is named', () => {
    expect(notificationOpenRoute(unapplied({ stripeEventId: 'evt_123' }))).toEqual({
      to: '/invoices',
      search: { invoiceId: 'inv_9' },
    });
  });

  it('leaves every other invoice key on the invoice', () => {
    const e = entry({ key: 'invoice.paid', targetType: 'invoice', targetId: 'inv_9', data: { kinfolkId: 'fam1' } });
    expect(notificationOpenRoute(e)).toEqual({ to: '/invoices', search: { invoiceId: 'inv_9' } });
  });
});

describe('notificationOpenRoute: kin.removal.requested (#1912)', () => {
  const removal = (data: Record<string, unknown>) =>
    entry({ key: 'kin.removal.requested', targetType: 'kinfolk', targetId: 'fam1', data });
  it('opens the removal queue on Bookings with the request named', () => {
    const route = { to: '/bookings', search: { kinRemoval: 'fam1_k1' } };
    const e = removal({ kinfolkId: 'fam1', kinId: 'k1', flatKinId: 'flat1', requestId: 'fam1_k1' });
    expect(notificationOpenRoute(e)).toEqual(route);
    expect(applicableNotificationActions(e).open).toEqual(route);
  });
  it('a Kin with no admin record yet still opens the queue', () => {
    expect(notificationOpenRoute(removal({ kinfolkId: 'fam1', kinId: 'k1', flatKinId: null, requestId: 'fam1_k1' }))).toEqual({
      to: '/bookings',
      search: { kinRemoval: 'fam1_k1' },
    });
  });
  it('falls back to the household when the notice names no request', () => {
    expect(notificationOpenRoute(removal({ kinfolkId: 'fam1' }))).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'fam1' },
    });
  });
  it('the answers the household hears keep their own target', () => {
    const e = entry({ key: 'kin.removal.declined', targetType: 'kinfolk', targetId: 'fam1', data: { requestId: 'fam1_k1' } });
    expect(notificationOpenRoute(e)).toEqual({ to: '/directory/$kinfolkId', params: { kinfolkId: 'fam1' } });
  });
});
describe('requestOutcomeLabel (#1647)', () => {
  it.each([
    ['booked', 'Booked'],
    ['declined', 'Declined'],
    ['cancelled', 'Cancelled'],
    ['BOOKED', 'Booked'],
    ['something-new', 'Answered'],
  ])('%s reads %s', (requestResolution, label) => {
    const e = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' }, requestResolution });
    expect(requestOutcomeLabel(e)).toBe(label);
    expect(applicableNotificationActions(e).outcome).toBe(label);
  });
  it('is null while the request is waiting', () => {
    expect(requestOutcomeLabel(entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } }))).toBeNull();
  });
  it('is null on every other key, stamp or not', () => {
    expect(
      requestOutcomeLabel(entry({ key: 'kincare.booking.confirm', targetType: 'booking', requestResolution: 'booked' })),
    ).toBeNull();
  });
});

/**
 * #2200 / #2201: Invoices is the owner's screen, and its address sends an
 * Auntie Home. A notice row must not offer her an Open or Create quote that
 * only does that, so both drop for her. Her own routes (a booking, a KinTale,
 * a household) stay, and so does Approve / Deny, which the "Needs a decision"
 * count is derived from.
 */
describe('applicableNotificationActions for an Auntie (#2200 / #2201)', () => {
  const request = entry({
    key: 'kincare.requested',
    targetType: 'booking',
    targetId: 'req_1',
    data: { kinfolkId: 'kf1' },
  });

  it('gives her no Open on an invoice notice, and keeps it for everyone else', () => {
    const e = entry({ key: 'invoice.paid', targetType: 'invoice', targetId: 'inv_1' });
    expect(applicableNotificationActions(e, { isAuntie: true }).open).toBeNull();
    expect(applicableNotificationActions(e).open).toEqual({ to: '/invoices', search: { invoiceId: 'inv_1' } });
    expect(applicableNotificationActions(e, { isAuntie: false }).open).not.toBeNull();
  });

  it('gives her no Create quote on a fresh request, and keeps her Approve / Deny and Open', () => {
    const forHer = applicableNotificationActions(request, { isAuntie: true, pendingRequests: WAITING });
    expect(forHer.quote).toBeNull();
    expect(forHer.bookingId).toBe('req_1');
    // #2028: Open lands on the request's card, which is hers to answer.
    expect(forHer.open).toEqual({ to: '/bookings', search: { requestId: 'req_1', requestKinfolkId: 'kf1' } });
    expect(applicableNotificationActions(request, { pendingRequests: WAITING }).quote).toEqual({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'kf1' },
    });
  });

  it('keeps her Open on a KinTale and a household notice', () => {
    for (const [targetType, targetId] of [
      ['kintale', 'kt_1'],
      ['kinfolk', 'kf_1'],
    ] as const) {
      expect(applicableNotificationActions(entry({ targetType, targetId }), { isAuntie: true }).open).not.toBeNull();
    }
  });
});
/**
 * #2208: the "Payment needing a decision" notice (`invoice.payment.unapplied`)
 * opens the household's Account credit section, which is money and is not
 * drawn for an Auntie. Her row offers no Open at all, with or without a
 * household on the notice; the owner keeps the profile deep link.
 */
describe('applicableNotificationActions: the payment decision notice for an Auntie (#2208)', () => {
  const withHousehold = entry({
    key: 'invoice.payment.unapplied',
    targetType: 'invoice',
    targetId: 'inv_9',
    data: { kinfolkId: 'kf1', stripeEventId: 'evt_1' },
  });
  const withoutHousehold = entry({ key: 'invoice.payment.unapplied', targetType: 'invoice', targetId: 'inv_9' });
  const onHousehold = entry({ key: 'invoice.payment.unapplied', targetType: 'kinfolk', targetId: 'kf1' });
  it('gives her no Open, whichever way the notice names its household', () => {
    for (const e of [withHousehold, withoutHousehold, onHousehold]) {
      expect(applicableNotificationActions(e, { isAuntie: true }).open).toBeNull();
    }
  });
  it('keeps the owner on the Account credit section of the household', () => {
    expect(applicableNotificationActions(withHousehold).open).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf1' },
      search: { section: 'unapplied-payments', paymentId: 'evt_1' },
    });
    expect(applicableNotificationActions(onHousehold, { isAuntie: false }).open).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf1' },
      search: { section: 'unapplied-payments' },
    });
    expect(applicableNotificationActions(withoutHousehold).open).toEqual({
      to: '/invoices',
      search: { invoiceId: 'inv_9' },
    });
  });
  it('still opens her own household notices', () => {
    const e = entry({ key: 'kinfolk.updated', targetType: 'kinfolk', targetId: 'kf1' });
    expect(applicableNotificationActions(e, { isAuntie: true }).open).toEqual({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf1' },
    });
  });
});

/**
 * #2069: the walk's August rows offered Approve and Deny three months after
 * their visits were booked, because #1647 read "no stamp" as "still waiting"
 * and rows from before the stamp never got one. "Needs a decision" read 19
 * against Bookings' 5. Pendency now needs the live queue to hold the request.
 */
describe('a request is waiting only when the live queue holds it (#2069)', () => {
  const august = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_old', data: { kinfolkId: 'kf1' } });
  const fresh = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } });

  it('offers no Approve, Deny or Create quote on an unstamped row the queue does not hold', () => {
    const a = applicableNotificationActions(august, { pendingRequests: WAITING });
    expect(a.bookingId).toBe('');
    expect(a.quote).toBeNull();
    expect(a.outcome).toBe('Answered');
    expect(a.open).not.toBeNull();
  });

  it('offers them on the request the queue holds', () => {
    const a = applicableNotificationActions(fresh, { pendingRequests: WAITING });
    expect(a.bookingId).toBe('req_1');
    expect(a.outcome).toBeNull();
    expect(a.awaitingQueue).toBe(false);
  });

  it('matches on the household too: the same batch id in another household is not this request', () => {
    const other = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf2' } });
    expect(applicableNotificationActions(other, { pendingRequests: WAITING }).bookingId).toBe('');
  });

  it('offers nothing as waiting while the queue has not read, and says it is checking', () => {
    for (const ctx of [{}, { pendingRequests: null }]) {
      const a = applicableNotificationActions(fresh, ctx);
      expect(a.bookingId).toBe('');
      expect(a.quote).toBeNull();
      expect(a.outcome).toBeNull();
      expect(a.awaitingQueue).toBe(true);
      // Open still goes to the request's card, where it can be answered.
      expect(a.open).toEqual(notificationRequestRoute('kf1', 'req_1'));
    }
  });

  it('keeps the server stamp as the outcome, queue or not', () => {
    const booked = entry({ ...fresh, requestResolution: 'booked' });
    expect(applicableNotificationActions(booked, { pendingRequests: WAITING }).outcome).toBe('Booked');
    expect(applicableNotificationActions(booked).outcome).toBe('Booked');
    expect(applicableNotificationActions(booked).awaitingQueue).toBe(false);
  });

  it('gives a stale request the same Open it had: an old row may carry a visit id', () => {
    expect(applicableNotificationActions(august, { pendingRequests: WAITING }).open).toEqual({
      to: '/bookings',
      search: { bookingId: 'vis_req_old' },
    });
  });
});

/**
 * #2028: Open on a "Kinfolk requested a KinCare visit" row went to
 * `/bookings?bookingId=vis_{batchId}`, a session that does not exist until the
 * request is booked, and showed "Booking unavailable".
 */
describe('Open on a booking request goes to its card (#2028)', () => {
  const fresh = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } });

  it('routes a waiting request to its card, by household and request', () => {
    expect(applicableNotificationActions(fresh, { pendingRequests: WAITING }).open).toEqual({
      to: '/bookings',
      search: { requestId: 'req_1', requestKinfolkId: 'kf1' },
    });
  });

  it('routes a stamped request there too, where the queue says it is no longer waiting', () => {
    const declined = entry({ ...fresh, requestResolution: 'declined' });
    expect(applicableNotificationActions(declined, { pendingRequests: WAITING }).open).toEqual(
      notificationRequestRoute('kf1', 'req_1'),
    );
  });

  it('keeps the target table for a row that names no household', () => {
    const anon = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1' });
    expect(applicableNotificationActions(anon, { pendingRequests: WAITING }).open).toEqual({
      to: '/bookings',
      search: { bookingId: 'vis_req_1' },
    });
  });
});
