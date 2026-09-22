import { describe, expect, it } from 'vitest';
import { parseEmailActionLink, safeContinueUrl } from './emailAction';

/**
 * #892. The project's email action URL (Identity Toolkit `callbackUri`) is
 * https://kinfolk.tribetails.com/account/secure-reset, so EVERY Firebase auth
 * email lands on that page: native resets from admin web, admin Android, admin
 * desktop and portal web, the custom `requestPasswordReset` email, email
 * verification and email-change links. The parser used to demand an `email`
 * param no Firebase link carries.
 */

const ORIGIN = 'https://kinfolk.tribetails.com';

describe('parseEmailActionLink', () => {
  it('reads the native Firebase reset link, which carries no email and no continueUrl', () => {
    const link = parseEmailActionLink('?mode=resetPassword&oobCode=CODE-1&apiKey=AIza&lang=en', ORIGIN);
    expect(link).toEqual({
      mode: 'resetPassword',
      rawMode: 'resetPassword',
      oobCode: 'CODE-1',
      continueUrl: null,
      audience: 'unknown',
    });
  });

  it('reads the requestPasswordReset link and sends its continue target to sign-in, not back to this page', () => {
    const continueUrl = encodeURIComponent('https://kinfolk.tribetails.com/account/secure-reset?email=pepper@example.com');
    const link = parseEmailActionLink(
      `?mode=resetPassword&oobCode=CODE-2&apiKey=AIza&continueUrl=${continueUrl}&lang=en`,
      ORIGIN,
    );
    expect(link?.mode).toBe('resetPassword');
    expect(link?.continueUrl).toBe('https://kinfolk.tribetails.com/signin');
    expect(link?.audience).toBe('kinfolk');
  });

  it('marks a link that continues to the admin site as staff', () => {
    const continueUrl = encodeURIComponent('https://auntie.tribetails.com/signin');
    const link = parseEmailActionLink(`?mode=resetPassword&oobCode=C&continueUrl=${continueUrl}`, ORIGIN);
    expect(link?.audience).toBe('staff');
    expect(link?.continueUrl).toBe('https://auntie.tribetails.com/signin');
  });

  it('treats an oobCode with no mode as a password reset (the legacy direct form)', () => {
    expect(parseEmailActionLink('?oobCode=C&email=x@example.com', ORIGIN)?.mode).toBe('resetPassword');
  });

  it('recognises the email modes Firebase sends to this page', () => {
    expect(parseEmailActionLink('?mode=verifyEmail&oobCode=C', ORIGIN)?.mode).toBe('verifyEmail');
    expect(parseEmailActionLink('?mode=verifyAndChangeEmail&oobCode=C', ORIGIN)?.mode).toBe('verifyAndChangeEmail');
    expect(parseEmailActionLink('?mode=recoverEmail&oobCode=C', ORIGIN)?.mode).toBe('recoverEmail');
  });

  it('keeps any other mode well-formed but unsupported, never "incomplete"', () => {
    const link = parseEmailActionLink('?mode=revertSecondFactorAddition&oobCode=C', ORIGIN);
    expect(link?.mode).toBe('unsupported');
    expect(link?.rawMode).toBe('revertSecondFactorAddition');
  });

  it('returns null only when there is no oobCode at all', () => {
    expect(parseEmailActionLink('', ORIGIN)).toBeNull();
    expect(parseEmailActionLink('?source=unauthorized_attempt&email=x@example.com', ORIGIN)).toBeNull();
  });
});

describe('safeContinueUrl', () => {
  it('allows the portal, the admin site and this origin', () => {
    expect(safeContinueUrl('https://kinfolk.tribetails.com/signin', ORIGIN)).toBe('https://kinfolk.tribetails.com/signin');
    expect(safeContinueUrl('https://auntie.tribetails.com/signin', ORIGIN)).toBe('https://auntie.tribetails.com/signin');
    expect(safeContinueUrl('http://127.0.0.1:5173/signin', 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/signin');
  });

  it('refuses any other host or scheme, so the page is never an open redirect', () => {
    expect(safeContinueUrl('https://evil.example/signin', ORIGIN)).toBeNull();
    expect(safeContinueUrl('https://kinfolk.tribetails.com.evil.example/', ORIGIN)).toBeNull();
    expect(safeContinueUrl('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(safeContinueUrl('http://kinfolk.tribetails.com/signin', ORIGIN)).toBeNull();
    expect(safeContinueUrl('not a url', ORIGIN)).toBeNull();
    expect(safeContinueUrl(null, ORIGIN)).toBeNull();
  });

  it('turns a continue target that points back at the action page into that host sign-in', () => {
    expect(safeContinueUrl('https://kinfolk.tribetails.com/account/action?x=1', ORIGIN)).toBe(
      'https://kinfolk.tribetails.com/signin',
    );
  });
});
