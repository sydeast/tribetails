package com.tribetails.auntieos.domain

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

/**
 * Payment terms as a VALUE, and the one place Android works a due date out from
 * them.
 *
 * WHY THIS EXISTS. `terms` was free text on the Android composer, and a free
 * text terms field cannot decide anything: "Net 14" is a sentence, not a rule,
 * so the due date beside it had to be typed by hand, and nothing could tell
 * whether the two agreed. The two are now one decision taken once: the operator
 * picks a TERMS CODE, and this file resolves the day that code means.
 *
 * THE RESOLVER IS PURE AND TAKES ITS `now`. It reads no clock and touches no
 * document, so the same three inputs always give the same day, in a test and on
 * a device, in whatever timezone either happens to sit in. Every date here is a
 * `YYYY-MM-DD` calendar day, never a timestamp: an invoice is due ON A DAY, and
 * a day plus a timezone is how "due the 14th" becomes "overdue since the 13th"
 * for a household one zone west.
 *
 * A DATE ALREADY IN THE PAST IS RESOLVED, REPORTED, AND NEVER MOVED. Terms
 * counted from the last visit routinely land behind today: work finished three
 * weeks ago on 14-day terms was due a week ago, and that is a true fact about
 * the money. Quietly bumping it to today would forgive a debt the household
 * already owes and would make the invoice disagree with its own stated rule.
 * [resolveDueDate] returns the real day plus [DueDateResolution.isPast], and the
 * composer says so out loud.
 *
 * VISIT-RELATIVE TERMS WITH NO VISITS ARE DUE ON RECEIPT (#1966, operator
 * ruling 2026-11-12), and [DueDateResolution.appliedCode] says so. Visit days are
 * BUSINESS days: an instant is read on the business's clock ([serviceDayOf]), so
 * an evening visit in Chicago is not counted on the next UTC day.
 *
 * MIRRORED, NOT SHARED, AND THE SERVER IS THE AUTHORITY. This is the THIRD copy
 * of one rule table: `mytribe/functions/src/lib/invoiceTerms.ts` owns it,
 * `auntieos-admin/src/lib/invoiceTerms.ts` mirrors it for the web composer, and
 * this file mirrors it for the Android one. There is no shared build across the
 * three trees, and the composer has to show a resolved due date while the
 * operator is still choosing, so a preview has to exist client-side. The server
 * resolves again on write and REFUSES a due date that disagrees, so both
 * mirrors are previews and neither is an authority.
 *
 * `InvoiceTermsParityTest` reads the server file off disk and pins THIS table
 * against it entry by entry, in order, plus the fixture table both TypeScript
 * suites run. A third copy that nothing pins is a fork waiting to happen.
 */

/** What a terms code counts from. */
enum class InvoiceTermsBasis {
    /** The invoice's own date. */
    INVOICE,

    /** The day of the last visit the invoice covers. */
    SERVICE,

    /** #1966: the day of the first visit the invoice covers. */
    FIRST_VISIT,

    /** Nothing: the code hands the date back to the operator. */
    NONE,
}

/**
 * Every terms rule the product offers, in the order the operator reads them:
 * invoice-relative first (the common case), then visit-relative, then the escape
 * hatch.
 *
 * The enum ORDER is the composer's option order, and it is pinned against the
 * server's `INVOICE_TERMS_CODES` array by the parity test.
 *
 * @property wire the value that goes on the wire as `termsCode`.
 * @property days days added to the basis day. Zero means the basis day itself.
 * @property label how the operator picks it, in the composer's terms field.
 * @property words how the household reads it on the invoice, as a sentence.
 *   Stated in words BESIDE the due date, never instead of it, so a household
 *   sees the rule and its output and can check one against the other.
 */
enum class InvoiceTermsCode(
    val wire: String,
    val basis: InvoiceTermsBasis,
    val days: Long,
    val label: String,
    val words: String,
) {
    DUE_ON_RECEIPT(
        wire = "due_on_receipt",
        basis = InvoiceTermsBasis.INVOICE,
        days = 0,
        label = "Due on receipt",
        words = "Due on receipt",
    ),
    DUE_ON_FIRST_VISIT(
        wire = "due_on_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = 0,
        label = "Due on the day of the first visit",
        words = "Due on the day of the first visit",
    ),
    DUE_ON_LAST_VISIT(
        wire = "due_on_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 0,
        label = "Due on the day of the last visit",
        words = "Due on the day of the last visit",
    ),
    NET_1_AFTER_LAST_VISIT(
        wire = "net_1_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 1,
        label = "Due 1 day after the last visit",
        words = "Due 1 day after the last visit",
    ),
    NET_2_AFTER_LAST_VISIT(
        wire = "net_2_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 2,
        label = "Due 2 days after the last visit",
        words = "Due 2 days after the last visit",
    ),
    NET_3_AFTER_LAST_VISIT(
        wire = "net_3_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 3,
        label = "Due 3 days after the last visit",
        words = "Due 3 days after the last visit",
    ),
    NET_4_AFTER_LAST_VISIT(
        wire = "net_4_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 4,
        label = "Due 4 days after the last visit",
        words = "Due 4 days after the last visit",
    ),
    NET_5_AFTER_LAST_VISIT(
        wire = "net_5_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 5,
        label = "Due 5 days after the last visit",
        words = "Due 5 days after the last visit",
    ),
    NET_6_AFTER_LAST_VISIT(
        wire = "net_6_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 6,
        label = "Due 6 days after the last visit",
        words = "Due 6 days after the last visit",
    ),
    NET_7_AFTER_LAST_VISIT(
        wire = "net_7_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 7,
        label = "Due 7 days after the last visit",
        words = "Due 7 days after the last visit",
    ),
    NET_14_AFTER_LAST_VISIT(
        wire = "net_14_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 14,
        label = "Due 14 days after the last visit",
        words = "Due 14 days after the last visit",
    ),
    NET_30_AFTER_LAST_VISIT(
        wire = "net_30_after_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 30,
        label = "Due 30 days after the last visit",
        words = "Due 30 days after the last visit",
    ),
    NET_1_BEFORE_FIRST_VISIT(
        wire = "net_1_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -1,
        label = "Due 1 day before the first visit",
        words = "Due 1 day before the first visit",
    ),
    NET_2_BEFORE_FIRST_VISIT(
        wire = "net_2_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -2,
        label = "Due 2 days before the first visit",
        words = "Due 2 days before the first visit",
    ),
    NET_3_BEFORE_FIRST_VISIT(
        wire = "net_3_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -3,
        label = "Due 3 days before the first visit",
        words = "Due 3 days before the first visit",
    ),
    NET_4_BEFORE_FIRST_VISIT(
        wire = "net_4_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -4,
        label = "Due 4 days before the first visit",
        words = "Due 4 days before the first visit",
    ),
    NET_5_BEFORE_FIRST_VISIT(
        wire = "net_5_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -5,
        label = "Due 5 days before the first visit",
        words = "Due 5 days before the first visit",
    ),
    NET_6_BEFORE_FIRST_VISIT(
        wire = "net_6_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -6,
        label = "Due 6 days before the first visit",
        words = "Due 6 days before the first visit",
    ),
    NET_7_BEFORE_FIRST_VISIT(
        wire = "net_7_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -7,
        label = "Due 7 days before the first visit",
        words = "Due 7 days before the first visit",
    ),
    NET_14_BEFORE_FIRST_VISIT(
        wire = "net_14_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -14,
        label = "Due 14 days before the first visit",
        words = "Due 14 days before the first visit",
    ),
    NET_30_BEFORE_FIRST_VISIT(
        wire = "net_30_before_first_visit",
        basis = InvoiceTermsBasis.FIRST_VISIT,
        days = -30,
        label = "Due 30 days before the first visit",
        words = "Due 30 days before the first visit",
    ),
    NET_7(
        wire = "net_7",
        basis = InvoiceTermsBasis.INVOICE,
        days = 7,
        label = "Due 7 days after the invoice date",
        words = "Due 7 days after the invoice date",
    ),
    NET_14(
        wire = "net_14",
        basis = InvoiceTermsBasis.INVOICE,
        days = 14,
        label = "Due 14 days after the invoice date",
        words = "Due 14 days after the invoice date",
    ),
    NET_30(
        wire = "net_30",
        basis = InvoiceTermsBasis.INVOICE,
        days = 30,
        label = "Due 30 days after the invoice date",
        words = "Due 30 days after the invoice date",
    ),
    CUSTOM(
        wire = "custom",
        basis = InvoiceTermsBasis.NONE,
        days = 0,
        label = "A date I pick myself",
        words = "Due by the date shown on this invoice",
    ),
}

/** Every rule, in the order the composer offers them. */
fun invoiceTermsDefs(): List<InvoiceTermsCode> = InvoiceTermsCode.entries.toList()

/**
 * #1966: the options of Settings > Invoices > Payment terms, in the ruled
 * order: due on receipt, the first visit, the last visit, then 1 to 7, 14 and
 * 30 days after the last visit, then the same counts before the first visit.
 * The server's `PAYMENT_TERMS_SETTING_CODES`.
 */
val PAYMENT_TERMS_SETTING_CODES: List<InvoiceTermsCode> = InvoiceTermsCode.entries.filter {
    it != InvoiceTermsCode.NET_7 && it != InvoiceTermsCode.NET_14 && it != InvoiceTermsCode.NET_30 &&
        it != InvoiceTermsCode.CUSTOM
}

/** #1966: what every business starts on, and what an absent setting reads as. */
val DEFAULT_PAYMENT_TERMS: InvoiceTermsCode = InvoiceTermsCode.DUE_ON_RECEIPT

/**
 * #1966: the stored `invoicePaymentTerms` setting as a code. Absent, blank or
 * not one of the setting's options reads as [DEFAULT_PAYMENT_TERMS].
 */
fun paymentTermsSettingOf(raw: String?): InvoiceTermsCode =
    parseInvoiceTermsCode(raw)?.takeIf { it in PAYMENT_TERMS_SETTING_CODES } ?: DEFAULT_PAYMENT_TERMS

/**
 * A stored or transported value read back as a code, or null.
 *
 * Null rather than a default: an invoice carrying legacy free-text terms has no
 * code, and inventing one would claim a rule nobody chose.
 */
fun parseInvoiceTermsCode(value: String?): InvoiceTermsCode? {
    val trimmed = value?.trim() ?: return null
    return InvoiceTermsCode.entries.firstOrNull { it.wire == trimmed }
}

/**
 * A `YYYY-MM-DD` that is also a real calendar day, so 2026-02-30 is not one.
 *
 * The shape check comes first because [LocalDate.parse] also accepts forms this
 * product never uses (a signed five-digit year, for one), and every day here
 * ends up compared as TEXT.
 *
 * NOT the same rule as `isValidNewInvoiceIsoDate` in the composer, which permits
 * every February 29 without asking whether the year is a leap year. That one is
 * a leniency the blank-invoice form has always had and the web port carried over
 * verbatim. This one decides money, so it is exact.
 */
fun isCalendarDay(value: String): Boolean {
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(value)) return false
    return try {
        // ISO_LOCAL_DATE resolves STRICT, so 2026-02-30 and 2026-13-01 throw
        // rather than rolling forward the way a lenient parser would.
        LocalDate.parse(value)
        true
    } catch (_: DateTimeParseException) {
        false
    }
}

/**
 * `day` plus `days` calendar days, as `YYYY-MM-DD`.
 *
 * [LocalDate] carries no zone at all, which is the same no-drift arithmetic the
 * TypeScript copies get by doing this in UTC. Returns the input unchanged when
 * it is not a calendar day, so a caller that skipped [isCalendarDay] gets its
 * own bad value back rather than a plausible wrong date.
 */
fun addDays(day: String, days: Long): String {
    if (!isCalendarDay(day)) return day
    return LocalDate.parse(day).plusDays(days).toString()
}

/** A bare local date-time: no `Z`, no offset. It is already the business's wall clock. */
private val BARE_LOCAL_TIME = Regex("""^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$""")

/** An instant: a date-time ending in `Z` or a UTC offset. */
private val ZONED_INSTANT = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$""")

/** The business's zone when none is given or the given one cannot be read (#1109). */
const val TERMS_FALLBACK_TIME_ZONE = "America/Chicago"

private fun zoneOrNull(id: String): ZoneId? = try {
    ZoneId.of(id)
} catch (_: Exception) {
    null
}

/**
 * #1966: the BUSINESS day a visit's `startTime` falls on, or null when it
 * cannot be read. The same reading as the server's `serviceDayOf`:
 *
 *  - a bare day (`2026-11-30`) is that day;
 *  - a bare local time (`2026-11-30T19:00`) is the business's wall clock
 *    already, so its own date is the day;
 *  - an instant (`2026-12-01T01:00:00.000Z`, `...-06:00`) is read on the
 *    business's clock in [timeZone], falling back to America/Chicago when the
 *    zone cannot be read. That instant is Nov 30 in Chicago.
 */
fun serviceDayOf(raw: String, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? {
    val s = raw.trim()
    if (isCalendarDay(s)) return s
    BARE_LOCAL_TIME.matchEntire(s)?.let { m ->
        val day = m.groupValues[1]
        return if (isCalendarDay(day)) day else null
    }
    if (!ZONED_INSTANT.matches(s)) return null
    // OffsetDateTime wants `+hh:mm`; the server also accepts `+hhmm`.
    val normalized = Regex("""([+-]\d{2})(\d{2})$""").replace(s) { "${it.groupValues[1]}:${it.groupValues[2]}" }
    val instant = try {
        OffsetDateTime.parse(normalized).toInstant()
    } catch (_: DateTimeParseException) {
        return null
    }
    val zone = zoneOrNull(timeZone) ?: ZoneId.of(TERMS_FALLBACK_TIME_ZONE)
    return instant.atZone(zone).toLocalDate().toString()
}

private fun serviceDaysOf(serviceDates: List<String>, timeZone: String): List<String> =
    serviceDates.mapNotNull { serviceDayOf(it, timeZone) }

/**
 * The LAST day work was done, out of whatever dates the caller has.
 *
 * Accepts full ISO timestamps as well as bare days, read as business days by
 * [serviceDayOf]. Unreadable entries are skipped rather than sorted as text:
 * "" would otherwise win a max against nothing and lose one against everything,
 * silently, in a function that decides when money is owed.
 */
fun lastServiceDay(serviceDates: List<String>, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? =
    serviceDaysOf(serviceDates, timeZone).maxOrNull()

/** #1966: the FIRST day work was done, by the same reading as [lastServiceDay]. */
fun firstServiceDay(serviceDates: List<String>, timeZone: String = TERMS_FALLBACK_TIME_ZONE): String? =
    serviceDaysOf(serviceDates, timeZone).minOrNull()

/**
 * What [resolveDueDate] worked out.
 *
 * @property dueDate the day this invoice is due, or null when the terms cannot
 *   decide one.
 * @property isPast true when [dueDate] is strictly before `now`. Never causes a
 *   shift; see the file header.
 * @property basisDay which day the count ran from, or null when nothing was
 *   counted.
 * @property appliedCode the rule that produced [dueDate]: the code asked for,
 *   or [InvoiceTermsCode.DUE_ON_RECEIPT] when a visit-relative code found no
 *   visits to count from (#1966).
 * @property problem why there is no date, as operator-facing text, or null when
 *   there is one. Names what is missing and what to do, never a bare "invalid".
 */
data class DueDateResolution(
    val dueDate: String?,
    val isPast: Boolean,
    val basisDay: String?,
    val problem: String?,
    val appliedCode: InvoiceTermsCode,
)

/**
 * The due date these terms mean, given the work on the invoice and today.
 *
 * `(terms, serviceDates, now, timeZone) => dueDate`, the resolver the composer
 * calls and the one the server re-runs before it writes. [timeZone] is the
 * business's (`business_settings.timeZone`).
 */
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
    val basisDay = if (applied.basis == InvoiceTermsBasis.INVOICE) {
        invoiceDate.trim().takeIf { isCalendarDay(it) }
    } else {
        visitDay
    }

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
    return DueDateResolution(
        dueDate = dueDate,
        // Strictly before: due today is due, not overdue.
        isPast = isCalendarDay(now) && dueDate < now,
        basisDay = basisDay,
        problem = null,
        appliedCode = applied,
    )
}
