package com.kinfolk.portal.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.portal.CreditHistoryResult
import com.kinfolk.portal.portal.CreditUse
import com.kinfolk.portal.portal.GivenCredit
import com.kinfolk.portal.screens.gallery.isPermissionDenied
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.formatUsd
import com.kinfolk.portal.util.invoiceDayLabel
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * Q6 (operator ruling 2026-09-27): "Those with billing access ... can see the
 * credit, dates, reason, and date applied when used." Same wording as the web
 * portal's section.
 */

const val CREDIT_HISTORY_TITLE = "Account credit history"
const val CREDIT_HISTORY_LOAD_ERROR = "Could not load account credit history."

/** What the section shows. [Hidden] covers both "no billing access" and "nothing to show". */
sealed interface CreditHistoryState {
    data object Loading : CreditHistoryState
    data object Hidden : CreditHistoryState
    data object Failed : CreditHistoryState
    data class Ready(val history: CreditHistoryResult) : CreditHistoryState
}

/**
 * A refusal means this person has no billing access, and the section is hidden
 * without a word. The native SDK puts only the server's message in the thrown
 * text, so the server's own sentence is matched as well as the code.
 */
internal fun isCreditHistoryRefusal(t: Throwable): Boolean {
    val m = t.message
    return isPermissionDenied(m) || (m?.contains("Billing access is required", ignoreCase = true) == true)
}

internal fun creditHistoryStateOf(result: Result<CreditHistoryResult>): CreditHistoryState =
    result.fold(
        onSuccess = { h ->
            if (h.credits.isEmpty() && h.uses.isEmpty()) CreditHistoryState.Hidden else CreditHistoryState.Ready(h)
        },
        onFailure = { t -> if (isCreditHistoryRefusal(t)) CreditHistoryState.Hidden else CreditHistoryState.Failed },
    )

private fun usd(cents: Long): String = formatUsd(cents.toDouble() / 100.0)

/** "Sep 27, 2026" for an instant, in the reader's own time zone. */
fun creditDateLabel(epochMs: Long, timeZone: TimeZone = TimeZone.currentSystemDefault()): String =
    invoiceDayLabel(Instant.fromEpochMilliseconds(epochMs).toLocalDateTime(timeZone).date.toString())

fun creditGivenLine(c: GivenCredit, timeZone: TimeZone = TimeZone.currentSystemDefault()): String =
    "Given ${creditDateLabel(c.givenAtMs, timeZone)}"

/** "Applied <date>", "$A of $B applied (<dates>)", or "Not used yet". */
fun creditStatusLine(c: GivenCredit, timeZone: TimeZone = TimeZone.currentSystemDefault()): String {
    c.fullyAppliedAtMs?.let { return "Applied ${creditDateLabel(it, timeZone)}" }
    if (c.applications.isEmpty()) return "Not used yet"
    val applied = c.amountCents - c.remainingCents
    val dates = c.applications.joinToString("; ") { creditDateLabel(it.appliedAtMs, timeZone) }
    return "${usd(applied)} of ${usd(c.amountCents)} applied ($dates)"
}

/** "$X on INV-1009, Sep 27, 2026", or "on an invoice" when it has no number. */
fun creditUseLine(u: CreditUse, timeZone: TimeZone = TimeZone.currentSystemDefault()): String {
    val target = u.invoiceNumber?.takeIf { it.isNotBlank() } ?: "an invoice"
    return "${usd(u.amountCents)} on $target, ${creditDateLabel(u.usedAtMs, timeZone)}"
}

@Composable
internal fun CreditHistorySection(state: CreditHistoryState) {
    if (state is CreditHistoryState.Hidden || state is CreditHistoryState.Loading) return
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text(CREDIT_HISTORY_TITLE, style = type.sansMeta)
            when (state) {
                is CreditHistoryState.Failed ->
                    Text(CREDIT_HISTORY_LOAD_ERROR, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
                is CreditHistoryState.Ready -> {
                    val h = state.history
                    if (h.credits.isNotEmpty()) {
                        Text("Credits given", style = type.sansLabel.copy(fontWeight = FontWeight.SemiBold))
                        h.credits.forEach { c ->
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(usd(c.amountCents), style = type.sansBody.copy(fontWeight = FontWeight.SemiBold))
                                    Text(creditGivenLine(c), style = type.sansMeta)
                                }
                                if (c.reason.isNotBlank()) Text(c.reason, style = type.sansBody)
                                Text(creditStatusLine(c), style = type.sansMeta.copy(color = KinfolkBrand.KinTeal))
                            }
                        }
                    }
                    if (h.uses.isNotEmpty()) {
                        Text("Credit used", style = type.sansLabel.copy(fontWeight = FontWeight.SemiBold))
                        h.uses.forEach { u -> Text(creditUseLine(u), style = type.sansMeta) }
                    }
                }
                else -> Unit
            }
        }
    }
}
