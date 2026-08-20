package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.domain.formatCents
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * A household's un-invoiced work, and the two things that can be done with it.
 *
 * CREATING AN INVOICE IS AN ACT OF SELECTION OVER WORK THAT ALREADY EXISTS, NOT
 * AN ACT OF DESCRIPTION (issue #408). This panel is that selection. It opens as
 * soon as a household is chosen, with no date range to guess at and no separate
 * find step: the work is simply there, all of it, and the interaction is
 * unticking whatever this invoice should not cover.
 *
 * THE RANGE APPEARS ONLY WHEN THE SERVER SAYS ITS PAGE CAP WAS REACHED, which is
 * the one situation where narrowing helps. Asking for one up front makes the
 * operator already know when the work happened in order to bill it, and a visit
 * from five weeks ago then produces a perfectly worded "nothing here" with no
 * hint that a wider window would find it.
 *
 * A VISIT THE RATE CARD COULD NOT PRICE ARRIVES WITH A NULL PRICE, AND NULL IS
 * NOT ZERO. `listUninvoicedSessions` refuses to guess: a `serviceType` the rate
 * card does not hold, a rate that will not parse, and a rate of zero all come
 * back as null plus an entry in `unpriceable`, because a silent 0 would bill a
 * household nothing for real work and would look entirely deliberate on the
 * finished invoice. So an unpriced visit is selectable and shows an EMPTY price
 * field the operator has to fill in, and it says so on the row. It never seeds
 * 0.00, and it never quietly drops the visit either, because not billing for
 * completed work is the same loss by a different route.
 *
 * A PRICED VISIT'S MONEY IS NOT TYPEABLE HERE, and that is the #408 ruling on
 * bound lines: the price comes from the rate card by way of the visit, so the
 * way to change it is to change one of those, not to type over the invoice. The
 * row routes to the visit instead. A price field appears only where there is no
 * price for it to disagree with.
 *
 * `rateCardLoaded` separates "this service is not on the card" from "there is no
 * card at all". Those need different sentences: the second is a settings problem
 * to go fix once, not a per-visit annoyance to work around every time.
 *
 * @param load the un-invoiced read, taking the household and an optional
 *   narrowing window. A parameter rather than a repository handle so a mount
 *   test can drive this panel without Firebase.
 * @param setDoNotInvoice the queue write, taking the visits, the state to put
 *   them in, and the operator's reason.
 * @param onOpenVisit routes to the visit itself. The affordance that replaces
 *   typing over a bound line's money.
 */
@Composable
fun UninvoicedVisitsPicker(
    kinfolkId: String,
    householdLabel: String,
    todayIso: String,
    selected: Set<String>,
    onSelectedChange: (Set<String>) -> Unit,
    prices: Map<String, String>,
    onPriceChange: (String, String) -> Unit,
    onSessionsLoaded: (List<ListUninvoicedSessionsResultSession>) -> Unit,
    onWriteBlankInvoice: () -> Unit,
    onOpenVisit: (String) -> Unit,
    load: suspend (String, String?, String?) -> Result<ListUninvoicedSessionsResult>,
    setDoNotInvoice: suspend (List<String>, Boolean, String) -> Result<SetSessionDoNotInvoiceResult>,
    disabled: Boolean = false,
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<ListUninvoicedSessionsResult?>(null) }
    var narrowedFrom by remember { mutableStateOf<String?>(null) }
    var narrowedTo by remember { mutableStateOf<String?>(null) }
    var windowFrom by remember { mutableStateOf("") }
    var windowTo by remember { mutableStateOf("") }
    // The do-not-invoice confirm step, and the note that goes with it. Armed
    // rather than immediate: it is a decision not to charge for real work, and
    // it is worth the half-second the reason field takes to read.
    var excluding by remember { mutableStateOf(false) }
    var excludeReason by remember { mutableStateOf("") }
    var excludeError by remember { mutableStateOf<String?>(null) }
    var excludeBusy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }

    suspend fun runLoad(from: String?, to: String?) {
        if (kinfolkId.isBlank()) return
        loading = true
        error = null
        load(kinfolkId, from, to)
            .onSuccess { res ->
                result = res
                // EVERY BILLABLE VISIT STARTS SELECTED. The ordinary invoice
                // covers all of a household's outstanding work; unticking two is
                // less work than ticking eleven, and the count is stated on the
                // button either way.
                onSelectedChange(res.sessions.map { it.sessionId }.toSet())
                onSessionsLoaded(res.sessions)
                loading = false
            }
            .onFailure { t ->
                loading = false
                result = null
                onSessionsLoaded(emptyList())
                error = "Could not load this work: ${t.message ?: "the request failed"}"
            }
    }

    // THE HOUSEHOLD IS THE QUERY. Changing it reloads; there is no Find button,
    // because there is no second question to answer.
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
            setDoNotInvoice(ids, doNotInvoice, reason)
                .onSuccess { res ->
                    excludeBusy = false
                    excluding = false
                    excludeReason = ""
                    notice = exclusionNotice(res.changed.size, doNotInvoice)
                    runLoad(narrowedFrom, narrowedTo)
                }
                .onFailure { t ->
                    excludeBusy = false
                    excludeError = "Nothing was changed: ${t.message ?: "the request failed"}"
                }
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (loading) {
            Text(
                "Looking for un-invoiced work for $householdLabel.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
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
            // "There is no rate card" is a settings problem to fix once, not a
            // per-visit annoyance. It gets its own sentence for that reason.
            if (!loaded.rateCardLoaded) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "No rate card") {
                    Text(
                        "Business settings has no service rates, so nothing below could be priced " +
                            "automatically. Every visit you bill will need a price typed in. Setting the " +
                            "rates up once will prefill this in future.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            if (loaded.truncated) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "More visits than fit") {
                    Text(
                        "This household has more un-invoiced visits than one page holds, so the list " +
                            "below may not be all of them. Narrow the dates to be sure you are seeing " +
                            "everything.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            // Changing the dates cannot surface these, so the banner says what to
            // do instead of implying a different window would help.
            if (unplaceable.isNotEmpty()) {
                val one = unplaceable.size == 1
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Visits with no start time") {
                    Text(
                        (
                            if (one) {
                                "1 completed visit for this household has no start time"
                            } else {
                                "${unplaceable.size} completed visits for this household have no start time"
                            }
                            ) +
                            ", so nothing can place ${if (one) "it" else "them"} in time and " +
                            "${if (one) "it" else "they"} cannot be billed from this screen. Fix the start " +
                            "time on the visit itself, then reopen this. Visit " +
                            "${if (one) "id" else "ids"}: ${unplaceable.joinToString(", ") { it.sessionId }}",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            if (loaded.truncated || narrowedFrom != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        AuntieField(
                            value = windowFrom,
                            onValueChange = { windowFrom = it },
                            label = "Visits from",
                            placeholder = "YYYY-MM-DD",
                            enabled = !loading && !disabled,
                            isError = windowFrom.isNotBlank() && !isValidNewInvoiceIsoDate(windowFrom),
                            modifier = Modifier.weight(1f),
                        )
                        AuntieField(
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
                GhostButton(
                    label = "Write a blank invoice instead",
                    onClick = onWriteBlankInvoice,
                    enabled = !disabled,
                )
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
                    val unpriced = unitCents == null
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
                                    val next = selected.toMutableSet()
                                    if (s.sessionId in next) next.remove(s.sessionId) else next.add(s.sessionId)
                                    onSelectedChange(next)
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
                            // NEVER "$0.00" for an unpriced visit. A zero here is
                            // indistinguishable from a service genuinely given
                            // away, and it would ride onto the invoice looking
                            // deliberate.
                            Text(
                                if (unitCents == null) {
                                    if (s.sessionId in unpriceableIds && loaded.rateCardLoaded) {
                                        "not on the rate card"
                                    } else {
                                        "needs a price"
                                    }
                                } else {
                                    formatCents(unitCents)
                                },
                                style = AuntieTheme.typography.bodySmall,
                                color = if (unpriced) c.error else c.textPrimary,
                            )
                        }
                        if (unpriced && isSelected) {
                            AuntieField(
                                value = prices[s.sessionId] ?: "",
                                onValueChange = { onPriceChange(s.sessionId, it) },
                                label = "Price for this visit ($)",
                                enabled = !disabled,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        // The affordance the #408 ruling asks for: the money on a
                        // priced visit is not typed over here. It is corrected on
                        // the visit, and the invoice follows.
                        GhostButton(
                            label = "Open this visit",
                            onClick = { onOpenVisit(s.sessionId) },
                            enabled = !disabled,
                        )
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
                        AuntieField(
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
                                // The label does not change while it runs:
                                // PrimaryButton swaps it for a spinner, so the
                                // verb the operator pressed is the last one they
                                // saw.
                                label = doNotInvoiceLabel(selectedSessions.size),
                                onClick = {
                                    applyExclusion(
                                        selectedSessions.map { it.sessionId },
                                        true,
                                        excludeReason,
                                    )
                                },
                                enabled = !excludeBusy,
                                loading = excludeBusy,
                            )
                        }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        // THE SAME VERB THE CONFIRM STEP USES, and disabled with
                        // its reason beside it rather than relabelled into one.
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
                    Text(
                        excludedWorkLine(excluded.size),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
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
                                    (
                                        if (e.startTime.take(10).isBlank()) {
                                            "no start time"
                                        } else {
                                            visitDayLabel(e.startTime, todayIso)
                                        }
                                        ) + if (e.reason.isBlank()) "" else " · ${e.reason}",
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
