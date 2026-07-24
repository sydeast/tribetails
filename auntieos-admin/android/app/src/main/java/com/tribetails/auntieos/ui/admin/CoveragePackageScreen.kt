package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.CalendarDays
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.domain.CoverageRules
import com.tribetails.auntieos.domain.DEFAULT_COVERAGE_RULES
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.DayPattern
import com.tribetails.auntieos.domain.Duration
import com.tribetails.auntieos.domain.OVERNIGHT_MINUTES
import com.tribetails.auntieos.domain.PinnedTime
import com.tribetails.auntieos.domain.buildDayPatterns
import com.tribetails.auntieos.domain.daysBetween
import com.tribetails.auntieos.domain.minutesToTime
import com.tribetails.auntieos.domain.timeToMinutes
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconBtn
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.util.UUID
import kotlin.math.floor

/** Android parity with the web Coverage Package Builder. Config (visit menu +
 *  rules) loads/saves through [CoveragePackageViewModel]; schedule generation and
 *  pricing are the pure `domain/CoveragePackage.kt` functions. Per-stay inputs
 *  (client, dates, approved schedule) are UI-only and never persisted. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CoveragePackageScreen(
    onBack: () -> Unit,
    viewModel: CoveragePackageViewModel = viewModel<CoveragePackageViewModel>(),
) {
    val c = AuntieTheme.colors
    val uiState by viewModel.uiState.collectAsState()
    val config = uiState.config

    LaunchedEffect(Unit) { viewModel.loadConfig() }

    // Working copy of the saveable config, re-seeded whenever the loaded/saved
    // config changes (load, or a successful save). Edits touch these, not config.
    var durations by remember { mutableStateOf(config.durations) }
    var rules by remember { mutableStateOf(config.rules) }
    LaunchedEffect(config) {
        durations = config.durations
        rules = config.rules
    }

    // Ephemeral, per-stay session state — never persisted.
    var useOvernight by remember { mutableStateOf(false) }
    var overnightDurationId by remember { mutableStateOf("d7") }
    var startDate by remember { mutableStateOf("") }
    var endDate by remember { mutableStateOf("") }
    var clientName by remember { mutableStateOf("") }
    var approvedId by remember { mutableStateOf<String?>(null) }

    // Draft rows.
    var newDurLabel by remember { mutableStateOf("") }
    var newDurMinutes by remember { mutableStateOf("") }
    var newDurPrice by remember { mutableStateOf("") }
    var newPinLabel by remember { mutableStateOf("") }
    var newPinTime by remember { mutableStateOf("") }
    var newPinDurId by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }

    val dirty = durations != config.durations || rules != config.rules

    val patterns = remember(durations, rules, useOvernight, overnightDurationId) {
        buildDayPatterns(durations, rules, useOvernight, overnightDurationId)
    }
    LaunchedEffect(patterns) {
        if (approvedId != null && patterns.none { it.id == approvedId }) approvedId = null
    }
    // Keep the overnight selection pointing at a real menu item.
    LaunchedEffect(useOvernight, durations) {
        if (useOvernight) {
            val opts = durations.filter { it.minutes >= OVERNIGHT_MINUTES }
            if (opts.isNotEmpty() && opts.none { it.id == overnightDurationId }) {
                overnightDurationId = opts.first().id
            }
        }
    }

    val approvedPattern = patterns.firstOrNull { it.id == approvedId }
    val days = daysBetween(startDate, endDate)
    val packageTotal = if (approvedPattern != null && days > 0) approvedPattern.dayTotal * days else 0.0
    val overnightOptions = durations.filter { it.minutes >= OVERNIGHT_MINUTES }
    val dayVisitOptions = durations.filter { it.minutes < OVERNIGHT_MINUTES }

    fun updateDuration(id: String, block: (Duration) -> Duration) {
        durations = durations.map { if (it.id == id) block(it) else it }
    }

    fun addDuration() {
        if (newDurLabel.isBlank() || newDurMinutes.isBlank() || newDurPrice.isBlank()) {
            formError = "Enter a visit name, length in minutes, and price."
            return
        }
        durations = durations + Duration(
            id = uid(),
            label = newDurLabel.trim(),
            minutes = newDurMinutes.toDoubleOrNull() ?: 0.0,
            price = newDurPrice.toDoubleOrNull() ?: 0.0,
        )
        newDurLabel = ""; newDurMinutes = ""; newDurPrice = ""; formError = null
    }

    fun addPinned() {
        if (newPinLabel.isBlank() || newPinTime.isBlank() || newPinDurId.isBlank()) {
            formError = "Enter a label, time, and visit length for the pinned visit."
            return
        }
        rules = rules.copy(
            pinnedTimes = rules.pinnedTimes + PinnedTime(uid(), newPinLabel.trim(), newPinTime, newPinDurId),
        )
        newPinLabel = ""; newPinTime = ""; newPinDurId = ""; formError = null
    }

    AuntieScreenScaffold(title = "Coverage Packages", onBack = onBack, imePaddingEnabled = true) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            DenScreenHeading(
                kicker = "Care Ops · Pricing",
                title = "Coverage",
                accentTail = "packages.",
                subtitle = "Set the visit menu and coverage rules, approve a rule-valid daily schedule, then price it across the full stay.",
            )

            // ── save bar ─────────────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = if (config.updatedAt.isBlank()) "Config not saved yet"
                    else "Last saved${if (config.updatedBy.isBlank()) "" else " by ${config.updatedBy}"}",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                    modifier = Modifier.weight(1f),
                )
                GhostButton(
                    label = "Revert",
                    enabled = dirty && !uiState.isLoading,
                    onClick = { durations = config.durations; rules = config.rules; formError = null },
                )
                PrimaryButton(
                    label = if (dirty) "Save configuration" else "Saved",
                    enabled = dirty,
                    onClick = { viewModel.saveConfig(durations, rules) },
                )
            }

            uiState.error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Something went wrong", icon = Lucide.TriangleAlert) {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            // ── visit menu ───────────────────────────────────────────────────
            DenPanel(
                title = "Visit menu",
                subtitle = "Your visit lengths and their prices. These feed every schedule below.",
                trailing = {
                    GhostButton(
                        label = "Defaults",
                        onClick = { durations = DEFAULT_DURATIONS; rules = DEFAULT_COVERAGE_RULES },
                    )
                },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    durations.forEach { d ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            AuntieField(
                                value = d.label,
                                onValueChange = { v -> updateDuration(d.id) { it.copy(label = v) } },
                                placeholder = "Visit name",
                                modifier = Modifier.weight(2f),
                            )
                            AuntieField(
                                value = numText(d.minutes),
                                onValueChange = { v -> updateDuration(d.id) { it.copy(minutes = v.toDoubleOrNull() ?: 0.0) } },
                                placeholder = "min",
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = numText(d.price),
                                onValueChange = { v -> updateDuration(d.id) { it.copy(price = v.toDoubleOrNull() ?: 0.0) } },
                                placeholder = "$",
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.weight(1f),
                            )
                            AuntieIconBtn(onClick = { durations = durations.filter { it.id != d.id } }) {
                                Icon(Lucide.Trash2, contentDescription = "Remove ${d.label}", tint = c.textDim, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AuntieField(value = newDurLabel, onValueChange = { newDurLabel = it }, placeholder = "New visit name", modifier = Modifier.weight(2f))
                    AuntieField(value = newDurMinutes, onValueChange = { newDurMinutes = it }, placeholder = "min", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    AuntieField(value = newDurPrice, onValueChange = { newDurPrice = it }, placeholder = "$", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    PrimaryButton(label = "Add", onClick = { addDuration() }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.background, modifier = Modifier.size(16.dp)) })
                }
            }

            // ── coverage rules ───────────────────────────────────────────────
            DenPanel(
                title = "Coverage rules",
                subtitle = "The window the day covers, the longest allowed gap, and any fixed daily visits.",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AuntieField(value = rules.wakeStart, onValueChange = { rules = rules.copy(wakeStart = it) }, label = "Day starts", placeholder = "HH:MM", modifier = Modifier.weight(1f))
                        AuntieField(value = rules.wakeEnd, onValueChange = { rules = rules.copy(wakeEnd = it) }, label = "Day ends", placeholder = "HH:MM", modifier = Modifier.weight(1f))
                        AuntieField(value = numText(rules.maxGapHours), onValueChange = { rules = rules.copy(maxGapHours = it.toDoubleOrNull() ?: 1.0) }, label = "Max gap (hrs)", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    }

                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AuntieToggle(checked = useOvernight, onCheckedChange = { useOvernight = it })
                        Text(
                            "Include overnight coverage (covers the hours outside the day window above)",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    }
                    if (useOvernight) {
                        if (overnightOptions.isEmpty()) {
                            EmptyHint("Add a visit of ${OVERNIGHT_MINUTES.toInt()} minutes or more to use as overnight coverage.")
                        } else {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                overnightOptions.forEach { d ->
                                    AuntieChip(selected = overnightDurationId == d.id, onClick = { overnightDurationId = d.id }, label = "${d.label} · $${money(d.price)}")
                                }
                            }
                        }
                    }

                    // pinned visits
                    Text("Pinned visits (specific times that must happen every day)", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    rules.pinnedTimes.forEach { p ->
                        Row(
                            modifier = Modifier.fillMaxWidth().background(c.surface, RoundedCornerShape(8.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(p.label, style = AuntieTheme.typography.titleSmall, color = c.textPrimary, modifier = Modifier.weight(2f))
                            Text(pinnedTimeLabel(p), style = AuntieTheme.typography.bodySmall, color = c.primary, modifier = Modifier.weight(1f))
                            Text(durations.firstOrNull { it.id == p.durationId }?.label ?: "", style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.weight(1f))
                            AuntieIconBtn(onClick = { rules = rules.copy(pinnedTimes = rules.pinnedTimes.filter { it.id != p.id }) }) {
                                Icon(Lucide.Trash2, contentDescription = "Remove ${p.label}", tint = c.textDim, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AuntieField(value = newPinLabel, onValueChange = { newPinLabel = it }, placeholder = "e.g. Medication", modifier = Modifier.weight(2f))
                        AuntieField(value = newPinTime, onValueChange = { newPinTime = it }, placeholder = "HH:MM", modifier = Modifier.weight(1f))
                        PrimaryButton(label = "Add", onClick = { addPinned() }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.background, modifier = Modifier.size(16.dp)) })
                    }
                    if (dayVisitOptions.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            dayVisitOptions.forEach { d ->
                                AuntieChip(selected = newPinDurId == d.id, onClick = { newPinDurId = d.id }, label = d.label)
                            }
                        }
                    }

                    formError?.let { msg ->
                        AuntieBanner(tone = AuntieBannerTone.Warning, title = "Check your entry", icon = Lucide.TriangleAlert) {
                            Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        }
                    }
                }
            }

            // ── valid daily schedules ────────────────────────────────────────
            DenPanel(
                title = "Valid daily schedules",
                subtitle = "Rule-valid options at different price points. Approve one to price the stay.",
                trailing = {
                    // Regenerate simply re-approves nothing; schedules are deterministic
                    // given the rules, so this clears the current pick to compare fresh.
                    GhostButton(label = "Reset pick", leading = { Icon(Lucide.RefreshCw, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(14.dp)) }, onClick = { approvedId = null })
                },
            ) {
                if (patterns.isEmpty()) {
                    EmptyHint("Set your day window and rules above to see valid schedule options.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        patterns.forEach { pattern ->
                            PatternCard(
                                pattern = pattern,
                                approved = approvedId == pattern.id,
                                onApprove = { approvedId = pattern.id },
                            )
                        }
                    }
                }
            }

            // ── coverage window & price ──────────────────────────────────────
            DenPanel(
                title = "Coverage window & price",
                subtitle = "The stay's dates. Priced from the approved schedule; not saved with the config.",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AuntieField(value = clientName, onValueChange = { clientName = it }, label = "Client (optional)", placeholder = "Kinfolk name", modifier = Modifier.weight(1f))
                        AuntieField(value = startDate, onValueChange = { startDate = it }, label = "Start", placeholder = "YYYY-MM-DD", modifier = Modifier.weight(1f))
                        AuntieField(value = endDate, onValueChange = { endDate = it }, label = "End", placeholder = "YYYY-MM-DD", modifier = Modifier.weight(1f))
                    }
                    if (days > 0) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Lucide.CalendarDays, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(16.dp))
                            Text("$days day${if (days != 1) "s" else ""} of coverage", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                        }
                    }
                    if (approvedPattern == null) {
                        EmptyHint("Approve a daily schedule above to price the full stay.")
                    } else if (days > 0) {
                        Row(
                            modifier = Modifier.fillMaxWidth().background(c.surface, RoundedCornerShape(12.dp)).padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(if (clientName.isNotBlank()) "$clientName's package" else "Package total", style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                                Text("${approvedPattern.strategyLabel} schedule × $days day${if (days != 1) "s" else ""}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                            Text("$${money(packageTotal)}", style = AuntieTheme.typography.displayMedium, color = c.primary, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PatternCard(pattern: DayPattern, approved: Boolean, onApprove: () -> Unit) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(
                width = if (approved) 1.5.dp else 1.dp,
                color = if (approved) c.primary else c.border,
                shape = RoundedCornerShape(12.dp),
            )
            .background(if (approved) c.surfaceGlass else c.surface, RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(pattern.strategyLabel.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.primary, modifier = Modifier.weight(1f))
            Text("$${money(pattern.dayTotal)}/day", style = AuntieTheme.typography.headlineSmall, color = c.textPrimary)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            pattern.touchpoints.forEach { tp ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Lucide.Clock, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(12.dp))
                    Text(minutesToTime(tp.time), style = AuntieTheme.typography.bodySmall, color = c.textPrimary, modifier = Modifier.width(64.dp))
                    Text(
                        if (tp.label == "Check-in") "Check-in (${tp.durationLabel})" else "${tp.label} (${tp.durationLabel})",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
            pattern.overnightLabel?.let { label ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Lucide.Clock, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(12.dp))
                    Text("$label · $${money(pattern.overnightCost)}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
        PrimaryButton(
            label = if (approved) "Approved" else "Approve this schedule",
            onClick = onApprove,
            modifier = Modifier.fillMaxWidth(),
            leading = if (approved) {
                { Icon(Lucide.Check, contentDescription = null, tint = c.background, modifier = Modifier.size(14.dp)) }
            } else null,
        )
    }
}

private fun uid(): String = UUID.randomUUID().toString().take(7)

/** Drop a trailing ".0" so "30.0" shows as "30" while "22.5" stays "22.5". */
private fun numText(d: Double): String = if (d == floor(d)) d.toLong().toString() else d.toString()

private fun money(d: Double): String = "%.2f".format(d)

private fun pinnedTimeLabel(p: PinnedTime): String {
    val mins = timeToMinutes(p.time) ?: return ""
    return minutesToTime(mins.toDouble())
}
