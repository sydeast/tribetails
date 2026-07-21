import { type CollectionSpec } from '../lib/firestore';
import type { SessionEntry } from './sessions';

/**
 * `Schedule` ("The Den · Schedule", nav slug `schedule` per `lib/nav.ts`) reads
 * TWO collections, confirmed against three independent sources per collection
 * (not assumed from the wasm model alone), see `lib/scheduleFormat.ts` for the
 * full rationale on the busy-slot timezone caveat:
 *
 *  - `kin_care_sessions`, the SAME collection Sessions.tsx ("Auntie Time")
 *    already reads (`ScheduleScreen.kt`'s `client.sessionsStream()` reads the
 *    identical flat collection Sessions' `KinCareSessionsScreen.kt` does).
 *    `ScheduleSessionEntry` is a type alias to `SessionEntry`, not a
 *    re-declaration, this is genuinely one doc shape read by two independent
 *    screens/listeners, not two shapes that happen to look alike.
 *  - `booking_time_slots`, Google Calendar "Busy" imports
 *    (`syncGoogleCalendarBusyEvents.ts`) plus admin-created BLOCKED windows
 *    (`createBlockedTimeSlot.ts`). `firestore.rules:565`:
 *    `match /booking_time_slots/{id} { allow read: if isAuntie(); allow write: if false; }`,
 *    an admin gets an unfiltered collection read; all writes are server-side
 *    only (both callables above), confirming this really is a read-only feed
 *    for this screen.
 */
export type ScheduleSessionEntry = SessionEntry;

/**
 * The bounded, server-ordered `kin_care_sessions` listener FOR THIS SCREEN.
 * Same shape as `api/sessions.ts`'s `SESSIONS_QUERY` (ordered `startTime`
 * desc, capped 300, same AO-29 rationale: the wasm's own
 * `client.sessionsStream()` is a plain unbounded whole-collection listen),
 * but its OWN `CollectionSpec` constant/listener instance: Schedule and
 * Sessions are two independent nav destinations in `lib/nav.ts`
 * (`schedule` vs `sessions`) with two independent mounts in the wasm
 * reference too, each opening its own `sessionsStream()` subscription. See
 * `api/sessions.ts`'s `SESSIONS_QUERY` doc comment for the full set of
 * known tradeoffs (lexical string sort across mixed UTC/offset writers,
 * `orderBy` dropping any doc missing `startTime`, `desc` keeping the
 * most-future 300): they apply identically here.
 */
export const SCHEDULE_SESSIONS_QUERY: CollectionSpec = {
  path: 'kin_care_sessions',
  order: ['startTime', 'desc'],
  max: 300,
};

/**
 * One `booking_time_slots` row, only the fields this READ-ONLY overlay needs
 * (the Directory.ts "subset type, not a blind mirror" convention). `source`/
 * `notes`/`externalEventId`/etc. belong to the not-yet-built
 * create/block-time-edit surface, not this list.
 *
 * EVERY DOCUMENT FIELD IS OPTIONAL, and that is not pedantry: this interface is
 * a CAST over whatever `useCollection` hands back, never a validation of it.
 * Firestore has no schema, `firestore.rules` enforces no field on this
 * collection, and a doc written before a field existed simply does not have it.
 * Declaring `slotType: string` for a doc with no `slotType` is a lie TypeScript
 * cannot catch, and the first `.trim()` on it throws inside render, which
 * React's error boundary turns into a BLANK Schedule page over one bad row
 * (this is exactly how `serviceType` took the screen down on 2026-07-20).
 * `_id` stays required: `useCollection` sets it from the doc id itself, so it
 * is the one key that is genuinely always there. Read every other field
 * through `str()`/`?? ''` at the point of use.
 */
export interface BusySlotEntry {
  _id: string;
  /** `YYYY-MM-DD`. NOT guaranteed to be in the viewer's own local zone, see `lib/scheduleFormat.ts`'s doc on `groupBlockedSlotsByDate`. */
  date?: string | undefined;
  /** `HH:mm`, 24h. Same zone caveat as `date`. */
  startTime?: string | undefined;
  /** Same zone caveat as `date`. */
  endTime?: string | undefined;
  /** Free-text; only `'BLOCKED'` is written by any real writer today, see `lib/scheduleFormat.ts#busySlotKind`. */
  slotType?: string | undefined;
}

/**
 * The bounded, server-ordered `booking_time_slots` listener.
 *
 * Ordered by `date` ascending, capped at 500. `date` is the sort key rather
 * than a pixel/detail ordering, because it is the one field both writers set
 * as a plain, directly-sortable `YYYY-MM-DD` string. The field this screen
 * must NOT trust across writers is what that string means in wall-clock terms
 * (see `BusySlotEntry`'s doc and `lib/scheduleFormat.ts`'s doc on
 * `groupBlockedSlotsByDate` for the full Google-import-vs-manual-block
 * inconsistency): that ambiguity does not affect sort correctness, only
 * display, since `YYYY-MM-DD` sorts lexically same as chronologically either way.
 *
 * NO `filters`: `slotType`/blocked-only narrowing happens client-side
 * (`groupBlockedSlotsByDate`), same rationale as `SESSIONS_QUERY`'s own
 * client-side filter-tab narrowing, a `where` on `slotType` here alongside
 * `orderBy('date')` would need a composite index for no real benefit (every
 * writer sets `slotType: 'BLOCKED'` today; the client-side filter only exists
 * to degrade honestly if that ever stops being true).
 */
export const SCHEDULE_BUSY_SLOTS_QUERY: CollectionSpec = {
  path: 'booking_time_slots',
  order: ['date', 'asc'],
  max: 500,
};
