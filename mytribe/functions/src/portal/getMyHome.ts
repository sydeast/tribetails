import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';
import { payMethodSettingsFrom, resolveHomePayMethods, type PayMethod } from '../lib/paymentMethods';

interface GetMyHomeRequest {
  kinfolkId?: string;
}

/** A single home section's config. `limit` 0 = unlimited. */
interface PortalHomeSection {
  id: string;
  enabled: boolean;
  limit: number;
}

interface PortalBanner {
  enabled: boolean;
  message: string;
  tone: string;
  dismissMode: string;
  id: string;
}

interface PortalChat {
  enabled: boolean;
  awayMessage: string;
  hoursEnabled: boolean;
  hours: Record<string, string>;
  maxMessageLength: number;
  rateLimitPerHour: number;
}

/**
 * MyTribe client-portal config. Shared wire contract; field names/types/defaults
 * MUST match the AuntieOS `MyTribePortalConfig` model and the MyTribe portal
 * client `PortalConfig`. Every field is defaulted if missing from the doc.
 */
interface PortalConfig {
  logoUrl: string;
  themeId: string;
  banner: PortalBanner;
  home: PortalHomeSection[];
  chat: PortalChat;
}

interface GetMyHomeResult {
  kinfolkId: string;
  displayName: string;
  /** Operating-business branding for the portal chrome (logo left of wordmark). */
  businessLogoUrl: string;
  businessName: string;
  /** MyTribe portal config (branding, home layout, banner, chat). */
  portal: PortalConfig;
  /**
   * True when the signed-in user has dismissed the current banner (its id is in
   * `clients/{uid}.dismissedBanners`). Backs the `perUser` dismiss mode (§5) so
   * the client can suppress an already-dismissed banner. False when there is no
   * banner id to match against.
   */
  bannerDismissedByUser: boolean;
  /**
   * PR30: every payment processor the operator has configured — resolved
   * (URL + label), never raw handles: the portal needs somewhere to send a
   * household, not the operator's account identifiers, and keeping the
   * parsing in `resolvePayMethods` means it's tested in one place.
   *
   * This is BUSINESS-LEVEL, not invoice-level: `getMyHome` has no specific
   * invoice, so it resolves against a nonzero placeholder rather than a real
   * `amountDue` (`resolvePayMethods` returns [] once nothing is owed, which
   * has no meaning outside a specific bill). The client still gates on
   * whether an invoice itself has anything due before rendering `PayOptions`.
   *
   * Never carries `feeBps`/`feeFixedCents` — kinfolk never see processor fees
   * (standing ruling; see `paymentMethods.ts`), and `PayMethod` has no field
   * for them.
   *
   * ISSUE #409: this list ships only the `checkout` and `link` kinds, never
   * `instructions`. It is a deploy-skew guard, not a product decision — see
   * `resolveHomePayMethods`. The full catalogue, including the operator's
   * written instructions and each invoice's own frozen options, rides
   * `getMyInvoices`'s per-invoice `payMethods`, which is where a client
   * should read it. This field remains the business-wide fallback.
   */
  payMethods: PayMethod[];
}

/**
 * Resolves the home payload for the signed-in kinfolk user.
 *
 * Auth model: caller must be a kinfolk with `clients/{auth.uid}.kinfolkIds`
 * containing the requested kinfolkId. If the request omits kinfolkId and
 * the user only has one, that one is used.
 *
 * AuntieOS data is keyed by integer-string `kinfolkId`. This Function
 * is the translation layer, never expose another kinfolk's data.
 */
export async function getMyHomeHandler(
  req: CallableRequest<GetMyHomeRequest>,
): Promise<GetMyHomeResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyHome');

  // Resolve displayName via fallback chain:
  //   1. families/{kinfolkId}.displayName    (MyTribe-shaped, kinfolk-edited)
  //   2. dossiers/{kinfolkId}.kinfolkName    (AuntieOS auto-gen summary)
  //   3. kinfolk/{kinfolkId}.firstName + lastName    (AuntieOS canonical record, covers
  //                                                   numeric AuntieOS ids w/ no MyTribe family doc yet)
  //   4. "Tribe {kinfolkId}"                 (final fallback, no usable name source)
  // Family doc + business branding + caller's client doc in parallel (no extra
  // round-trip cost). The client doc carries `dismissedBanners` for the per-user
  // banner dismiss mode.
  const [familySnap, settingsSnap, clientSnap] = await Promise.all([
    firestore.collection('families').doc(kinfolkId).get(),
    firestore.collection('business_settings').doc('business_settings').get(),
    firestore.collection('clients').doc(uid).get(),
  ]);
  let displayName = (familySnap.data()?.displayName as string | undefined) ?? null;

  if (!displayName) {
    const dossierSnap = await firestore.collection('dossiers').doc(kinfolkId).get();
    const summary = dossierSnap.data() as Record<string, unknown> | undefined;
    if (summary && typeof summary['kinfolkName'] === 'string') {
      displayName = summary['kinfolkName'] as string;
    }
  }
  if (!displayName) {
    const kinfolkSnap = await firestore.collection('kinfolk').doc(kinfolkId).get();
    const k = kinfolkSnap.data() as Record<string, unknown> | undefined;
    if (k) {
      const first = (typeof k['firstName'] === 'string' ? k['firstName'] : '').trim();
      const last = (typeof k['lastName'] === 'string' ? k['lastName'] : '').trim();
      const joined = `${first} ${last}`.trim();
      if (joined) displayName = joined;
    }
  }
  if (!displayName) displayName = `Tribe ${kinfolkId}`;

  const settings = (settingsSnap.data() ?? {}) as Record<string, unknown>;
  const businessName = typeof settings['businessName'] === 'string' ? (settings['businessName'] as string) : '';

  // MyTribe portal config (shared wire contract). Each field defaulted if absent
  // so a settings doc with no `mytribePortal` returns the canonical defaults.
  const mt = (typeof settings['mytribePortal'] === 'object' && settings['mytribePortal'] !== null
    ? (settings['mytribePortal'] as Record<string, unknown>)
    : {});

  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const int = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);

  const rawBanner = (typeof mt['banner'] === 'object' && mt['banner'] !== null
    ? (mt['banner'] as Record<string, unknown>)
    : {});
  const banner: PortalBanner = {
    enabled: bool(rawBanner['enabled'], false),
    message: str(rawBanner['message'], ''),
    tone: str(rawBanner['tone'], 'info'),
    dismissMode: str(rawBanner['dismissMode'], 'none'),
    id: str(rawBanner['id'], ''),
  };

  const rawHome = (typeof mt['home'] === 'object' && mt['home'] !== null
    ? (mt['home'] as Record<string, unknown>)
    : {});
  const rawSections = Array.isArray(rawHome['sections']) ? (rawHome['sections'] as unknown[]) : [];
  const home: PortalHomeSection[] = rawSections
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      id: str(s['id'], ''),
      enabled: bool(s['enabled'], true),
      limit: int(s['limit'], 0),
    }));

  const rawChat = (typeof mt['chat'] === 'object' && mt['chat'] !== null
    ? (mt['chat'] as Record<string, unknown>)
    : {});
  const rawHours = (typeof rawChat['hours'] === 'object' && rawChat['hours'] !== null
    ? (rawChat['hours'] as Record<string, unknown>)
    : {});
  const hours: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHours)) {
    if (typeof v === 'string') hours[k] = v;
  }
  const chat: PortalChat = {
    enabled: bool(rawChat['enabled'], true),
    awayMessage: str(rawChat['awayMessage'], ''),
    hoursEnabled: bool(rawChat['hoursEnabled'], false),
    hours,
    maxMessageLength: int(rawChat['maxMessageLength'], 2000),
    rateLimitPerHour: int(rawChat['rateLimitPerHour'], 0),
  };

  const portal: PortalConfig = {
    logoUrl: str(mt['logoUrl'], ''),
    themeId: str(mt['themeId'], 'default'),
    banner,
    home,
    chat,
  };

  // Portal chrome logo comes from the MyTribe portal config, NOT the AuntieOS
  // top-level logoUrl (that's the operator app's own nav-rail brand mark).
  const businessLogoUrl = portal.logoUrl;

  // Per-user banner dismissal (§5 perUser mode): the banner is dismissed for this
  // user when its stable id is recorded in `clients/{uid}.dismissedBanners`.
  // False when there's no banner id to match (e.g. banner never configured).
  const rawDismissed = clientSnap.data()?.['dismissedBanners'];
  const dismissedBanners: string[] = Array.isArray(rawDismissed)
    ? rawDismissed.filter((b): b is string => typeof b === 'string')
    : [];
  const bannerDismissedByUser = portal.banner.id.length > 0 && dismissedBanners.includes(portal.banner.id);

  // PR30: resolved against a nonzero placeholder — see `payMethods` on
  // `GetMyHomeResult` for why `getMyHome` has no real invoice to gate on.
  //
  // Issue #409: the hand-picked three fields are gone in favour of the shared
  // decoder, so this read and the per-invoice snapshot read cannot drift
  // apart. `resolveHomePayMethods` rather than `resolvePayMethods` because
  // this business-wide list still ships only the two kinds an older portal
  // bundle knows how to draw — that function's own header says why at length.
  const payMethods = resolveHomePayMethods(payMethodSettingsFrom(settings), { amountDue: 1 });

  logEvent({
    severity: 'info',
    function: 'getMyHome',
    event: 'portal.home.resolved',
    uid,
    extra: { kinfolkId },
  });

  return {
    kinfolkId,
    displayName,
    businessLogoUrl,
    businessName,
    portal,
    bannerDismissedByUser,
    payMethods,
  };
}

export const getMyHome = onCall(
  // Portal landing read.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getMyHome', getMyHomeHandler),
);
