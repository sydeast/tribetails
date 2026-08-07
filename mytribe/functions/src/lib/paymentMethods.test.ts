import { describe, it, expect } from 'vitest';
import { resolvePayMethods, type InvoiceDto } from './paymentMethods';

/**
 * PR30: the payment method registry. Operator, 2026-08-06: three CTAs now,
 * "but build out for other more payment options" — so this resolves a
 * configured LIST off `business_settings`, not three hardcoded buttons.
 *
 * `invoice()` only ever needs `amountDue` (cents): resolvePayMethods offers
 * nothing once a bill is settled, and that is the one field it reads off the
 * invoice. See `paymentMethods.ts` for why this is NOT the portal's dollars-
 * float `InvoiceDto` from `getMyInvoices.ts`.
 */
function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return { amountDue: 12750, ...overrides };
}

describe('resolvePayMethods', () => {
  it('omits a method whose handle is blank rather than rendering a dead button', () => {
    const out = resolvePayMethods(
      { venmoHandle: '', paypalHandle: 'auntie', cashappHandle: '' },
      invoice(),
    );
    expect(out.map((m) => m.id)).toEqual(['stripe', 'paypal']);
  });

  it('normalizes a handle written any of the three ways an operator writes it', () => {
    for (const raw of ['auntie', '@auntie', 'https://venmo.com/u/auntie']) {
      const [venmo] = resolvePayMethods({ venmoHandle: raw }, invoice()).filter((m) => m.id === 'venmo');
      expect(venmo.url).toBe('https://venmo.com/u/auntie');
    }
  });

  it('supports Cash App, which settings already carries', () => {
    const out = resolvePayMethods({ cashappHandle: '$auntie' }, invoice());
    expect(out.find((m) => m.id === 'cashapp')?.url).toBe('https://cash.app/$auntie');
  });

  it('always offers Stripe, which needs no handle', () => {
    expect(resolvePayMethods({}, invoice()).map((m) => m.id)).toEqual(['stripe']);
  });

  it('offers nothing on a settled invoice', () => {
    expect(resolvePayMethods({ venmoHandle: 'auntie' }, invoice({ amountDue: 0 }))).toEqual([]);
  });

  it('offers nothing on an invoice already in credit (negative amountDue)', () => {
    // getMyInvoices documents negative amountDue as the credit signal, not a
    // bill. A "Pay with Venmo" button on a credit invoice is the exact dead
    // button this registry exists to prevent.
    expect(resolvePayMethods({ venmoHandle: 'auntie' }, invoice({ amountDue: -500 }))).toEqual([]);
  });

  it('omits PayPal for an email-form handle rather than building paypal.me/you@email.com', () => {
    // The admin field's own placeholder text is "you@email.com or
    // paypal.me/tribetails". An email is a real PayPal identifier, but
    // paypal.me only resolves a paypal.me USERNAME — appending an email to
    // that base is a 404 with a bill attached, not a working link.
    const out = resolvePayMethods({ paypalHandle: 'auntie@example.com' }, invoice());
    expect(out.map((m) => m.id)).toEqual(['stripe']);
  });

  it('returns Stripe as a checkout method with no url, and link methods with a url', () => {
    const out = resolvePayMethods({ venmoHandle: 'auntie' }, invoice());
    expect(out).toEqual([
      { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null },
      { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie' },
    ]);
  });
});
