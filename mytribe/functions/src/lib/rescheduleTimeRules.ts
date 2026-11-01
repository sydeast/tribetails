import type { Firestore } from 'firebase-admin/firestore';
import { BUSINESS_SETTINGS_DOC } from './businessHours';
import { assertWeeklyHours } from './weeklyHoursRule';
import { businessTimeZone, resolveBookingPolicy } from './bookingTimeBlocks';
import { guardCompanyHolidayConflict } from './companyHolidayConflict';
import { assertVisitBookingMode, type ResolvedVisitBlock } from '../portal/requestBooking';

/**
 * #1284: the rules a household's PROPOSED new time is judged against.
 *
 * `requestBookingReschedule` used to check one thing, that the time was in the
 * future, so a request for 2:00 AM on a Sunday went straight through to the
 * office. A proposal is only worth asking the office about if the booking path
 * would have taken the same time, so this reuses that path's own rules rather
 * than writing a second set:
 *
 *  1. the booking MODE: a business that books by time block refuses a clock
 *     time, and a named block must exist and contain the start
 *     (`assertVisitBookingMode`, the very function `requestBooking` calls);
 *  2. company closures (`guardCompanyHolidayConflict`, the booking path's
 *     un-overridable closed-day guard, which is also what
 *     `getBusinessClosures` marks in the day picker);
 *  3. the weekly business hours in the business's own zone
 *     (`resolveBusinessOpen`, the phone line's resolver): a closed weekday is
 *     refused in either mode, a clock time outside the day's hours is refused
 *     in clock mode. A block is the operator's own statement of when visits
 *     happen, so its start is not second-guessed against the weekly hours.
 *
 * Fail-open where the configuration is unreadable, which is how every one of
 * those helpers behaves: a settings document with no `businessHours` map, an
 * unreadable hours string, a dated `specialHours` entry (presence only, the
 * free text cannot be parsed), or a read that fails does not refuse a
 * household. Not being able to read our own hours is not evidence we are shut.
 */

export interface RescheduleCandidate {
  startTimeMs: number;
  endTimeMs: number | null;
  /** The named window the household picked, when the business books by block. */
  timeBlockId?: string | undefined;
  /** The visit's own catalog service, which can exempt it from block-only booking (#1092). */
  serviceId?: string | undefined;
}

/** Reads the settings document; null when it is missing or the read fails. */
async function readSettings(firestore: Firestore): Promise<Record<string, unknown> | null> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Throws `invalid-argument` or `failed-precondition` with a sentence a
 * household can act on, and returns the verified block (or none) otherwise.
 */
export async function assertRescheduleTimeAllowed(
  firestore: Firestore,
  candidate: RescheduleCandidate,
): Promise<ResolvedVisitBlock> {
  const raw = await readSettings(firestore);
  // No readable settings: the pre-#1284 behaviour, which is the booking
  // path's own fallback (specific time allowed, no blocks, no hours).
  const settings = raw ?? {};
  const policy = resolveBookingPolicy(settings).policy;
  const timeZone = businessTimeZone(settings);

  const block = assertVisitBookingMode(
    {
      startTimeMs: candidate.startTimeMs,
      timeBlockId: candidate.timeBlockId,
      serviceId: candidate.serviceId,
    },
    policy,
    timeZone,
  );

  await guardCompanyHolidayConflict({
    firestore,
    visits: [{ startTimeMs: candidate.startTimeMs, endTimeMs: candidate.endTimeMs }],
  });

  assertWeeklyHours(raw, timeZone, policy, {
    startTimeMs: candidate.startTimeMs,
    timeBlockId: block.timeBlockId,
    serviceId: candidate.serviceId,
  });
  return block;
}
