import type { TimeBlockDefinition } from '../api/settings';
import { businessWallClock } from './businessZoneTime';
import { minutesOfDayFromHhmm } from './businessOperations';

/**
 * #1863 / #2034: WHAT A HOUSEHOLD IS SHOWN FOR A VISIT, mirrored from the
 * server rule (`mytribe/functions/src/lib/bookingTimeBlocks.ts`:
 * `storedBookingMode`, `resolveBookingPolicy`, `householdBlockFor`). The
 * portal is told by the server; the office's own screens (the Bookings row)
 * use this copy so they say the same thing. Both run the shared case table in
 * `mytribe/functions/test/fixtures/householdVisitTime.json`.
 *
 * Operator rulings: one Business Settings mode, Time Blocks or Exact times
 * (2026-11-12). In Time Blocks mode the household sees only blocks, and a
 * clock time the office booked in no block is shown as "The nearest block"
 * (2026-11-13). In Exact times mode it sees the clock.
 */

/** The one mode. Wire values, as `defaultBookingMode` stores them. */
export type HouseholdTimeMode = 'TIME_BLOCK' | 'SPECIFIC_TIME';

/** The fields the mode is written as. Every Settings editor writes all three. */
export interface BookingModeFields {
  defaultBookingMode?: unknown;
  allowTimeBlockBooking?: unknown;
  allowSpecificTimeBooking?: unknown;
}

/** The three fields for a mode, exactly as `saveBusinessSettings` accepts them. */
export function bookingModeFields(mode: HouseholdTimeMode): {
  defaultBookingMode: HouseholdTimeMode;
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
} {
  return {
    defaultBookingMode: mode,
    allowTimeBlockBooking: mode === 'TIME_BLOCK',
    allowSpecificTimeBooking: mode === 'SPECIFIC_TIME',
  };
}

/**
 * The mode as STORED (server `storedBookingMode`): exactly one switch on is
 * that switch; both on (the stored default) or both off is the mode
 * `defaultBookingMode` names, which defaults to SPECIFIC_TIME.
 */
export function storedHouseholdTimeMode(s: BookingModeFields): HouseholdTimeMode {
  const block = typeof s.allowTimeBlockBooking === 'boolean' ? s.allowTimeBlockBooking : true;
  const specific = typeof s.allowSpecificTimeBooking === 'boolean' ? s.allowSpecificTimeBooking : true;
  if (block && !specific) return 'TIME_BLOCK';
  if (!block && specific) return 'SPECIFIC_TIME';
  return s.defaultBookingMode === 'TIME_BLOCK' ? 'TIME_BLOCK' : 'SPECIFIC_TIME';
}

/** One readable, active block: what the server's `parseTimeBlockRow` keeps. */
export interface HouseholdBlock {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  start: number;
  end: number;
}

/** 'midday' -> 'Midday', 'late-afternoon' -> 'Late Afternoon', as the server names an unlabelled row. */
function labelFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The active, readable blocks in start order, read the way the server reads
 * them: an inactive row, a row with no id or no readable start is dropped; a
 * row with no readable end runs for `defaultTimeBlockDurationHours` (4 when
 * unset), never past midnight.
 */
export function usableBlocks(
  rows: readonly TimeBlockDefinition[],
  defaultTimeBlockDurationHours?: number,
): HouseholdBlock[] {
  const hours =
    typeof defaultTimeBlockDurationHours === 'number' && Number.isFinite(defaultTimeBlockDurationHours) && defaultTimeBlockDurationHours > 0
      ? defaultTimeBlockDurationHours
      : 4;
  const out: HouseholdBlock[] = [];
  for (const row of rows) {
    if (!row || row.active === false) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id === '') continue;
    const start = minutesOfDayFromHhmm(row.startTime);
    if (start === null || start > 24 * 60 - 1) continue;
    const endText = typeof row.endTime === 'string' ? row.endTime.trim() : '';
    const parsedEnd = endText === '24:00' ? 24 * 60 : minutesOfDayFromHhmm(endText);
    const end =
      parsedEnd !== null && parsedEnd > start ? parsedEnd : Math.min(24 * 60, start + Math.max(1, Math.round(hours * 60)));
    if (end <= start) continue;
    const label = typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : labelFromId(id);
    out.push({ id, label, startTime: hhmm(start), endTime: end === 24 * 60 ? '24:00' : hhmm(end), start, end });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** What the household-time rule needs to know about the business. */
export interface HouseholdTimeSettings extends BookingModeFields {
  timeBlocks: readonly TimeBlockDefinition[];
  defaultTimeBlockDurationHours?: number;
  /** The KinCare names (catalog keys) booked and shown by the clock (#1092). */
  startTimeServiceIds: readonly string[];
}

/**
 * The mode the household is SERVED (server `resolveBookingPolicy`): the stored
 * mode, except Time Blocks with no usable block, which is served as Exact
 * times because there is nothing to show.
 */
export function servedHouseholdTimeMode(s: HouseholdTimeSettings): HouseholdTimeMode {
  const stored = storedHouseholdTimeMode(s);
  if (stored === 'TIME_BLOCK' && usableBlocks(s.timeBlocks, s.defaultTimeBlockDurationHours).length === 0) {
    return 'SPECIFIC_TIME';
  }
  return stored;
}

/**
 * The block for a business-local minute of the day (server
 * `nearestBlockForMinutes`): the booked block when the start is inside it,
 * else the first block containing it, else the nearest by distance to the
 * closer edge; a TIE goes to the earlier block.
 */
export function nearestBlockForMinutes(
  minutes: number,
  storedBlockId: string,
  blocks: readonly HouseholdBlock[],
): HouseholdBlock | null {
  if (blocks.length === 0) return null;
  const inside = (b: HouseholdBlock) => minutes >= b.start && minutes < b.end;
  const booked = storedBlockId === '' ? undefined : blocks.find((b) => b.id === storedBlockId);
  if (booked && inside(booked)) return booked;
  const containing = blocks.find(inside);
  if (containing) return containing;
  let best = blocks[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    const distance = minutes < b.start ? b.start - minutes : minutes - b.end;
    if (distance < bestDistance) {
      best = b;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The block a household sees for a visit, or null when it sees the clock
 * (Exact times mode, no start, or a start-time KinCare). `startMs` is read on
 * the BUSINESS clock, never the device's.
 */
export function householdBlockFor(
  visit: { startMs: number | null; timeBlockId?: string | null; serviceId?: string | null },
  settings: HouseholdTimeSettings,
  businessZone: string,
): HouseholdBlock | null {
  if (servedHouseholdTimeMode(settings) !== 'TIME_BLOCK') return null;
  if (visit.startMs === null || !Number.isFinite(visit.startMs)) return null;
  if (visit.serviceId && settings.startTimeServiceIds.includes(visit.serviceId)) return null;
  const minutes = minutesOfDayFromHhmm(businessWallClock(visit.startMs, businessZone).hhmm);
  if (minutes === null) return null;
  return nearestBlockForMinutes(
    minutes,
    (visit.timeBlockId ?? '').trim(),
    usableBlocks(settings.timeBlocks, settings.defaultTimeBlockDurationHours),
  );
}

/** The start-time KinCares off `business_settings.serviceStartTimeBooking`, as the server reads them. */
export function startTimeServiceIdsFrom(map: Record<string, unknown> | undefined): string[] {
  return Object.entries(map ?? {})
    .filter(([id, flag]) => flag === true && id.trim() !== '')
    .map(([id]) => id)
    .sort();
}
