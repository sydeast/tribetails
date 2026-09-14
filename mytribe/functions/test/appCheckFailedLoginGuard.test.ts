import { describe, expect, it } from 'vitest';
import {
  APP_CHECK_COHORT,
  UNATTESTED_CLIENT_CALLABLES,
  appCheckDecision,
  isAppCheckCohort,
} from '../src/lib/appCheckPolicy';

/**
 * #886 guard: `recordFailedLogin` must stay out of App Check enforcement until
 * every client that calls it sends a token.
 *
 * Six sign-in clients report failures to it, and two of them (both desktop
 * clients) have no App Check SDK. Enforcement would refuse those reports, the
 * clients swallow the refusal on purpose, and lockout would silently stop.
 * Nothing else in the suite would notice, because every server test calls the
 * handler directly and never goes through `wrapCallable`'s App Check gate.
 */
describe('#886 recordFailedLogin is never App Check enforced without client tokens', () => {
  it('recordFailedLogin is listed as a callable its clients cannot attest', () => {
    expect(UNATTESTED_CLIENT_CALLABLES).toContain('recordFailedLogin');
  });

  it('no callable its clients cannot attest is in the enforced cohort', () => {
    const overlap = APP_CHECK_COHORT.filter((name) => UNATTESTED_CLIENT_CALLABLES.includes(name));
    expect(
      overlap,
      'Adding these to APP_CHECK_COHORT would refuse every failed-login report from the ' +
        'desktop clients (no App Check SDK) and unattested web sessions, and account lockout would ' +
        'stop without an error. Give every client a token first, then remove the name from ' +
        'UNATTESTED_CLIENT_CALLABLES in the same change.',
    ).toEqual([]);
  });

  it('under full enforcement, a token-less recordFailedLogin report is still served', () => {
    for (const status of ['absent', 'invalid'] as const) {
      expect(
        appCheckDecision({ mode: 'enforce', status, inCohort: isAppCheckCohort('recordFailedLogin') }),
      ).toBe('allow');
    }
  });
});
