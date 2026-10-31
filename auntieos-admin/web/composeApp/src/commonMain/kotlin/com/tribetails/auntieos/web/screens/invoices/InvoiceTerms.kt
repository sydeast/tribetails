package com.tribetails.auntieos.web.screens.invoices

import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.plus

/**
 * #1178: payment terms as a code, and the due date worked out from them.
 *
 * The FOURTH copy of one rule table. `mytribe/functions/src/lib/invoiceTerms.ts`
 * owns it; `auntieos-admin/src/lib/invoiceTerms.ts` (web) and the Android
 * `domain/InvoiceTerms.kt` mirror it, and this mirrors the Android copy for the
 * desktop composer. The composer has to show the due date while the operator is
 * still choosing, so a client-side preview has to exist. The server resolves
 * again on write and refuses a due date that disagrees, so this is a preview,
 * never the authority. `InvoiceTermsParityTest` (jvmTest) reads the server file
 * off disk and pins this table to it entry by entry.
 *
 * Pure: it reads no clock. Every date is a `YYYY-MM-DD` calendar day, never a
 * timestamp. A due date already in the past is reported through
 * [DueDateResolution.isPast] and never moved to today.
 */

/** What a terms code counts from. */
enum class InvoiceTermsBasis { INVOICE, SERVICE, NONE }

/**
 * Every terms rule, in the order the composer offers them (pinned to the
 * server's `INVOICE_TERMS_CODES` order).
 *
 * @property wire the `termsCode` value on the wire.
 * @property label how the operator picks it.
 * @property words how the household reads it on the invoice.
 */
enum class InvoiceTermsCode(
    val wire: String,
    val basis: InvoiceTermsBasis,
    val days: Int,
    val label: String,
    val words: String,
) {
    DUE_ON_RECEIPT("due_on_receipt", InvoiceTermsBasis.INVOICE, 0, "Due on receipt", "Due on receipt"),
    NET_7(
        "net_7", InvoiceTermsBasis.INVOICE, 7,
        "Due 7 days after the invoice date", "Due 7 days after the invoice date",
    ),
    NET_14(
        "net_14", InvoiceTermsBasis.INVOICE, 14,
        "Due 14 days after the invoice date", "Due 14 days after the invoice date",
    ),
    NET_30(
        "net_30", InvoiceTermsBasis.INVOICE, 30,
        "Due 30 days after the invoice date", "Due 30 days after the invoice date",
    ),
    DUE_ON_LAST_VISIT(
        "due_on_last_visit", InvoiceTermsBasis.SERVICE, 0,
        "Due on the day of the last visit", "Due on the day of the last visit",
    ),
    NET_7_AFTER_LAST_VISIT(
        "net_7_after_last_visit", InvoiceTermsBasis.SERVICE, 7,
        "Due 7 days after the last visit", "Due 7 days after the last visit",
    ),
    NET_14_AFTER_LAST_VISIT(
        "net_14_after_last_visit", InvoiceTermsBasis.SERVICE, 14,
        "Due 14 days after the last visit", "Due 14 days after the last visit",
    ),
    CUSTOM(
        "custom", InvoiceTermsBasis.NONE, 0,
        "A date I pick myself", "Due by the date shown on this invoice",
    ),
}

/** Every rule, in the order the composer offers them. */
fun invoiceTermsDefs(): List<InvoiceTermsCode> = InvoiceTermsCode.entries.toList()

/** A `YYYY-MM-DD` that is also a real calendar day (2026-02-30 is not one). */
fun isCalendarDay(value: String): Boolean {
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(value)) return false
    return try {
        LocalDate.parse(value)
        true
    } catch (_: IllegalArgumentException) {
        false
    }
}

/** [day] plus [days] calendar days. Returns [day] unchanged when it is not a calendar day. */
fun addDays(day: String, days: Int): String {
    if (!isCalendarDay(day)) return day
    return LocalDate.parse(day).plus(days, DateTimeUnit.DAY).toString()
}

/** The last day work was done. Accepts ISO timestamps; skips unreadable entries. */
fun lastServiceDay(serviceDates: List<String>): String? {
    var latest: String? = null
    for (raw in serviceDates) {
        val day = raw.trim().take(10)
        if (!isCalendarDay(day)) continue
        if (latest == null || day > latest) latest = day
    }
    return latest
}

/**
 * What [resolveDueDate] worked out. [dueDate] null means the terms cannot
 * decide one, and [problem] says why in the server's own words.
 */
data class DueDateResolution(
    val dueDate: String?,
    val isPast: Boolean,
    val basisDay: String?,
    val problem: String?,
)

/** The due date these terms mean, given the invoice date, the work on it, and today. */
fun resolveDueDate(
    code: InvoiceTermsCode,
    invoiceDate: String,
    serviceDates: List<String>,
    now: String,
): DueDateResolution {
    if (code.basis == InvoiceTermsBasis.NONE) {
        return DueDateResolution(
            dueDate = null,
            isPast = false,
            basisDay = null,
            problem = "These terms let you pick the due date, so there is nothing to work out. " +
                "Choose the date yourself.",
        )
    }

    val basisDay = if (code.basis == InvoiceTermsBasis.INVOICE) {
        invoiceDate.trim().takeIf { isCalendarDay(it) }
    } else {
        lastServiceDay(serviceDates)
    }

    if (basisDay == null) {
        return DueDateResolution(
            dueDate = null,
            isPast = false,
            basisDay = null,
            problem = if (code.basis == InvoiceTermsBasis.INVOICE) {
                "These terms count from the invoice date, and this invoice has no date on it yet. " +
                    "Set the date, or pick the date yourself."
            } else {
                "These terms count from the last visit, and there are no visits on this invoice yet. " +
                    "Add the visits it covers, or pick the date yourself."
            },
        )
    }

    val dueDate = addDays(basisDay, code.days)
    return DueDateResolution(
        dueDate = dueDate,
        // Strictly before: due today is due, not overdue.
        isPast = isCalendarDay(now) && dueDate < now,
        basisDay = basisDay,
        problem = null,
    )
}
