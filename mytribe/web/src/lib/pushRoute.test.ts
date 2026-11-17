import { describe, expect, it } from 'vitest';
import { pushClickUrl } from './pushRoute';
import { safeRedirectPath } from './signInRedirect';

const ORIGIN = 'https://kinfolk.tribetails.com';

describe('pushClickUrl (#2259)', () => {
  it.each([
    ['/schedule/v1', `${ORIGIN}/schedule/v1`],
    ['/schedule', `${ORIGIN}/schedule`],
    ['/kintales?tale=t1', `${ORIGIN}/kintales?tale=t1`],
    ['/kintales', `${ORIGIN}/kintales`],
    ['/invoices/inv1', `${ORIGIN}/invoices/inv1`],
    ['/kin/k1', `${ORIGIN}/kin/k1`],
    ['/kin', `${ORIGIN}/kin`],
    ['/tribe', `${ORIGIN}/tribe`],
    ['/messages', `${ORIGIN}/messages`],
    ['/notifications', `${ORIGIN}/notifications`],
    ['/notifications?entry=n1', `${ORIGIN}/notifications?entry=n1`],
  ])('opens %s, the thing the notice is about', (route, url) => {
    expect(pushClickUrl(route, ORIGIN)).toBe(url);
  });

  it.each([
    ['an absolute address', 'https://evil.example/schedule/v1'],
    ['a protocol-relative address', '//evil.example/schedule/v1'],
    ['a backslash address', '/\\evil.example/schedule/v1'],
    ['a javascript: target', 'javascript:alert(1)'],
    ['a data: target', 'data:text/html,<script>alert(1)</script>'],
    ['a link into another app', 'venmo://paycharge?recipients=x'],
    ['an intent link', 'intent://scan/#Intent;scheme=zxing;end'],
    ['the portal host on plain http', 'http://kinfolk.tribetails.com/schedule/v1'],
    ['a lookalike host', 'https://kinfolk.tribetails.com.evil.example/'],
  ])('refuses %s and opens Home', (_label, route) => {
    expect(pushClickUrl(route, ORIGIN)).toBe(`${ORIGIN}/home`);
  });

  it.each([undefined, null, '', '   ', 42, {}, ['/schedule/v1']])('a push with no usable route (%j) opens Home', (route) => {
    expect(pushClickUrl(route, ORIGIN)).toBe(`${ORIGIN}/home`);
  });

  it('an id the server percent-encoded stays inside its path part', () => {
    const url = new URL(pushClickUrl('/schedule/https%3A%2F%2Fevil.example%2Fx', ORIGIN));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/schedule/https%3A%2F%2Fevil.example%2Fx');
  });

  it('every route the server builds also survives the sign-in redirect, so a signed-out tap opens it after sign-in', () => {
    for (const route of ['/schedule/v1', '/schedule', '/kintales?tale=t1', '/kintales', '/invoices/inv1', '/kin/k1', '/kin', '/tribe', '/messages', '/notifications', '/notifications?entry=n1']) {
      expect(safeRedirectPath(route), route).toBe(route);
    }
  });
});
