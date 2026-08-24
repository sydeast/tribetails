import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { normalizeBookingStatus } from './bookingTransitions';
import type { ActorRole } from './schema';

/**
 * The check no write path had: does this candidate window land on a visit that
 * is ALREADY on the books?
 *
 * WHAT WAS ACTUALLY MISSING (#397 items M11/M12/M13). `bookingBusyConflict.ts`
 * is the sibling guard and it is deliberately narrow: it reads
 * `booking_time_slots` rows whose `source` is `GOOGLE_BUSY_IMPORT`, i.e. the
 * operator's own external calendar. NOTHING on the server ever compared a
 * candidate window against `kin_care_sessions`, the collection that holds the
 * visits themselves. So:
 *
 *   - `createKinCareSession` would write a second visit straight on top of an
 *     existing one,
 *   - `rescheduleBooking` would move a visit onto another one (its own header
 *     documented the busy-import half of this gap as "a separate decision";
 *     this module closes both halves, and that comment is updated),
 *   - `createBlockedTimeSlot` would block out a window that already had a
 *     promised visit in it, with nothing said to the operator.
 *
 * Three write paths, one question, so one module — the shape
 * `bookingBusyConflict.ts` and `companyHolidayConflict.ts` already established.
 *
 * IT REFUSES BY DEFAULT AND IT IS OVERRIDABLE, unlike the company-holiday
 * guard. A closure is the operator's statement that NOBODY works that day, so
 * there is no legitimate case to build an escape hatch for. Two visits in the
 * same hour is different: assignment lives on the envelope visit doc
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, see
 * `auntieos-admin/src/api/bookingsWrite.ts#getVisitAssignment`) and is never
 * mirrored onto the flat `kin_care_sessions` row this module reads, so the
 * server genuinely cannot tell "double-booked one Auntie" from "two Aunties
 * working concurrently" — and `listStaff`/`assignAuntie` prove a multi-Auntie
 * business is a supported state. Refusing that outright would forbid something
 * legitimate. So it is `overrideVisitConflict`, the same escape hatch
 * `overrideBusyConflict` already is: the refusal is the default, the override
 * is explicit, and taking it writes an audit entry naming exactly what was
 * overridden.
 *
 * A CANCELLED VISIT DOES NOT OCCUPY ITS WINDOW, and nothing else is assumed
 * away. `normalizeBookingStatus` already folds the three stored spellings that
 * mean cancelled (`CANCELLED`/`CANCELED`/`REJECTED`) into one value, so this
 * reuses it rather than inventing a fourth reading of the same field. Every
 * other status occupies, INCLUDING a blank or unrecognized one: the admin
 * detail sheet already treats a blank status as scheduled
 * (`BookingDetailModal.tsx#ReschedulePanel`), and a row whose status cannot be
 * read is not a row whose time may be assumed free.
 *
 * TIMEZONE. Both sides of this comparison are real instants: a candidate window
 * arrives as epoch ms, and a stored session's `startTime`/`endTime` are ISO
 * strings that `Date.parse` resolves. That is what makes this guard possible on
 * the server at all, and it is exactly why `createBlockedTimeSlot`'s
 * `date`+`HH:mm` window has to send epoch ms alongside its wall clock to be
 * checkable — see `BlockTimeArgs`. The one inherited looseness (not introduced
 * here): this collection has writers that emit a zone-LESS local string
 * (Android's reschedule) next to writers that emit UTC (`buildRescheduleTimes`,
 * `approveBookingSeriesCore`), which `Date.parse` resolves against the SERVER's
 * zone. Documented rather than silently wrong; the date-padded query below is
 * wide enough that the mismatch changes which rows conflict, never which rows
 * are looked at.
 */

/** Machine-readable `details.code` on the rejection, so a client can branch on it rather than the message. */
export const VISIT_OVERLAP_CONFLICT_CODE = 'visit_overlap_conflict';

const SESSIONS_COLLECTION = 'kin_care_sessions';

/**
 * Cap on how many `kin_care_sessions` rows one guard call reads. Matches the
 * 500-row bound `bookingBusyConflict.ts` uses on its own collection and the
 * `SCHEDULE_SESSIONS_QUERY`/`AVAILABILITY_BUSY_SLOTS_QUERY` convention on the
 * client: generous next to a real day's visits in a padded window, and bounded
 * so one booking attempt cannot turn into an unbounded read.
 */
const MAX_SESSIONS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a stored visit is assumed to run when its own record cannot say.
 *
 * 30 minutes, matching Android's `resolveDurationMinutes`
 * (`domain/Stage2Step2Helpers.kt`) and the web's `visitDurationMinutes`
 * default. NOT the one-millisecond point `bookingBusyConflict.ts#resolveWindow`
 * uses for a CANDIDATE with no end: a candidate with an unknown length is the
 * caller's own under-specified input, but a STORED visit with an unreadable end
 * is a real visit occupying real time, and shrinking it to a point would let a
 * double-booking through by silence.
 */
const DEFAULT_VISIT_MINUTES = 30;

/**
 * One candidate window, in the same epoch-ms shape `bookingBusyConflict.ts` and
 * `companyHolidayConflict.ts` already take, so a write path assembles its
 * `visits` array once and passes it to all three guards.
 */
export interface CandidateVisit {
  startTimeMs: number;
  /** Null/undefined/unparseable is treated as a one-millisecond point in time, the same convention the sibling guards use. */
  endTimeMs?: number | null;
}

/** A resolved, checkable window: real epoch ms, never NaN. */
interface ResolvedWindow {
  startMs: number;
  endMs: number;
}

/** One `kin_care_sessions` row that occupies real time, decoded to instants. */
export interface OccupiedVisit {
  sessionId: string;
  startMs: number;
  endMs: number;
  /** "2026-08-07 22:00 UTC to 2026-08-08 02:00 UTC", for the fail-loud message. */
  label: string;
  /** The household this visit belongs to, when the row carries one. Named in the audit payload, never in the refusal message. */
  kinfolkId: string | null;
}

/** One candidate window landing on one visit already on the books. */
export interface VisitOverlapConflict {
  /** 0-based position in the caller's `visits` array, so a message can name "visit 2" rather than only the first. */
  visitIndex: number;
  visitLabel: string;
  occupied: OccupiedVisit;
}

/** "2026-08-07 22:00 UTC" */
function formatUtcInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Resolves a candidate to a checkable window, or null when its start is not a
 * real number. Null means "cannot tell", treated as "cannot conflict" rather
 * than thrown on — identical to `bookingBusyConflict.ts#resolveWindow`, so the
 * three guards agree about what un-checkable input means.
 */
function resolveWindow(v: CandidateVisit): ResolvedWindow | null {
  if (!Number.isFinite(v.startTimeMs)) return null;
  const startMs = v.startTimeMs;
  const endMs = v.endTimeMs != null && Number.isFinite(v.endTimeMs) ? v.endTimeMs : startMs + 1;
  return endMs > startMs ? { startMs, endMs } : { startMs, endMs: startMs + 1 };
}

function windowLabel(v: CandidateVisit, w: ResolvedWindow): string {
  return v.endTimeMs != null
    ? `${formatUtcInstant(w.startMs)} to ${formatUtcInstant(w.endMs)}`
    : formatUtcInstant(w.startMs);
}

/** A string field read off a document nothing validates on write. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Decodes ONE `kin_care_sessions` row into the window it occupies, or null when
 * it occupies nothing this guard should refuse over:
 *
 *  - a CANCELLED row (any of the three stored spellings), or
 *  - a row whose `startTime` does not parse at all.
 *
 * The END is resolved in the same order every other reader of this collection
 * uses: the stored `endTime` when it parses to something after the start, then
 * `serviceDurationMinutes` (the field `approveBookingSeriesCore` stamps and
 * `createKinCareSession` may), then {@link DEFAULT_VISIT_MINUTES}. A visit is
 * never shrunk to nothing for want of a readable end.
 */
export function decodeOccupiedVisit(
  sessionId: string,
  data: Record<string, unknown>,
): OccupiedVisit | null {
  if (normalizeBookingStatus(data['status']) === 'CANCELLED') return null;

  const startMs = Date.parse(str(data['startTime']));
  if (!Number.isFinite(startMs)) return null;

  const parsedEnd = Date.parse(str(data['endTime']));
  let endMs: number;
  if (Number.isFinite(parsedEnd) && parsedEnd > startMs) {
    endMs = parsedEnd;
  } else {
    const stated = data['serviceDurationMinutes'];
    const minutes =
      typeof stated === 'number' && Number.isFinite(stated) && stated > 0
        ? Math.round(stated)
        : DEFAULT_VISIT_MINUTES;
    endMs = startMs + minutes * 60_000;
  }

  const kinfolkId = str(data['kinfolkId']);
  return {
    sessionId,
    startMs,
    endMs,
    label: `${formatUtcInstant(startMs)} to ${formatUtcInstant(endMs)}`,
    kinfolkId: kinfolkId === '' ? null : kinfolkId,
  };
}

/**
 * Pure overlap check: half-open intervals `[startMs, endMs)`, so a candidate
 * starting exactly when a visit ends is NOT a conflict and one starting exactly
 * when a visit starts IS. Same convention as
 * `bookingBusyConflict.ts#findBookingBusyConflicts`, because "back-to-back" has
 * to mean the same thing on every guard or an operator learns two rules.
 *
 * `excludeSessionId` is what makes this usable from `rescheduleBooking`: a visit
 * being MOVED must not be found conflicting with its own stored window, which
 * would refuse every reschedule that overlaps where the visit already is (any
 * nudge shorter than the visit's own length).
 */
export function findVisitOverlapConflicts(
  visits: readonly CandidateVisit[],
  occupied: readonly OccupiedVisit[],
  excludeSessionId?: string | null,
): VisitOverlapConflict[] {
  const conflicts: VisitOverlapConflict[] = [];
  visits.forEach((visit, visitIndex) => {
    const window = resolveWindow(visit);
    if (!window) return;
    for (const other of occupied) {
      if (excludeSessionId != null && other.sessionId === excludeSessionId) continue;
      if (window.startMs < other.endMs && window.endMs > other.startMs) {
        conflicts.push({ visitIndex, visitLabel: windowLabel(visit, window), occupied: other });
      }
    }
  });
  return conflicts;
}

/** One human-readable, fail-loud message naming every colliding window, never just the first. */
export function formatVisitOverlapConflictMessage(
  conflicts: readonly VisitOverlapConflict[],
): string {
  const parts = conflicts.map(
    (c) => `visit ${c.visitIndex + 1} (${c.visitLabel}) overlaps a visit already booked (${c.occupied.label})`,
  );
  return `That time is already taken: ${parts.join('; ')}.`;
}

/**
 * UTC `YYYY-MM-DD` range covering every candidate window, padded a day on each
 * side, exactly as `bookingBusyConflict.ts#utcDateRangeForVisits` pads for the
 * same reasons: a stored `startTime` may be a zone-less or offset-bearing
 * string whose UTC day is one off the candidate's, and the query below is a
 * lexical range on that string rather than a precise instant. The pure overlap
 * check is what decides conflict; this range only has to be wide enough not to
 * exclude a real one.
 *
 * `toDateExclusive` is an EXCLUSIVE upper bound and is deliberately a bare
 * `YYYY-MM-DD`: a stored `2026-08-26T09:00:00Z` sorts AFTER the bare
 * `'2026-08-26'`, so the bound has to be the day after the last day we want.
 */
export function sessionDateRangeForVisits(
  visits: readonly CandidateVisit[],
): { fromDate: string; toDateExclusive: string } | null {
  const windows = visits.map(resolveWindow).filter((w): w is ResolvedWindow => w !== null);
  if (windows.length === 0) return null;
  const minMs = Math.min(...windows.map((w) => w.startMs));
  const maxMs = Math.max(...windows.map((w) => w.endMs));
  return {
    fromDate: new Date(minMs - DAY_MS).toISOString().slice(0, 10),
    toDateExclusive: new Date(maxMs + 2 * DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * Loads the `kin_care_sessions` rows that could possibly overlap `visits`.
 *
 * ONE range filter on `startTime` plus the matching `orderBy`, which is a
 * single-field query every collection indexes automatically — no composite
 * index, and therefore no operator-visible deploy step. Status is filtered in
 * memory (via {@link decodeOccupiedVisit}) rather than with a second `where`,
 * the same in-memory-narrowing rule `loadGoogleBusySlots` and
 * `SCHEDULE_BUSY_SLOTS_QUERY` already follow on this codebase's other
 * two-predicate reads.
 */
export async function loadOccupyingVisits(
  firestore: Firestore,
  visits: readonly CandidateVisit[],
): Promise<OccupiedVisit[]> {
  const range = sessionDateRangeForVisits(visits);
  if (!range) return [];

  const snap = await firestore
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '>=', range.fromDate)
    .where('startTime', '<', range.toDateExclusive)
    .orderBy('startTime', 'asc')
    .limit(MAX_SESSIONS)
    .get();

  const out: OccupiedVisit[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (!data) continue;
    const decoded = decodeOccupiedVisit(doc.id, data);
    if (decoded) out.push(decoded);
  }
  return out;
}

export interface GuardVisitOverlapConflictOptions {
  firestore: Firestore;
  visits: readonly CandidateVisit[];
  actorUid: string;
  actorRole: ActorRole;
  /**
   * The session being MOVED, so it never conflicts with its own stored window.
   * Set by `rescheduleBooking`; left unset by every create path.
   */
  excludeSessionId?: string | null;
  /**
   * True only when the operator explicitly asked to write over a visit they
   * have been shown. See the file header for why this guard has an override
   * where `companyHolidayConflict.ts` has none.
   */
  override?: boolean;
  /** What the caller was doing, folded into the refusal details and the override audit entry, e.g. `'block_time'`. */
  attempt: string;
  /** Extra fields folded into the override audit entry's payload, e.g. `{ kinfolkId }`. */
  auditContext?: Record<string, unknown>;
}

/**
 * The one call every write path makes. Loads the visits that could overlap,
 * checks, and either:
 *   - no conflict: returns, silently.
 *   - a conflict, not overridden: throws `failed-precondition` naming every
 *     colliding window, with `details.code === 'visit_overlap_conflict'` and a
 *     machine-readable `conflicts` array so the caller can offer the override
 *     rather than parse the sentence.
 *   - a conflict, overridden: writes an audit entry recording exactly what was
 *     written over, then returns.
 *
 * There is deliberately NO settings switch here, unlike
 * `bookingBusyConflict.ts`'s `enableConflictDetection`. That flag is worded, on
 * every client that renders it, as "Block bookings during busy events" — it is
 * about the operator's imported CALENDAR, which may be stale or personal. It
 * has never meant "let two households be promised the same hour with no word
 * said", and quietly widening it to mean that would change what an existing
 * setting does to an operator who never asked.
 */
export async function guardVisitOverlapConflict(
  opts: GuardVisitOverlapConflictOptions,
): Promise<void> {
  const occupied = await loadOccupyingVisits(opts.firestore, opts.visits);
  if (occupied.length === 0) return;

  const conflicts = findVisitOverlapConflicts(opts.visits, occupied, opts.excludeSessionId);
  if (conflicts.length === 0) return;

  if (!opts.override) {
    throw new HttpsError('failed-precondition', formatVisitOverlapConflictMessage(conflicts), {
      code: VISIT_OVERLAP_CONFLICT_CODE,
      attempt: opts.attempt,
      conflicts: conflicts.map((c) => ({
        visitIndex: c.visitIndex,
        sessionId: c.occupied.sessionId,
        window: c.occupied.label,
      })),
    });
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.VISIT_OVERLAP_CONFLICT_OVERRIDDEN,
    severity: 'warn',
    actorRole: opts.actorRole,
    actorUid: opts.actorUid,
    description: formatVisitOverlapConflictMessage(conflicts),
    payload: {
      ...opts.auditContext,
      attempt: opts.attempt,
      conflicts: conflicts.map((c) => ({
        visitIndex: c.visitIndex,
        sessionId: c.occupied.sessionId,
        kinfolkId: c.occupied.kinfolkId,
      })),
    },
  });
}
