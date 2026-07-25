import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * The booking-note edit cutoff, shared by BOTH note callables
 * (`portal/addBookingNote.ts` and `admin/addInternalBookingNote.ts`).
 *
 * WHY IT LIVES HERE. The rule used to exist once, privately, inside
 * `addBookingNote`, so the kinfolk-facing thread was guarded server-side and
 * the internal thread was guarded by the UI alone. A guard that lives only in
 * the UI is not a guard: another client, a stale bundle, or a direct callable
 * invocation walks straight past it. The two android surfaces had already
 * drifted apart on this exact rule (one composer honoured the cutoff, the other
 * ignored it) before it was noticed, which is what a duplicated time rule does.
 * One module, two call sites, no second copy of the number or the comparison.
 *
 * WHY A CUTOFF AT ALL. An Auntie reads the notes on arrival and acts on them.
 * Freezing them a few hours out means what she read at the door is what the
 * household actually asked for, not something edited while she was driving.
 *
 * Clients mirror this rule for a courtesy lock so the operator is not surprised
 * by a rejection, but THIS is the enforcement. See
 * `auntieos-admin/src/lib/bookingDetailFormat.ts` (web) and
 * `ui/admin/scheduling/BookingNoteCutoff.kt` (android).
 */
export const NOTE_CUTOFF_MS = 3 * 60 * 60 * 1000;

/**
 * The machine-readable discriminator on the rejection's `details`. Clients
 * branch on this to tell "the window closed" apart from "the write broke",
 * without string-matching the message.
 */
export const NOTE_CUTOFF_CODE = 'booking_note_cutoff';

/** The operator/household-facing text. One string, so both threads read alike. */
export const NOTE_CUTOFF_MESSAGE =
  'Notes cannot be edited within 3 hours of booking start window.';

/**
 * Epoch millis for a visit's `startTime`, whichever shape the doc carries.
 *
 * All four are real: MyTribe's own booking flow writes a Firestore
 * `Timestamp`, the admin SDK hands back a `Date` in some paths, and AuntieOS
 * writes plain ISO text (`approveBookingSeriesCore.ts#toIso`). `null` for
 * absent or unparseable, never a guessed instant.
 */
export function visitStartMs(visitData: FirebaseFirestore.DocumentData): number | null {
  const raw = visitData?.startTime;
  if (raw instanceof Timestamp) return raw.toMillis();
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * True once the visit is within [NOTE_CUTOFF_MS] of starting, or has started.
 *
 * A visit with no readable start is OPEN, not closed. There is no window to be
 * inside of, and refusing a note on a doc whose start we cannot read would
 * block writes on undated bookings for a rule that cannot be evaluated.
 */
export function noteWindowClosed(
  visitData: FirebaseFirestore.DocumentData,
  nowMs: number,
): boolean {
  const startMs = visitStartMs(visitData);
  if (startMs === null) return false;
  return nowMs >= startMs - NOTE_CUTOFF_MS;
}

/**
 * Throw the typed rejection when the window has closed, otherwise return.
 *
 * Call it AFTER the visit doc has been read and confirmed to exist, so a
 * missing booking still resolves to `not-found` rather than leaking as a
 * cutoff failure.
 */
export function assertNoteWindowOpen(
  visitData: FirebaseFirestore.DocumentData,
  nowMs: number = Date.now(),
): void {
  if (noteWindowClosed(visitData, nowMs)) {
    throw new HttpsError('failed-precondition', NOTE_CUTOFF_MESSAGE, {
      code: NOTE_CUTOFF_CODE,
    });
  }
}
