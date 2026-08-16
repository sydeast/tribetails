import type { GetMyAccessResult, GetMyHomeResult } from '../../src/api/types';
import { KINFOLK } from './accounts';

/**
 * The access chain: the callables the router's guard cannot get past.
 *
 * `requireActiveTribe` guards nearly every route in `router.tsx`, and it awaits
 * `ensureAccess()`, which is `getMyAccess`. With the Functions SDK pinned to an
 * unserved port that call fails, `access.error` is non-null, and the guard
 * routes every screen in the app to `/error`. Nothing renders and nothing can
 * be tested. Stubbing these three is what makes the portal reachable at all.
 *
 * TYPED AGAINST THE APP'S OWN INTERFACES on purpose. `GetMyAccessResult` and
 * `GetMyHomeResult` are what `src/api/portal.ts` consumes, so a backend shape
 * change that lands in those types breaks `npm run e2e:cy:tsc` here rather than
 * leaving a fixture quietly describing a response the server stopped sending.
 */

/** One household, not an operator: the only shape that routes to `/home`. */
export const ACCESS: GetMyAccessResult = {
  kinfolkIds: [KINFOLK.kinfolkId],
  isOperator: false,
};

/**
 * Enough of a home for the portal chrome to render.
 *
 * Every `home` section is enabled, because the nav and the tab bar are what the
 * crawl walks and a config that hid sections would silently shrink the surface
 * under test. `limit: 0` is unlimited, per `PortalHomeSection`.
 */
export const HOME: GetMyHomeResult = {
  kinfolkId: KINFOLK.kinfolkId,
  displayName: KINFOLK.displayName,
  businessLogoUrl: '',
  businessName: 'Tribe Tails Pet Care',
  portal: {
    logoUrl: '',
    themeId: 'default',
    banner: { enabled: false, message: '', tone: 'info', dismissMode: 'session', id: 'e2e-banner' },
    home: [
      { id: 'schedule', enabled: true, limit: 0 },
      { id: 'kin', enabled: true, limit: 0 },
      { id: 'kintales', enabled: true, limit: 0 },
      { id: 'invoices', enabled: true, limit: 0 },
      { id: 'messages', enabled: true, limit: 0 },
    ],
    chat: {
      enabled: true,
      awayMessage: '',
      hoursEnabled: false,
      hours: {},
      maxMessageLength: 2000,
      rateLimitPerHour: 60,
    },
  },
  bannerDismissedByUser: true,
  // Empty on purpose: a pay method renders an outbound link to a real payment
  // processor, and a crawl that followed one would leave the machine.
  payMethods: [],
};

/**
 * `setActiveTribe` re-mints the `kinfolkId` claim after a pick. The seeded
 * kinfolk has one household, so the app autopicks and this is called with that
 * id; `claimReminted: false` is honest here, because no token is actually
 * re-minted in this harness: the seed wrote the claim at account creation.
 */
export const SET_ACTIVE_TRIBE = { ok: true as const, kinfolkId: KINFOLK.kinfolkId, claimReminted: false };
