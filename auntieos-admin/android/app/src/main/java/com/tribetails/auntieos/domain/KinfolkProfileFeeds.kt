package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/**
 * Pure joins for the kinfolk-profile feed cards (Recent KinTales / Upcoming
 * visits / Invoices), plus the hero's tenure label.
 *
 * The web twin is `auntieos-admin/src/lib/kinfolkProfileFeeds.ts`. (This header
 * used to name `screens/directory/KinfolkProfileFeeds.kt`, which was the wasm
 * admin's copy; that tree was deleted in #481 and the React admin then had no
 * feeds at all until #407 ported them back.) The two files are kept in lockstep
 * function for function, argument for argument, so the two surfaces cannot show
 * an operator different rows for the same household.
 *
 * Lexical ISO-8601 compares (the app's date convention).
 */

/** How far ahead the profile's UPCOMING VISITS card looks. The mock's own header. */
const val UPCOMING_HORIZON_DAYS = 7L

/** The far edge of that window, as an ISO instant [days] out from [now]. */
fun horizonIso(now: Instant, days: Long = UPCOMING_HORIZON_DAYS): String =
    now.plus(days, ChronoUnit.DAYS).toString()

/**
 * SCHEDULED/CONFIRMED visits for [kinfolkId] dated at/after [nowIso], soonest first.
 *
 * [throughIso] is the far edge of the window, and null means "no far edge". The
 * mock heads this card "next 7 days", so the profile passes a bound and the card
 * says what the bound is; the web twin takes the same argument for the same
 * reason. Left null, this behaves exactly as it always has.
 */
fun upcomingVisitsFor(
    sessions: List<KinCareSession>,
    kinfolkId: String,
    nowIso: String,
    throughIso: String? = null,
    limit: Int = 5,
): List<KinCareSession> =
    sessions.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .filter { it.status.equals("scheduled", ignoreCase = true) || it.status.equals("confirmed", ignoreCase = true) }
        .filter { it.startTime.isNotBlank() && it.startTime >= nowIso }
        .filter { throughIso == null || it.startTime <= throughIso }
        .sortedBy { it.startTime }
        .take(limit)
        .toList()

/** SENT KinTales for [kinfolkId], most recent first (sentAt, falling back to visitDate). */
fun recentTalesFor(
    reports: List<KinCareReport>,
    kinfolkId: String,
    limit: Int = 5,
): List<KinCareReport> =
    reports.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .filter { it.status.equals("SENT", ignoreCase = true) }
        .sortedByDescending { it.sentAt.orEmpty().ifBlank { it.visitDate } }
        .take(limit)
        .toList()

/**
 * The left-hand line of one row in the profile's INVOICES card: the invoice
 * number, and the date it carries when it carries one.
 *
 * Lifted out of the composable so the string is unit-testable, which is the
 * whole reason it is here: this expression used to end in `inv.date.take(10)`.
 * See [freeTextDateLabel] for why ten characters of `invoices.date` is a
 * different date rather than a shorter one.
 *
 * A blank date drops the whole ` · ` segment, as it always has, so the row is
 * the invoice number alone rather than a number trailing a separator into
 * nothing.
 */
fun kinfolkInvoiceFeedLabel(invoice: Invoice): String {
    val number = invoice.invoiceNumber.ifBlank { "Invoice" }
    val date = freeTextDateLabel(invoice.date)
    return if (date.isEmpty()) number else "$number · $date"
}

/** Invoices for [kinfolkId], most recent first. */
fun invoicesForKinfolk(
    invoices: List<Invoice>,
    kinfolkId: String,
    limit: Int = 5,
): List<Invoice> =
    invoices.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .sortedByDescending { it.date }
        .take(limit)
        .toList()

/**
 * A feed card's header count, and the reason it is a function rather than
 * `"${rows.size} total"`.
 *
 * These feeds read a CAPPED source. While the cap is not reached, the row count
 * IS the household's total and may say so. Once the read comes back holding
 * everything it was allowed, the collection may well hold more, and "N total"
 * would be a confident number nobody verified.
 *
 * [capped] is a fact about the RAW read, not about [loaded], which is why it is
 * a separate argument: a card that counts a SUBSET of what it read (the KinTales
 * card counts only the sent ones) has a [loaded] below the cap on a read that
 * was truncated all the same.
 */
fun feedCountMeta(shown: Int, loaded: Int, capped: Boolean): String {
    val total = if (capped) "$loaded+ loaded" else "$loaded total"
    return if (shown < loaded) "$shown of $total" else total
}

/**
 * The profile hero's tenure label ("14 months"), or null when the stored join
 * date is not a date anybody can read.
 *
 * NEVER a fabricated "0 months": a household whose join date is blank, or is one
 * of the free-text shapes this app deliberately refuses to parse (`07/24/2026`
 * is month-first or day-first and nobody can tell which, see [freeTextDateLabel]
 * and the web's `lib/joinDate.ts`), gets NO label. A tenure is a claim about how
 * long someone has been a client and the profile does not make one it cannot
 * back. A join date in the FUTURE is a typo rather than a negative tenure, and
 * also says nothing.
 *
 * Kept identical branch for branch to the web's `tenureLabel`.
 */
fun tenureLabel(joinDate: String, today: LocalDate): String? {
    val raw = joinDate.trim()
    if (raw.length < 10) return null
    val head = raw.substring(0, 10)
    if (!ISO_DAY.matches(head)) return null
    if (raw.length > 10 && raw[10] != 'T' && raw[10] != ' ') return null

    val start = try {
        LocalDate.parse(head)
    } catch (_: DateTimeParseException) {
        return null
    }
    if (start.isAfter(today)) return null

    val months = ChronoUnit.MONTHS.between(start, today).toInt()
    if (months < 1) return "new"
    if (months < 24) return if (months == 1) "1 month" else "$months months"
    return "${months / 12} years"
}

private val ISO_DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
