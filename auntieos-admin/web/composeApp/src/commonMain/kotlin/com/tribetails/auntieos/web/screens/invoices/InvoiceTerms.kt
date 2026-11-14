package com.tribetails.auntieos.web.screens.invoices

import kotlin.time.Instant
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.plus
import kotlinx.datetime.toLocalDateTime

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
 * timestamp; a visit's instant is read as its business day first (#1966), and
 * visit-relative terms with no visits are due on receipt. A due date already in the past is reported through
 * [DueDateResolution.isPast] and never moved to today. A bill is never due
 * before its own date (#1966 review): visit-relative terms that land there are
 * due on receipt, and [DueDateResolution.beforeInvoiceDate] says why.
 */

/** What a terms code counts from. */
enum class InvoiceTermsBasis { INVOICE, SERVICE, FIRST_VISIT, NONE }

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
    DUE_ON_RECEIPT(
        "due_on_receipt", InvoiceTermsBasis.INVOICE, 0,
        "Due on receipt", "Due on receipt",
    ),
    DUE_ON_FIRST_VISIT(
        "due_on_first_visit", InvoiceTermsBasis.FIRST_VISIT, 0,
        "Due on the day of the first visit", "Due on the day of the first visit",
    ),
    DUE_ON_LAST_VISIT(
        "due_on_last_visit", InvoiceTermsBasis.SERVICE, 0,
        "Due on the day of the last visit", "Due on the day of the last visit",
    ),
    NET_1_AFTER_LAST_VISIT(
        "net_1_after_last_visit", InvoiceTermsBasis.SERVICE, 1,
        "Due 1 day after the last visit", "Due 1 day after the last visit",
    ),
    NET_2_AFTER_LAST_VISIT(
        "net_2_after_last_visit", InvoiceTermsBasis.SERVICE, 2,
        "Due 2 days after the last visit", "Due 2 days after the last visit",
    ),
    NET_3_AFTER_LAST_VISIT(
        "net_3_after_last_visit", InvoiceTermsBasis.SERVICE, 3,
        "Due 3 days after the last visit", "Due 3 days after the last visit",
    ),
    NET_4_AFTER_LAST_VISIT(
        "net_4_after_last_visit", InvoiceTermsBasis.SERVICE, 4,
        "Due 4 days after the last visit", "Due 4 days after the last visit",
    ),
    NET_5_AFTER_LAST_VISIT(
        "net_5_after_last_visit", InvoiceTermsBasis.SERVICE, 5,
        "Due 5 days after the last visit", "Due 5 days after the last visit",
    ),
    NET_6_AFTER_LAST_VISIT(
        "net_6_after_last_visit", InvoiceTermsBasis.SERVICE, 6,
        "Due 6 days after the last visit", "Due 6 days after the last visit",
    ),
    NET_7_AFTER_LAST_VISIT(
        "net_7_after_last_visit", InvoiceTermsBasis.SERVICE, 7,
        "Due 7 days after the last visit", "Due 7 days after the last visit",
    ),
    NET_14_AFTER_LAST_VISIT(
        "net_14_after_last_visit", InvoiceTermsBasis.SERVICE, 14,
        "Due 14 days after the last visit", "Due 14 days after the last visit",
    ),
    NET_30_AFTER_LAST_VISIT(
        "net_30_after_last_visit", InvoiceTermsBasis.SERVICE, 30,
        "Due 30 days after the last visit", "Due 30 days after the last visit",
    ),
    NET_1_BEFORE_FIRST_VISIT(
        "net_1_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -1,
        "Due 1 day before the first visit", "Due 1 day before the first visit",
    ),
    NET_2_BEFORE_FIRST_VISIT(
        "net_2_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -2,
        "Due 2 days before the first visit", "Due 2 days before the first visit",
    ),
    NET_3_BEFORE_FIRST_VISIT(
        "net_3_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -3,
        "Due 3 days before the first visit", "Due 3 days before the first visit",
    ),
    NET_4_BEFORE_FIRST_VISIT(
        "net_4_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -4,
        "Due 4 days before the first visit", "Due 4 days before the first visit",
    ),
    NET_5_BEFORE_FIRST_VISIT(
        "net_5_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -5,
        "Due 5 days before the first visit", "Due 5 days before the first visit",
    ),
    NET_6_BEFORE_FIRST_VISIT(
        "net_6_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -6,
        "Due 6 days before the first visit", "Due 6 days before the first visit",
    ),
    NET_7_BEFORE_FIRST_VISIT(
        "net_7_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -7,
        "Due 7 days before the first visit", "Due 7 days before the first visit",
    ),
    NET_14_BEFORE_FIRST_VISIT(
        "net_14_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -14,
        "Due 14 days before the first visit", "Due 14 days before the first visit",
    ),
    NET_30_BEFORE_FIRST_VISIT(
        "net_30_before_first_visit", InvoiceTermsBasis.FIRST_VISIT, -30,
        "Due 30 days before the first visit", "Due 30 days before the first visit",
    ),
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
    CUSTOM(
        "custom", InvoiceTermsBasis.NONE, 0,
        "A date I pick myself", "Due by the date shown on this invoice",
    ),
}

/** Every rule, in the order the composer offers them. */
fun invoiceTermsDefs(): List<InvoiceTermsCode> = InvoiceTermsCode.entries.toList()

/**
 * #1966: the options of Settings > Invoices > Payment terms, in the ruled
 * order (the server's `PAYMENT_TERMS_SETTING_CODES`): due on receipt, the
 * first visit, the last visit, then 1 to 7, 14 and 30 days after the last
 * visit, then the same counts before the first visit.
 */
val PAYMENT_TERMS_SETTING_CODES: List<InvoiceTermsCode> = InvoiceTermsCode.entries.filter {
    it != InvoiceTermsCode.NET_7 && it != InvoiceTermsCode.NET_14 && it != InvoiceTermsCode.NET_30 &&
        it != InvoiceTermsCode.CUSTOM
}

/** #1966: what every business starts on, and what an absent setting reads as. */
val DEFAULT_PAYMENT_TERMS: InvoiceTermsCode = InvoiceTermsCode.DUE_ON_RECEIPT

/** #1966: the stored setting as a code; absent or off the list reads as [DEFAULT_PAYMENT_TERMS]. */
fun paymentTermsSettingOf(raw: String?): InvoiceTermsCode {
    val trimmed = raw?.trim() ?: return DEFAULT_PAYMENT_TERMS
    return PAYMENT_TERMS_SETTING_CODES.firstOrNull { it.wire == trimmed } ?: DEFAULT_PAYMENT_TERMS
}

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

/** A bare local date-time: no `Z`, no offset. It is already the business's wall clock. */
private val BARE_LOCAL_TIME = Regex("""^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$""")

/** An instant: a date-time ending in `Z` or a UTC offset. */
private val ZONED_INSTANT = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$""")

/** The business's zone when none is given or the given one cannot be read (#1109). */
const val TERMS_FALLBACK_TIME_ZONE = "America/Chicago"

private fun zoneOrNull(id: String): TimeZone? = try {
    TimeZone.of(id)
} catch (_: Exception) {
    null
}

/**
 * #1966: the BUSINESS day a visit's `startTime` falls on, or null when it
 * cannot be read. The server's `serviceDayOf`: a bare day is that day, a bare
 * local time keeps its own date (it is the business's clock already), and an
 * instant is read on the business's clock in [timeZone], falling back to
 * America/Chicago when the zone cannot be read.
 */
@OptIn(kotlin.time.ExperimentalTime::class)
fun serviceDayOf(raw: String, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? {
    val s = raw.trim()
    if (isCalendarDay(s)) return s
    BARE_LOCAL_TIME.matchEntire(s)?.let { m ->
        val day = m.groupValues[1]
        return if (isCalendarDay(day)) day else null
    }
    if (!ZONED_INSTANT.matches(s)) return null
    val normalized = Regex("""([+-]\d{2})(\d{2})$""").replace(s) { "${it.groupValues[1]}:${it.groupValues[2]}" }
    val instant = try {
        Instant.parse(normalized)
    } catch (_: IllegalArgumentException) {
        return null
    }
    val zone = zoneOrNull(timeZone) ?: TimeZone.of(TERMS_FALLBACK_TIME_ZONE)
    return instant.toLocalDateTime(zone).date.toString()
}

private fun serviceDaysOf(serviceDates: List<String>, timeZone: String): List<String> =
    serviceDates.mapNotNull { serviceDayOf(it, timeZone) }

/** The last day work was done, on the business's clock. Skips unreadable entries. */
fun lastServiceDay(serviceDates: List<String>, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? =
    serviceDaysOf(serviceDates, timeZone).maxOrNull()

/** #1966: the first day work was done, on the business's clock. */
fun firstServiceDay(serviceDates: List<String>, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? =
    serviceDaysOf(serviceDates, timeZone).minOrNull()

/**
 * What [resolveDueDate] worked out. [dueDate] null means the terms cannot
 * decide one, and [problem] says why in the server's own words. [appliedCode]
 * is the rule that produced the date: the code asked for, or due on receipt
 * when a visit-relative code found no visits (#1966).
 */
data class DueDateResolution(
    val dueDate: String?,
    val isPast: Boolean,
    val basisDay: String?,
    val problem: String?,
    val appliedCode: InvoiceTermsCode,
    /**
     * True when the terms worked out to a day before the invoice date, so the
     * invoice is due on receipt instead (#1966 review). [appliedCode] is then
     * due on receipt and [basisDay] the invoice date.
     */
    val beforeInvoiceDate: Boolean = false,
)

/** The due date these terms mean, given the invoice date, the work on it, today and the business zone. */
fun resolveDueDate(
    code: InvoiceTermsCode,
    invoiceDate: String,
    serviceDates: List<String>,
    now: String,
    timeZone: String = TERMS_FALLBACK_TIME_ZONE,
): DueDateResolution {
    if (code.basis == InvoiceTermsBasis.NONE) {
        return DueDateResolution(
            dueDate = null,
            isPast = false,
            basisDay = null,
            problem = "These terms let you pick the due date, so there is nothing to work out. " +
                "Choose the date yourself.",
            appliedCode = code,
        )
    }

    val visitDay = when (code.basis) {
        InvoiceTermsBasis.SERVICE -> lastServiceDay(serviceDates, timeZone)
        InvoiceTermsBasis.FIRST_VISIT -> firstServiceDay(serviceDates, timeZone)
        else -> null
    }
    // A visit-relative code with no visits to count from is due on receipt.
    val applied = if (code.basis != InvoiceTermsBasis.INVOICE && visitDay == null) InvoiceTermsCode.DUE_ON_RECEIPT else code
    val invoiceDay = invoiceDate.trim().takeIf { isCalendarDay(it) }
    val basisDay = if (applied.basis == InvoiceTermsBasis.INVOICE) invoiceDay else visitDay

    if (basisDay == null) {
        return DueDateResolution(
            dueDate = null,
            isPast = false,
            basisDay = null,
            problem = "These terms count from the invoice date, and this invoice has no date on it yet. " +
                "Set the date, or pick the date yourself.",
            appliedCode = applied,
        )
    }

    val dueDate = addDays(basisDay, applied.days)
    // #1966 review: a bill is never due before its own date. Visit-relative
    // terms that land there make the invoice due on receipt.
    if (applied.basis != InvoiceTermsBasis.INVOICE && invoiceDay != null && dueDate < invoiceDay) {
        return DueDateResolution(
            dueDate = invoiceDay,
            isPast = isCalendarDay(now) && invoiceDay < now,
            basisDay = invoiceDay,
            problem = null,
            appliedCode = InvoiceTermsCode.DUE_ON_RECEIPT,
            beforeInvoiceDate = true,
        )
    }
    return DueDateResolution(
        dueDate = dueDate,
        // Strictly before: due today is due, not overdue.
        isPast = isCalendarDay(now) && dueDate < now,
        basisDay = basisDay,
        problem = null,
        appliedCode = applied,
    )
}
