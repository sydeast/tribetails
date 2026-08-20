package com.tribetails.auntieos.domain

import java.time.LocalDate
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
 * SERVICE-RELATIVE TERMS WITH NO VISITS RESOLVE TO NOTHING, deliberately. There
 * is no last visit to count from, so there is no date to state, and the honest
 * answer is a null plus a sentence naming what is missing. The alternative,
 * silently falling back to the invoice date, would print a due date derived from
 * a rule that was never applied.
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
    DUE_ON_LAST_VISIT(
        wire = "due_on_last_visit",
        basis = InvoiceTermsBasis.SERVICE,
        days = 0,
        label = "Due on the day of the last visit",
        words = "Due on the day of the last visit",
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

/**
 * The LAST day work was done, out of whatever dates the caller has.
 *
 * Accepts full ISO timestamps as well as bare days, because a visit's
 * `startTime` is an ISO-8601 string and truncating it here means no caller has
 * to remember to. Unreadable entries are skipped rather than sorted as text:
 * "" would otherwise win a max against nothing and lose one against everything,
 * silently, in a function that decides when money is owed.
 */
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
 * What [resolveDueDate] worked out.
 *
 * @property dueDate the day this invoice is due, or null when the terms cannot
 *   decide one.
 * @property isPast true when [dueDate] is strictly before `now`. Never causes a
 *   shift; see the file header.
 * @property basisDay which day the count ran from, or null when nothing was
 *   counted.
 * @property problem why there is no date, as operator-facing text, or null when
 *   there is one. Names what is missing and what to do, never a bare "invalid".
 */
data class DueDateResolution(
    val dueDate: String?,
    val isPast: Boolean,
    val basisDay: String?,
    val problem: String?,
)

/**
 * The due date these terms mean, given the work on the invoice and today.
 *
 * `(terms, serviceDates, now) => dueDate`, the resolver the composer calls and
 * the one the server re-runs before it writes.
 */
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
