/**
 * #2334: what an online (Stripe Checkout) payment was actually paid with, and
 * the plain words every surface shows for a payment's method.
 *
 * THE STORED METHOD STAYS `'stripe'` (`CARD_PAYMENT_METHOD`). Dedupe, the
 * backfill scripts and `resolveUnappliedPayment` all key off that word, so the
 * actual method rides beside it in {@link ONLINE_METHOD_FIELD}: Stripe's own
 * `payment_method_details.type` (`card`, `klarna`, `affirm`), or the card's
 * wallet (`apple_pay`, `google_pay`, `link`) when the card came from one.
 *
 * Ruling 2026-11-21 (docket v196, #2334 "method"): online payments read as the
 * actual method, Card, Klarna, Affirm. A row written before the field existed
 * reads "Online payment", never "stripe".
 */

import { FALLBACK_BUSINESS_TIME_ZONE } from './businessHours';

/** The field on both the invoice's payment row and the root ledger row. */
export const ONLINE_METHOD_FIELD = 'onlineMethod';

/** What a Stripe payment with no stored method reads as. */
export const ONLINE_PAYMENT_FALLBACK_LABEL = 'Online payment';

/** The stored method word for a payment taken through Stripe Checkout. Mirrors `CARD_PAYMENT_METHOD`. */
const STRIPE_METHOD = 'stripe';

/**
 * Stripe's method and wallet keys, in plain words. A key not listed here reads
 * as {@link ONLINE_PAYMENT_FALLBACK_LABEL}: a raw key never reaches a screen.
 */
const ONLINE_METHOD_LABELS: Readonly<Record<string, string>> = {
  card: 'Card',
  klarna: 'Klarna',
  affirm: 'Affirm',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  samsung_pay: 'Samsung Pay',
  link: 'Link',
  amazon_pay: 'Amazon Pay',
  cashapp: 'Cash App Pay',
  paypal: 'PayPal',
  afterpay_clearpay: 'Afterpay',
  us_bank_account: 'Bank account',
  masterpass: 'Masterpass',
  visa_checkout: 'Visa Checkout',
  amex_express_checkout: 'Amex Express Checkout',
};

/** A Stripe key we store: lower-case letters, digits and underscores, short. */
const STRIPE_KEY = /^[a-z0-9_]{1,40}$/;

function keyOrNull(v: unknown): string | null {
  return typeof v === 'string' && STRIPE_KEY.test(v) ? v : null;
}

/**
 * The method a charge was paid with, off `charge.payment_method_details`, or
 * null when the charge does not say (unexpanded, absent, or a shape we cannot
 * read). A card paid from a wallet is stored as the wallet, since that is what
 * the household tapped.
 *
 * PURE, and it never throws: the payment is real whether or not this resolves.
 */
export function onlineMethodOfCharge(charge: unknown): string | null {
  if (!charge || typeof charge !== 'object') return null;
  const details = (charge as { payment_method_details?: unknown }).payment_method_details;
  if (!details || typeof details !== 'object') return null;
  const type = keyOrNull((details as { type?: unknown }).type);
  if (type === null) return null;
  if (type === 'card') {
    const card = (details as { card?: unknown }).card;
    const wallet = card && typeof card === 'object' ? (card as { wallet?: unknown }).wallet : null;
    const walletType = wallet && typeof wallet === 'object' ? keyOrNull((wallet as { type?: unknown }).type) : null;
    // `unknown` is Stripe's own word for a wallet it could not name: the card is the fact.
    if (walletType !== null && walletType !== 'unknown') return walletType;
  }
  return type;
}

/**
 * Epoch ms off a stored Firestore Timestamp (or anything shaped like one), or
 * null when the value is not one. Strings and numbers are NOT timestamps here:
 * the ledger `date` is free text when a person wrote it.
 */
export function timestampMillisOf(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as { toMillis?: unknown; seconds?: unknown; _seconds?: unknown; nanoseconds?: unknown; _nanoseconds?: unknown };
  if (typeof t.toMillis === 'function') {
    const ms = (t.toMillis as () => unknown)();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  const seconds = typeof t.seconds === 'number' ? t.seconds : typeof t._seconds === 'number' ? t._seconds : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const nanos = typeof t.nanoseconds === 'number' ? t.nanoseconds : typeof t._nanoseconds === 'number' ? t._nanoseconds : 0;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

/** `YYYY-MM-DD` for an instant on `timeZone`'s clock, or null when the zone cannot be read. */
export function businessDayOfMillis(ms: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

/**
 * #2334: the root ledger row's `date` as TEXT, which is what every reader and
 * client expects.
 *
 * A person-recorded row holds free text ("February 17, 2026") and passes
 * through untouched. The Stripe webhook has always stored a server Timestamp,
 * which `str()` read as `''` and every admin app showed as "no date recorded".
 * Such a row now reads as its business day, `YYYY-MM-DD`, on the business's
 * clock: a card paid at 9 PM in Chicago is that day, not tomorrow in UTC.
 *
 * PURE. `timeZone` is the business zone; a caller reads it only when
 * {@link anyTimestamp} says a row needs it.
 */
export function ledgerDateText(raw: unknown, timeZone: string): string {
  if (typeof raw === 'string') return raw;
  const ms = timestampMillisOf(raw);
  if (ms === null) return '';
  return businessDayOfMillis(ms, timeZone) ?? businessDayOfMillis(ms, FALLBACK_BUSINESS_TIME_ZONE) ?? '';
}

/** Whether any of these stored dates is a Timestamp, so the business zone is worth reading. */
export function anyTimestamp(raws: readonly unknown[]): boolean {
  return raws.some((r) => timestampMillisOf(r) !== null);
}

/** The plain words for a stored online method key. Unknown or absent reads "Online payment". */
export function onlineMethodLabel(onlineMethod: unknown): string {
  const key = keyOrNull(onlineMethod);
  return (key !== null ? ONLINE_METHOD_LABELS[key] : undefined) ?? ONLINE_PAYMENT_FALLBACK_LABEL;
}

/**
 * What a payment row's Method says.
 *
 *  - a Stripe payment: its actual method, or "Online payment" when none was stored;
 *  - anything else: the method as the admin recorded it, trimmed;
 *  - no method at all: `''`, so each client keeps its own words for a blank
 *    ("no method recorded").
 */
export function paymentMethodLabelOf(method: unknown, onlineMethod: unknown): string {
  const stored = typeof method === 'string' ? method.trim() : '';
  if (stored.toLowerCase() === STRIPE_METHOD) return onlineMethodLabel(onlineMethod);
  return stored;
}

/** What a payment row with no method reads as on the household's own bill. */
export const HOUSEHOLD_PAYMENT_FALLBACK_LABEL = 'Payment';

/**
 * #2334: the same rule as {@link paymentMethodLabelOf}, worded for the
 * household's Payment History: it opens with a capital ("account credit" reads
 * "Account credit", a typed "venmo" reads "Venmo"), and a row with no method
 * reads "Payment" rather than an office phrase.
 */
export function householdMethodLabelOf(method: unknown, onlineMethod: unknown): string {
  const label = paymentMethodLabelOf(method, onlineMethod);
  if (label === '') return HOUSEHOLD_PAYMENT_FALLBACK_LABEL;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * #2334: the business day a payment row's `paidAt` falls on, or null.
 *
 *  - a bare day (`2026-11-20`) is that day;
 *  - an ISO instant (every writer's `toISOString()`) is read on the business's
 *    clock, so a card paid at 9 PM in Chicago is that day, not tomorrow in UTC;
 *  - a Timestamp is read the same way;
 *  - anything else is null.
 */
export function paymentDayOf(paidAt: unknown, timeZone: string): string | null {
  if (typeof paidAt === 'string') {
    const s = paidAt.trim();
    if (CALENDAR_DAY.test(s)) return s;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
    // A wall-clock time with no zone is the business's clock already.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s.slice(0, 10);
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    return businessDayOfMillis(ms, timeZone) ?? businessDayOfMillis(ms, FALLBACK_BUSINESS_TIME_ZONE);
  }
  const ms = timestampMillisOf(paidAt);
  if (ms === null) return null;
  return businessDayOfMillis(ms, timeZone) ?? businessDayOfMillis(ms, FALLBACK_BUSINESS_TIME_ZONE);
}
