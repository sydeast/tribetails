/**
 * Where an invoice number comes from when nobody typed one.
 *
 * WHY THE COMPOSER STOPPED ASKING. `invoiceNumber` was a blank required text
 * box on the new-invoice form: the operator had to invent a number, from
 * memory, for a field the system was perfectly able to assign. That is the
 * definition of a question that already had an answer somewhere else. Both
 * vendors studied for issue #408 assign it; neither asks.
 *
 * THE SEQUENCE IS A COUNTER DOCUMENT, READ AND WRITTEN IN ONE TRANSACTION, so
 * two operators creating invoices at the same moment cannot be handed the same
 * number. Deriving the next number by scanning the collection for the highest
 * one would be a race by construction, and an expensive one.
 *
 * THE YEAR IS IN THE NUMBER, and that is a deliberate collision decision.
 * Invoice numbers in this system have never been unique and nothing joins on
 * them: every number in the collection today was typed by a person, in whatever
 * shape they felt like ("INV-9", "1042", ""). Minting a bare `INV-0001` would
 * sit alongside those and read as a duplicate of somebody's old number. The
 * year-stamped form cannot be mistaken for one of them.
 *
 * THE SEQUENCE DOES NOT RESET AT NEW YEAR. It is one counter for the business,
 * and the year segment records when the number was ISSUED, not which sequence
 * it belongs to. A resetting counter would need a per-year counter document and
 * would hand out `INV-2027-0001` while `INV-2026-0001` was still unpaid, which
 * is two invoices whose numbers differ only in a segment nobody reads aloud.
 *
 * AN ASSIGNED NUMBER IS NOT A LOCKED ONE. `updateInvoice` has always accepted
 * `invoiceNumber` in its patch, so an operator who needs a specific number
 * still sets it, before or after creation, and a caller that sends its own
 * number at creation keeps it untouched. This module only answers the case
 * where nobody said.
 */
import type { Firestore } from 'firebase-admin/firestore';

/** The counter document. One per business; this deployment is single-tenant. */
export const INVOICE_NUMBER_COUNTER_PATH = 'counters/invoiceNumber';

/** Digits in the sequence segment. A longer sequence simply gets longer. */
const SEQUENCE_PAD = 4;

/**
 * `INV-2026-0001` from a year and a sequence.
 *
 * Pure, so the format is testable without a database, which is the only way the
 * padding and the rollover past 9999 get covered at all.
 */
export function formatInvoiceNumber(year: number, sequence: number): string {
  const seq = Math.max(1, Math.trunc(sequence));
  return `INV-${String(year)}-${String(seq).padStart(SEQUENCE_PAD, '0')}`;
}

/**
 * The next sequence value from whatever the counter document currently holds.
 *
 * A missing, junk, zero or negative counter reads as "start at 1" rather than
 * throwing: this is the first invoice on a fresh deployment, or a counter
 * somebody edited in the console, and refusing to create an invoice over it
 * would be a worse answer than starting the sequence.
 */
export function nextSequence(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return 1;
  const n = Math.trunc(stored);
  return n < 1 ? 1 : n;
}

/**
 * Reserves and returns the next invoice number. One transaction: read the
 * counter, hand out its value, store the successor.
 *
 * `day` is the invoice's own date when it has one, so a back-dated invoice
 * carries the year it is FOR rather than the year it was typed in. Blank or
 * unreadable falls back to `now`, which is the only other year available.
 */
export async function mintInvoiceNumber(
  firestore: Firestore,
  day: string,
  now: Date = new Date(),
): Promise<string> {
  const year = /^\d{4}-\d{2}-\d{2}$/.test(day.trim())
    ? Number(day.trim().slice(0, 4))
    : now.getUTCFullYear();

  const ref = firestore.doc(INVOICE_NUMBER_COUNTER_PATH);
  const sequence = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const seq = nextSequence(snap.exists ? (snap.data() ?? {})['next'] : undefined);
    tx.set(ref, { next: seq + 1 }, { merge: true });
    return seq;
  });

  return formatInvoiceNumber(year, sequence);
}
