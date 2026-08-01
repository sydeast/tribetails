/**
 * Wire types + wrapper functions for the Tribe hub / Tribe profile editor
 * callables. Self-contained (per S3 merge-conflict guardrail) rather than
 * folded into api/types.ts + api/portal.ts. Field names/types are
 * transcribed from the backend handlers; each block cites its source file.
 */
import { call } from '../lib/fns';

// ── shared custom-field shape (functions/src/portal/getMyTribeProfile.ts,
//    saveTribeProfile.ts, saveHomeAccess.ts all use the same {key,label,value}) ──

export interface CustomFieldDto {
  key: string;
  label: string;
  value: string;
}

// ── getMyTribeProfile (functions/src/portal/getMyTribeProfile.ts) ───────────

export interface GetMyTribeProfileRequest {
  kinfolkId?: string;
}

export interface TribeProfileDto {
  kinfolkId: string;
  displayName: string;
  customFields: CustomFieldDto[];
}

export interface HomeAccessDto {
  gateCode: string | null;
  keyLocation: string | null;
  wifiPassword: string | null;
  customFields: CustomFieldDto[];
  updatedAtMs: number | null;
}

export interface GetMyTribeProfileResult {
  profile: TribeProfileDto;
  homeAccess: HomeAccessDto;
}

/** Tribe profile + home access (home access fields null when the caller lacks `home_access` perm). */
export function getMyTribeProfile(kinfolkId?: string): Promise<GetMyTribeProfileResult> {
  const payload: GetMyTribeProfileRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyTribeProfileRequest, GetMyTribeProfileResult>('getMyTribeProfile', payload);
}

// ── saveTribeProfile (functions/src/portal/saveTribeProfile.ts) ─────────────

export interface SaveTribeProfileRequest {
  kinfolkId?: string;
  displayName?: string;
  customFields?: CustomFieldDto[];
}

export interface SaveTribeProfileResult {
  ok: true;
}

/** Additive: only writes the fields passed. `families/{kinfolkId}`. */
export function saveTribeProfile(req: SaveTribeProfileRequest): Promise<SaveTribeProfileResult> {
  return call<SaveTribeProfileRequest, SaveTribeProfileResult>('saveTribeProfile', req);
}

// ── saveHomeAccess (functions/src/portal/saveHomeAccess.ts) ─────────────────

export interface SaveHomeAccessRequest {
  kinfolkId?: string;
  gateCode?: string | null;
  keyLocation?: string | null;
  wifiPassword?: string | null;
  customFields?: CustomFieldDto[];
}

export interface SaveHomeAccessResult {
  ok: true;
}

/** Additive: writes `families/{kinfolkId}/homeAccess/current`. Requires `home_access` perm. */
export function saveHomeAccess(req: SaveHomeAccessRequest): Promise<SaveHomeAccessResult> {
  return call<SaveHomeAccessRequest, SaveHomeAccessResult>('saveHomeAccess', req);
}

// ── getFormSchema (functions/src/portal/getFormSchema.ts) ───────────────────

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
 * Admin-authored dynamic-form schema. Throws (HttpsError 'not-found') when
 * no admin has configured `schemaId` yet — callers should catch and fall
 * back to the static mockup fields, exactly like TribeScreen.kt's
 * best-effort `try { ... } catch (_) { /* keep static fields *\/ }`.
 */
export function getFormSchema(schemaId: 'tribeProfile' | 'homeAccess'): Promise<FormSchemaDto> {
  return call<{ schemaId: string }, FormSchemaDto>('getFormSchema', { schemaId });
}

// ── getVetClinics / submitVetClinic (functions/src/portal/{getVetClinics,submitVetClinic}.ts)

export interface VetClinicDto {
  id: string;
  name: string;
  phone: string;
  address: string;
  website: string;
  googleMapsUrl: string;
  isEmergency: boolean;
}

export interface GetVetClinicsResult {
  clinics: VetClinicDto[];
}

/** The shared, operator-curated vet clinic catalog (approved entries only). */
export function getVetClinics(): Promise<GetVetClinicsResult> {
  return call<Record<string, never>, GetVetClinicsResult>('getVetClinics', {});
}

export interface SubmitVetClinicRequest {
  name: string;
  phone?: string;
  address?: string;
  website?: string;
}

export interface SubmitVetClinicResult {
  clinicId: string;
  created: boolean;
  pending: boolean;
}

/** Lands a PENDING (`verified: false`) clinic entry for operator approval. Idempotent by normalized name. */
export function submitVetClinic(req: SubmitVetClinicRequest): Promise<SubmitVetClinicResult> {
  return call<SubmitVetClinicRequest, SubmitVetClinicResult>('submitVetClinic', req);
}

// ── mapboxSearch / mapboxRetrieve (functions/src/portal/mapboxSearch.ts) ────

export interface MapboxSuggestionDto {
  name: string;
  full_address: string;
  mapbox_id: string;
  place_formatted: string;
}

export interface MapboxSearchResult {
  suggestions: MapboxSuggestionDto[];
  signedBy: 'mapboxSearch';
}

/** Server-side Mapbox Search Box autocomplete proxy (no client-side Mapbox token). */
export function mapboxSearch(query: string, sessionToken: string, limit?: number, country?: string): Promise<MapboxSearchResult> {
  return call<{ query: string; sessionToken: string; limit?: number; country?: string }, MapboxSearchResult>('mapboxSearch', {
    query,
    sessionToken,
    ...(limit !== undefined ? { limit } : {}),
    ...(country !== undefined ? { country } : {}),
  });
}

export interface MapboxRetrieveResult {
  /** Raw GeoJSON Feature (or null); see resolveMapboxAddress for the field extraction. */
  feature: unknown;
  signedBy: 'mapboxRetrieve';
}

/** Resolves a mapbox_id from a suggestion into a full feature (address + coords). */
export function mapboxRetrieve(mapboxId: string, sessionToken: string): Promise<MapboxRetrieveResult> {
  return call<{ mapboxId: string; sessionToken: string }, MapboxRetrieveResult>('mapboxRetrieve', { mapboxId, sessionToken });
}

/**
 * Pulls the display address out of a mapboxRetrieve `feature` GeoJSON object,
 * mirroring Kotlin's `MapboxFeature.resolvedAddress` (MapboxDtos.kt):
 * `properties.full_address`, falling back to `properties.name`.
 */
export function resolveMapboxAddress(feature: unknown): string {
  if (typeof feature !== 'object' || feature === null) return '';
  const props = (feature as Record<string, unknown>)['properties'];
  if (typeof props !== 'object' || props === null) return '';
  const p = props as Record<string, unknown>;
  const full = typeof p['full_address'] === 'string' ? p['full_address'] : '';
  const name = typeof p['name'] === 'string' ? p['name'] : '';
  return full || name;
}

/** Generates a 32-hex-char Mapbox session token, mirroring Kotlin's `newMapboxSessionToken()`. */
export function newMapboxSessionToken(): string {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Normalizes a clinic name for case/space-insensitive dedupe (mirrors submitVetClinic's `normName`). */
export function normalizeClinicName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when `name` already matches a clinic in the catalog, or is blank (nothing to add yet). */
export function clinicAlreadyOnList(name: string, clinics: VetClinicDto[]): boolean {
  const n = normalizeClinicName(name);
  if (n.length === 0) return true;
  return clinics.some((c) => normalizeClinicName(c.name) === n);
}

// ── listMembers (functions/src/portal/listMembers.ts) ────────────────────────

export type MemberRole = 'PRIMARY' | 'SECONDARY';
export type MemberStatus = 'ACTIVE' | 'SUSPENDED' | 'INVITED';

export interface MemberPermissionsDto {
  billing_full: boolean;
  messaging_direct: boolean;
  messaging_group: boolean;
  kin_edit: boolean;
  kintales_only: boolean;
  home_access: boolean;
}

export interface MemberDto {
  uid: string;
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  permissions: MemberPermissionsDto;
  invitedEmail: string | null;
}

export interface ListMembersResult {
  members: MemberDto[];
}

/** Household members roster. PRIMARY-only (operator bypasses); a SECONDARY caller is denied. */
export function listMembers(kinfolkId?: string): Promise<ListMembersResult> {
  const payload = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<{ kinfolkId?: string }, ListMembersResult>('listMembers', payload);
}

// ── updateSecondaryPermissions (functions/src/membership/updateSecondaryPermissions.ts)

export interface UpdateSecondaryPermissionsRequest {
  familyId: string;
  targetUid: string;
  permissions: {
    // RULING: "Primary kinfolk is allowed to set the permissions of the
    // secondary, including billing if they want ... besides admin, primary
    // kinfolk can set permissions for the secondary." The callable's schema was
    // missing billing_full, and being a non-strict object it answered a request
    // to grant it with `{ ok: true }` and no write. It accepts it now.
    // kintales_only stays absent: no path on any surface turns it off.
    billing_full?: boolean;
    messaging_direct?: boolean;
    messaging_group?: boolean;
    kin_edit?: boolean;
    home_access?: boolean;
  };
}

export interface UpdateSecondaryPermissionsResult {
  ok: true;
}

/** PRIMARY-only. Target must be role SECONDARY. Only the passed permission keys are updated. */
export function updateSecondaryPermissions(req: UpdateSecondaryPermissionsRequest): Promise<UpdateSecondaryPermissionsResult> {
  return call<UpdateSecondaryPermissionsRequest, UpdateSecondaryPermissionsResult>('updateSecondaryPermissions', req);
}

// ── addSecondaryContact (functions/src/portal/addSecondaryContact.ts) ───────

export interface AddSecondaryContactRequest {
  kinfolkId?: string;
  invitedEmail: string;
  secondaryLabel?: string;
  permissions?: {
    billing_full?: boolean;
    messaging_direct?: boolean;
    messaging_group?: boolean;
    kin_edit?: boolean;
    kintales_only?: boolean;
    home_access?: boolean;
  };
}

export interface AddSecondaryContactResult {
  inviteId: string;
}

/** PRIMARY-only. Mints an `inviteRequests` doc AuntieOS's `acceptInvite` resolves. Rejects self-invites server-side. */
export function addSecondaryContact(req: AddSecondaryContactRequest): Promise<AddSecondaryContactResult> {
  return call<AddSecondaryContactRequest, AddSecondaryContactResult>('addSecondaryContact', req);
}

/** Friendly label for a member status string, mirrors Kotlin's `statusLabel`. */
export function memberStatusLabel(status: MemberStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'SUSPENDED':
      return 'Suspended';
    case 'INVITED':
      return 'Invite pending';
    default:
      return status;
  }
}

/**
 * Reserved customField keys owned by a dedicated control elsewhere on the
 * Tribe Profile screen (vet clinic / emergency contact / after-hours vet),
 * so the generic "set by your Auntie" custom-field list never double-shows
 * them. Mirrors TribeScreen.kt's `reservedKeys` + `ownedElsewhere`.
 */
export const PROFILE_RESERVED_KEYS = [
  'vetClinicName',
  'vetClinicPhone',
  'vetClinicAddress',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
] as const;

export const HOME_RESERVED_KEYS = ['afterHoursVetName', 'afterHoursVetPhone'] as const;

/** Replaces any customFields under `reservedKeys` with `next`, preserving everything else untouched. */
export function mergeReservedFields(base: CustomFieldDto[], next: CustomFieldDto[], reservedKeys: readonly string[]): CustomFieldDto[] {
  const reserved = new Set(reservedKeys);
  return [...base.filter((f) => !reserved.has(f.key)), ...next];
}

/** True when a custom field has anything worth displaying (mirrors the Kotlin visibility guards). */
export function isDisplayableField(f: CustomFieldDto): boolean {
  return f.label.trim().length > 0 || f.value.trim().length > 0;
}
