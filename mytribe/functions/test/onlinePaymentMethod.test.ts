import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  anyTimestamp,
  householdMethodLabelOf,
  ledgerDateText,
  onlineMethodLabel,
  onlineMethodOfCharge,
  paymentDayOf,
  paymentMethodLabelOf,
} from '../src/lib/onlinePaymentMethod';

/**
 * #2334: a checkout payment reads as what it was paid with (Card, Klarna,
 * Affirm, a wallet), an old one reads "Online payment", never "stripe", and
 * the card's ledger row has a day.
 */

describe('onlineMethodOfCharge: what the charge says it was paid with', () => {
  it('a card', () => {
    expect(onlineMethodOfCharge({ payment_method_details: { type: 'card', card: { wallet: null } } })).toBe('card');
  });

  it('Klarna and Affirm', () => {
    expect(onlineMethodOfCharge({ payment_method_details: { type: 'klarna', klarna: {} } })).toBe('klarna');
    expect(onlineMethodOfCharge({ payment_method_details: { type: 'affirm', affirm: {} } })).toBe('affirm');
  });

  it('a card from a wallet is stored as the wallet', () => {
    expect(
      onlineMethodOfCharge({ payment_method_details: { type: 'card', card: { wallet: { type: 'apple_pay' } } } }),
    ).toBe('apple_pay');
    expect(
      onlineMethodOfCharge({ payment_method_details: { type: 'card', card: { wallet: { type: 'google_pay' } } } }),
    ).toBe('google_pay');
  });

  it("Stripe's own 'unknown' wallet is just the card", () => {
    expect(
      onlineMethodOfCharge({ payment_method_details: { type: 'card', card: { wallet: { type: 'unknown' } } } }),
    ).toBe('card');
  });

  it('nothing to read gives null, never a guess', () => {
    expect(onlineMethodOfCharge(null)).toBeNull();
    expect(onlineMethodOfCharge('ch_123')).toBeNull();
    expect(onlineMethodOfCharge({})).toBeNull();
    expect(onlineMethodOfCharge({ payment_method_details: null })).toBeNull();
    expect(onlineMethodOfCharge({ payment_method_details: { type: 42 } })).toBeNull();
    expect(onlineMethodOfCharge({ payment_method_details: { type: 'Not A Key!' } })).toBeNull();
  });
});

describe('paymentMethodLabelOf: the Method cell', () => {
  it('a Stripe payment reads as its actual method', () => {
    expect(paymentMethodLabelOf('stripe', 'card')).toBe('Card');
    expect(paymentMethodLabelOf('stripe', 'klarna')).toBe('Klarna');
    expect(paymentMethodLabelOf('stripe', 'affirm')).toBe('Affirm');
    expect(paymentMethodLabelOf('stripe', 'apple_pay')).toBe('Apple Pay');
    expect(paymentMethodLabelOf('stripe', 'link')).toBe('Link');
  });

  it('an old Stripe row with no stored method reads "Online payment", never "stripe"', () => {
    expect(paymentMethodLabelOf('stripe', undefined)).toBe('Online payment');
    expect(paymentMethodLabelOf('stripe', null)).toBe('Online payment');
    expect(paymentMethodLabelOf('Stripe', '')).toBe('Online payment');
  });

  it('a method Stripe names that has no words here reads "Online payment", never the raw key', () => {
    expect(paymentMethodLabelOf('stripe', 'some_new_rail')).toBe('Online payment');
    expect(onlineMethodLabel('some_new_rail')).toBe('Online payment');
  });

  it('a payment recorded by hand reads as recorded, and a blank stays blank for the client', () => {
    expect(paymentMethodLabelOf('Venmo', undefined)).toBe('Venmo');
    expect(paymentMethodLabelOf('  check ', 'card')).toBe('check');
    expect(paymentMethodLabelOf('', undefined)).toBe('');
    expect(paymentMethodLabelOf(null, undefined)).toBe('');
  });
});

describe('householdMethodLabelOf: the household Payment History', () => {
  it('opens with a capital, and a blank reads "Payment"', () => {
    expect(householdMethodLabelOf('stripe', 'klarna')).toBe('Klarna');
    expect(householdMethodLabelOf('stripe', undefined)).toBe('Online payment');
    expect(householdMethodLabelOf('account credit', undefined)).toBe('Account credit');
    expect(householdMethodLabelOf('venmo', undefined)).toBe('Venmo');
    expect(householdMethodLabelOf(null, undefined)).toBe('Payment');
  });
});

describe('ledgerDateText: the root ledger row date as text', () => {
  // 2026-11-21T02:30:00Z is 8:30 PM on Nov 20 in Chicago.
  const lateEvening = Timestamp.fromMillis(Date.parse('2026-11-21T02:30:00Z'));

  it('a Timestamp reads as its business day, not the UTC one', () => {
    expect(ledgerDateText(lateEvening, 'America/Chicago')).toBe('2026-11-20');
    expect(ledgerDateText(lateEvening, 'UTC')).toBe('2026-11-21');
  });

  it('a plain {_seconds} shape reads the same', () => {
    expect(ledgerDateText({ _seconds: Date.parse('2026-11-21T02:30:00Z') / 1000, _nanoseconds: 0 }, 'America/Chicago')).toBe(
      '2026-11-20',
    );
  });

  it('a zone that cannot be read falls back to the shared default, never drops the day', () => {
    expect(ledgerDateText(lateEvening, 'Not/AZone')).toBe('2026-11-20');
  });

  it('free text passes through untouched, and nothing reads as blank', () => {
    expect(ledgerDateText('February 17, 2026', 'America/Chicago')).toBe('February 17, 2026');
    expect(ledgerDateText(undefined, 'America/Chicago')).toBe('');
    expect(ledgerDateText(12345, 'America/Chicago')).toBe('');
  });

  it('anyTimestamp says when the zone is worth reading', () => {
    expect(anyTimestamp(['February 17, 2026', undefined])).toBe(false);
    expect(anyTimestamp(['2026-11-14', lateEvening])).toBe(true);
  });
});

describe('paymentDayOf: the day on the household Payment History', () => {
  it('an ISO instant is read on the business clock', () => {
    expect(paymentDayOf('2026-11-21T02:30:00.000Z', 'America/Chicago')).toBe('2026-11-20');
  });

  it('a bare day and a zone-less wall clock are already the business day', () => {
    expect(paymentDayOf('2026-11-14', 'America/Chicago')).toBe('2026-11-14');
    expect(paymentDayOf('2026-11-14T21:00', 'America/Chicago')).toBe('2026-11-14');
  });

  it('a Timestamp reads the same way', () => {
    expect(paymentDayOf(Timestamp.fromMillis(Date.parse('2026-11-21T02:30:00Z')), 'America/Chicago')).toBe('2026-11-20');
  });

  it('anything else is null', () => {
    expect(paymentDayOf('', 'America/Chicago')).toBeNull();
    expect(paymentDayOf('February 17, 2026', 'America/Chicago')).toBeNull();
    expect(paymentDayOf(null, 'America/Chicago')).toBeNull();
  });
});
