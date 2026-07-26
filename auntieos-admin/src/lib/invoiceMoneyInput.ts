/**
 * Turning what an operator TYPES into the integer cents the server stores, and
 * back again.
 *
 * The operator thinks in dollars, because that is what an invoice is written in.
 * The system stores integer cents, because adding float dollars is the classic
 * money bug (`lib/invoiceMath.ts` has the full argument). This module is the
 * only place the two meet, so the conversion happens once, deliberately, instead
 * of being re-improvised in each field.
 *
 * EVERY FAILURE IS AN EXPLICIT null, NEVER A 0. That is the whole design rule
 * here. `Number('')` is 0 and `parseFloat('abc')` is NaN, and both would sail
 * into a total: a blank price field would silently bill a household nothing for
 * real work and look completely deliberate on the finished invoice. So an
 * unreadable figure returns null and the caller has to decide what to say about
 * it, which is the same call `listUninvoicedSessions` makes server-side when a
 * rate will not parse.
 */

/** The largest unit price the server's zod schema accepts: $100,000.00. */
export const MAX_UNIT_CENTS = 10_000_000;

/** The largest quantity the server's zod schema accepts. */
export const MAX_QTY = 999;

/**
 * "12.50" -> 1250. Returns null for anything that is not a readable, non-negative
 * amount of money.
 *
 * Accepts a leading `$`, thousands separators and surrounding whitespace,
 * because operators paste figures out of other documents and refusing "$1,250.00"
 * on a technicality is a worse experience than reading it. Rejects anything with
 * more than two decimal places rather than rounding it: "12.345" is a typo, and
 * silently deciding whether it meant $12.34 or $12.35 is not this function's
 * call to make.
 */
export function parseDollarsToCents(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const dollars = Number(s);
  if (!Number.isFinite(dollars)) return null;
  // toFixed before rounding: 12.55 * 100 is 1254.9999... in binary floating
  // point, and Math.round of that is still 1255, but the fixed form makes the
  // intent explicit rather than relying on the error landing the right way.
  return Math.round(Number(dollars.toFixed(2)) * 100);
}

/**
 * 1250 -> "12.50", for seeding an input from a stored figure.
 *
 * Always two decimals: an input pre-filled with "12" invites an operator to
 * append a digit and accidentally bill $125.
 */
export function centsToInputDollars(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

/**
 * "2.5" -> 2.5. Returns null for anything that is not a readable, positive
 * quantity.
 *
 * Fractional is legitimate (2.5 hours), so this is not an integer parse. Zero
 * and negative are refused: a line billing zero units is not a line, and the
 * server's schema refuses it too, so catching it here means the operator hears
 * about it before the round trip rather than after.
 */
export function parseQty(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const qty = Number(s);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return qty;
}

/** A quantity as it should sit in an input: "3", not "3.00". */
export function qtyToInput(qty: number): string {
  if (!Number.isFinite(qty)) return '';
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(2)));
}
