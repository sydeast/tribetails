import { type CollectionSpec } from '../lib/firestore';
import type { BusySlotEntry } from './schedule';
import type { SessionEntry } from './sessions';

/**
 * The two READS that tell the booking date picker whether a day is actually
 * free. Both collections are already read by the Schedule screen; what is new
 * here is the DIRECTION, and that is the whole reason these are separate
 * `CollectionSpec`s rather than an import of `api/schedule.ts`'s pair.
 *
 * Schedule is a browse-any-month calendar, so it takes the OLDEST 500 blocked
 * slots (`date` ascending) and the most-future 300 sessions. A picker only ever
 * looks forward: the oldest 500 blocked slots on a mature account are all
 * history, and a picker fed those would show every future day as clear. Both
 * specs below are therefore future-first.
 *
 * No callable is missing here. `firestore.rules` grants an authenticated Auntie
 * an unfiltered read on `booking_time_slots` (`allow read: if isAuntie()`, all
 * writes server-side only) and on `kin_care_sessions`, and the business-hours
 * half comes from the `business_settings/business_settings` doc the dialog
 * already reads through `getBusinessSettings`. Everything the picker needs is
 * reachable with the client SDK the admin already uses.
 *
 * NEITHER spec carries `filters`. A `where` on the same field as the `orderBy`
 * would need no composite index, but it would also mean a doc whose date field
 * is missing or oddly formatted silently vanishes from the availability picture
 * rather than being visibly ignored, and a booking picker that quietly forgets
 * a blocked window is worse than one that reads a few stale rows.
 */

/** Same doc shape the Schedule overlay reads; every field optional, it is a cast over raw data. */
export type AvailabilityBusySlot = BusySlotEntry;

/** Same doc shape Sessions and Schedule read. */
export type AvailabilitySession = SessionEntry;

/**
 * Blocked and Google-busy windows, most-future first.
 *
 * `date` descending with a 500 cap keeps the window of days a picker can
 * actually reach (it opens on this month and pages forward), where ascending
 * would spend the whole budget on the past.
 */
export const AVAILABILITY_BUSY_SLOTS_QUERY: CollectionSpec = {
  path: 'booking_time_slots',
  order: ['date', 'desc'],
  max: 500,
};

/**
 * Already-scheduled visits, most-future first.
 *
 * Same 300 cap and same `startTime` descending order Sessions and Schedule use,
 * with the same known caveats (lexical sort across mixed UTC/offset writers,
 * `orderBy` dropping any doc with no `startTime`). Those affect WHICH 300 rows
 * arrive, not the correctness of the per-day counts computed from them, and a
 * count is the softest signal this picker shows: it never disables a day.
 */
export const AVAILABILITY_SESSIONS_QUERY: CollectionSpec = {
  path: 'kin_care_sessions',
  order: ['startTime', 'desc'],
  max: 300,
};
