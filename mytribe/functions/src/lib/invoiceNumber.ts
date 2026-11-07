/**
 * Where an invoice number comes from when nobody typed one.
 *
 * WHY THE COMPOSER STOPPED ASKING. `invoiceNumber` was a blank required text
 * box on the new-invoice form: the operator had to invent a number, from
 * memory, for a field the system was perfectly able to assign. Both vendors
 * studied for issue #408 assign it; neither asks.
 *
 * THE STYLE IS THE OPERATOR'S RULING (#1609, 2026-11-05 docket): "continue the
 * current count (#1020, #1021 and on), then switch to the year style at the
 * start of next year (INV-2027-0001 from 2027-01-01, business time zone)."
 *
 *   - Until 2027-01-01 00:00 in America/Chicago, a new invoice gets the next
 *     PLAIN number: one past the highest all-digit number already stored, so
 *     `1020` follows the imported `1001` to `1019`.
 *   - From then on it gets `INV-<year>-<NNNN>`, and the sequence RESTARTS each
 *     year: `INV-2027-0001`, ..., then `INV-2028-0001`.
 *   - The year is the year the invoice is ISSUED in the business's zone, not
 *     the invoice's own `date`, so a back-dated invoice typed in 2027 never
 *     reaches back into a sequence that has already closed.
 *   - Existing numbers are never touched, including `INV-2026-0001` and the
 *     invoices that have none.
 *
 * Quotes draw from the same sequence (`createQuote`): an accepted quote becomes
 * the invoice, under the number it already carries.
 *
 * THE COUNTERS LIVE ON ONE DOCUMENT, READ AND WRITTEN IN THE CALLER'S
 * TRANSACTION, so two operators creating invoices at the same moment cannot be
 * handed the same number: Firestore retries the losing transaction against the
 * winner's counter. `nextPlain` holds the plain sequence and `byYear.<year>`
 * the year sequences. The plain counter has no stored value on a deployment
 * that predates this rule, so its first use reads the invoices collection (in
 * the same transaction) for the highest plain number.
 *
 * A NUMBER SOMEBODY TYPED IS NEVER HANDED OUT AGAIN. `updateInvoice` lets the
 * operator set a number by hand, so before a candidate is returned it is looked
 * up, and a taken one is skipped. `invoiceNumberTaken` is the same check the
 * write paths use to refuse a typed duplicate.
 */
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';

/** The counter document. One per business; this deployment is single-tenant. */
export const INVOICE_NUMBER_COUNTER_PATH = 'counters/invoiceNumber';

/** The ruled zone for the switch and the year segment. */
export const INVOICE_NUMBER_TIME_ZONE = 'America/Chicago';

/** The first year issued in the year style. */
export const YEAR_STYLE_FROM = 2027;

/** Digits in the year style's sequence segment. A longer sequence gets longer. */
const SEQUENCE_PAD = 4;

/** How many taken numbers a mint will step over before it gives up loudly. */
const MAX_SKIPS = 50;

/** `INV-2027-0001` from a year and a sequence. Pure. */
export function formatInvoiceNumber(year: number, sequence: number): string {
  const seq = Math.max(1, Math.trunc(sequence));
  return `INV-${String(year)}-${String(seq).padStart(SEQUENCE_PAD, '0')}`;
}

/**
 * The sequence value a counter field holds, or null when it holds nothing
 * usable. A missing, junk, zero or negative value reads as "not seeded", never
 * a throw: refusing to create an invoice over a counter somebody edited in the
 * console would be the worse answer.
 */
export function storedSequence(stored: unknown): number | null {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return null;
  const n = Math.trunc(stored);
  return n < 1 ? null : n;
}

/** The calendar year of `now` in the business's zone. */
export function businessYearOf(now: Date): number {
  const year = new Intl.DateTimeFormat('en-US', { timeZone: INVOICE_NUMBER_TIME_ZONE, year: 'numeric' }).format(now);
  return Number(year);
}

/** Which style an invoice issued at `now` gets. Pure. */
export function invoiceNumberStyleAt(now: Date): { style: 'plain' } | { style: 'year'; year: number } {
  const year = businessYearOf(now);
  return year < YEAR_STYLE_FROM ? { style: 'plain' } : { style: 'year', year };
}

/** An all-digit stored number, as its value, or null. `"1019"` is 1019; `"INV-2026-0001"` is null. */
export function plainNumberValue(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

/**
 * Is `invoiceNumber` already held by an invoice other than `exceptId`?
 * Read through the transaction when one is passed, so the answer and the write
 * that depends on it commit together.
 */
export async function invoiceNumberTaken(
  firestore: Firestore,
  invoiceNumber: string,
  exceptId: string | null,
  tx?: Transaction,
): Promise<boolean> {
  const q = firestore.collection('invoices').where('invoiceNumber', '==', invoiceNumber).limit(2);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.some((d) => d.id !== exceptId);
}

/** One past the highest plain number stored on any invoice, or 1 on an empty collection. */
async function seedPlainSequence(firestore: Firestore, tx: Transaction): Promise<number> {
  const snap = await tx.get(firestore.collection('invoices'));
  let highest = 0;
  for (const d of snap.docs) {
    const n = plainNumberValue((d.data() ?? {})['invoiceNumber']);
    if (n !== null && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * Reserves and returns the next invoice number INSIDE A TRANSACTION THE CALLER
 * ALREADY OWNS (#825: `createInvoice` and `createQuote` write the document and
 * take the number in one transaction, so a replay never spends a number).
 *
 * FIRESTORE'S READ-BEFORE-WRITE RULE applies to the caller's whole transaction:
 * call this before staging any write, or the transaction is rejected.
 */
export async function mintInvoiceNumberInTransaction(
  tx: Transaction,
  firestore: Firestore,
  now: Date = new Date(),
): Promise<string> {
  const counterRef: DocumentReference = firestore.doc(INVOICE_NUMBER_COUNTER_PATH);
  const counterSnap = await tx.get(counterRef);
  const counter = (counterSnap.exists ? counterSnap.data() : undefined) ?? {};
  const when = invoiceNumberStyleAt(now);

  let seq: number;
  if (when.style === 'plain') {
    seq = storedSequence(counter['nextPlain']) ?? (await seedPlainSequence(firestore, tx));
  } else {
    const byYear = (counter['byYear'] ?? {}) as Record<string, unknown>;
    seq = storedSequence(byYear[String(when.year)]) ?? 1;
  }
  const render = (n: number) => (when.style === 'plain' ? String(n) : formatInvoiceNumber(when.year, n));

  // Step over a number somebody typed by hand onto another invoice.
  for (let skips = 0; await invoiceNumberTaken(firestore, render(seq), null, tx); skips += 1) {
    if (skips >= MAX_SKIPS) {
      throw new Error(
        `Invoice number ${render(seq)} and the ${String(MAX_SKIPS)} after it are already taken. ` +
          `Check ${INVOICE_NUMBER_COUNTER_PATH} and the invoices numbered by hand.`,
      );
    }
    seq += 1;
  }

  if (when.style === 'plain') {
    tx.set(counterRef, { nextPlain: seq + 1 }, { merge: true });
  } else {
    tx.set(counterRef, { byYear: { [String(when.year)]: seq + 1 } }, { merge: true });
  }
  return render(seq);
}

/** The same reservation in a transaction of its own. */
export async function mintInvoiceNumber(firestore: Firestore, now: Date = new Date()): Promise<string> {
  return firestore.runTransaction((tx) => mintInvoiceNumberInTransaction(tx, firestore, now));
}
