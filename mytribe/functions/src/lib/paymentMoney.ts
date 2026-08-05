/**
 * WHAT A PAYMENT ROW IS MADE OF, in integer cents, and the one place that
 * arithmetic is written down.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ─────────────────────────────────────────
 *
 * The operator is paid through Venmo and PayPal business accounts, records each
 * payment by hand, and is charged a processor fee which she takes out of the
 * tip. Her previous system had a Fees field. This one had no fee at any layer,
 * so the fee was dropped on the way in and the rows it was dropped from can no
 * longer be made to add up. Invoice #1029 is the live example:
 *
 *     Amount   $137.50
 *     Applied  $127.50
 *     Tip        $7.29
 *     Balance    $0.00
 *
 * $2.71 is missing and nothing on the record says where it went. It is the
 * processor fee. The true arithmetic was:
 *
 *     amount(137.50) = applied(127.50) + tipGross(10.00)
 *     fee(2.71)      taken out of the tip, off her proceeds
 *     tipNet(7.29)   = tipGross(10.00) - fee(2.71)
 *     proceeds(134.79) = amount(137.50) - fee(2.71)
 *
 * The previous system stored the NET tip and the fee separately. The migration
 * kept the net tip and dropped the fee, which loses BOTH numbers: the gross tip
 * cannot be recovered from a net tip whose deduction is unknown.
 *
 * ── THE OPERATOR'S RULING, 2026-08-04, verbatim ───────────────────────────
 *
 *   "store both, and display the latter. itll help with taxes."
 *
 * So the stored tip is the GROSS tip, the fee is stored beside it, and the net
 * is derived. The reason is tax treatment and it decides the shape: the gross
 * tip is income and the processor fee is a deductible business expense. A
 * system that remembers only the net has thrown away one line of her Schedule C
 * and understated the other.
 *
 * ── THE IDENTITY ──────────────────────────────────────────────────────────
 *
 *     amountCents = appliedCents + tipCents + unappliedCents
 *
 * ONE PAYMENT APPLIES TO ONE INVOICE. That is the operator's own ruling, 2026
 * -08-04, on being offered a multi-invoice split: "this is not something i
 * want." Her screen bears it out: one open invoice, one Applied Invoices card,
 * one "Apply: $" box. `appliedCents` therefore names a single invoice and
 * nothing here generalises it into a list.
 *
 * `amountCents` is the whole sum that left the client's hands. `tipCents` is
 * the GROSS tip inside it. `unappliedCents` is what is left over, which is the
 * figure she checks before saving to catch a mis-keyed amount.
 *
 * The fee is NOT in that identity, deliberately: it is not part of what the
 * client paid, it is a deduction from what the operator receives. It belongs to
 * `proceedsCents`, on the other side of the ledger.
 *
 * ── WHY A TIP NEEDS A BASIS FIELD ─────────────────────────────────────────
 *
 * This change gives the existing `tip` field a NEW MEANING. Before it, a stored
 * tip was whatever the source happened to record; after it, a stored tip is the
 * gross. Both conventions now live in the same collection, and the bytes are
 * identical, so a reader cannot tell a $7.29 gross tip from a $7.29 net one.
 * That is precisely the defect PR #243 left behind on `createdAt`, and
 * `createdAtSource` is the shape of the answer: a marker that says which
 * convention a given document follows, so nothing has to guess.
 *
 * `tipBasis` is that marker. It is stamped `'gross'` on every row this server
 * writes from now on. It is ABSENT on every row written before, and absent
 * reads as `'unknown'`, NOT as `'net'`.
 *
 * That is the deliberate difference from `createdAtSource`, which defaults to
 * `'live'`. There, absence was evidence: exactly one import had ever run and it
 * stamped everything it touched. Here absence is not evidence. The root
 * `payments` collection was written by a legacy migration (net tips), by
 * `stripeWebhook.ts` (no tip at all), and by this callable before today
 * (whatever the caller sent). Defaulting those to `'net'` would state a fact
 * about each row that nobody checked, on the exact field whose last unchecked
 * assumption is the bug being fixed.
 *
 * NO BACK-COMPUTED GROSS. Given a net tip and no fee there is no arithmetic
 * that recovers the gross, and inventing a plausible one would put a number
 * that was never collected onto a tax return. An unknown-basis row is displayed
 * as what it is and marked as unreconcilable; see `paymentReconciles`.
 */

/**
 * Which convention a stored `tip` follows.
 *
 *   gross    what the client actually tipped, before the processor fee. The
 *            only value this server writes. `fee`/`feeCents` sits beside it and
 *            the net is derived.
 *   net      what reached the operator after the fee came out. Set only by a
 *            writer that can prove it; nothing in this repo writes it today. It
 *            exists so a future import that DOES carry both numbers can say so
 *            rather than being forced into `unknown`.
 *   unknown  no marker on the row. The tip is a number whose convention nobody
 *            recorded, and the fee that would settle it was dropped.
 */
export type TipBasis = 'gross' | 'net' | 'unknown';

/** The three values, for zod enums and for the clients' mirrors. */
export const TIP_BASES = ['gross', 'net', 'unknown'] as const;

/** The stored field name, named once so the writer and the readers cannot drift. */
export const TIP_BASIS_FIELD = 'tipBasis';

/**
 * Reads a stored `tipBasis`. Absent, blank, and unrecognized all read as
 * `'unknown'`.
 *
 * UNRECOGNIZED IS NOT AN EXCEPTION, for the same reason `readCreatedAtSource`
 * does not throw: this runs inside ledger rendering, and one malformed document
 * must not blank an operator's payment history. It reads as `'unknown'`, which
 * is the honest answer for a value nothing can interpret, and the row is marked
 * rather than silently trusted.
 */
export function readTipBasis(raw: unknown): TipBasis {
  return typeof raw === 'string' && (TIP_BASES as readonly string[]).includes(raw)
    ? (raw as TipBasis)
    : 'unknown';
}

/** Everything the arithmetic below needs, in integer cents. */
export interface PaymentMoneyInput {
  /** The whole sum collected from the client, tip included. */
  amountCents: number;
  /** The GROSS tip inside `amountCents`, when `tipBasis` says so. */
  tipCents: number;
  /** The processor's cut, deducted from the operator's proceeds. */
  feeCents: number;
  /** What was put against THE invoice. One payment, one invoice. */
  appliedCents: number;
  tipBasis: TipBasis;
}

/** Every derived figure for one payment row. */
export interface PaymentMoney {
  amountCents: number;
  tipCents: number;
  feeCents: number;
  appliedCents: number;
  /**
   * What the payment has left over. NEVER clamped: see `paymentOverApplied`. A
   * negative value means more was applied than came in, which is an operator
   * error to show, not to hide.
   */
  unappliedCents: number;
  /** What the operator actually receives: the collection less the processor fee. */
  proceedsCents: number;
  /**
   * What she keeps of the tip, once the fee is out of it. `null` when the basis
   * is not `'gross'`, because subtracting a fee from a net tip charges it twice
   * and subtracting it from an unknown tip is arithmetic on a guess.
   */
  tipNetCents: number | null;
}

/** A broken number reads as 0, never as NaN. Same rule as `invoiceMath.ts#finite`. */
function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Dollars-as-float to integer cents, rounded ONCE, floored at zero. */
export function dollarsToCents(v: unknown): number {
  return Math.max(0, Math.round(finite(v) * 100));
}

/** The legacy dollar projection of a cents figure. Mirrors `invoiceMath.ts#centsToDollars`. */
export function centsToDollars(cents: number): number {
  return Number((finite(cents) / 100).toFixed(2));
}

/**
 * Every derived figure for one payment, from its stored parts.
 *
 * Integer addition throughout. Nothing here divides, so nothing here can
 * introduce a fractional cent.
 */
export function paymentMoneyOf(input: PaymentMoneyInput): PaymentMoney {
  const amountCents = Math.round(finite(input.amountCents));
  const tipCents = Math.round(finite(input.tipCents));
  const feeCents = Math.round(finite(input.feeCents));
  const appliedCents = Math.round(finite(input.appliedCents));

  return {
    amountCents,
    tipCents,
    feeCents,
    appliedCents,
    unappliedCents: amountCents - appliedCents - tipCents,
    proceedsCents: amountCents - feeCents,
    tipNetCents: input.tipBasis === 'gross' ? tipCents - feeCents : null,
  };
}

/**
 * More was applied to the invoice than the payment can cover.
 *
 * A distinct question from "is there anything left", because the answers point
 * opposite ways: an unapplied balance is money waiting to be used, and an
 * over-application is a bill credited with money that never arrived. The
 * callable refuses this outright; the reader surfaces it, because a row already
 * in this shape must not render as if it balanced.
 */
export function paymentOverApplied(money: PaymentMoney): boolean {
  return money.unappliedCents < 0;
}

/**
 * Can this row be reconciled by a reader, or is it one of the rows the dropped
 * fee ruined?
 *
 * TRUE means `amount = applied + tipGross + unapplied` is a statement about
 * this row that can actually be checked, because the tip in it is known to be
 * the gross one. FALSE means the row carries a tip whose convention was never
 * recorded, so the identity cannot be evaluated and must not be presented as
 * though it had been.
 *
 * A row with NO TIP reconciles whatever its basis says. There is no convention
 * to be wrong about when the number is zero, and marking those would put a
 * caveat on every Stripe row and every payment nobody tipped on, which is the
 * noise that trains an operator to stop reading caveats.
 */
export function paymentReconciles(input: { tipCents: number; tipBasis: TipBasis }): boolean {
  return Math.round(finite(input.tipCents)) === 0 || input.tipBasis === 'gross';
}
