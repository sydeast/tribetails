// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  appInvoiceLink,
  cameBackFromCheckout,
  checkoutReturnUrls,
  dropCheckoutMarker,
  webInvoiceHref,
} from './checkoutReturn';

/**
 * #2400, #2401: one place builds the addresses Stripe sends a household back
 * to, and one place reads the marker, so no Pay button can send its own.
 */
describe('checkoutReturnUrls', () => {
  it('puts the marker on the success address only', () => {
    expect(checkoutReturnUrls('https://kinfolk.tribetails.com', 'inv-1')).toEqual({
      successUrl: 'https://kinfolk.tribetails.com/invoices/inv-1?checkout=done',
      cancelUrl: 'https://kinfolk.tribetails.com/invoices/inv-1',
    });
  });

  it('encodes an id that would otherwise change the path or the query', () => {
    const { successUrl, cancelUrl } = checkoutReturnUrls('https://kinfolk.tribetails.com', 'a/b?c=d#e f');
    expect(cancelUrl).toBe('https://kinfolk.tribetails.com/invoices/a%2Fb%3Fc%3Dd%23e%20f');
    expect(new URL(successUrl).pathname).toBe('/invoices/a%2Fb%3Fc%3Dd%23e%20f');
    expect(new URL(successUrl).search).toBe('?checkout=done');
  });
});

describe('cameBackFromCheckout', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('is true for exactly checkout=done', () => {
    window.history.replaceState(null, '', '/invoices/inv-1?checkout=done');
    expect(cameBackFromCheckout()).toBe(true);
  });

  it.each([
    ['no marker', '/invoices/inv-1'],
    ['another value', '/invoices/inv-1?checkout=cancelled'],
    ['an empty value', '/invoices/inv-1?checkout='],
    ['a different case', '/invoices/inv-1?checkout=DONE'],
    ['a lookalike key', '/invoices/inv-1?checkouts=done'],
  ])('is false for %s', (_why, path) => {
    window.history.replaceState(null, '', path);
    expect(cameBackFromCheckout()).toBe(false);
  });
});

describe('dropCheckoutMarker', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('removes the marker and keeps the rest of the address', () => {
    window.history.replaceState(null, '', '/invoices/inv-1?checkout=done&from=email#totals');
    dropCheckoutMarker();
    expect(window.location.pathname).toBe('/invoices/inv-1');
    expect(window.location.search).toBe('?from=email');
    expect(window.location.hash).toBe('#totals');
  });

  it('leaves an address without the marker alone', () => {
    window.history.replaceState(null, '', '/invoices/inv-1?from=email');
    dropCheckoutMarker();
    expect(window.location.search).toBe('?from=email');
  });
});

describe('the links on the app return page (#2401)', () => {
  it("opens the app's own invoice link, with the marker only after a finished checkout", () => {
    expect(appInvoiceLink('inv-1', true)).toBe('mytribe://invoices/inv-1?checkout=done');
    expect(appInvoiceLink('inv-1', false)).toBe('mytribe://invoices/inv-1');
    expect(appInvoiceLink('INV 2027/1', true)).toBe('mytribe://invoices/INV%202027%2F1?checkout=done');
  });

  it('keeps the marker on the web invoice link, so that page checks the payment too', () => {
    expect(webInvoiceHref('inv-1', true)).toBe('/invoices/inv-1?checkout=done');
    expect(webInvoiceHref('inv-1', false)).toBe('/invoices/inv-1');
    expect(webInvoiceHref('INV 2027/1', true)).toBe('/invoices/INV%202027%2F1?checkout=done');
  });
});
