package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.InvoiceLineItem
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Invoice line items and the archive flag: decoding them, and the money rules
 * that go with them. Pure, so it is unit-tested directly (the
 * `domain/CoveragePackage.kt` precedent).
 *
 * MONEY IS INTEGER CENTS HERE, matching the server's `lib/invoiceMath.ts`.
 * `Invoice.total` and `.amountDue` stay `Double` DOLLARS because the portal, the
 * PDF, the Stripe path and the `onInvoicesWrite` trigger all read them that way,
 * but they are a SERVER-DERIVED PROJECTION of the cents figures, never an input.
 * Nothing in this file adds one dollar amount to another.
 *
 * ANDROID IS READ-ONLY ON LINE ITEMS in Task 5.1, by explicit ruling. It renders
 * what the web wrote and never writes lines itself, so there is no validator and
 * no editor here. The editable version, and the un-invoiced-visits picker that
 * depends on it, are task 5.1a. Archive was NOT deferred with them, because an
 * invoice archived on web would otherwise still be counted into Android's
 * revenue tiles, which is a correctness bug rather than a parity nicety.
 */

/**
 * Is this invoice archived?
 *
 * PRESENCE, NOT TRUTHINESS. An archived invoice carries a server timestamp; an
 * active one carries nothing at all. `unarchiveInvoice` writes an explicit
 * `null` rather than deleting the field, so null must read as "not archived"
 * exactly as an absent field does.
 *
 * DO NOT TURN THIS INTO A FIRESTORE PREDICATE. `whereEqualTo("archivedAt", null)`
 * matches only documents that HAVE the field set to null, and every invoice
 * predating Task 5.1 lacks it entirely. Archiving new invoices does not
 * retroactively give it to the old ones, so a server-side exclusion would return
 * ZERO rows and would do it silently, with no error to notice. The exclusion is
 * applied in memory over loaded rows, the same call the React admin makes, until
 * a backfill exists.
 */
fun invoiceIsArchived(invoice: Invoice): Boolean = invoice.archivedAt != null

/**
 * The stored line items, or NULL when this invoice was never itemized.
 *
 * Null and an empty list are different answers. Null means nobody has itemized
 * this invoice, which is true of every invoice created before Task 5.1; an empty
 * list means somebody itemized it as billing nothing. The server's
 * `updateInvoice` refuses to recompute an un-itemized invoice on exactly that
 * distinction, and the detail screen says two different things about them, so
 * they are not collapsed here.
 *
 * NEVER THROWS. `Invoice.lineItems` is held raw because `firestore.rules` grants
 * `allow update: if isAuntie()` over the whole collection and `postInvoiceEvent`
 * merges an arbitrary payload, so this field can genuinely hold junk. A row that
 * is not a usable line is DROPPED; a value that is not a list at all reads as
 * "not itemized". Same rule and same reason as `decodeTagDefs`: a bad document
 * must never take down the surface that reads it.
 */
fun decodeInvoiceLineItems(raw: Any?): List<InvoiceLineItem>? {
    val list = raw as? List<*> ?: return null
    val out = mutableListOf<InvoiceLineItem>()
    for (entry in list) {
        val map = entry as? Map<*, *> ?: continue
        val qty = (map["qty"] as? Number)?.toDouble() ?: continue
        val unitCents = (map["unitCents"] as? Number)?.toLong() ?: continue
        if (!qty.isFinite()) continue
        out.add(
            InvoiceLineItem(
                description = map["description"] as? String ?: "",
                qty = qty,
                unitCents = unitCents,
                discountCents = (map["discountCents"] as? Number)?.toLong() ?: 0L,
            ),
        )
    }
    return out
}

/** Convenience over [decodeInvoiceLineItems] for the common `Invoice` case. */
fun invoiceLineItems(invoice: Invoice): List<InvoiceLineItem>? = decodeInvoiceLineItems(invoice.lineItems)

/**
 * One line's charge, in whole cents.
 *
 * Rounds HALF-UP exactly once, here, so no fractional cent ever reaches a sum.
 * `qty` is capped at 999 and `unitCents` at 10,000,000 by the server's schema,
 * so the product is at most 1e10, well inside the exact-integer range of a
 * Double: the multiply is exact and the rounding is a deliberate decision about
 * fractional cents rather than floating-point slop.
 */
fun lineAmountCents(line: InvoiceLineItem): Long {
    if (!line.qty.isFinite()) return -line.discountCents
    return (line.qty * line.unitCents).roundToLong() - line.discountCents
}

/** Sum of the line amounts, before any whole-invoice discount. Exact integer addition. */
fun invoiceSubtotalCents(lines: List<InvoiceLineItem>): Long = lines.sumOf { lineAmountCents(it) }

/**
 * What the lines actually add up to, after the whole-invoice discount.
 *
 * Negative results are reported HONESTLY rather than clamped at zero, matching
 * the server: a discount larger than the subtotal is an operator error, and
 * flooring it would replace a visible mistake with a plausible-looking $0.00.
 */
fun invoiceDerivedTotalCents(lines: List<InvoiceLineItem>, invoiceDiscountCents: Long): Long =
    invoiceSubtotalCents(lines) - invoiceDiscountCents

/**
 * Does the stored total actually agree with the lines beside it?
 *
 * NOT DEFENSIVE THEATRE. `firestore.rules:219-226` is `allow update: if
 * isAuntie()` over the whole invoices collection, and `postInvoiceEvent` merges
 * an arbitrary payload. Both bypass every callable that would have kept the two
 * in step, so a stored total drifting away from the sum of its lines is a
 * reachable state.
 *
 * Returns null when there is nothing to compare: an un-itemized invoice has no
 * lines to disagree with, and its stored total is the only assertion anyone has
 * ever made about it. Otherwise it returns BOTH figures, and the screen NAMES
 * BOTH and RECONCILES NEITHER. Picking a winner here, or quietly showing the
 * derived figure in place of the stored one, would hide the drift from the only
 * person who can resolve it.
 *
 * `totalCents` is preferred over the dollar `total` when present because it is
 * the exact integer the server wrote. The dollar fallback matters: an invoice
 * edited outside the callables can easily carry a changed `total` and a stale or
 * absent `totalCents`, which is precisely the case worth catching.
 */
data class InvoiceTotalDisagreement(val derivedCents: Long, val storedCents: Long)

fun invoiceTotalDisagreement(invoice: Invoice): InvoiceTotalDisagreement? {
    val lines = invoiceLineItems(invoice) ?: return null
    val derived = invoiceDerivedTotalCents(lines, invoice.invoiceDiscountCents)
    val stored = if (invoice.totalCents != 0L) {
        invoice.totalCents
    } else {
        // Compared in integers so a float representation artifact can never
        // masquerade as real drift.
        (invoice.total * 100).roundToLong()
    }
    return if (stored == derived) null else InvoiceTotalDisagreement(derived, stored)
}

/** "$36.00" / "-$12.50" from an integer count of cents. */
fun formatCents(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    return "$sign$%.2f".format(abs(cents) / 100.0)
}

/** "3" for a whole quantity, "2.5" for a fractional one. Never money-style decimals. */
fun formatQty(qty: Double): String {
    if (!qty.isFinite()) return "0"
    return if (qty == qty.toLong().toDouble()) qty.toLong().toString() else "%.2f".format(qty).trimEnd('0').trimEnd('.')
}
