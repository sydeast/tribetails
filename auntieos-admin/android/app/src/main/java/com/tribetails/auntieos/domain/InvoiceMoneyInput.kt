package com.tribetails.auntieos.domain

import kotlin.math.roundToLong

/**
 * Turning what an operator TYPES into the integer cents the server stores.
 *
 * The operator thinks in dollars, because that is what an invoice is written in.
 * The system stores integer cents, because adding float dollars is the classic
 * money bug (`domain/InvoiceLineItems.kt` and the server's `lib/invoiceMath.ts`
 * both carry the full argument). This file is the only place the two meet on
 * Android, so the conversion happens once, deliberately, instead of being
 * re-improvised in each field.
 *
 * EVERY FAILURE IS AN EXPLICIT null, NEVER A 0. That is the whole design rule
 * here, and it is the rule the old composer broke: it read every money field as
 * `toDoubleOrNull() ?: 0.0`, so a typo in a price field billed a household
 * nothing for real work and looked entirely deliberate on the finished invoice.
 * An unreadable figure returns null and the caller has to decide what to say
 * about it, which is the same call `listUninvoicedSessions` makes server-side
 * when a rate will not parse.
 *
 * Mirrors `auntieos-admin/src/lib/invoiceMoneyInput.ts` rule for rule.
 */

/** The largest unit price the server's zod schema accepts: $100,000.00. */
const val MAX_UNIT_CENTS: Long = 10_000_000L

/** The largest quantity the server's zod schema accepts. */
const val MAX_QTY: Double = 999.0

private val MONEY_RE = Regex("""^\d+(\.\d{1,2})?$""")

/**
 * "12.50" to 1250. Returns null for anything that is not a readable,
 * non-negative amount of money.
 *
 * Accepts a leading `$`, thousands separators and surrounding whitespace,
 * because operators paste figures out of other documents and refusing
 * "$1,250.00" on a technicality is a worse experience than reading it. Rejects
 * anything with more than two decimal places rather than rounding it: "12.345"
 * is a typo, and silently deciding whether it meant $12.34 or $12.35 is not this
 * function's call to make.
 */
fun parseDollarsToCents(raw: String): Long? {
    val s = raw.trim().removePrefix("$").replace(",", "")
    if (s.isEmpty()) return null
    if (!MONEY_RE.matches(s)) return null
    val dollars = s.toDoubleOrNull() ?: return null
    if (!dollars.isFinite()) return null
    // The regex already caps this at two decimal places, so the product is at
    // most a half-cent away from an integer and rounding it is exact rather
    // than a decision about fractional cents.
    return (dollars * 100).roundToLong()
}

/**
 * 1250 to "12.50", for seeding an input from a stored figure.
 *
 * Always two decimals: an input pre-filled with "12" invites an operator to
 * append a digit and accidentally bill $125.
 */
fun centsToInputDollars(cents: Long): String = "%.2f".format(cents / 100.0)

/**
 * Integer cents as the DOLLARS float the `invoices` collection has always stored
 * in `total` and `amountDue`.
 *
 * A PROJECTION, NEVER AN INPUT. The cents figure is what the lines were computed
 * in and what the server recomputes; this is the legacy shape the portal, the
 * PDF, the Stripe path and the `onInvoicesWrite` trigger all read. Rounded to
 * the cent so the projection can never carry a fraction the integer did not
 * have.
 */
fun centsToDollars(cents: Long): Double = cents.toDouble() / 100.0

/**
 * "2.5" to 2.5. Returns null for anything that is not a readable, positive
 * quantity.
 *
 * Fractional is legitimate (2.5 hours), so this is not an integer parse. Zero
 * and negative are refused: a line billing zero units is not a line, and the
 * server's schema refuses it too, so catching it here means the operator hears
 * about it before the round trip rather than after.
 */
fun parseQty(raw: String): Double? {
    val s = raw.trim()
    if (s.isEmpty()) return null
    if (!MONEY_RE.matches(s)) return null
    val qty = s.toDoubleOrNull() ?: return null
    if (!qty.isFinite() || qty <= 0.0) return null
    return qty
}
