package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.DoNotInvoiceResult
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

/**
 * #1178: a household's un-invoiced work, as on web and Android (#408).
 *
 * Loads as soon as a household is picked, with no date range up front. Every
 * billable visit starts ticked. The date range appears only when the server says
 * its page cap was reached. A visit the rate card could not price arrives with a
 * null price, shows "needs a price", and asks for a typed one; it is never shown
 * or billed as $0.00. Ticked visits can be marked do not invoice, with an
 * optional reason, and put back from the list below.
 *
 * [load] and [setDoNotInvoice] are parameters rather than a client handle, so a
 * compose test can drive this panel without Firebase.
 */
@Composable
internal fun UninvoicedVisitsPicker(
    kinfolkId: String,
    householdLabel: String,
    todayIso: String,
    selected: Set<String>,
    onSelectedChange: (Set<String>) -> Unit,
    prices: Map<String, String>,
    onPriceChange: (String, String) -> Unit,
    onSessionsLoaded: (List<UninvoicedSession>) -> Unit,
    onWriteBlankInvoice: () -> Unit,
    load: suspend (String, String?, String?) -> WriteResult<UninvoicedSessionsResult>,
    setDoNotInvoice: suspend (List<String>, Boolean, String) -> WriteResult<DoNotInvoiceResult>,
    disabled: Boolean = false,
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<UninvoicedSessionsResult?>(null) }
    var narrowedFrom by remember { mutableStateOf<String?>(null) }
    var narrowedTo by remember { mutableStateOf<String?>(null) }
    var windowFrom by remember { mutableStateOf("") }
    var windowTo by remember { mutableStateOf("") }
    var excluding by remember { mutableStateOf(false) }
    var excludeReason by remember { mutableStateOf("") }
    var excludeError by remember { mutableStateOf<String?>(null) }
    var excludeBusy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }

    suspend fun runLoad(from: String?, to: String?) {
        if (kinfolkId.isBlank()) return
        loading = true
        error = null
        when (val r = load(kinfolkId, from, to)) {
            is WriteResult.Ok -> {
                result = r.value
                // Every billable visit starts selected.
                onSelectedChange(r.value.sessions.map { it.sessionId }.toSet())
                onSessionsLoaded(r.value.sessions)
            }
            is WriteResult.Err -> {
                result = null
                onSessionsLoaded(emptyList())
                error = "Could not load this work: ${r.message}"
            }
        }
        loading = false
    }

    // The household is the query: changing it reloads.
    LaunchedEffect(kinfolkId) {
        narrowedFrom = null
        narrowedTo = null
        notice = null
        excluding = false
        windowFrom = ""
        windowTo = ""
        runLoad(null, null)
    }

    if (kinfolkId.isBlank()) return

    val sessions = result?.sessions.orEmpty()
    val excluded = result?.excluded.orEmpty()
    val unpriceableIds = result?.unpriceable.orEmpty().map { it.sessionId }.toSet()
    val unplaceable = result?.unplaceable.orEmpty()
    val selectedSessions = sessions.filter { it.sessionId in selected }

    fun applyExclusion(ids: List<String>, doNotInvoice: Boolean, reason: String) {
        if (excludeBusy) return
        excludeBusy = true
        excludeError = null
        scope.launch {
            when (val r = setDoNotInvoice(ids, doNotInvoice, reason)) {
                is WriteResult.Ok -> {
                    excludeBusy = false
                    excluding = false
                    excludeReason = ""
                    notice = exclusionNotice(r.value.changed.size, doNotInvoice)
                    runLoad(narrowedFrom, narrowedTo)
                }
                is WriteResult.Err -> {
                    excludeBusy = false
                    excludeError = "Nothing was changed: ${r.message}"
                }
            }
        }
    }

    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (loading) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                AuntieSpinner(modifier = Modifier.size(16.dp))
                Text(
                    "Looking for un-invoiced work for $householdLabel.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }

        error?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load this work") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    GhostButton(
                        label = "Try again",
                        onClick = { scope.launch { runLoad(narrowedFrom, narrowedTo) } },
                        enabled = !loading,
                    )
                }
            }
        }

        notice?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Info, title = "Done") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        excludeError?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't change those visits") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        val loaded = result
        if (loaded != null && !loading) {
            if (!loaded.rateCardLoaded) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "No rate card") {
                    Text(
                        "Business settings has no service rates, so every visit you bill needs a price typed in.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            if (loaded.truncated) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "More visits than fit") {
                    Text(
                        "This household has more un-invoiced visits than one page holds. Narrow the dates " +
                            "to see them all.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            if (unplaceable.isNotEmpty()) {
                val one = unplaceable.size == 1
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Visits with no start time") {
                    Text(
                        (if (one) "1 completed visit has" else "${unplaceable.size} completed visits have") +
                            " no start time and cannot be billed here. Fix the start time on the visit, " +
                            "then reopen this. Visit ${if (one) "id" else "ids"}: " +
                            unplaceable.joinToString(", ") { it.sessionId },
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            if (loaded.truncated || narrowedFrom != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        BottomBorderField(
                            value = windowFrom,
                            onValueChange = { windowFrom = it },
                            label = "Visits from",
                            placeholder = "YYYY-MM-DD",
                            enabled = !loading && !disabled,
                            isError = windowFrom.isNotBlank() && !isValidNewInvoiceIsoDate(windowFrom),
                            modifier = Modifier.weight(1f),
                        )
                        BottomBorderField(
                            value = windowTo,
                            onValueChange = { windowTo = it },
                            label = "to",
                            placeholder = "YYYY-MM-DD",
                            enabled = !loading && !disabled,
                            isError = windowTo.isNotBlank() && !isValidNewInvoiceIsoDate(windowTo),
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(
                            label = "Narrow the dates",
                            onClick = {
                                when {
                                    !isValidNewInvoiceIsoDate(windowFrom) || !isValidNewInvoiceIsoDate(windowTo) ->
                                        error = "Both ends of the window need a real YYYY-MM-DD date."
                                    windowFrom > windowTo ->
                                        error = "The start of the window must not be after its end."
                                    else -> {
                                        narrowedFrom = windowFrom
                                        narrowedTo = windowTo
                                        scope.launch { runLoad(windowFrom, windowTo) }
                                    }
                                }
                            },
                            enabled = !loading && !disabled,
                            loading = loading,
                        )
                        if (narrowedFrom != null) {
                            GhostButton(
                                label = "Show everything again",
                                onClick = {
                                    narrowedFrom = null
                                    narrowedTo = null
                                    scope.launch { runLoad(null, null) }
                                },
                                enabled = !loading && !disabled,
                            )
                        }
                    }
                }
            }

            Text(
                uninvoicedScopeLine(
                    householdLabel = householdLabel,
                    total = sessions.size,
                    selectedCount = selectedSessions.size,
                    scanned = loaded.scanned,
                    narrowedFrom = narrowedFrom,
                    narrowedTo = narrowedTo,
                ),
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            if (sessions.isEmpty()) {
                GhostButton(label = "Write a blank invoice instead", onClick = onWriteBlankInvoice, enabled = !disabled)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(
                        label = "Select all",
                        onClick = { onSelectedChange(sessions.map { it.sessionId }.toSet()) },
                        enabled = !disabled && selectedSessions.size != sessions.size,
                    )
                    GhostButton(
                        label = "Select none",
                        onClick = { onSelectedChange(emptySet()) },
                        enabled = !disabled && selectedSessions.isNotEmpty(),
                    )
                }

                sessions.forEach { s ->
                    val unitCents = s.unitCents
                    val isSelected = s.sessionId in selected
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AuntieCheckbox(
                                checked = isSelected,
                                onCheckedChange = {
                                    onSelectedChange(if (isSelected) selected - s.sessionId else selected + s.sessionId)
                                },
                                enabled = !disabled,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    s.serviceType.ifBlank { "Visit" },
                                    style = AuntieTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = c.textPrimary,
                                )
                                Text(
                                    visitDayLabel(s.startTime, todayIso) +
                                        if (s.durationMinutes > 0) " · ${s.durationMinutes.toLong()} min" else "",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                            // Never "$0.00" for an unpriced visit.
                            Text(
                                when {
                                    unitCents != null -> formatInvoiceCents(unitCents)
                                    s.sessionId in unpriceableIds && loaded.rateCardLoaded -> "not on the rate card"
                                    else -> "needs a price"
                                },
                                style = AuntieTheme.typography.bodySmall,
                                color = if (unitCents == null) c.error else c.textPrimary,
                            )
                        }
                        if (unitCents == null && isSelected) {
                            BottomBorderField(
                                value = prices[s.sessionId] ?: "",
                                onValueChange = { onPriceChange(s.sessionId, it) },
                                label = "Price for this visit ($)",
                                enabled = !disabled,
                                keyboardType = KeyboardType.Decimal,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                if (excluding) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            if (selectedSessions.size == 1) {
                                "This visit leaves the un-invoiced list without being billed. You can put it back."
                            } else {
                                "These ${selectedSessions.size} visits leave the un-invoiced list without being " +
                                    "billed. You can put them back."
                            },
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                        BottomBorderField(
                            value = excludeReason,
                            onValueChange = { excludeReason = it },
                            label = "Why, optional",
                            enabled = !excludeBusy,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            GhostButton(
                                label = "Keep them billable",
                                onClick = { excluding = false; excludeReason = "" },
                                enabled = !excludeBusy,
                            )
                            PrimaryButton(
                                label = doNotInvoiceLabel(selectedSessions.size),
                                onClick = {
                                    applyExclusion(selectedSessions.map { it.sessionId }, true, excludeReason.trim())
                                },
                                enabled = !excludeBusy && selectedSessions.isNotEmpty(),
                                loading = excludeBusy,
                            )
                        }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GhostButton(
                            label = doNotInvoiceLabel(selectedSessions.size),
                            onClick = { excluding = true },
                            enabled = !disabled && selectedSessions.isNotEmpty(),
                        )
                        if (selectedSessions.isEmpty()) {
                            Text(
                                "Tick the visits nobody will ever be billed for.",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }
                }
            }

            if (excluded.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(excludedWorkLine(excluded.size), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    excluded.forEach { e ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    e.serviceType.ifBlank { "Visit" },
                                    style = AuntieTheme.typography.bodyMedium,
                                    color = c.textPrimary,
                                )
                                Text(
                                    (if (e.startTime.take(10).isBlank()) "no start time" else visitDayLabel(e.startTime, todayIso)) +
                                        if (e.reason.isBlank()) "" else " · ${e.reason}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                            GhostButton(
                                label = "Put it back",
                                onClick = { applyExclusion(listOf(e.sessionId), false, "") },
                                enabled = !disabled && !excludeBusy,
                            )
                        }
                    }
                }
            }
        }
    }
}
