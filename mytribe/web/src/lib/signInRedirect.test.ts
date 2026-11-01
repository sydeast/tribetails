import { describe, expect, it } from 'vitest';
import { safeRedirectPath, signInSearch, signInSearchFor } from './signInRedirect';
describe('safeRedirectPath (#1384)', () => {
  it.each([
    '/invites/abc',
    '/home',
    '/bookings?bookingId=b1',
    '/directory/k1?section=unapplied-payments&paymentId=p1#top',
    '/schedule/v1',
  ])('keeps the in-app path %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });
  it.each([
    ['an absolute URL', 'https://evil.example/home'],
    ['an http URL', 'http://evil.example'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash host', '/\\evil.example'],
    ['a javascript URI', 'javascript:alert(1)'],
    ['a data URI', 'data:text/html,hi'],
    ['a relative path', 'invites/abc'],
    ['an empty string', ''],
    ['a tab-smuggled host', '/\t/evil.example'],
    ['a newline', '/home\n//evil.example'],
    ['a space before a slash', '/ /evil.example'],
    ['the sign-in screen itself', '/signin'],
    ['the sign-in screen with a query', '/signin?redirect=/home'],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['/home']],
  ])('refuses %s', (_label, value) => {
    expect(safeRedirectPath(value)).toBeNull();
  });
});
describe('signInSearchFor', () => {
  it('carries path, search and hash', () => {
    expect(signInSearchFor({ pathname: '/bookings', searchStr: '?bookingId=b1', hash: 'x' })).toEqual({
      redirect: '/bookings?bookingId=b1#x',
    });
  });
  it('carries nothing for the bare root', () => {
    expect(signInSearchFor({ pathname: '/' })).toEqual({});
  });
  it('carries nothing for /signin itself', () => {
    expect(signInSearchFor({ pathname: '/signin', searchStr: '?redirect=/home' })).toEqual({});
  });
});
describe('signInSearch (the /signin validateSearch)', () => {
  it('keeps a safe redirect', () => {
    expect(signInSearch({ redirect: '/invites/abc' })).toEqual({ redirect: '/invites/abc' });
  });
  it('drops an unsafe or missing redirect', () => {
    expect(signInSearch({ redirect: '//evil.example' })).toEqual({});
    expect(signInSearch({ redirect: 'https://evil.example' })).toEqual({});
    expect(signInSearch({})).toEqual({});
  });
});
