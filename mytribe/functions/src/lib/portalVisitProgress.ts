/**
 * #1830 / #1832 / #1823: where a visit stands for the household while the
 * Auntie is working it.
 *
 * THE DEFECT THIS CLOSES. On my way, Arrived and Departed are written to
 * `kin_care_sessions/{id}.status` and nowhere else (three admin clients patch
 * that document directly, see `admin/setVisitLifecycle.ts`). The household's
 * copy, `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, kept
 * `status: 'confirmed'` until Cancel or Mark Completed moved it (#1627). So
 * `getMyBookings`, which read only that copy:
 *
 *  - showed CONFIRMED on the booking page all the way through the visit, and
 *  - dropped the visit from every bucket the minute its start passed (a
 *    `confirmed` visit is "upcoming" only while its start is ahead), which is
 *    why every visit notice opened "We couldn't find that booking."
 *
 * THE FIX IS ON THE READ. `getMyBookings` already reads the household's
 * sessions, so each visit takes its progress from the session it is linked to.
 * No second writer, no trigger, no backfill, and a tap from any admin client
 * (online or replayed from an offline queue) shows on the next read.
 *
 * #2123 (operator ruling 2026-11-12): A VISIT IS COMPLETED AT DEPARTURE.
 * Kinfolk see Completed whether or not the KinTale has been sent, so a
 * DEPARTED session reads `status: 'completed'` here, the same answer a
 * COMPLETED one gives. #2110 sent `status: 'active'` with
 * `visitProgress: 'ended'` (a "Departed, waiting for the KinTale" stage); that
 * stage is gone. The server also completes the session itself at departure,
 * and this read does not wait for that write to land (or for a refusal under
 * the operator's arrival rule), so the household never sees the gap.
 *
 * {@link visitStageOf} still reads an `active` + `ended` pair, which an answer
 * cached before this change can carry, as Completed.
 */
import type { BookingDto } from './portalBookingDto';

/** A visit's place in its life as a household reads it. */
export type VisitStage = BookingDto['status'];

type StatusPair = Pick<BookingDto, 'status' | 'visitProgress'>;

/** The stage a status pair stands for. An `active` visit whose progress has ended is a departed visit, and that is Completed (#2123). */
export function visitStageOf(b: StatusPair): VisitStage {
  if (b.status === 'active' && b.visitProgress === 'ended') return 'completed';
  return b.status;
}

/** On the way or arrived: the Auntie has started and the visit is not finished. A departed visit is finished (#2123). */
export function isUnderWay(b: StatusPair): boolean {
  const stage = visitStageOf(b);
  return stage === 'enRoute' || stage === 'active';
}

/** The Auntie is on the way or at the door right now. */
export function isLive(b: StatusPair): boolean {
  const stage = visitStageOf(b);
  return stage === 'enRoute' || stage === 'active';
}

/**
 * What a `kin_care_sessions` status says about the visit's progress, or null
 * when it says nothing the household's copy does not already know.
 *
 * SCHEDULED is null on purpose: it is where an undone arrival lands, and a
 * visit nobody has started keeps the status its own document holds (requested
 * or confirmed). CANCELLED is null too: a cancelled session reaches the
 * household through `transitionBookingStatus`'s mirror, and a REJECT lands on
 * CANCELLED without being a cancelled visit (#533), so the session alone
 * cannot say which it was.
 */
export function sessionProgressOf(rawStatus: unknown): StatusPair | null {
  switch (typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '') {
    case 'ON_MY_WAY':
      return { status: 'enRoute', visitProgress: 'enRoute' };
    case 'ARRIVED':
      return { status: 'active', visitProgress: 'active' };
    // #2123: departed is completed for the household, KinTale or not.
    case 'DEPARTED':
    case 'COMPLETED':
      return { status: 'completed', visitProgress: 'ended' };
    default:
      return null;
  }
}

/**
 * One `kinCares` document's fields with its linked session's progress laid
 * over them. Applied to the RAW document before it is mapped, so everything
 * read off the status afterwards (the bucket, the completed visit's KinTale
 * and invoice links, the envelope's copy of the visit) sees one answer.
 *
 * A visit that already reads completed or cancelled is left alone: that is an
 * answer the household has been given, and a session cannot take it back.
 */
export function withSessionProgress(
  data: Record<string, unknown>,
  sessionStatus: unknown,
): Record<string, unknown> {
  if (data['status'] === 'completed' || data['status'] === 'cancelled') return data;
  const progress = sessionProgressOf(sessionStatus);
  if (progress === null) return data;
  return { ...data, status: progress.status, visitProgress: progress.visitProgress };
}

/**
 * How long a confirmed visit stays on the household's list after its start
 * with no tap from the Auntie. The same day of slack the session-only path has
 * always given a SCHEDULED visit: a visit that is running late is still the
 * household's next visit, and it must not vanish at its start time.
 */
export const LATE_VISIT_WINDOW_MS = 24 * 3600_000;

/**
 * Still ahead of the household, or just late?
 *
 * A timed visit: its start is no more than a minute past, and a CONFIRMED one
 * stays for {@link LATE_VISIT_WINDOW_MS} beyond that. A request nobody
 * answered does not get the slack: once its time has passed there is nothing
 * left to wait for. A night awaiting its start time (#1098): its night is
 * today or later, judged in UTC with a day of slack, since this read knows no
 * business zone. An American evening is already "tomorrow" in UTC, and
 * tonight's overnight must not vanish from the list at 8 PM.
 */
export function isUpcoming(b: BookingDto, nowMs: number): boolean {
  if (b.startTimeMs == null && b.startTimePending && b.requestedDate) {
    const yesterdayUtc = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10);
    return b.requestedDate >= yesterdayUtc;
  }
  const startMs = b.startTimeMs ?? 0;
  if (startMs >= nowMs - 60_000) return true;
  return b.status === 'confirmed' && startMs >= nowMs - LATE_VISIT_WINDOW_MS;
}

/**
 * Which list a visit is on.
 *
 * - `upcoming`: a request or a confirmed visit that is still ahead (or late,
 *   see {@link isUpcoming}), and EVERY visit that is under way, whatever the
 *   clock says. Under way sorts first: it is what is happening now.
 * - `recent`: completed or cancelled.
 * - null: a request or a confirmed visit whose time has passed with nothing
 *   done about it. It is on neither list, and still opens by id through its
 *   envelope.
 */
export function bucketOf(b: BookingDto, nowMs: number): 'upcoming' | 'recent' | null {
  const stage = visitStageOf(b);
  if (stage === 'completed' || stage === 'cancelled') return 'recent';
  if (isUnderWay(b)) return 'upcoming';
  return isUpcoming(b, nowMs) ? 'upcoming' : null;
}

/**
 * The visit the live card is about: the one the Auntie is at, else the one
 * she is on the way to. Never a departed visit (that is completed, #2123),
 * so the card clears when she leaves.
 */
export function pickLiveVisit(all: readonly BookingDto[]): BookingDto | null {
  return (
    all.find((b) => visitStageOf(b) === 'active') ??
    all.find((b) => visitStageOf(b) === 'enRoute') ??
    null
  );
}
