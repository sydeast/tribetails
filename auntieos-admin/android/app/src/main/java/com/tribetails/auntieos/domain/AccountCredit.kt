package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultCredit
import com.tribetails.auntieos.data.contracts.GetAccountCreditHistoryResultUse
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Q6 (operator ruling 2026-09-27): the pure half of Give credit and the credit
 * history on the household profile. Every string here is shared word for word
 * with the web admin, the desktop console and the portals.
 */

/** The server's cap, `MAX_GIVEN_CREDIT_CENTS`: $5,000.00. */
const val MAX_GIVEN_CREDIT_CENTS: Long = 500_000L

/** The server's longest reason. */
const val MAX_CREDIT_REASON_LENGTH: Int = 1000

sealed interface GiveCreditForm {
    data class Ready(val amountCents: Long, val reason: String) : GiveCreditForm
    data class Invalid(val message: String) : GiveCreditForm
}

/** Reads the dialog's two fields. Refuses before any call is made. */
fun parseGiveCreditForm(amountText: String, reasonText: String): GiveCreditForm {
    if (amountText.isBlank()) return GiveCreditForm.Invalid("Enter an amount.")
    val cents = parseDollarsToCents(amountText)
        ?: return GiveCreditForm.Invalid("Enter an amount in dollars, like 25.00.")
    if (cents <= 0L) return GiveCreditForm.Invalid("Credit must be more than $0.00.")
    if (cents > MAX_GIVEN_CREDIT_CENTS) return GiveCreditForm.Invalid("Credit can be at most $5,000.00.")
    val reason = reasonText.trim()
    if (reason.isEmpty()) return GiveCreditForm.Invalid("Enter a reason.")
    if (reason.length > MAX_CREDIT_REASON_LENGTH) {
        return GiveCreditForm.Invalid("Reason can be at most 1,000 characters.")
    }
    return GiveCreditForm.Ready(cents, reason)
}

/** "Give $25.00 credit? Balance goes from $12.00 to $37.00." The balance half only when it is known. */
fun giveCreditConfirmText(amountCents: Long, balanceCents: Long?): String {
    val head = "Give ${formatCentsUsd(amountCents)} credit?"
    return if (balanceCents == null) head
    else "$head Balance goes from ${formatCentsUsd(balanceCents)} to ${formatCentsUsd(balanceCents + amountCents)}."
}

/** The note after a save. Only ever the SERVER's balance, never the client's sum. */
fun giveCreditSuccessText(newAccountBalanceCents: Long): String =
    "Credit given. Balance is now ${formatCentsUsd(newAccountBalanceCents)}."

fun accountBalanceLine(balanceCents: Long): String = "${formatCentsUsd(balanceCents)} on account"

private val CREDIT_DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/** "Sep 27, 2026", in the device's zone. */
fun creditDate(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    CREDIT_DATE.format(Instant.ofEpochMilli(ms).atZone(zone))

fun creditGivenLine(credit: GetAccountCreditHistoryResultCredit, zone: ZoneId = ZoneId.systemDefault()): String =
    "Given ${creditDate(credit.givenAtMs, zone)}"

/**
 * The status line: "Applied <date>" once the last of it is spent, "$A of $B
 * applied" while part is, "Not used yet" before any is.
 */
fun creditStatusLine(credit: GetAccountCreditHistoryResultCredit, zone: ZoneId = ZoneId.systemDefault()): String {
    val applied = credit.fullyAppliedAtMs
    if (applied != null) return "Applied ${creditDate(applied, zone)}"
    if (credit.applications.isEmpty()) return "Not used yet"
    val used = credit.amountCents - credit.remainingCents
    return "${formatCentsUsd(used)} of ${formatCentsUsd(credit.amountCents)} applied"
}

/** One line per partial use, shown under a partly used credit: "$10.00 applied Sep 28, 2026". */
fun creditApplicationLines(credit: GetAccountCreditHistoryResultCredit, zone: ZoneId = ZoneId.systemDefault()): List<String> =
    if (credit.fullyAppliedAtMs != null) emptyList()
    else credit.applications.map { "${formatCentsUsd(it.amountCents)} applied ${creditDate(it.appliedAtMs, zone)}" }

/** "$25.00 on INV-1009, Sep 28, 2026". */
fun creditUseLine(use: GetAccountCreditHistoryResultUse, zone: ZoneId = ZoneId.systemDefault()): String {
    val invoice = use.invoiceNumber?.takeIf { it.isNotBlank() } ?: "an invoice"
    return "${formatCentsUsd(use.amountCents)} on $invoice, ${creditDate(use.usedAtMs, zone)}"
}
