import { afterEach, describe, expect, it } from 'vitest';
import {
  isPortalReturnUrl,
  requirePortalReturnUrls,
  RETURN_URL_REFUSED_CODE,
} from '../src/lib/cors';

/**
 * #2366: where Stripe may send a household back to after a checkout. Only the
 * MyTribe web portal's own origins, compared on the parsed origin.
 */
describe('isPortalReturnUrl', () => {
  const ORIGINAL = process.env.FUNCTIONS_EMULATOR;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = ORIGINAL;
  });

  it.each([
    'https://kinfolk.tribetails.com/invoices/inv-1?checkout=done',
    'https://kinfolk.tribetails.com/invoices/inv-1',
    'https://kinfolk.tribetails.com/account?billing=saved',
    // An Android build from before #2366: the path is not the server's call.
    'https://kinfolk.tribetails.com/portal/payment-success',
    'https://kinfolk-portal.web.app/invoices/inv-1',
    'https://kinfolk-portal.firebaseapp.com/invoices/inv-1',
    'https://mytribe-kinfolk-beta.web.app/invoices/inv-1',
    'https://kinfolk-portal--main-abc123.web.app/invoices/inv-1',
    'https://kinfolk-portal--pr2366-x1y2z3.web.app/invoices/inv-1?checkout=done',
    // An explicit default port is the same origin.
    'https://kinfolk.tribetails.com:443/invoices/inv-1',
  ])('allows %s', (url) => {
    expect(isPortalReturnUrl(url, { emulator: false })).toBe(true);
  });

  it.each([
    ['a foreign site', 'https://evil.example/invoices/inv-1'],
    ['a lookalike suffix', 'https://kinfolk.tribetails.com.evil.example/invoices/inv-1'],
    ['a lookalike prefix', 'https://evilkinfolk.tribetails.com/invoices/inv-1'],
    ['a user part that hides the real host', 'https://kinfolk.tribetails.com@evil.example/invoices/inv-1'],
    ['a user part on the real host', 'https://someone@kinfolk.tribetails.com/invoices/inv-1'],
    ['plain http on the real host', 'http://kinfolk.tribetails.com/invoices/inv-1'],
    ['another port on the real host', 'https://kinfolk.tribetails.com:8443/invoices/inv-1'],
    ['the admin site', 'https://auntie.tribetails.com/invoices/inv-1'],
    ['the apex domain', 'https://tribetails.com/invoices/inv-1'],
    ['a preview channel of the admin site', 'https://auntieos-ttpc--main-abc.web.app/invoices/inv-1'],
    ['a lookalike preview channel', 'https://kinfolk-portal--x.web.app.evil.example/invoices/inv-1'],
    ['a custom scheme', 'mytribe://invoice/inv-1'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    ['a relative path', '/invoices/inv-1'],
    ['an empty string', ''],
  ])('refuses %s', (_why, url) => {
    expect(isPortalReturnUrl(url, { emulator: false })).toBe(false);
  });

  it('refuses a loopback address outside the Functions emulator', () => {
    delete process.env.FUNCTIONS_EMULATOR;
    expect(isPortalReturnUrl('http://127.0.0.1:5173/invoices/inv-1')).toBe(false);
    expect(isPortalReturnUrl('http://localhost:5173/invoices/inv-1')).toBe(false);
  });

  it('allows the local portal under the Functions emulator, where the e2e suites run', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    expect(isPortalReturnUrl('http://127.0.0.1:5173/invoices/inv-1?checkout=done')).toBe(true);
    expect(isPortalReturnUrl('http://localhost:5173/invoices/inv-1')).toBe(true);
    expect(isPortalReturnUrl('http://localhost/invoices/inv-1')).toBe(true);
  });

  it('still refuses a foreign site and a loopback lookalike under the emulator', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    expect(isPortalReturnUrl('https://evil.example/invoices/inv-1')).toBe(false);
    expect(isPortalReturnUrl('http://localhost.evil.example/invoices/inv-1')).toBe(false);
    expect(isPortalReturnUrl('http://127.0.0.1.evil.example/invoices/inv-1')).toBe(false);
  });
});

describe('requirePortalReturnUrls', () => {
  const OK = 'https://kinfolk.tribetails.com/invoices/inv-1';

  it('passes when both addresses are portal addresses', () => {
    expect(() => requirePortalReturnUrls({ successUrl: `${OK}?checkout=done`, cancelUrl: OK })).not.toThrow();
  });

  it.each([
    ['the success address', { successUrl: 'https://evil.example/ok', cancelUrl: OK }],
    ['the cancel address', { successUrl: OK, cancelUrl: 'https://evil.example/no' }],
  ])('refuses as invalid-argument when %s is foreign', (_why, urls) => {
    expect(() => requirePortalReturnUrls(urls)).toThrow(
      expect.objectContaining({ code: 'invalid-argument', details: { code: RETURN_URL_REFUSED_CODE } }),
    );
  });
});
