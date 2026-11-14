import { businessInstantMs, businessWallClock } from './businessZoneTime';
import { shownVisitLengthMinutes } from './visitFacts';
import { type VisitLifecycleAction } from '../api/sessionsWrite';

/**
 * #2039: A CLOCK TAP THAT DOES NOT FIT THE BOOKING ASKS ONCE MORE.
 *
 * On the walk a 45-minute visit booked for 22:45 was clocked in at 21:58 and
 * out a minute later, 43 minutes before it was due to start, through the
 * normal confirm with nothing to say anything was off. Since #2123 a departure
 * completes the visit and tells the household it has finished, so a stray
 * Departed is not a small thing to undo.
 *
 * THE GUARD IS A WARNING LINE IN THE SAME CONFIRM, never a refusal. The Auntie
 * at the door is the one who knows (a household that asked her to come early,
 * a visit cut short on purpose), and the server takes the clock as a direct
 * write it does not judge. Nothing new is written: the step, its stamp and the
 * household notice keyed from that stamp (#2238) are exactly what they were.
 *
 * When it speaks, on the business clock (`businessInstantMs` reads a stored
 * zone-less time as business time and an instant as itself):
 *   Arrived   more than EARLY_ARRIVAL_WARNING_MINUTES before the booked start;
 *   Departed  before the booked start, or with less than
 *             SHORT_VISIT_WARNING_SHARE of the booked length since clock-in.
 * The thresholds are product constants, not business settings. The Android app
 * (`domain/ClockStepWarning.kt`) and the desktop console
 * (`screens/sessions/ClockStepWarning.kt`) hold the same two numbers and say
 * the same sentences.
 */
export const EARLY_ARRIVAL_WARNING_MINUTES = 30;
export const SHORT_VISIT_WARNING_SHARE = 0.5;

export interface ClockStepSession {
  startTime?: unknown;
  endTime?: unknown;
  serviceDurationMinutes?: unknown;
  arrivedAt?: unknown;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** "1 minute", "43 minutes", "1 hour", "2 hours 5 minutes". */
export function spanWords(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return 'less than a minute';
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  const minutePart = rest === 1 ? '1 minute' : `${rest} minutes`;
  if (hours === 0) return minutePart;
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;
  return rest === 0 ? hourPart : `${hourPart} ${minutePart}`;
}

/**
 * The warning line for this clock step, or null when the tap fits the booking
 * (or nothing on the visit can say whether it does).
 */
export function clockStepWarning(
  action: VisitLifecycleAction,
  session: ClockStepSession,
  nowMs: number,
  businessZone: string,
): string | null {
  const startMs = businessInstantMs(text(session.startTime), businessZone);
  const startClock = startMs === null ? '' : businessWallClock(startMs, businessZone).hhmm;

  if (action === 'ARRIVED') {
    if (startMs === null) return null;
    const early = (startMs - nowMs) / 60_000;
    if (early <= EARLY_ARRIVAL_WARNING_MINUTES) return null;
    return `This visit is booked for ${startClock}, ${spanWords(early)} from now.`;
  }

  if (action === 'DEPARTED') {
    if (startMs !== null && nowMs < startMs) {
      return `This visit is booked to start at ${startClock}, ${spanWords((startMs - nowMs) / 60_000)} from now. Clocking out now ends it before it was due to begin.`;
    }
    const arrivedMs = businessInstantMs(text(session.arrivedAt), businessZone);
    const length = shownVisitLengthMinutes(session);
    if (arrivedMs === null || length === null || length <= 0) return null;
    const stayed = (nowMs - arrivedMs) / 60_000;
    if (stayed >= length * SHORT_VISIT_WARNING_SHARE) return null;
    return `Only ${spanWords(stayed)} since clock-in. This visit is booked for ${spanWords(length)}.`;
  }

  return null;
}
