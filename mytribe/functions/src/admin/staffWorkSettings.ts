import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { businessTimeZone, resolveBookingPolicy, type BookingMode } from '../lib/bookingTimeBlocks';
import { BUSINESS_SETTINGS_SOURCE_DOC } from '../lib/businessPublicCard';

/**
 * #2164: the few business settings an Auntie's own work reads, and nothing else.
 *
 * `business_settings/business_settings` is owner-only in `firestore.rules`, and
 * stays that way: it carries rates, payment handles, the business phone,
 * integration state and every other switch on Business Settings, which an
 * Auntie never sees (role rule: never money; ruling 2026-11-13: never Business
 * Settings). Her visit, schedule, booking and KinTale template screens still
 * need a handful of its values to work at all (and her household and Kin tag
 * fields need the tag suggestions, #2186), so this callable reads the
 * document on the server and returns a closed projection of it.
 *
 * ── EXACTLY WHAT CROSSES THE BOUNDARY ────────────────────────────────────────
 *
 *   services[]                      the KinCare list: each `serviceRates` KEY
 *                                   (the name) and its stated
 *                                   `serviceDurations` length. Never the rate.
 *   timeZone                        the business clock, resolved
 *   timeBlocks[]                    the Time Block definitions: id, label,
 *                                   start, end, active
 *   allowTimeBlockBooking           the Time Blocks / exact time mode, as
 *   allowSpecificTimeBooking        `resolveBookingPolicy` serves it to the
 *   defaultBookingMode              booking path
 *   requireArrivalDepartureVerification   the arrival rule
 *   kinTaleRequired                 the "KinTale required" switch
 *   householdTagNames[]             #2186: the tag suggestions on a household
 *   kinTagNames[]                   and a Kin profile, by NAME only (the
 *                                   `householdTags` / `petTags` rows' `name`).
 *                                   The color and icon stay on the server.
 *
 * and NOTHING else. Every field is copied by name below, so a field added to
 * the settings document later cannot reach an Auntie by spread. Adding one here
 * is a decision that she may read it.
 *
 * WHY A CALLABLE AND NOT A MIRROR DOCUMENT like `business_public/card`. A
 * mirror is only as fresh as `onBusinessSettingsWrite`, which has no retry and
 * whose events can arrive out of order, and it is only created by the next
 * settings save, so after a deploy her screens would fail until the owner
 * happened to save Settings. A callable reads the document as it stands on
 * every call: nothing to backfill, nothing that can fall behind, and the owner's
 * own reads are untouched.
 *
 * Gated by `wrapAdminCallable` and listed in `lib/auntieAccess.ts`, so the owner
 * and an Auntie may call it and nobody else.
 */

export interface StaffWorkService {
  /** The KinCare's name, which is also its catalog key. */
  id: string;
  /** `serviceDurations[id]` as stored, trimmed. '' when the operator stated none. */
  durationMinutes: string;
}

export interface StaffWorkTimeBlock {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  /** Present only when the stored row says, so the client reads a row exactly as the owner's does. */
  active?: boolean;
}

export interface StaffWorkSettings {
  services: StaffWorkService[];
  timeZone: string;
  /** Null when the document carries no `timeBlocks` list at all, so the client applies its own default. */
  timeBlocks: StaffWorkTimeBlock[] | null;
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  defaultBookingMode: BookingMode;
  requireArrivalDepartureVerification: boolean;
  kinTaleRequired: boolean;
  /** #2186: `householdTags[].name`, trimmed, blanks dropped, in stored order. */
  householdTagNames: string[];
  /** #2186: `petTags[].name`, the same way. */
  kinTagNames: string[];
}

function isPlainMap(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function trimmedString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The KinCare names off `serviceRates`, with their stated lengths. The rate values are never read. */
function servicesFrom(data: Record<string, unknown>): StaffWorkService[] {
  const rates = data['serviceRates'];
  if (!isPlainMap(rates)) return [];
  const durations = isPlainMap(data['serviceDurations']) ? data['serviceDurations'] : {};
  return Object.keys(rates)
    .filter((id) => id.trim() !== '')
    .map((id) => ({ id, durationMinutes: trimmedString(durations[id]) }));
}

function timeBlocksFrom(data: Record<string, unknown>): StaffWorkTimeBlock[] | null {
  const rows = data['timeBlocks'];
  if (!Array.isArray(rows)) return null;
  return rows.filter(isPlainMap).map((row) => ({
    id: trimmedString(row['id']),
    label: trimmedString(row['label']),
    startTime: trimmedString(row['startTime']),
    endTime: trimmedString(row['endTime']),
    ...(typeof row['active'] === 'boolean' ? { active: row['active'] } : {}),
  }));
}

/** The tag NAMES off a `householdTags` / `petTags` list. The color and icon are never read. */
function tagNamesFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const row of raw) {
    if (!isPlainMap(row)) continue;
    const name = trimmedString(row['name']);
    if (name !== '') names.push(name);
  }
  return names;
}

/**
 * Pure: the raw settings document onto the staff projection. The ONLY place the
 * field list is spelled.
 */
export function buildStaffWorkSettings(settings: Record<string, unknown> | undefined): StaffWorkSettings {
  const data = settings ?? {};
  const { policy } = resolveBookingPolicy(data);
  return {
    services: servicesFrom(data),
    timeZone: businessTimeZone(data),
    timeBlocks: timeBlocksFrom(data),
    allowTimeBlockBooking: policy.allowTimeBlockBooking,
    allowSpecificTimeBooking: policy.allowSpecificTimeBooking,
    defaultBookingMode: policy.defaultBookingMode,
    // Only an explicit true is on, as the server enforces both
    // (`lib/arrivalVerification.ts`, `kinTaleRequiredFrom` in
    // `lib/kinTaleRequirement.ts`). Spelled here rather than imported so this
    // entry adds no module to every cold start (test/coldStartImportGraph).
    requireArrivalDepartureVerification: data['requireArrivalDepartureVerification'] === true,
    kinTaleRequired: data['kinTaleRequired'] === true,
    householdTagNames: tagNamesFrom(data['householdTags']),
    kinTagNames: tagNamesFrom(data['petTags']),
  };
}

export async function getStaffWorkSettingsHandler(_req: CallableRequest<unknown>): Promise<StaffWorkSettings> {
  // A failed read throws, and the caller's screen says so. Answering with
  // defaults here would put her visit times on a clock the business never set.
  const snap = await db().doc(BUSINESS_SETTINGS_SOURCE_DOC).get();
  return buildStaffWorkSettings(snap.data() as Record<string, unknown> | undefined);
}

export const getStaffWorkSettings = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getStaffWorkSettings', getStaffWorkSettingsHandler),
);
