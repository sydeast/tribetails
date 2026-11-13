import { call } from '../lib/fns';
import { arr, str } from '../lib/coerce';
import { currentSessionSeat, type SessionSeat } from '../lib/sessionSeat';
import { getBusinessSettings, mergeBusinessSettings, type BusinessSettings, type TimeBlockDefinition } from './settings';
import { startTimeServiceIdsFrom } from '../lib/householdVisitTime';

/**
 * #2164: the business settings a staff member's own WORK reads (visits, the
 * schedule, bookings, KinTale templates, the Auntie Time board), for whoever is
 * signed in.
 *
 * TWO SOURCES, ONE SHAPE.
 *   - The owner (and the Stage 0I test admin) read `business_settings`
 *     directly, exactly as before (`getBusinessSettings`). Nothing about the
 *     owner's read changes.
 *   - An Auntie cannot read that document (owner-only in `firestore.rules`),
 *     so her session calls `getStaffWorkSettings`, which returns a closed
 *     projection of it (mytribe/functions/src/admin/staffWorkSettings.ts).
 *
 * Both are decoded through `mergeBusinessSettings`, so a field the document
 * lacks takes the same default on either side and her screens cannot drift from
 * the owner's.
 *
 * NO PRICES FOR AN AUNTIE. `serviceRates` here is the KinCare catalog keyed by
 * name, which is how every screen below finds a KinCare. On the owner's read the
 * values are the rates, as stored. On an Auntie's the server never sends a rate,
 * so every value is '', which every reader already treats as "no rate set"
 * (`serviceChipLabel` prints the bare name).
 */
export interface WorkSettings {
  /** KinCare name -> rate. Every value is '' for an Auntie. */
  serviceRates: Record<string, string>;
  /** False on an Auntie's read: no rate was sent, so a screen hides its Rate row rather than show it blank. */
  ratesIncluded: boolean;
  serviceDurations: Record<string, string>;
  /** As stored (owner) or as the server resolved it (Auntie); read through `resolveBusinessTimeZone`. */
  timeZone: string;
  timeBlocks: TimeBlockDefinition[];
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  defaultBookingMode: string;
  /** #1863: the KinCare names a household sees by the clock even in Time Blocks mode (#1092). */
  startTimeServiceIds: string[];
  /** How long a block with no stated end runs. Not sent to an Auntie; the server's own default (4) then. */
  defaultTimeBlockDurationHours?: number;
  requireArrivalDepartureVerification: boolean;
  kinTaleRequired: boolean;
  /** The owner's Schedule snap. Not sent to an Auntie, so hers is the default (off). */
  snapRescheduleTo15Min: boolean;
}

/** The owner's full settings, narrowed to the work fields. Tolerates a partial object. */
export function workSettingsFromBusinessSettings(s: Partial<BusinessSettings>): WorkSettings {
  return {
    serviceRates: s.serviceRates ?? {},
    ratesIncluded: true,
    serviceDurations: s.serviceDurations ?? {},
    timeZone: s.timeZone ?? '',
    timeBlocks: s.timeBlocks ?? [],
    allowTimeBlockBooking: s.allowTimeBlockBooking ?? true,
    allowSpecificTimeBooking: s.allowSpecificTimeBooking ?? true,
    defaultBookingMode: s.defaultBookingMode ?? '',
    startTimeServiceIds: startTimeServiceIdsFrom(s.serviceStartTimeBooking),
    ...(typeof s.defaultTimeBlockDurationHours === 'number'
      ? { defaultTimeBlockDurationHours: s.defaultTimeBlockDurationHours }
      : {}),
    requireArrivalDepartureVerification: s.requireArrivalDepartureVerification === true,
    kinTaleRequired: s.kinTaleRequired === true,
    snapRescheduleTo15Min: s.snapRescheduleTo15Min === true,
  };
}

/** The `getStaffWorkSettings` reply, as the server sends it. Every field optional: the decoder defaults. */
interface RawStaffWorkSettings {
  services?: Array<{ id?: unknown; durationMinutes?: unknown }>;
  timeZone?: unknown;
  timeBlocks?: unknown;
  allowTimeBlockBooking?: unknown;
  allowSpecificTimeBooking?: unknown;
  defaultBookingMode?: unknown;
  startTimeServiceIds?: unknown;
  requireArrivalDepartureVerification?: unknown;
  kinTaleRequired?: unknown;
}

/**
 * The staff projection onto `WorkSettings`, through the same merge the owner's
 * document goes through. Exported for the api test.
 */
export function decodeStaffWorkSettings(raw: RawStaffWorkSettings | null | undefined): WorkSettings {
  const r = raw ?? {};
  const serviceRates: Record<string, string> = {};
  const serviceDurations: Record<string, string> = {};
  for (const row of arr<{ id?: unknown; durationMinutes?: unknown }>(r.services)) {
    const id = str(row?.id);
    if (id.trim() === '') continue;
    serviceRates[id] = '';
    const minutes = str(row?.durationMinutes).trim();
    if (minutes !== '') serviceDurations[id] = minutes;
  }
  const merged = mergeBusinessSettings({
    serviceRates,
    serviceDurations,
    timeZone: r.timeZone,
    ...(Array.isArray(r.timeBlocks) ? { timeBlocks: r.timeBlocks } : {}),
    allowTimeBlockBooking: typeof r.allowTimeBlockBooking === 'boolean' ? r.allowTimeBlockBooking : undefined,
    allowSpecificTimeBooking: typeof r.allowSpecificTimeBooking === 'boolean' ? r.allowSpecificTimeBooking : undefined,
    defaultBookingMode: r.defaultBookingMode,
    requireArrivalDepartureVerification: r.requireArrivalDepartureVerification,
    kinTaleRequired: r.kinTaleRequired,
  });
  return {
    ...workSettingsFromBusinessSettings(merged),
    ratesIncluded: false,
    // #1863: sent by the server as names; a stray non-string is dropped.
    startTimeServiceIds: arr<unknown>(r.startTimeServiceIds).filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    ),
  };
}

/** The work settings for [seat]: the owner's direct read, or the Auntie's narrow callable. */
export async function getWorkSettingsFor(seat: SessionSeat): Promise<WorkSettings> {
  if (seat.caretaker) {
    const raw = await call<Record<string, never>, RawStaffWorkSettings>('getStaffWorkSettings', {});
    return decodeStaffWorkSettings(raw);
  }
  return workSettingsFromBusinessSettings(await getBusinessSettings());
}

/**
 * The work settings for whoever is signed in. One read per call; the hooks in
 * `lib/useWorkSettings.ts` share one across a board. THROWS on a failed read,
 * for the screen to say so.
 */
export async function getWorkSettings(): Promise<WorkSettings> {
  return getWorkSettingsFor(await currentSessionSeat());
}
