import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, TRIBETAILS_CORS } from './cors';
describe('TRIBETAILS_CORS', () => {
  it.each([
    'https://auntie.tribetails.com',
    'https://kinfolk.tribetails.com',
    'https://tribetails.com',
    'https://auntieos-ttpc.web.app',
    'https://auntieos-ttpc.firebaseapp.com',
    'https://mytribe-kinfolk-beta.web.app',
    'http://localhost',
    'http://localhost:5173',
    'https://kinfolk-portal.web.app',
    'https://kinfolk-portal.firebaseapp.com',
    'https://kinfolk-portal--main-qsqq9kok.web.app',
    'https://kinfolk-portal--pr-1791-ab12cd34.web.app',
    'https://auntieos-ttpc--main-x1y2z3w4.web.app',
  ])('accepts %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });
  it.each([
    'https://kinfolk-portal--x.web.app.evil.com',
    'https://evilkinfolk-portal--x.web.app',
    'https://evil.com/https://kinfolk-portal--x.web.app',
    'http://kinfolk-portal--x.web.app',
    'https://other-site--x.web.app',
    'https://kinfolk-portal--x.web.app/',
    'https://kinfolk-portal--x.web.app/path',
    'https://kinfolk-portal--x.web.app:8443',
    'https://kinfolk-portal--.evil.com',
    'https://kinfolk-portal--x.y.web.app',
    'https://kinfolk-portal--X.web.app',
    'https://kinfolk-portal.web.app.evil.com',
    'https://sub.kinfolk-portal.web.app',
    'https://evil.com',
    '',
  ])('refuses %j', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });
  it('is never a wildcard', () => {
    expect(TRIBETAILS_CORS).not.toContain('*');
  });
});
