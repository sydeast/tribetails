import { describe, expect, it } from 'vitest';
import {
  APP_CHECK_COHORT,
  UNATTESTED_CLIENT_CALLABLES,
  appCheckDecision,
  isAppCheckCohort,
} from '../src/lib/appCheckPolicy';
import {
  CLIENT_TREES,
  callableMap,
  clientSourceFiles,
  cohortViolations,
  exportWrapNameMismatches,
  type ClientId,
} from '../scripts/clientCallables';

/**
 * #987 guard: no callable that a Compose or Android client can reach is ever in
 * an enforced App Check cohort.
 *
 * Android has no App Check (ruling R3, 2026-09-27) and the desktop builds never
 * had it, so `enforce` on such a callable refuses that client forever. The
 * cohort was once checked by hand and the check was wrong: `getBusinessClosures`
 * was in it while the Android portal's booking calendar called it. This suite
 * reads the client source on every run instead, via scripts/clientCallables.ts.
 *
 * Every server test calls handlers directly and never passes through
 * `wrapCallable`'s gate, so nothing else in the suite would notice.
 */

const map = callableMap();

/**
 * Floors on files scanned per client, well under today's counts (2026-09-28:
 * 208, 338, 232, 92, 403). If a tree moves, the walk finds nothing, the
 * reachable set shrinks to empty, and the guard would pass vacuously. These
 * make that a failure instead.
 */
const MIN_FILES: Record<ClientId, number> = {
  portalKmp: 120,
  adminAndroid: 200,
  adminDesktop: 150,
  portalWeb: 40,
  adminWeb: 200,
};

/**
 * One known call per client, each through a different call spelling, so a
 * broken extraction fails here rather than quietly missing a name.
 */
const SENTINELS: Record<ClientId, string[]> = {
  // PortalApi.kt `fns.call(\n "getBusinessClosures"`, `decideQuote("acceptQuote", ...)`,
  // RestAuthClient.kt `endpoints.functionUrl("recordFailedLogin")`.
  portalKmp: ['getBusinessClosures', 'acceptQuote', 'recordFailedLogin'],
  // `getHttpsCallable("x")`, `name = "broadcastMessage"`, `const val SCREEN_CALL_ACTION = "screenCallAction"`.
  adminAndroid: ['recordFailedLogin', 'broadcastMessage', 'screenCallAction'],
  // `JvmFirestoreRest.callable("recordFailedLogin", ...)`, `callAndDecode("getGoogleCalendarConnection", ...)`.
  adminDesktop: ['recordFailedLogin', 'getGoogleCalendarConnection'],
  portalWeb: ['getBusinessClosures'],
  adminWeb: ['recordFailedLogin'],
};

describe('#987 client callable extraction reaches every client', () => {
  it('finds the server callables the gate keys on', () => {
    expect(map.server.length).toBeGreaterThan(200);
    expect(map.server).toContain('getBusinessClosures');
  });

  it('the name clients dial is the name the gate checks, for every wrapped callable', () => {
    // Clients dial the export name; `isAppCheckCohort` receives the
    // `wrapCallable` name. A difference would let a cohort entry miss its callers.
    expect(exportWrapNameMismatches()).toEqual([]);
  });

  for (const tree of CLIENT_TREES) {
    it(`${tree.id}: scans ${tree.root} and finds its known calls`, () => {
      expect(clientSourceFiles(tree).length).toBeGreaterThanOrEqual(MIN_FILES[tree.id]);
      for (const name of SENTINELS[tree.id]) expect(map.byClient[tree.id], name).toContain(name);
    });
  }

  it('the Kotlin clients are the ones marked as sending no App Check token', () => {
    for (const tree of CLIENT_TREES) expect(tree.sendsAppCheck, tree.id).toBe(tree.language === 'typescript');
  });
});

describe('#987 the enforced cohort holds no callable a Compose or Android client can reach', () => {
  it('every cohort name is a real callable', () => {
    for (const name of APP_CHECK_COHORT) expect(map.server, name).toContain(name);
  });

  it('no cohort name is reachable from a client with no App Check', () => {
    expect(
      cohortViolations(APP_CHECK_COHORT, map.unattestedReachable),
      'These callables are in APP_CHECK_COHORT but an Android or desktop client calls them. ' +
        'Those clients have no App Check (ruling R3), so enforce would refuse them for good. ' +
        'Only names listed as web-only by `npm run callables:map` may be in the cohort.',
    ).toEqual([]);
  });

  it('the guard is not vacuous: getBusinessClosures, the old cohort member, would be refused by it', () => {
    expect(map.unattestedReachable).toContain('getBusinessClosures');
    expect(cohortViolations(['getBusinessClosures'], map.unattestedReachable)).toEqual(['getBusinessClosures']);
    expect(APP_CHECK_COHORT).not.toContain('getBusinessClosures');
  });

  it('a token-less call to any Compose-reachable callable is served without an observation', () => {
    for (const name of map.unattestedReachable) {
      for (const status of ['absent', 'invalid'] as const) {
        expect(appCheckDecision({ mode: 'log', status, inCohort: isAppCheckCohort(name) }), name).toBe('allow');
      }
    }
  });

  it('the #886 unattested sign-in callables are among the Compose-reachable ones', () => {
    // #886 listed these by hand. The extraction must agree, or it is missing calls.
    for (const name of UNATTESTED_CLIENT_CALLABLES) expect(map.unattestedReachable, name).toContain(name);
  });
});
