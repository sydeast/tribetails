import { call } from '../lib/fns';

/**
 * Wire types + wrapper functions for the Account Settings screen's
 * callables. Kept in a self-contained file (session S3 convention, see
 * docs/DEVELOPMENT_PLAN_2026-07-10.md) instead of api/portal.ts /
 * api/types.ts to avoid merge conflicts with parallel screen ports.
 * Field names/types transcribed from the backend handlers; each block
 * cites its source.
 */

// ── getMyAccount / saveMyAccount (functions/src/portal/account.ts) ─────────

/**
 * `getMyAccount` takes an optional `kinfolkId`: when an OPERATOR (admin claim)
 * passes a household that is not their own, the backend returns THAT household's
 * primary account with `impersonated: true`, so the profile reflects the tribe
 * being viewed rather than the operator. A normal kinfolk (or an operator on
 * their own household) gets their own uid-scoped account, `impersonated: false`.
 * `saveMyAccount` stays uid-scoped and has no kinfolkId — the screen renders the
 * impersonated profile read-only, so an operator never edits a client's account.
 */
export interface AccountDto {
  uid: string;
  email: string | null;
  displayName: string | null;
  phone: string | null;
  /** Cloudinary or any HTTPS image URL. */
  photoUrl: string | null;
  backupEmail: string | null;
  backupPhone: string | null;
  kinfolkIds: string[];
  hasPaymentMethod: boolean;
  updatedAtMs: number | null;
  /** True when an operator is viewing a household that is not their own. */
  impersonated: boolean;
}

export function getMyAccount(kinfolkId?: string): Promise<AccountDto> {
  return call<{ kinfolkId?: string }, AccountDto>('getMyAccount', kinfolkId !== undefined ? { kinfolkId } : {});
}

/**
 * Mirrors account.ts's `SaveArgs` zod schema exactly: displayName is a
 * plain optional string (server requires min 1 char when present, so only
 * send it non-blank); phone/photoUrl/backupEmail/backupPhone are
 * nullable+optional — sending `null` clears the field server-side
 * (normalizeE164(null) -> null; email/url checks are skipped for null).
 * There is deliberately no `email` field: the backend never accepts one.
 */
export interface SaveMyAccountRequest {
  displayName?: string;
  phone?: string | null;
  photoUrl?: string | null;
  backupEmail?: string | null;
  backupPhone?: string | null;
}

export interface SaveMyAccountResult {
  ok: true;
}

export function saveMyAccount(req: SaveMyAccountRequest): Promise<SaveMyAccountResult> {
  return call<SaveMyAccountRequest, SaveMyAccountResult>('saveMyAccount', req);
}

// ── getFormSchema (functions/src/portal/getFormSchema.ts) ──────────────────

export type FormFieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'date' | 'number' | 'checkbox' | 'phone' | 'email';

export interface FormFieldDto {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  helperText: string | null;
  placeholder: string | null;
  options: string[] | null;
  defaultValue: string | null;
  group: string | null;
}

export interface FormSectionDto {
  title: string;
  description: string | null;
  fields: FormFieldDto[];
}

export interface FormSchemaDto {
  id: string;
  name: string;
  description: string | null;
  appliesTo: string;
  sections: FormSectionDto[];
  version: number;
}

/**
 * Admin-driven form schema, keyed by name (e.g. 'account'). Per the Compose
 * reference (AccountSettingsScreen.kt), this is a best-effort call: when no
 * `formSchemas/{schemaId}` doc exists yet the backend throws `not-found`,
 * and the caller falls back to the static fields rather than treating that
 * as a fatal screen error. Account.tsx mirrors that by using retry:false
 * and ignoring query errors here (no LaunchError).
 */
export function getFormSchema(schemaId: string): Promise<FormSchemaDto> {
  return call<{ schemaId: string }, FormSchemaDto>('getFormSchema', { schemaId });
}

// ── signKinfolkAvatar (functions/src/portal/signKinfolkAvatar.ts) ──────────

export interface SignedAvatarUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  /** Signed server-side; must be echoed verbatim in the upload POST or
   *  Cloudinary rejects it as a signature mismatch. */
  allowedFormats: string;
}

export function signKinfolkAvatar(): Promise<SignedAvatarUpload> {
  return call<Record<string, never>, SignedAvatarUpload>('signKinfolkAvatar', {});
}

// ── addSecondaryContact (functions/src/portal/addSecondaryContact.ts) ──────

/**
 * kinfolkId IS accepted here (unlike account.ts's calls) — the zod Args has
 * `kinfolkId: z.string().optional()`, defaulting server-side to the
 * caller's first linked tribe when omitted, same convention as
 * api/portal.ts's other kinfolkId-threaded calls.
 */
export interface AddSecondaryContactRequest {
  kinfolkId?: string;
  invitedEmail: string;
  secondaryLabel?: string;
}

export interface AddSecondaryContactResult {
  inviteId: string;
}

export function addSecondaryContact(
  invitedEmail: string,
  opts?: { kinfolkId?: string; secondaryLabel?: string },
): Promise<AddSecondaryContactResult> {
  const payload: AddSecondaryContactRequest = {
    invitedEmail,
    ...(opts?.kinfolkId !== undefined ? { kinfolkId: opts.kinfolkId } : {}),
    ...(opts?.secondaryLabel !== undefined ? { secondaryLabel: opts.secondaryLabel } : {}),
  };
  return call<AddSecondaryContactRequest, AddSecondaryContactResult>('addSecondaryContact', payload);
}

// ── avatar upload policy + direct-to-Cloudinary upload ──────────────────────

/**
 * Avatar-specific policy — deliberately still 2MB even though the signed
 * Cloudinary upload path has no payload-size constraint the way the old
 * base64-through-a-callable path did (see kinPhotoApi.ts's KIN_PHOTO_MAX_BYTES,
 * raised to 10MB for kin photos): an avatar is a small square crop, not a
 * full pet photo, so 2MB stays a reasonable ceiling on its own terms. jpeg/
 * png/webp/gif only. Client-side check only — Cloudinary's own upload is the
 * real gate.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Returns a user-facing problem description, or null when the file is acceptable. */
export function validateAvatarFile(file: { size: number; type: string }): string | null {
  if (file.size === 0) return 'That file looks empty. Pick a different photo.';
  if (file.size > AVATAR_MAX_BYTES) return 'Photos need to be 2MB or smaller.';
  if (!AVATAR_ALLOWED_MIME_TYPES.includes(file.type.toLowerCase())) return 'Use a JPG, PNG, WebP, or GIF image.';
  return null;
}

/**
 * Direct-to-Cloudinary signed upload, ported from CloudinaryUpload.js.kt:
 * a multipart POST carrying the server-signed params (the API secret never
 * reaches the browser). Returns the `secure_url`, or null on any failure
 * (non-2xx response, unparsable body, or a body missing secure_url).
 */
export async function uploadAvatarToCloudinary(signed: SignedAvatarUpload, file: File): Promise<string | null> {
  const form = new FormData();
  form.append('api_key', signed.apiKey);
  form.append('timestamp', String(signed.timestamp));
  form.append('signature', signed.signature);
  form.append('folder', signed.folder);
  if (signed.allowedFormats) form.append('allowed_formats', signed.allowedFormats);
  form.append('file', file, file.name || 'avatar');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { secure_url?: string } | null;
  return body?.secure_url ?? null;
}
// ── Card management (functions/src/portal/billing.ts) ────────────────────────
/**
 * These four are hand-typed rather than generated. The contract registry
 * (`mytribe/functions/scripts/contracts/registry.ts`) publishes the invoice and
 * booking surfaces to three clients; billing card state reaches exactly one
 * client tree beyond this file (the portal Android app, which hand-decodes JSON
 * anyway), and its header is explicit that adding a line there is a decision to
 * publish, not a formality. The rest of this file's account callables are
 * hand-typed for the same reason.
 */
export interface CardDto {
  /** Stripe's brand string, lowercase: 'visa', 'mastercard', 'amex'. */
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}
export interface PaymentMethodDto {
  hasPaymentMethod: boolean;
  /**
   * Null when there is no card, AND when a card exists that the server could
   * not describe. Render the generic "on file" copy in the second case rather
   * than a half-empty card.
   */
  card: CardDto | null;
  updatedAtMs: number | null;
}
export interface SyncPaymentMethodResult extends PaymentMethodDto {
  /** True when the sync changed which card is on file. */
  changed: boolean;
}
export interface BillingSetupSessionResult {
  /** Stripe-hosted Checkout URL. Redirect to it, do not fetch it. */
  checkoutUrl: string;
  sessionId: string;
}
export function getMyPaymentMethod(kinfolkId?: string): Promise<PaymentMethodDto> {
  return call<{ kinfolkId?: string }, PaymentMethodDto>(
    'getMyPaymentMethod',
    kinfolkId !== undefined ? { kinfolkId } : {},
  );
}
/**
 * Opens a Stripe Checkout Session in setup mode: the household enters a card,
 * Stripe charges nothing, and the card is attached to their customer record.
 * REAL CARD FLOW: redirect the browser to `checkoutUrl` (window.location.href).
 */
export function createBillingSetupSession(
  successUrl: string,
  cancelUrl: string,
  kinfolkId?: string,
): Promise<BillingSetupSessionResult> {
  return call<{ successUrl: string; cancelUrl: string; kinfolkId?: string }, BillingSetupSessionResult>(
    'createBillingSetupSession',
    { successUrl, cancelUrl, ...(kinfolkId !== undefined ? { kinfolkId } : {}) },
  );
}
/**
 * Asks the server to re-read the card from Stripe. Called when the browser
 * comes back from Checkout, so the screen shows the new card without waiting
 * for a webhook.
 */
export function syncMyPaymentMethod(kinfolkId?: string): Promise<SyncPaymentMethodResult> {
  return call<{ kinfolkId?: string }, SyncPaymentMethodResult>(
    'syncMyPaymentMethod',
    kinfolkId !== undefined ? { kinfolkId } : {},
  );
}
/** Takes the card off file. Removes an instrument, never a payment already made. */
export function removeMyPaymentMethod(kinfolkId?: string): Promise<{ ok: true; alreadyEmpty: boolean }> {
  return call<{ kinfolkId?: string }, { ok: true; alreadyEmpty: boolean }>(
    'removeMyPaymentMethod',
    kinfolkId !== undefined ? { kinfolkId } : {},
  );
}
/** "Visa •••• 4242 · exp 04/2030", the one place this string is composed. */
export function formatCard(card: CardDto): string {
  const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
  const month = String(card.expMonth).padStart(2, '0');
  return `${brand} •••• ${card.last4} · exp ${month}/${card.expYear}`;
}
