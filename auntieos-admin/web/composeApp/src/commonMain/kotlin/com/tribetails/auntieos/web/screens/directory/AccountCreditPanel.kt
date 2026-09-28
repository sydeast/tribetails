package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.AccountCreditHistory
import com.tribetails.auntieos.web.data.CreditHistoryLoad
import com.tribetails.auntieos.web.data.CreditUseDto
import com.tribetails.auntieos.web.data.GiveCreditEntry
import com.tribetails.auntieos.web.data.GivenCreditDto
import com.tribetails.auntieos.web.data.MAX_GIVE_CREDIT_CENTS
import com.tribetails.auntieos.web.data.MAX_GIVE_CREDIT_REASON_LENGTH
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.math.abs
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/*
 * Q6 (operator ruling 2026-09-27): the household's account credit on the
 * desktop profile. The balance, a Give credit action, and the history of
 * credits given and credit used. The wording matches the web and Android
 * admin clients.
 */

// ---- Pure text helpers (commonTest covers every one) ----

/** "$12.00", "-$5.00". Integer cents, so no float rounding. */
fun creditUsd(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    val a = abs(cents)
    return sign + "$" + (a / 100).toString() + "." + (a % 100).toString().padStart(2, '0')
}

private val CREDIT_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Sep 27, 2026", in [zone] (the console's own zone unless a test pins one). */
@OptIn(ExperimentalTime::class)
fun creditDate(ms: Long, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    val d = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone).date
    return "${CREDIT_MONTHS[d.month.ordinal]} ${d.day}, ${d.year}"
}

/** The balance line at the top of the panel. */
fun creditBalanceLine(balanceCents: Long): String = "${creditUsd(balanceCents)} on account"

/** "Given Sep 27, 2026". */
fun givenCreditDateLine(c: GivenCreditDto, zone: TimeZone = TimeZone.currentSystemDefault()): String =
    "Given ${creditDate(c.givenAtMs, zone)}"

/**
 * What happened to a given credit: "Applied <date>" once the last of it was
 * spent, "$A of $B applied: <dates>" while part is left, "Not used yet" before
 * any of it was.
 */
fun givenCreditStatusLine(c: GivenCreditDto, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    c.fullyAppliedAtMs?.let { return "Applied ${creditDate(it, zone)}" }
    if (c.applications.isEmpty()) return "Not used yet"
    val used = c.amountCents - c.remainingCents
    val dates = c.applications.joinToString(", ") { creditDate(it.appliedAtMs, zone) }
    return "${creditUsd(used)} of ${creditUsd(c.amountCents)} applied: $dates"
}

/** "$25.00 on INV-1009, Sep 27, 2026", or "on an invoice" when the number is unknown. */
fun creditUseLine(u: CreditUseDto, zone: TimeZone = TimeZone.currentSystemDefault()): String {
    val on = u.invoiceNumber?.takeIf { it.isNotBlank() } ?: "an invoice"
    return "${creditUsd(u.amountCents)} on $on, ${creditDate(u.usedAtMs, zone)}"
}

/** The confirmation step's sentence. The new balance here is a preview; the toast repeats the server's. */
fun giveCreditConfirmText(amountCents: Long, balanceCents: Long): String =
    "Give ${creditUsd(amountCents)} credit? Balance goes from ${creditUsd(balanceCents)} to ${creditUsd(balanceCents + amountCents)}."

/** The toast after the server answered. Only the server's figure. */
fun giveCreditSuccessText(newBalanceCents: Long): String = "Credit given. Balance is now ${creditUsd(newBalanceCents)}."

/** The dialog's error when the call is refused or fails. */
fun giveCreditRefusalText(serverMessage: String): String = "Couldn't give credit: $serverMessage"

/** What the Give credit form came to. */
sealed class GiveCreditForm {
    data class Ready(val entry: GiveCreditEntry) : GiveCreditForm()
    data class Invalid(val message: String) : GiveCreditForm()
}

private val DOLLARS = Regex("""^\d+(\.\d{1,2})?$""")

/** Dollars as typed -> integer cents, or null when it is not a plain amount with at most 2 decimals. */
fun parseCreditDollarsToCents(raw: String): Long? {
    val s = raw.trim().removePrefix("$").replace(",", "")
    if (!DOLLARS.matches(s)) return null
    val parts = s.split('.')
    val whole = parts[0].toLongOrNull() ?: return null
    if (whole > 1_000_000_000L) return null
    val frac = if (parts.size > 1) parts[1].padEnd(2, '0').toLong() else 0L
    return whole * 100 + frac
}

/** Checks the form before any call. The server checks all of this again. */
fun parseGiveCreditForm(kinfolkId: String, amountText: String, reasonText: String): GiveCreditForm {
    val amount = amountText.trim()
    if (amount.isEmpty()) return GiveCreditForm.Invalid("Enter an amount.")
    if (amount.startsWith("-")) return GiveCreditForm.Invalid("The amount has to be more than $0.00.")
    val cents = parseCreditDollarsToCents(amount)
        ?: return GiveCreditForm.Invalid("Enter the amount in dollars, like 25.00.")
    if (cents <= 0L) return GiveCreditForm.Invalid("The amount has to be more than $0.00.")
    if (cents > MAX_GIVE_CREDIT_CENTS) return GiveCreditForm.Invalid("One credit can be at most $5,000.00.")
    val reason = reasonText.trim()
    if (reason.isEmpty()) return GiveCreditForm.Invalid("Enter a reason.")
    if (reason.length > MAX_GIVE_CREDIT_REASON_LENGTH) {
        return GiveCreditForm.Invalid("The reason can be at most 1,000 characters.")
    }
    return GiveCreditForm.Ready(GiveCreditEntry(kinfolkId = kinfolkId, amountCents = cents, reason = reason))
}

// ---- Composables ----

/** The panel body: balance, then credits given, then credit used. */
@Composable
internal fun AccountCreditBody(load: CreditHistoryLoad, onRetry: () -> Unit) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    when (load) {
        CreditHistoryLoad.Hidden -> Unit
        is CreditHistoryLoad.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Couldn't load account credit: ${load.message}", style = t.bodySmall, color = c.error)
            GhostButton(label = "Try again", onClick = onRetry)
        }
        is CreditHistoryLoad.Loaded -> AccountCreditHistoryView(load.history)
    }
}

@Composable
private fun AccountCreditHistoryView(h: AccountCreditHistory) {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(creditBalanceLine(h.accountBalanceCents), style = t.titleMedium, color = c.textPrimary)
        Text("Credits given", style = t.labelSmall, color = c.textDim)
        if (h.credits.isEmpty()) {
            Text("No credit given yet.", style = t.bodySmall, color = c.textDim)
        } else {
            h.credits.forEach { credit ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "${creditUsd(credit.amountCents)} · ${givenCreditDateLine(credit)}",
                        style = t.bodyMedium,
                        color = c.textPrimary,
                    )
                    if (credit.reason.isNotBlank()) {
                        Text(credit.reason, style = t.bodySmall, color = c.textDim)
                    }
                    Text(givenCreditStatusLine(credit), style = t.labelSmall, color = c.textDim)
                }
            }
        }
        if (h.uses.isNotEmpty()) {
            Text("Credit used", style = t.labelSmall, color = c.textDim)
            h.uses.forEach { use ->
                Text(creditUseLine(use), style = t.bodySmall, color = c.textPrimary)
            }
        }
    }
}

/** Loading placeholder for the panel. */
@Composable
internal fun AccountCreditLoading() {
    ShimmerCard(height = 56.dp)
}

/**
 * The Give credit dialog: amount and reason, then a Review step with the
 * confirmation sentence. Not dismissable while the call is in flight.
 */
@Composable
internal fun GiveCreditDialog(
    visible: Boolean,
    kinfolkId: String,
    balanceCents: Long,
    submitting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onInvalid: (String) -> Unit,
    onClearError: () -> Unit,
    onSubmit: (GiveCreditEntry) -> Unit,
) {
    var amount by remember(kinfolkId, visible) { mutableStateOf("") }
    var reason by remember(kinfolkId, visible) { mutableStateOf("") }
    var review by remember(kinfolkId, visible) { mutableStateOf<GiveCreditEntry?>(null) }
    val pending = review
    AuntieDialog(
        visible = visible,
        title = "Give credit",
        onDismiss = { if (!submitting) onDismiss() },
        hint = "Adds account credit the household can spend on future invoices.",
        maxWidth = 460.dp,
        footer = {
            if (pending == null) {
                GhostButton(label = "Cancel", onClick = onDismiss, enabled = !submitting)
                Spacer(Modifier.width(8.dp))
                PrimaryButton(
                    label = "Review",
                    enabled = amount.isNotBlank() && reason.isNotBlank(),
                    onClick = {
                        when (val form = parseGiveCreditForm(kinfolkId, amount, reason)) {
                            is GiveCreditForm.Invalid -> onInvalid(form.message)
                            is GiveCreditForm.Ready -> {
                                onClearError()
                                review = form.entry
                            }
                        }
                    },
                )
            } else {
                GhostButton(label = "Back", onClick = { review = null }, enabled = !submitting)
                Spacer(Modifier.width(8.dp))
                PrimaryButton(
                    label = if (submitting) "Giving credit..." else "Give credit",
                    enabled = !submitting,
                    loading = submitting,
                    onClick = { onSubmit(pending) },
                )
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (error != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Not given",
                    icon = Lucide.CircleAlert,
                    body = {
                        Text(error, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    },
                )
            }
            if (pending == null) {
                BottomBorderField(
                    amount, { amount = it },
                    label = "Amount *",
                    placeholder = "25.00",
                    keyboardType = KeyboardType.Decimal,
                    enabled = !submitting,
                    modifier = Modifier.fillMaxWidth(),
                )
                BottomBorderField(
                    reason, { if (it.length <= MAX_GIVE_CREDIT_REASON_LENGTH) reason = it },
                    label = "Reason *",
                    placeholder = "The household sees this",
                    enabled = !submitting,
                    singleLine = false,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Text(
                    giveCreditConfirmText(pending.amountCents, balanceCents),
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
                Text(pending.reason, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }
    }
}
