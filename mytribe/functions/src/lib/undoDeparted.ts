import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { normalizeBookingStatus, type BookingStatus } from './bookingTransitions';
import { COMPLETED_OUTSIDE_RANGE_FIELD } from './arrivalVerification';
import {
  DEPARTED_NOTICE_TOLD_FOR_ARRIVAL_FIELD,
  HOUSEHOLD_STATUS_BEFORE_COMPLETION_FIELD,
  UNDO_DEPARTED_NO_ARRIVAL_CODE,
  UNDO_DEPARTED_NO_ARRIVAL_MESSAGE,
  UNDO_DEPARTED_UNTIL_FIELD,
  UNDO_DEPARTED_WINDOW_CODE,
  evaluateVisitLifecycle,
  undoDepartedWindowMessage,
} from './visitLifecycle';

/**
 * #2250, operator ruling 2026-11-14: "A short Undo departed. For a few minutes
 * after Departed, Undo departed puts the visit back to Arrived; the household
 * is not told."
 *
 * WHAT A DEPARTURE DID, AND WHAT THIS TAKES BACK. Since #2123 the departure
 * trigger (`triggers/onKinCareSessionDeparted.ts`) completes the visit on the
 * write that departs it. Everything that trigger and the tap wrote is undone
 * here, in ONE transaction that re-reads the visit:
 *
 *   on the visit             `status` back to ARRIVED; `departedAt` cleared to
 *                            '' (this collection's cleared spelling, as Undo
 *                            arrival clears `arrivedAt`); `completedAt`,
 *                            `kinTaleDue`, `completedOutsideRange` and the two
 *                            undo fields removed, which is how the visit read
 *                            before it departed.
 *   on the household's copy  `completed` back to what it read before, kept by
 *                            the trigger on the visit. Only when this visit
 *                            was Completed and the copy still reads completed.
 *
 * WHAT IT LEAVES ALONE, each on purpose:
 *   - THE ARRIVAL. `arrivedAt`, the distance measured at it and who measured it
 *     (`arrivalCheckedByOwner`) stay exactly as they were. The visit returns to
 *     the arrival it already had. No position is taken and none is accepted,
 *     so this is never a second way to start a visit: the range was checked,
 *     or waived for the owner, when that arrival was made, and a visit with no
 *     arrival on record is refused. The next Departed completes it by the same
 *     evidence, outside-the-range record included.
 *   - THE INVOICE. A visit can be on an invoice before it is ever completed
 *     (`lib/invoiceSessionLinks.ts` only refuses a cancelled one), so
 *     `invoiceId` says nothing about this completion and is not touched. The
 *     one thing completion feeds is the "visits to invoice" list
 *     (`lib/sessionInvoicing.ts#isSessionBillable`), which reads the status and
 *     so drops the visit by itself until it is completed again.
 *   - WHAT THE HOUSEHOLD WAS ALREADY TOLD. "Your Auntie has left" went out when
 *     the departure landed. It is not recalled and no correction follows. The
 *     restore of their copy carries an `officeNoticeStamp` so `onBookingsWrite`
 *     does not read `completed` to `confirmed` as a fresh confirmation.
 *     Because they were told once, the undo also notes which arrival that was
 *     (`departedNoticeToldForArrival`), and the next Departed of the same
 *     arrival sends no second "has left". Its Activity Log line is still
 *     written.
 *
 * THE WINDOW is the server's: `undoDepartedUntil`, stamped by the trigger from
 * its own clock. No stamp means the departure has not reached the trigger (a
 * second or two) or the visit was completed some other way; both are refused
 * with the same sentence, and the first is gone by the time anyone reads it.
 *
 * A TRANSACTION because the trigger is racing it. An undo that lands while the
 * visit is still DEPARTED commits ARRIVED, and the trigger's own transaction
 * then finds a visit that is not Departed and writes nothing.
 */

type SessionData = Record<string, unknown>;

export type UndoDepartedOutcome =
  | {
      kind: 'undone';
      from: BookingStatus;
      /** The visit as it read before the undo, for the Activity Log line. */
      before: SessionData;
      /** What the household's copy was put back to, or null when it was not moved. */
      householdCopy: string | null;
    }
  /** Already Arrived: a second tap. Nothing written. */
  | { kind: 'noop'; at: BookingStatus }
  | { kind: 'not-found' }
  | { kind: 'unknown-status'; raw: string }
  | { kind: 'illegal'; from: BookingStatus; allowedFrom: readonly BookingStatus[] }
  | { kind: 'refused'; code: string; message: string; from: BookingStatus };

function nonBlank(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** What a household's copy goes back to when the trigger kept no record of it. */
export const HOUSEHOLD_STATUS_FALLBACK = 'confirmed';

/**
 * Take back one departure, or say why not. The caller (`setVisitLifecycle`)
 * audits the outcome; this writes the visit and the household's copy only.
 */
export async function undoDepartedSession(args: {
  sessionId: string;
  uid: string;
  nowMs?: number;
  /** A fresh `officeNoticeStamp` for the household's copy. */
  officeNoticeStamp: string;
}): Promise<UndoDepartedOutcome> {
  const firestore = db();
  const nowMs = args.nowMs ?? Date.now();
  const sessionRef = firestore.doc(`kin_care_sessions/${args.sessionId}`);

  return firestore.runTransaction(async (tx): Promise<UndoDepartedOutcome> => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return { kind: 'not-found' };
    const session = (snap.data() ?? {}) as SessionData;

    const decision = evaluateVisitLifecycle({ currentStatus: session['status'], action: 'UNDO_DEPARTED' });
    if (decision.kind === 'unknown-status') return { kind: 'unknown-status', raw: decision.raw };
    if (decision.kind === 'noop') return { kind: 'noop', at: decision.at };
    if (decision.kind === 'illegal') {
      return { kind: 'illegal', from: decision.from, allowedFrom: decision.allowedFrom };
    }
    const from = decision.from;

    const until = Date.parse(nonBlank(session[UNDO_DEPARTED_UNTIL_FIELD]));
    if (!Number.isFinite(until) || nowMs > until) {
      return { kind: 'refused', code: UNDO_DEPARTED_WINDOW_CODE, message: undoDepartedWindowMessage(), from };
    }
    if (nonBlank(session['arrivedAt']) === '') {
      return {
        kind: 'refused',
        code: UNDO_DEPARTED_NO_ARRIVAL_CODE,
        message: UNDO_DEPARTED_NO_ARRIVAL_MESSAGE,
        from,
      };
    }

    // The household's copy, read before any write as a transaction requires.
    // Only a COMPLETED visit moved it; a visit left at DEPARTED never did.
    let visitRef: FirebaseFirestore.DocumentReference | null = null;
    let householdCopy: string | null = null;
    if (from === 'COMPLETED') {
      const kinfolkId = nonBlank(session['kinfolkId']);
      const batchId = nonBlank(session['kinCareBatchId']);
      const visitId = nonBlank(session['kinCareVisitId']);
      if (kinfolkId !== '' && batchId !== '' && visitId !== '') {
        const ref = firestore.doc(`families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}`);
        const visit = await tx.get(ref);
        const current = (visit.data() as { status?: unknown } | undefined)?.status;
        if (visit.exists && current === 'completed') {
          visitRef = ref;
          const kept = nonBlank(session[HOUSEHOLD_STATUS_BEFORE_COMPLETION_FIELD]);
          householdCopy = kept !== '' && kept !== 'completed' ? kept : HOUSEHOLD_STATUS_FALLBACK;
        }
      }
    }

    tx.set(
      sessionRef,
      {
        status: 'ARRIVED',
        departedAt: '',
        completedAt: FieldValue.delete(),
        kinTaleDue: FieldValue.delete(),
        [COMPLETED_OUTSIDE_RANGE_FIELD]: FieldValue.delete(),
        [UNDO_DEPARTED_UNTIL_FIELD]: FieldValue.delete(),
        [HOUSEHOLD_STATUS_BEFORE_COMPLETION_FIELD]: FieldValue.delete(),
        // The household was told she left when this departure landed. The
        // next Departed of this same arrival tells them nothing again.
        [DEPARTED_NOTICE_TOLD_FOR_ARRIVAL_FIELD]: session['arrivedAt'],
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: args.uid,
      },
      { merge: true },
    );
    if (visitRef !== null && householdCopy !== null) {
      tx.set(
        visitRef,
        {
          status: householdCopy,
          officeNoticeStamp: args.officeNoticeStamp,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    return { kind: 'undone', from, before: session, householdCopy };
  });
}

/** PURE. Is this visit's "Undo departed" still open at `nowMs`? For the tests and the trigger. */
export function undoDepartedOpen(session: SessionData, nowMs: number): boolean {
  const status = normalizeBookingStatus(session['status']);
  if (status !== 'DEPARTED' && status !== 'COMPLETED') return false;
  const until = Date.parse(nonBlank(session[UNDO_DEPARTED_UNTIL_FIELD]));
  return Number.isFinite(until) && nowMs <= until;
}
