import { describe, expect, it } from 'vitest';
import { APP_CHECK_COHORT, isAppCheckCohort } from '../src/lib/appCheckPolicy';
import { callableMap } from '../scripts/clientCallables';

/**
 * D-2026-09-28-APP-CHECK-ONLY-LOGS (docs/DECISIONS.md), docket Q9: "No: App
 * Check only logs. Sign-in and rate limits protect every function."
 *
 * The cohort stays empty by ruling. #987's guard
 * (appCheckComposeReachable.test.ts) only refuses names an Android or desktop
 * client can reach, so it would still let a web-only callable in, and with an
 * empty list it passes trivially. This suite makes emptiness itself the
 * assertion. Adding a name takes a new operator ruling, not a code change.
 */
describe('D-2026-09-28-APP-CHECK-ONLY-LOGS: the App Check cohort stays empty', () => {
  it('APP_CHECK_COHORT holds no callable at all', () => {
    expect(
      APP_CHECK_COHORT,
      'APP_CHECK_COHORT must stay empty (D-2026-09-28-APP-CHECK-ONLY-LOGS, docket Q9: ' +
        '"No: App Check only logs. Sign-in and rate limits protect every function."). ' +
        'Adding a name needs a new operator ruling recorded in docs/DECISIONS.md.',
    ).toEqual([]);
  });

  it('no server callable, web-only ones included, counts as a cohort member', () => {
    const map = callableMap();
    expect(map.server.length).toBeGreaterThan(200);
    expect(map.server.filter((name) => isAppCheckCohort(name))).toEqual([]);
    // The web-only names #987 left eligible are no longer eligible.
    expect(map.webOnly.filter((name) => isAppCheckCohort(name))).toEqual([]);
  });
});
