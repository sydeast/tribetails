import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { logEvent } from './logger';
import type { ActorRole } from './schema';
import { businessTimeZone } from './bookingTimeBlocks';
import { formatBusyWindow } from './visitWindowLabel';
import { legacyUtcWindow, storedInstants } from './googleBusySlot';

/**
 * The one check every visit-creating write path shares: does this candidate
 * window land on a Google Calendar busy import?
 *
 * THE DEFECT THIS CLOSES: the booking-create AVAILABILITY UI
 * (`auntieos-admin/src/lib/bookingAvailability.ts`, Android's
 * `BookingRepository.evaluateAvailability`) already reads `booking_time_slots`
 * and warns about a Google-imported busy block. No server write path checked
 * the same collection before committing a visit, so a booking could be
 * created on time the operator's own calendar says is taken. This module is
 * that check, called from every server callable that creates a visit or a
 * booking REQUEST that will become one, before the write.
 *
 * WHETHER IT REFUSES IS THE OPERATOR'S CALL: the check runs on every write
 * path, but `business_settings.enableConflictDetection` ("Block bookings during
 * busy events") decides whether a found conflict refuses the write or is only
 * logged. See `isBusyConflictBlockingEnabled` below for why absent means ON.
 *
 * SCOPE: `source === 'GOOGLE_BUSY_IMPORT'` rows only
 * (`syncGoogleCalendarBusyEvents.ts`). `INTERNAL_MANUAL` blocks
 * (`createBlockedTimeSlot.ts`) are the operator's own deliberate schedule
 * block, already surfaced by the same availability UI as an advisory warning,
 * and are not what this task closed; folding them in is a separate, later
 * decision.
 *
 * THE TIMEZONE TRAP: `booking_time_slots.date`/`startTime`/`endTime` are three
 * plain strings with NO timezone field. Since #1160 a `GOOGLE_BUSY_IMPORT` row
 * also carries `startMs`/`endMs`, its real instants, and its wall clock is the
 * business's (`lib/googleBusySlot.ts`); this guard reads the instants. A row
 * written before #1160 has no `startMs`, and its wall clock is UTC by
 * construction (the importer used `.toISOString()`), so that row is still
 * reconstructed from its strings as UTC. Restricting the loader to this one
 * source is what makes that legacy reconstruction possible at all; comparing
 * `INTERNAL_MANUAL` rows the same way would silently misread a block by
 * whatever the operator's UTC offset happens to be.
 *
 * This is deliberately MORE precise than the advisory UI it backs up. The
 * picker compares wall-clock text with no conversion (documented there as an
 * approximation, "fine for an operator sitting in the business's zone"). That
 * is an acceptable trade for a warning that never blocks anything. A write
 * gate is not a warning: it is the last chance to refuse a real double-booking,
 * so it earns the extra precision of reconstructing the real instant. The
 * one caveat applies to legacy rows only: a slot carries a single `date` for
 * the whole block, so a pre-#1160 row that spans more than 24 hours decodes
 * short. Rows written since #1160 are split per business day and carry their
 * own instants, so they decode exactly.
 */

/** Machine-readable `details.code` on the rejection, so a client can branch on it rather than the message. */
export const BOOKING_BUSY_CONFLICT_CODE = 'booking_busy_conflict';

const BOOKING_TIME_SLOTS_COLLECTION = 'booking_time_slots';
const GOOGLE_BUSY_SOURCE = 'GOOGLE_BUSY_IMPORT';

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/**
 * Issue #517: the operator's "Block bookings during busy events" switch, which
 * is `business_settings.enableConflictDetection` on every model
 * (`auntieos-admin` web/React/Android all default it TRUE).
 *
 * Until now this guard refused a busy-block collision unconditionally, and the
 * field had no server-side consumer at all: it was persisted by three clients,
 * read by one of them for its own local availability check, and honoured by
 * nothing that could actually stop a write. Reading it here is what makes the
 * switch real, and it gates all five call sites (`requestBooking` x2,
 * `createMultiDateBookingRequest`, `createKinCareSession`,
 * `approveBookingSeriesCore`) from one place.
 *
 * ABSENT MEANS ON. Every existing `business_settings` doc predates the field, so
 * a missing value has to decode the way the models already decode it (`true`),
 * or turning the switch into a real one would silently open the gate on every
 * deployment that has not written it yet. Only an explicit `false` -- an
 * operator who went and turned it off -- lets a booking through.
 *
 * This matches what the flag already means on the client: Android's
 * `EnhancedSchedulingViewModel` gates its `evaluateAvailability` conflict check
 * on the same field, and that check reads the same `booking_time_slots` rows.
 */
export async function isBusyConflictBlockingEnabled(firestore: Firestore): Promise<boolean> {
  const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
  return snap.data()?.enableConflictDetection !== false;
}

/**
 * Cap on how many `booking_time_slots` rows one guard call reads. Mirrors the
 * 500-cap `AVAILABILITY_BUSY_SLOTS_QUERY` already uses for this exact
 * collection (`auntieos-admin/src/api/availability.ts`): generous next to a
 * real calendar's busy blocks in a padded date window, and bounded so a
 * years-old, never-purged collection cannot turn one booking attempt into an
 * unbounded read.
 */
const MAX_BUSY_SLOTS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One visit's candidate window, in exactly the shape every write path already
 * carries on the wire (`startTimeMs`/`endTimeMs` epoch ms). A caller with an
 * ISO string (`createKinCareSession`, `approveBookingSeriesCore`) converts
 * with `Date.parse` at the call site; there is no second, string-flavored
 * entry point to keep in sync.
 */
export interface CandidateVisit {
  startTimeMs: number;
  /** Null/undefined/unparseable is treated as "duration unknown", checked as a one-millisecond point in time rather than skipped outright. */
  endTimeMs?: number | null;
}

/** A resolved, checkable window: real epoch ms, never NaN. */
interface ResolvedWindow {
  startMs: number;
  endMs: number;
}

/** A single `GOOGLE_BUSY_IMPORT` `booking_time_slots` row, decoded to real UTC instants. */
export interface DecodedBusySlot {
  docId: string;
  startMs: number;
  endMs: number;
}

/** One candidate visit landing on one busy slot. */
export interface BookingBusyConflict {
  /** 0-based position in the caller's `visits` array, so a message can name "visit 2" rather than only the first. */
  visitIndex: number;
  /** The visit's own window, as instants; worded in the business zone only when the message is built. */
  visitStartMs: number;
  /** Null when the caller gave no end (a point-in-time visit). */
  visitEndMs: number | null;
  slot: DecodedBusySlot;
}

export { formatBusyWindow };
/**
 * Resolves a candidate visit to a checkable window, or null when its start is
 * not a real number (a pre-existing looseness upstream, e.g.
 * `createKinCareSession`'s `startTime` is any non-empty string up to 40
 * chars, not validated as a parseable date). Null here means "cannot tell",
 * which this module treats as "cannot conflict" rather than crashing on
 * unrelated bad input this task did not introduce and is not fixing.
 *
 * A missing/unparseable end is NOT the same as "cannot tell": it is expanded
 * to a one-millisecond point at the start instant, so a visit with only a
 * known start is still checked as landing (or not) inside a busy window,
 * rather than silently skipped for lack of a duration.
 */
function resolveWindow(v: CandidateVisit): ResolvedWindow | null {
  if (!Number.isFinite(v.startTimeMs)) return null;
  const startMs = v.startTimeMs;
  const endMs = v.endTimeMs != null && Number.isFinite(v.endTimeMs) ? v.endTimeMs : startMs + 1;
  return endMs > startMs ? { startMs, endMs } : { startMs, endMs: startMs + 1 };
}

/**
 * Decodes ONE `booking_time_slots` row into real UTC instants. Callers MUST
 * only pass a row whose `source` is already confirmed `GOOGLE_BUSY_IMPORT`
 * (see the file header); nothing here re-checks that, so `loadGoogleBusySlots`
 * is the one place this may be called from.
 *
 * Prefers `startMs`/`endMs` (#1160), the instants every row written since then
 * carries; its `date`/`startTime`/`endTime` are the business's wall clock and
 * are never read as UTC. Only a row without usable instants is a legacy row,
 * decoded from its strings as UTC below.
 *
 * Legacy rows: rolls the end to the next UTC day when `endTime <= startTime`, so a block
 * spanning UTC midnight (22:00 to 02:00) decodes to the real ~4h window
 * instead of a negative or zero-length one. Returns null for anything that
 * does not parse as a `date`/`startTime`/`endTime` triple, so a malformed
 * legacy row is skipped rather than thrown on: one bad row must not make the
 * guard unusable for every other visit being checked.
 */
export function decodeGoogleBusySlot(docId: string, data: Record<string, unknown>): DecodedBusySlot | null {
  const window = storedInstants(data) ?? legacyUtcWindow(data.date, data.startTime, data.endTime);
  if (!window) return null;
  return { docId, startMs: window.startMs, endMs: window.endMs };
}
/**
 * Pure overlap check: half-open intervals, `[startMs, endMs)`, so a visit
 * ending exactly when a busy block starts (or starting exactly when one ends)
 * is NOT a conflict, and a visit that starts exactly when a busy block starts
 * IS. Visits whose window cannot be resolved (see `resolveWindow`) are
 * skipped, never flagged and never thrown on.
 */
export function findBookingBusyConflicts(
  visits: readonly CandidateVisit[],
  busySlots: readonly DecodedBusySlot[],
): BookingBusyConflict[] {
  const conflicts: BookingBusyConflict[] = [];
  visits.forEach((visit, visitIndex) => {
    const window = resolveWindow(visit);
    if (!window) return;
    for (const slot of busySlots) {
      if (window.startMs < slot.endMs && window.endMs > slot.startMs) {
        conflicts.push({
          visitIndex,
          visitStartMs: window.startMs,
          visitEndMs: visit.endTimeMs != null ? window.endMs : null,
          slot,
        });
      }
    }
  });
  return conflicts;
}

/** A busy block's window worded in `timeZone` (the business zone), for the refusal and its `details`. */
export function busySlotLabel(slot: DecodedBusySlot, timeZone: string): string {
  return formatBusyWindow(slot.startMs, slot.endMs, timeZone);
}
/**
 * One human-readable, fail-loud message naming every conflicting date/time
 * window, never just the first. `timeZone` is `business_settings.timeZone`
 * (resolved by `businessTimeZone`), so the times read as the operator's
 * schedule shows them.
 */
export function formatBookingBusyConflictMessage(conflicts: readonly BookingBusyConflict[], timeZone: string): string {
  const parts = conflicts.map(
    (c) =>
      `visit ${c.visitIndex + 1} (${formatBusyWindow(c.visitStartMs, c.visitEndMs, timeZone)}) conflicts with a Google Calendar busy block (${busySlotLabel(c.slot, timeZone)})`,
  );
  return `This time is not available: ${parts.join('; ')}.`;
}

/**
 * UTC `YYYY-MM-DD` range covering every visit's window, padded a day on each
 * side. Null when no visit has a resolvable window at all.
 *
 * The pad absorbs two imprecisions rather than trying to eliminate them: a
 * busy slot's `date` is its START day, and since #1160 that is the business's
 * day rather than the UTC one (a day apart at most, for any real zone), so a
 * block that begins the evening before a padded-out visit is still found; and
 * the query below is a single
 * range on `date`, not a precise instant, so a slot recorded a day off from
 * where a visit's own UTC day falls (near a day boundary) is still read. The
 * PURE overlap check above is what actually decides conflict or not; this
 * range only has to be wide enough not to exclude a real candidate, never
 * narrow enough to be exact.
 */
export function utcDateRangeForVisits(
  visits: readonly CandidateVisit[],
): { fromDate: string; toDate: string } | null {
  const windows = visits.map(resolveWindow).filter((w): w is ResolvedWindow => w !== null);
  if (windows.length === 0) return null;
  const minMs = Math.min(...windows.map((w) => w.startMs));
  const maxMs = Math.max(...windows.map((w) => w.endMs));
  return {
    fromDate: new Date(minMs - DAY_MS).toISOString().slice(0, 10),
    toDate: new Date(maxMs + DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * Loads the `GOOGLE_BUSY_IMPORT` rows that could possibly overlap `visits`.
 *
 * Deliberately ONE filter in the query (`date` range) rather than adding
 * `where('source', '==', ...)` alongside it: an equality on one field plus a
 * range on another needs a composite index, and `booking_time_slots` is read
 * elsewhere in this codebase (`AVAILABILITY_BUSY_SLOTS_QUERY`,
 * `auntieos-admin/src/api/availability.ts`) with exactly ONE constraint for
 * the same reason, filtering everything else in memory. Adding a composite
 * index here would be a real, if small, operator-visible deploy step for a
 * query this collection's own established pattern already avoids needing.
 */
export async function loadGoogleBusySlots(
  firestore: Firestore,
  visits: readonly CandidateVisit[],
): Promise<DecodedBusySlot[]> {
  const range = utcDateRangeForVisits(visits);
  if (!range) return [];

  const snap = await firestore
    .collection(BOOKING_TIME_SLOTS_COLLECTION)
    .where('date', '>=', range.fromDate)
    .where('date', '<=', range.toDate)
    .limit(MAX_BUSY_SLOTS)
    .get();

  const out: DecodedBusySlot[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (!data || data.source !== GOOGLE_BUSY_SOURCE) continue;
    const decoded = decodeGoogleBusySlot(doc.id, data);
    if (decoded) out.push(decoded);
  }
  return out;
}

export interface GuardBookingBusyConflictOptions {
  firestore: Firestore;
  visits: readonly CandidateVisit[];
  actorUid: string;
  actorRole: ActorRole;
  /**
   * True only when the caller is an admin-facing callable AND the operator
   * explicitly asked to book over a known conflict. Never set by
   * `requestBooking` (kinfolk have no override precedent anywhere in this
   * codebase; see the override note in `CALLABLE_CONTRACT.md`). Never set by
   * `approveBookingSeriesCore` for a visit that already had its time (it
   * isolates that conflict as an ordinary per-visit failure); set by it only
   * for a night whose start the operator is setting in that same approval
   * (#1098), with `manageBookingSeries`'s `overrideBusyConflict`.
   */
  override?: boolean;
  /** Extra fields folded into the override audit entry's payload, e.g. `{ kinfolkId }`. */
  auditContext?: Record<string, unknown>;
}

/**
 * The one call every write path makes. Loads the relevant busy slots, checks
 * for a conflict, and either:
 *   - no conflict: returns, silently.
 *   - a conflict, but the operator turned "Block bookings during busy events"
 *     off (`enableConflictDetection === false`): logs the collision it is
 *     letting through and returns. No audit entry: nothing was overridden by a
 *     person, the gate is simply not armed.
 *   - a conflict, not overridden: throws `failed-precondition` naming every
 *     conflicting visit and the busy window it lands on.
 *   - a conflict, overridden: writes an audit entry recording exactly what was
 *     overridden, then returns. The write proceeds; auditing is not optional
 *     the way it would be if this were folded into a silent no-op.
 *
 * The settings read happens ONLY after a real conflict is found, so the common
 * path (no busy blocks, or none that overlap) still costs exactly the one
 * `booking_time_slots` query it always did.
 */
export async function guardBookingBusyConflict(opts: GuardBookingBusyConflictOptions): Promise<void> {
  const busySlots = await loadGoogleBusySlots(opts.firestore, opts.visits);
  if (busySlots.length === 0) return;

  const conflicts = findBookingBusyConflicts(opts.visits, busySlots);
  if (conflicts.length === 0) return;

  // ONE settings read serves both the switch and the zone the refusal is worded in (#1164).
  const settings = (await opts.firestore.doc(BUSINESS_SETTINGS_DOC).get()).data();
  const timeZone = businessTimeZone(settings);
  if (settings?.enableConflictDetection === false) {
    logEvent({
      severity: 'info',
      function: 'guardBookingBusyConflict',
      event: 'booking.busyConflict.detectionDisabled',
      uid: opts.actorUid,
      extra: {
        ...opts.auditContext,
        conflicts: conflicts.map((c) => ({ visitIndex: c.visitIndex, slotDocId: c.slot.docId })),
      },
    });
    return;
  }

  if (!opts.override) {
    throw new HttpsError('failed-precondition', formatBookingBusyConflictMessage(conflicts, timeZone), {
      code: BOOKING_BUSY_CONFLICT_CODE,
      conflicts: conflicts.map((c) => ({
        visitIndex: c.visitIndex,
        slotDocId: c.slot.docId,
        window: busySlotLabel(c.slot, timeZone),
      })),
    });
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BOOKING_BUSY_CONFLICT_OVERRIDDEN,
    severity: 'warn',
    actorRole: opts.actorRole,
    actorUid: opts.actorUid,
    description: formatBookingBusyConflictMessage(conflicts, timeZone),
    payload: {
      ...opts.auditContext,
      conflicts: conflicts.map((c) => ({ visitIndex: c.visitIndex, slotDocId: c.slot.docId })),
    },
  });
}
