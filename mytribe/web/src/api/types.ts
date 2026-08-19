/**
 * Wire types for the Phase-1 callables, transcribed from the backend
 * handlers (functions/src). Field names/types/defaults MUST stay in sync
 * with those files; each interface cites its source.
 */

// ── getMyAccess (functions/src/portal/getMyAccess.ts) ───────────────────────

export interface GetMyAccessResult {
  /** kinfolkIds the caller may view (clients/{uid}.kinfolkIds; operators get all). */
  kinfolkIds: string[];
  isOperator: boolean;
}

// ── getMyHome (functions/src/portal/getMyHome.ts) ───────────────────────────

export interface GetMyHomeRequest {
  kinfolkId?: string;
}

/** A single home section's config. `limit` 0 = unlimited. */
export interface PortalHomeSection {
  id: string;
  enabled: boolean;
  limit: number;
}

export interface PortalBanner {
  enabled: boolean;
  message: string;
  tone: string;
  dismissMode: string;
  id: string;
}

export interface PortalChat {
  enabled: boolean;
  awayMessage: string;
  hoursEnabled: boolean;
  hours: Record<string, string>;
  maxMessageLength: number;
  rateLimitPerHour: number;
}

/**
 * MyTribe client-portal config. Shared wire contract with AuntieOS
 * MyTribePortalConfig; every field is server-defaulted if missing.
 */
export interface PortalConfig {
  logoUrl: string;
  themeId: string;
  banner: PortalBanner;
  home: PortalHomeSection[];
  chat: PortalChat;
}

/**
 * PR30: one configured payment option, resolved (URL + label), never a raw
 * operator handle. `kind: 'checkout'` is the existing `payInvoice` flow
 * (Stripe, and the Klarna/Affirm rails that ride it); `kind: 'link'` is a
 * plain anchor to `url`; `kind: 'instructions'` (issue #409) is a method with
 * no link at all, where the operator's own words are the whole thing.
 *
 * NEVER carries a processor fee — kinfolk never see fees (standing ruling);
 * see `functions/src/lib/paymentMethods.ts`.
 *
 * Hand-written rather than generated, because `getMyHome` parses its request
 * against a plain interface and there is no zod Result to project from. The
 * per-invoice list on `getMyInvoices` IS generated (`InvoiceDtoPayMethod` in
 * `contracts/invoiceContracts.generated.ts`) and is the one to prefer; this
 * shape is kept assignment-compatible with it on purpose.
 */
export interface PayMethod {
  id: 'stripe' | 'venmo' | 'paypal' | 'cashapp' | 'zelle' | 'cash' | 'check' | 'banktransfer' | 'klarna' | 'affirm' | 'other';
  label: string;
  kind: 'checkout' | 'link' | 'instructions';
  url: string | null;
  /** Set only on `kind: 'instructions'`, and never blank. Null on the other two. */
  instructions: string | null;
}

export interface GetMyHomeResult {
  kinfolkId: string;
  displayName: string;
  /** Operating-business branding for the portal chrome. */
  businessLogoUrl: string;
  businessName: string;
  portal: PortalConfig;
  /** True when the signed-in user already dismissed the current banner. */
  bannerDismissedByUser: boolean;
  /**
   * PR30: every payment option the operator has configured, business-level
   * (not filtered to a specific invoice's amount due — see
   * `functions/src/portal/getMyHome.ts`).
   *
   * ISSUE #409: this list never carries the `instructions` kind, and it does
   * not know what any particular invoice was ISSUED with. Prefer the
   * per-invoice `payMethods` on an `InvoiceDto`; this stays as the fallback
   * for a screen that has no invoice, and for the deploy-skew window where
   * the server is older than this bundle.
   */
  payMethods: PayMethod[];
}

// ── getMyBookings (functions/src/portal/getMyBookings.ts) ───────────────────
//
// The REQUEST is hand-written on purpose (see GetMyBookingsRequest in
// api/portal.ts, next to the function that sends it): getMyBookings parses
// its request against a plain TypeScript interface rather than a zod schema,
// same situation as getMyInvoices, so there is no authority to generate a
// request type from. The RESPONSE is generated: GetMyBookingsResult and its
// nested visit/envelope shapes now come from
// ../contracts/bookingContracts.generated, projected from the server zod
// schema that validates the response outbound (ADR-0001).

// ── getMyVisits (functions/src/portal/getMyVisits.ts) ───────────────────────

export interface GetMyVisitsRequest {
  kinfolkId?: string;
  /** Default 10, clamped 1-50. */
  limit?: number;
}

export interface RoutePointDto {
  lat: number;
  lng: number;
  /** Epoch millis. Absent/0 means unknown. */
  t?: number;
}

export interface GpsSummaryDto {
  distanceMeters?: number;
  durationSeconds?: number;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
  route?: RoutePointDto[];
  computedAt?: string;
}

export interface VisitDto {
  id: string;
  /** Raw AuntieOS status string, e.g. "ARRIVED" — case-insensitive match for the live gate. */
  status: string;
  serviceType: string | null;
  startTimeIso: string | null;
  endTimeIso: string | null;
  arrivedAtIso: string | null;
  departedAtIso: string | null;
  gpsSummary?: GpsSummaryDto;
}

export interface GetMyVisitsResult {
  visits: VisitDto[];
}

// ── getMyKin (functions/src/portal/getMyKin.ts) ──────────────────────────────

export interface GetMyKinRequest {
  kinfolkId?: string;
}

export type KinStatus = 'active' | 'noLongerWithUs';

export interface KinDto {
  id: string;
  name: string | null;
  species: string | null;
  breed: string | null;
  ageYears: number | null;
  photoUrl: string | null;
  status: KinStatus;
  feedingInstructions: string | null;
  walkingInstructions: string | null;
  medications: string | null;
  allergies: string | null;
  emergencyNotes: string | null;
  sitterNotes: string | null;
}

export interface GetMyKinResult {
  kin: KinDto[];
}

// ── archiveKin (functions/src/portal/kinWrites.ts, authed) ──────────────────

export interface ArchiveKinRequest {
  kinfolkId?: string;
  kinId: string;
  reason: 'noLongerWithUs' | 'restore';
}

export interface ArchiveKinResult {
  ok: true;
}

// ── updateKin (functions/src/portal/kinWrites.ts, authed) ───────────────────
// Editable subset of a kin doc, mirroring the KinPayload zod schema in
// kinWrites.ts. `name` is required when present; every other field is
// optional and nullable (sending null clears it via the server merge write).

export interface KinPayloadPartial {
  name?: string;
  species?: string | null;
  breed?: string | null;
  ageYears?: number | null;
  photoUrl?: string | null;
  feedingInstructions?: string | null;
  walkingInstructions?: string | null;
  medications?: string | null;
  allergies?: string | null;
  emergencyNotes?: string | null;
  sitterNotes?: string | null;
  legacyKinId?: string | null;
}

export interface UpdateKinRequest {
  kinfolkId?: string;
  kinId: string;
  kin: KinPayloadPartial;
}

export interface UpdateKinResult {
  ok: true;
}

// ── addKin (functions/src/portal/kinWrites.ts, authed) ───────────────────────
// Same `KinPayload` zod schema as updateKin, except `name` is required (not
// merged over an existing doc).

export interface AddKinRequest {
  kinfolkId?: string;
  kin: KinPayloadPartial & { name: string };
}

export interface AddKinResult {
  kinId: string;
}

// ── getMyKinTales (functions/src/portal/getMyKinTales.ts) ───────────────────

export interface GetMyKinTalesRequest {
  kinfolkId?: string;
  /** Pagination cursor, `sentAtMs` of the last item from the previous page. */
  before?: number;
  /** Page size; default 20, max 50. */
  limit?: number;
}

/** Same shape KinTaleMediaItemDto (kinTalesApi.ts) already has. */
export interface TaleThumbDto {
  id: string;
  url: string;
  contentType: string | null;
}

/** One care task the Auntie's checklist recorded as DONE for this visit. */
export interface ChecklistItemDto {
  key: string;
  text: string;
}

export interface KinTaleDto {
  id: string;
  title: string;
  body: string;
  authorDisplayName: string;
  mediaIds: string[];
  sentAtMs: number | null;
  shared: boolean;
  gpsRoute?: RoutePointDto[];
  gpsSummary?: GpsSummaryDto;
  petMoods?: Record<string, string>;
  /**
   * Preview media for the feed card's thumbnail strip: at most the first 8
   * of `mediaIds`. Optional so an older deployed function that doesn't send
   * it renders as "no thumbnails" instead of crashing.
   */
  thumbs?: TaleThumbDto[];
  /**
   * When the Auntie arrived / departed, resolved server-side from the visit's
   * session (task-25, P4). `null` means not recorded — never zero, never
   * "now". `departedAtIso` can be `null` while `arrivedAtIso` is set (a
   * departure that was never stamped).
   */
  arrivedAtIso: string | null;
  departedAtIso: string | null;
  /**
   * Care tasks checked done on this visit. CHECKED ITEMS ONLY — an item that
   * wasn't checked has no entry here and must never be shown as "not done"
   * (the source data can't tell "left undone" apart from "not applicable to
   * this visit"). Omitted (not `[]`) when nothing was recorded, so an absent
   * checklist and a recorded-but-empty one never render the same way.
   */
  checklist?: ChecklistItemDto[];
}

export interface GetMyKinTalesResult {
  tales: KinTaleDto[];
  hasMore: boolean;
}

// ── getBusinessContact (functions/src/portal/getBusinessContact.ts) ─────────

export interface BusinessContactDto {
  name: string;
  email: string;
  phone: string;
  address: string;
}

// ── getInvitePreview (functions/src/portal/getInvitePreview.ts, public) ─────

export interface GetInvitePreviewRequest {
  inviteId: string;
}

/**
 * Discriminated union straight from the backend. The invited email is only
 * returned while the invite is still claimable.
 */
export type InvitePreviewResult =
  | { status: 'valid'; invitedEmail: string; tribeName: string }
  | { status: 'not_found' | 'expired' | 'claimed' | 'revoked' };

export type InvitePreviewStatus = InvitePreviewResult['status'];

// ── claimInviteSignup (functions/src/membership/claimInviteSignup.ts, public)

export interface ClaimInviteSignupRequest {
  inviteId: string;
  /** Min 8 chars (zod-enforced server-side too). */
  password: string;
}

export interface ClaimInviteSignupResult {
  /** Custom token; sign in with it, then call acceptInvite. */
  token: string;
}

// ── acceptInvite (functions/src/membership/acceptInvite.ts, authed) ─────────

export interface AcceptInviteRequest {
  inviteId: string;
}

export interface AcceptInviteResult {
  familyId: string;
}

// ── confirmSecureReset (functions/src/security/confirmSecureReset.ts) ───────
// NOT a callable: a public onRequest endpoint hit while signed out.

export interface ConfirmSecureResetRequest {
  /** Firebase oobCode from the password-reset link. */
  oobCode: string;
  /** New password chosen by the kinfolk (min 8 chars). */
  newPassword: string;
  /** Kinfolk email (pre-filled from the reset link's query params). */
  email: string;
  /** navigator.userAgent, best effort. */
  userAgent?: string;
}

export interface ConfirmSecureResetResult {
  ok: true;
  incidentId: string;
}
