/**
 * Wire types + wrapper functions for the Tribe hub / Tribe profile editor
 * callables. Self-contained (per S3 merge-conflict guardrail) rather than
 * folded into api/types.ts + api/portal.ts. Field names/types are
 * transcribed from the backend handlers; each block cites its source file.
 */
import { FirebaseError } from 'firebase/app';
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
  /**
   * #843: may this caller change home details, the Emergency Contact included.
   * Absent from a backend older than #843, which reads as allowed; the server
   * enforces the rule either way.
   */
  canEditHomeDetails?: boolean;
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
  /** #873: merged by key into the stored rows. A row not sent is kept. */
  customFields?: CustomFieldDto[];
  /** #873: the only way to delete a stored row. */
  removeCustomFieldKeys?: string[];
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
  /** #873: merged by key into the stored rows. A row not sent is kept. */
  customFields?: CustomFieldDto[];
  /** #873: the only way to delete a stored row. */
  removeCustomFieldKeys?: string[];
}

export interface SaveHomeAccessResult {
  ok: true;
}

/** Additive: writes `families/{kinfolkId}/homeAccess/current`. Requires `home_access` perm. */
export function saveHomeAccess(req: SaveHomeAccessRequest): Promise<SaveHomeAccessResult> {
  return call<SaveHomeAccessRequest, SaveHomeAccessResult>('saveHomeAccess', req);
}

// ── Emergency Contacts (functions/src/portal/emergencyContacts.ts, #829) ────

export interface EmergencyContactDto {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

export interface ListEmergencyContactsResult {
  contacts: EmergencyContactDto[];
  /** True when the caller holds home_access (staff and the primary always do). */
  canEdit: boolean;
  legacy: boolean;
}

/** Any ACTIVE household member may read. Index 0 is called first. */
export function listEmergencyContacts(kinfolkId?: string): Promise<ListEmergencyContactsResult> {
  return call<{ kinfolkId?: string }, ListEmergencyContactsResult>('listEmergencyContacts', kinfolkId !== undefined ? { kinfolkId } : {});
}

export interface SaveEmergencyContactsRequest {
  kinfolkId?: string;
  contacts: Array<{ name: string; phone: string; relationship: string | null }>;
}

/** Replaces the household's list whole, index 0 called first. Needs home_access. */
export function saveEmergencyContacts(req: SaveEmergencyContactsRequest): Promise<{ contacts: EmergencyContactDto[] }> {
  return call<SaveEmergencyContactsRequest, { contacts: EmergencyContactDto[] }>('saveEmergencyContacts', req);
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
  /**
   * The ids of near-matches the user was SHOWN and chose not to use. Sending
   * them is what authorizes a create over the top of a match.
   *
   * Deliberately NOT a `confirmCreate` boolean: a boolean could be set by a
   * client that rendered nothing, whereas these ids can only have come from the
   * previous response, so echoing them is evidence the choice was presented.
   * See `functions/src/lib/vetClinicMatch.ts#acknowledgesAll`.
   */
  acknowledgedMatchIds?: string[];
}

/** A possible match the user must choose between. */
export interface ClinicCandidateDto {
  id: string;
  name: string;
  address: string;
  phone: string;
  isEmergency: boolean;
  /** False for a submission still awaiting operator approval. */
  verified: boolean;
  reason: 'name' | 'phone' | 'similar';
}

export interface SubmitVetClinicResult {
  /** `needs_choice` means NOTHING was written and `candidates` must be shown. */
  status: 'created' | 'needs_choice';
  clinicId: string;
  created: boolean;
  pending: boolean;
  candidates: ClinicCandidateDto[];
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

// ── household contacts (functions/src/portal/householdContacts.ts) ──────────

/**
 * A person the household can be reached through who holds no portal account.
 *
 * OPERATOR RULING (2026-09-12): "a secondary contact does not have to be a
 * portal user. primary kinfolk user will invite a second kinfolk to the
 * household to manage and receive notifications." Two gestures, two outcomes.
 * `addSecondaryContact` above is the second one — it mints an invite and hands
 * somebody a sign-in. This block is the first, and it mints nothing: no
 * `inviteRequests` row, no account, no `MemberPermissions`.
 *
 * THE REQUEST SHAPE IS THE WALL, on this side as well as the server's. The
 * payload built below carries exactly `name`, `label`, `phone`, `email` and the
 * optional `contactId`/`kinfolkId`. It has no `permissions` field to fill and
 * no `role`, so a screen cannot reach the invite through the contact door by
 * passing one — and if it somehow did, every schema in
 * `functions/src/portal/householdContacts.ts` is `.strict()` and answers
 * `invalid-argument` naming the key rather than stripping it.
 *
 * `kinfolkId` is OPTIONAL here and required in the admin's twin
 * (`auntieos-admin/src/api/householdContacts.ts`). The admin always targets a
 * household it picked from a list; a household targets itself, and the server
 * resolves that from `clients/{uid}.kinfolkIds` when the key is absent — the
 * same asymmetry `listMembers` already has.
 */

/** `CONTACT_NAME_MAX` in `mytribe/functions/src/portal/householdContacts.ts`. */
export const CONTACT_NAME_MAX = 80;
/** `CONTACT_PHONE_MAX`, same file. */
export const CONTACT_PHONE_MAX = 32;
/** `SECONDARY_LABEL_MAX` in `mytribe/functions/src/lib/schema.ts`. */
export const CONTACT_LABEL_MAX = 24;
/** `DEFAULT_CONTACT_LABEL`. What a contact is called when nobody says. */
export const DEFAULT_CONTACT_LABEL = 'Folk';

export interface HouseholdContactDto {
  contactId: string;
  name: string;
  label: string;
  /** Null means there is none, never "unknown". */
  phone: string | null;
  /**
   * Somewhere to reach this person, and nothing more. It grants no account and
   * sends no invite; the server writes no `inviteRequests` row for a contact.
   */
  email: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HouseholdContactInput {
  /** Absent creates. Present edits that contact in place. */
  contactId?: string;
  name: string;
  label: string;
  phone: string;
  email: string;
}

function contactText(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asContact(raw: unknown): HouseholdContactDto | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const contactId = contactText(c['contactId']);
  // No id means no row the household could edit or delete, so it is dropped
  // rather than drawn as a line with two dead buttons on it.
  if (contactId === null) return null;
  return {
    contactId,
    name: contactText(c['name']) ?? '(unnamed contact)',
    label: contactText(c['label']) ?? DEFAULT_CONTACT_LABEL,
    phone: contactText(c['phone']),
    email: contactText(c['email']),
    createdAt: contactText(c['createdAt']),
    updatedAt: contactText(c['updatedAt']),
  };
}

/** PRIMARY-only (operator bypasses). Order is the server's: by name. */
export async function listHouseholdContacts(kinfolkId?: string): Promise<HouseholdContactDto[]> {
  const payload = kinfolkId !== undefined ? { kinfolkId } : {};
  const res = await call<{ kinfolkId?: string }, { contacts?: unknown }>('listHouseholdContacts', payload);
  const rows = res?.contacts;
  // A shape we cannot read is not an empty household. Answering "no contacts"
  // off an unreadable payload is the fabricated-success failure the repo
  // forbids, and `queryState` can only tell a proven-empty list from an unknown
  // one if the unknown one throws.
  if (!Array.isArray(rows)) throw new Error('listHouseholdContacts returned no contacts array.');
  return rows.map(asContact).filter((c): c is HouseholdContactDto => c !== null);
}

/**
 * The exact request `saveHouseholdContact` is called with.
 *
 * Split out of the call so a test can assert the KEY SET rather than only the
 * values: the claim that matters is that this client sends no `permissions` and
 * no `role`, and a test that only checks the four fields it does send would
 * still pass with a fifth one smuggled in beside them.
 */
export function buildSaveContactPayload(
  input: HouseholdContactInput,
  kinfolkId?: string,
): { kinfolkId?: string; contactId?: string; name: string; label: string; phone: string; email: string } {
  const name = input.name.trim();
  if (name === '') throw new Error('A contact needs a name.');
  // EVERY EDITABLE FIELD IS SENT, including the empty ones: the server persists
  // `''` as `null`, so a cleared phone number actually goes away. Omitting a
  // blank field would leave the stale value on the document forever.
  const payload: { kinfolkId?: string; contactId?: string; name: string; label: string; phone: string; email: string } = {
    name,
    label: input.label.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
  };
  if (kinfolkId !== undefined) payload.kinfolkId = kinfolkId;
  const contactId = input.contactId?.trim();
  if (contactId !== undefined && contactId !== '') payload.contactId = contactId;
  return payload;
}

/**
 * Creates or edits one contact. No portal account is created either way.
 *
 * `createdAt` / `createdBy` are the server's and are never sent from here, so
 * an edit cannot rewrite a record's provenance.
 */
export async function saveHouseholdContact(
  input: HouseholdContactInput,
  kinfolkId?: string,
): Promise<{ contactId: string; created: boolean }> {
  const payload = buildSaveContactPayload(input, kinfolkId);
  const res = await call<typeof payload, { contactId?: unknown; created?: unknown }>('saveHouseholdContact', payload);
  const savedId = contactText(res?.contactId);
  if (savedId === null) throw new Error('saveHouseholdContact returned no contact id.');
  return { contactId: savedId, created: res?.created === true };
}

/**
 * Deletes one contact. HARD, unlike removing a member: there is no account to
 * suspend and no sign-in history to keep, so the row is gone.
 */
export async function removeHouseholdContact(contactId: string, kinfolkId?: string): Promise<void> {
  const cid = contactId.trim();
  if (cid === '') throw new Error('removeHouseholdContact requires a contact id');
  const payload = kinfolkId !== undefined ? { kinfolkId, contactId: cid } : { contactId: cid };
  await call<{ kinfolkId?: string; contactId: string }, { ok: true }>('removeHouseholdContact', payload);
}

/** "Sister · 805 555 0143 · ada@example.com", skipping what is absent. */
export function contactMetaLine(contact: HouseholdContactDto): string {
  return [contact.label, contact.phone, contact.email]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' · ');
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
 * Tribe Profile screen (vet clinic / emergency contact), so the generic "set
 * by your Auntie" custom-field list never double-shows them. Applied to
 * `profile.customFields` only; see [HOME_RESERVED_KEYS] for the home-access
 * store. #872: mirrors TribeScreen.kt's `SCREEN_OWNED_CUSTOM_FIELD_KEYS`,
 * which is one set covering both stores because Android's CustomFieldList is
 * shared between them and the keys never cross stores.
 */
export const PROFILE_RESERVED_KEYS = [
  'vetClinicName',
  'vetClinicPhone',
  'vetClinicAddress',
  // #829: no longer written here; Emergency Contacts go through
  // saveEmergencyContacts. Kept reserved so a stale copy is dropped from
  // customFields on the next save instead of riding along forever.
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

/** #829: stored for old clients and the migration only. This screen never sends them. */
export const LEGACY_EMERGENCY_CONTACT_KEYS = ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'] as const;

/**
 * #873. The row a schema field saves, or null when the stored row stays as it is.
 *
 * `value` undefined means the form never held the key: nothing stored, nothing
 * typed. A value equal to the stored one is untouched. `''` over a stored value
 * is a real clear and is sent. `''` with nothing stored writes no empty row.
 */
export function schemaFieldRow(stored: readonly CustomFieldDto[], field: { key: string; label: string }, value: string | undefined): CustomFieldDto | null {
  if (value === undefined) return null;
  const current = stored.find((f) => f.key === field.key);
  if (current) return value === current.value ? null : { key: field.key, label: field.label || current.label || field.key, value };
  return value === '' ? null : { key: field.key, label: field.label || field.key, value };
}

/**
 * #873. The save payload: the stored rows, in order, with [set] applied by key
 * (a new key is appended) and every stored key in [clear] removed and named in
 * `removeCustomFieldKeys`, because the callables merge by key and keep a row that
 * is merely omitted. Keys in [drop] are never sent and never named. A stored
 * duplicate key is folded into its first position.
 *
 * The full list is sent, not just the changes, so the payload is also right
 * against a server that still replaces the list whole.
 */
export function editCustomFields(
  stored: readonly CustomFieldDto[],
  set: readonly CustomFieldDto[],
  clear: readonly string[],
  drop: readonly string[] = [],
): { customFields: CustomFieldDto[]; removeCustomFieldKeys: string[] } {
  const dropKeys = new Set(drop);
  const clearKeys = new Set(clear);
  const latest = new Map<string, CustomFieldDto>();
  for (const row of set) latest.set(row.key, row);
  const placed = new Set<string>();
  const removed = new Set<string>();
  const customFields: CustomFieldDto[] = [];
  for (const row of stored) {
    if (dropKeys.has(row.key)) continue;
    if (clearKeys.has(row.key)) {
      removed.add(row.key);
      continue;
    }
    if (placed.has(row.key)) continue;
    customFields.push(latest.get(row.key) ?? row);
    placed.add(row.key);
  }
  for (const row of latest.values()) {
    if (placed.has(row.key) || clearKeys.has(row.key) || dropKeys.has(row.key)) continue;
    customFields.push(row);
    placed.add(row.key);
  }
  return { customFields, removeCustomFieldKeys: [...removed] };
}

/**
 * #873 second review. saveTribeProfile and saveHomeAccess each allow 60 saves an
 * hour per household and refuse the next with `resource-exhausted`. Starts with
 * "Save failed" like every other page-save failure. Same text as portal Android's
 * PROFILE_SAVE_RATE_LIMITED_MESSAGE.
 */
export const PROFILE_SAVE_RATE_LIMITED_MESSAGE =
  'Save failed: this household has saved too many times in the last hour. Wait a little, then save again.';

/** The page-save failure line for a rejected saveTribeProfile or saveHomeAccess. */
export function profileSaveErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError && err.code === 'functions/resource-exhausted') return PROFILE_SAVE_RATE_LIMITED_MESSAGE;
  return `Save failed: ${err instanceof Error ? err.message : 'unknown error'}`;
}

/**
 * #868: shown in place of the home details (Home Information and the after-hours
 * clinic) when `getMyTribeProfile` says the caller has no Home access. The server
 * sends no values to such a caller, so there is nothing to show read-only. Same
 * text as portal Android's HOME_DETAILS_LOCKED.
 */
export const HOME_DETAILS_LOCKED =
  'Only someone with Home access can see or change the home details. Your primary kinfolk can give you Home access.';

/** #868: what the page Save would send to saveHomeAccess. */
export interface HomeAccessEdit {
  gateCode: string | null;
  keyLocation: string | null;
  wifiPassword: string | null;
  customFields: CustomFieldDto[];
  removeCustomFieldKeys: string[];
}

/**
 * #868: true when [next] would change what was loaded. The page Save calls
 * saveHomeAccess only then, so a save that touched only the Family or Vet Clinic
 * card makes no home access call. Mirrors `homeAccessEditChanged` in TribeScreen.kt.
 */
export function homeAccessEditChanged(loaded: HomeAccessDto, next: HomeAccessEdit, drop: readonly string[] = []): boolean {
  const stored = (v: string | null) => (v === null || v === '' ? null : v);
  if (next.gateCode !== stored(loaded.gateCode)) return true;
  if (next.keyLocation !== stored(loaded.keyLocation)) return true;
  if (next.wifiPassword !== stored(loaded.wifiPassword)) return true;
  if (next.removeCustomFieldKeys.length > 0) return true;
  const unedited = editCustomFields(loaded.customFields, [], [], drop).customFields;
  return JSON.stringify(next.customFields) !== JSON.stringify(unedited);
}

/** #868: what became of one half of the page Save. */
export type SaveHalf = { kind: 'saved' } | { kind: 'skipped' } | { kind: 'failed'; error: unknown };

/** The reason a half failed, as a sentence that says what to do, with no "Save failed:" in front. */
function saveFailureReason(err: unknown): string {
  if (err instanceof FirebaseError && err.code === 'functions/resource-exhausted') {
    return 'this household has saved too many times in the last hour. Wait a little, then save again.';
  }
  const message = (err instanceof Error ? err.message : 'unknown error').trim().replace(/[.\s]+$/, '');
  return `${message}. Press Save Changes to try again.`;
}

/**
 * #868: the page Save's status line. The profile half (Family and Vet Clinic)
 * and the home half (Home Information and the after-hours clinic) are separate
 * callables, so one can land while the other is refused. A partial result names
 * what saved and what did not, and never starts "Save failed". It is still
 * coloured as a failure. Mirrors `pageSaveOutcome` in TribeScreen.kt.
 */
export function pageSaveOutcome(profile: SaveHalf, home: SaveHalf, ecDirty: boolean): { text: string; ok: boolean } {
  if (profile.kind === 'failed' && home.kind === 'saved') {
    return {
      text: `Home Information and the after-hours clinic saved. Family and Vet Clinic did not save: ${saveFailureReason(profile.error)} Your edits there are still on this page.`,
      ok: false,
    };
  }
  if (profile.kind === 'failed') return { text: profileSaveErrorMessage(profile.error), ok: false };
  if (home.kind === 'failed') {
    return {
      text: `Family and Vet Clinic saved. Home Information and the after-hours clinic did not save: ${saveFailureReason(home.error)} Your edits there are still on this page.`,
      ok: false,
    };
  }
  return {
    text: ecDirty ? 'Profile saved. Your Emergency Contacts are not saved yet: use Save Emergency Contacts.' : 'Saved.',
    ok: true,
  };
}

/**
 * #868: where an error from the row building AROUND the two callables belongs.
 * Both callables catch their own refusal, so anything left is the code that
 * assembles what they send, and it belongs to the half it was assembling for.
 * Without this the status line reads "Saved." over a save that never happened,
 * which is the bug #868 is about, pointing the other way. Mirrors
 * `blameUnfinishedHalf` in TribeScreen.kt.
 */
export function blameUnfinishedHalf(profile: SaveHalf, home: SaveHalf, error: unknown): { profile: SaveHalf; home: SaveHalf } {
  if (profile.kind === 'skipped') return { profile: { kind: 'failed', error }, home };
  if (home.kind === 'skipped') return { profile, home: { kind: 'failed', error } };
  return { profile, home };
}

/** True when a custom field has anything worth displaying (mirrors the Kotlin visibility guards). */
export function isDisplayableField(f: CustomFieldDto): boolean {
  return f.label.trim().length > 0 || f.value.trim().length > 0;
}
