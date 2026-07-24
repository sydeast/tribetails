package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.content.Intent
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.CalendarDays
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Moon
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Printer
import com.composables.icons.lucide.Share2
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.domain.CoverageRules
import com.tribetails.auntieos.domain.DEFAULT_COVERAGE_RULES
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.DayPattern
import com.tribetails.auntieos.domain.Duration
import com.tribetails.auntieos.domain.Package
import com.tribetails.auntieos.domain.PinnedTime
import com.tribetails.auntieos.domain.PriceContext
import com.tribetails.auntieos.domain.PricedDayRow
import com.tribetails.auntieos.domain.QuoteInput
import com.tribetails.auntieos.domain.Visit
import com.tribetails.auntieos.domain.buildDayPatterns
import com.tribetails.auntieos.domain.dateLabel
import com.tribetails.auntieos.domain.daysBetween
import com.tribetails.auntieos.domain.effectiveVisits
import com.tribetails.auntieos.domain.gapWarnings
import com.tribetails.auntieos.domain.minutesToInput
import com.tribetails.auntieos.domain.minutesToTime
import com.tribetails.auntieos.domain.normalizePackage
import com.tribetails.auntieos.domain.pricePackage
import com.tribetails.auntieos.domain.quoteText
import com.tribetails.auntieos.domain.timeToMinutes
import com.tribetails.auntieos.domain.uid
import com.tribetails.auntieos.domain.visitsFromPattern
import com.tribetails.auntieos.domain.visitsFromPinned
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconBtn
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlin.math.floor

/**
 * Android parity with the web Coverage Package Builder (full PackageBuilder_7
 * model). Config (visit menu + rules) loads/saves through [CoveragePackageViewModel];
 * the in-progress quote (client, dates, packages) is session UI state. Schedule
 * suggestions and pricing are the pure `domain/CoveragePackage.kt` functions.
 */
private enum class DateTarget { START, END }

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun CoveragePackageScreen(
    onBack: () -> Unit,
    viewModel: CoveragePackageViewModel = viewModel<CoveragePackageViewModel>(),
) {
    val c = AuntieTheme.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val uiState by viewModel.uiState.collectAsState()
    val config = uiState.config

    LaunchedEffect(Unit) { viewModel.loadConfig() }

    // Working copy of the saveable config.
    var durations by remember { mutableStateOf(config.durations) }
    var rules by remember { mutableStateOf(config.rules) }
    LaunchedEffect(config) {
        durations = config.durations
        rules = config.rules
    }

    // Session quote state.
    var clientName by remember { mutableStateOf("") }
    var startDate by remember { mutableStateOf("") }
    var endDate by remember { mutableStateOf("") }
    var packages by remember { mutableStateOf<List<Package>>(emptyList()) }
    var overnightDurationId by remember { mutableStateOf("") }
    var detailId by remember { mutableStateOf<String?>(null) }
    var datePickerFor by remember { mutableStateOf<DateTarget?>(null) }

    // Draft rows.
    var newDurLabel by remember { mutableStateOf("") }
    var newDurMinutes by remember { mutableStateOf("") }
    var newDurPrice by remember { mutableStateOf("") }
    var newDurKind by remember { mutableStateOf("visit") }
    var newPinLabel by remember { mutableStateOf("") }
    var newPinTime by remember { mutableStateOf("07:00") }
    var newPinDurId by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }

    val dirty = durations != config.durations || rules != config.rules
    val days = daysBetween(startDate, endDate)
    val nights = (days - 1).coerceAtLeast(0)

    // Keep overnight selection pointing at a real overnight-kind duration.
    LaunchedEffect(durations) {
        val overnights = durations.filter { it.kind == "overnight" }
        if (overnights.isNotEmpty() && overnights.none { it.id == overnightDurationId }) {
            overnightDurationId = overnights.first().id
        }
    }
    // Date range shrank: drop overnight toggles / day overrides for days that no longer exist.
    LaunchedEffect(nights, days) {
        packages = packages.map { p ->
            val keptNights = p.overnightNights.filterKeys { it < nights }
            val keptDays = p.dayOverrides.filterKeys { it < days }
            if (keptNights.size == p.overnightNights.size && keptDays.size == p.dayOverrides.size) p
            else p.copy(overnightNights = keptNights, dayOverrides = keptDays)
        }
    }

    val overnightDuration = durations.firstOrNull { it.id == overnightDurationId }
    val visitDurations = durations.filter { it.kind == "visit" }

    fun updateDuration(id: String, block: (Duration) -> Duration) {
        durations = durations.map { if (it.id == id) block(it) else it }
    }
    fun patchPackage(id: String, block: (Package) -> Package) {
        packages = packages.map { if (it.id == id) block(it) else it }
    }

    fun addDuration() {
        if (newDurLabel.isBlank() || newDurMinutes.isBlank() || newDurPrice.isBlank()) {
            formError = "Enter a name, length in minutes, and price."
            return
        }
        durations = durations + Duration(uid(), newDurLabel.trim(), newDurMinutes.toDoubleOrNull() ?: 0.0, newDurPrice.toDoubleOrNull() ?: 0.0, newDurKind)
        newDurLabel = ""; newDurMinutes = ""; newDurPrice = ""; newDurKind = "visit"; formError = null
    }
    fun addPinned() {
        if (newPinLabel.isBlank() || newPinTime.isBlank() || newPinDurId.isBlank()) {
            formError = "Enter a label, time, and visit length for the pinned visit."
            return
        }
        rules = rules.copy(pinnedTimes = rules.pinnedTimes + PinnedTime(uid(), newPinLabel.trim(), newPinTime, newPinDurId))
        newPinLabel = ""; newPinTime = "07:00"; newPinDurId = ""; formError = null
    }

    val suggestions = buildDayPatterns(durations, rules.pinnedTimes, rules.maxGapHours, rules.wakeStart, rules.wakeEnd)

    fun newPackage(name: String, visits: List<Visit>) {
        val pkg = normalizePackage(id = uid(), name = name, visits = visits)
        packages = packages + pkg
        detailId = pkg.id
        formError = null
    }
    fun startNewQuote() {
        packages = emptyList(); detailId = null; clientName = ""; startDate = ""; endDate = ""
    }

    val ctx = PriceContext(days, nights, durations, overnightDuration)
    val detailPkg = packages.firstOrNull { it.id == detailId }
    val detailPriced = detailPkg?.let { pricePackage(it, ctx) }

    datePickerFor?.let { target ->
        val currentIso = if (target == DateTarget.START) startDate else endDate
        val initial = runCatching { LocalDate.parse(currentIso) }.getOrNull() ?: LocalDate.now()
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { datePickerFor = null },
            confirmButton = {
                AuntieTextBtn(onClick = {
                    pickerState.selectedDateMillis?.let { ms ->
                        val picked = Instant.ofEpochMilli(ms).atZone(ZoneId.of("UTC")).toLocalDate().toString()
                        if (target == DateTarget.START) startDate = picked else endDate = picked
                    }
                    datePickerFor = null
                }) { Text("OK") }
            },
            dismissButton = { AuntieTextBtn(onClick = { datePickerFor = null }) { Text("Cancel") } },
        ) { DatePicker(state = pickerState) }
    }

    AuntieScreenScaffold(title = "Coverage Packages", onBack = onBack, imePaddingEnabled = true) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            DenScreenHeading(
                kicker = "Care Ops · Pricing",
                title = "Coverage",
                accentTail = "packages.",
                subtitle = "Set the visit menu and this client's rules, then build packages — mix any visit lengths, pick which nights get an overnight. No pinned visit required.",
            )

            // save bar (config)
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = if (config.updatedAt.isBlank()) "Menu & rules not saved yet" else "Last saved${if (config.updatedBy.isBlank()) "" else " by ${config.updatedBy}"}",
                    style = AuntieTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.weight(1f),
                )
                GhostButton(label = "Revert", enabled = dirty && !uiState.isLoading, onClick = { durations = config.durations; rules = config.rules; formError = null })
                PrimaryButton(label = if (dirty) "Save menu & rules" else "Saved", enabled = dirty, onClick = { viewModel.saveConfig(durations, rules) })
            }
            uiState.error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Something went wrong", icon = Lucide.TriangleAlert) {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            // ── visit menu ───────────────────────────────────────────────────
            DenPanel(
                title = "Visit menu",
                subtitle = "Service lengths, prices, and type. Overnights price as a window; visits are per-drop-in.",
                trailing = { GhostButton(label = "Defaults", onClick = { durations = DEFAULT_DURATIONS; rules = DEFAULT_COVERAGE_RULES }) },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    durations.forEach { d ->
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AuntieField(value = d.label, onValueChange = { v -> updateDuration(d.id) { it.copy(label = v) } }, placeholder = "Service name", modifier = Modifier.weight(2f))
                                AuntieField(value = numText(d.minutes), onValueChange = { v -> updateDuration(d.id) { it.copy(minutes = v.toDoubleOrNull() ?: 0.0) } }, placeholder = "min", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                                AuntieField(value = numText(d.price), onValueChange = { v -> updateDuration(d.id) { it.copy(price = v.toDoubleOrNull() ?: 0.0) } }, placeholder = "$", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                                AuntieIconBtn(onClick = { durations = durations.filter { it.id != d.id } }) {
                                    Icon(Lucide.Trash2, contentDescription = "Remove ${d.label}", tint = c.textDim, modifier = Modifier.size(18.dp))
                                }
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AuntieChip(selected = d.kind == "visit", onClick = { updateDuration(d.id) { it.copy(kind = "visit") } }, label = "Visit")
                                AuntieChip(selected = d.kind == "overnight", onClick = { updateDuration(d.id) { it.copy(kind = "overnight") } }, label = "Overnight")
                            }
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AuntieField(value = newDurLabel, onValueChange = { newDurLabel = it }, placeholder = "New service", modifier = Modifier.weight(2f))
                    AuntieField(value = newDurMinutes, onValueChange = { newDurMinutes = it }, placeholder = "min", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    AuntieField(value = newDurPrice, onValueChange = { newDurPrice = it }, placeholder = "$", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
                    PrimaryButton(label = "Add", onClick = { addDuration() }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.background, modifier = Modifier.size(16.dp)) })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                    AuntieChip(selected = newDurKind == "visit", onClick = { newDurKind = "visit" }, label = "Visit")
                    AuntieChip(selected = newDurKind == "overnight", onClick = { newDurKind = "overnight" }, label = "Overnight")
                }
            }

            // ── coverage rules ───────────────────────────────────────────────
            DenPanel(title = "Coverage rules for this client", subtitle = "Seed the suggestions and gap warnings. Not a hard gate.") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TimeField(label = "Day starts", value = rules.wakeStart, onChange = { rules = rules.copy(wakeStart = it) }, modifier = Modifier.weight(1f))
                        TimeField(label = "Day ends", value = rules.wakeEnd, onChange = { rules = rules.copy(wakeEnd = it) }, modifier = Modifier.weight(1f))
                    }
                    AuntieField(value = numText(rules.maxGapHours), onValueChange = { rules = rules.copy(maxGapHours = it.toDoubleOrNull() ?: 1.0) }, label = "Max gap between visits (hrs)", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth(0.5f))
                    val overnightOptions = durations.filter { it.kind == "overnight" }
                    if (overnightOptions.isNotEmpty()) {
                        Text("Overnight duration", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            overnightOptions.forEach { d ->
                                AuntieChip(selected = overnightDurationId == d.id, onClick = { overnightDurationId = d.id }, label = "${d.label} · $${money(d.price)}")
                            }
                        }
                    }

                    Text("Pinned visits — this client's non-negotiables. New blank packages start with these.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    rules.pinnedTimes.forEach { p ->
                        Row(modifier = Modifier.fillMaxWidth().background(c.surface, RoundedCornerShape(8.dp)).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(p.label, style = AuntieTheme.typography.titleSmall, color = c.textPrimary, modifier = Modifier.weight(2f))
                            Text(pinnedTimeLabel(p), style = AuntieTheme.typography.bodySmall, color = c.primary, modifier = Modifier.weight(1f))
                            Text(durations.firstOrNull { it.id == p.durationId }?.label ?: "", style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.weight(1f))
                            AuntieIconBtn(onClick = { rules = rules.copy(pinnedTimes = rules.pinnedTimes.filter { it.id != p.id }) }) {
                                Icon(Lucide.Trash2, contentDescription = "Remove ${p.label}", tint = c.textDim, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                    AuntieField(value = newPinLabel, onValueChange = { newPinLabel = it }, placeholder = "e.g. Medication", modifier = Modifier.fillMaxWidth())
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TimeField(label = "At", value = newPinTime, onChange = { newPinTime = it }, modifier = Modifier.weight(1f))
                        PrimaryButton(label = "Add", onClick = { addPinned() }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.background, modifier = Modifier.size(16.dp)) })
                    }
                    if (visitDurations.isNotEmpty() || durations.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            durations.forEach { d ->
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

            // ── coverage window ──────────────────────────────────────────────
            DenPanel(title = "Coverage window", subtitle = "The stay's dates. Packages price across this range; not saved with the menu.") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuntieField(value = clientName, onValueChange = { clientName = it }, label = "Client (optional)", placeholder = "Kinfolk name", modifier = Modifier.fillMaxWidth())
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        DateField(label = "Start", value = startDate, onClick = { datePickerFor = DateTarget.START }, modifier = Modifier.weight(1f))
                        DateField(label = "End", value = endDate, onClick = { datePickerFor = DateTarget.END }, modifier = Modifier.weight(1f))
                    }
                    if (days > 0) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Lucide.CalendarDays, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(16.dp))
                            Text("$days day${if (days != 1) "s" else ""} of coverage · $nights night${if (nights != 1) "s" else ""} available", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                        }
                    }
                    if (packages.isNotEmpty() || startDate.isNotBlank() || clientName.isNotBlank()) {
                        GhostButton(label = "Start new quote", onClick = { startNewQuote() })
                    }
                }
            }

            // ── packages ─────────────────────────────────────────────────────
            DenPanel(
                title = "Packages",
                subtitle = "Build one or more options. Mix any visit lengths — a 15-min lunch check-in with a 60-min evening, however you like.",
                trailing = { PrimaryButton(label = "New package", onClick = { newPackage("Package ${packages.size + 1}", visitsFromPinned(rules.pinnedTimes)) }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.background, modifier = Modifier.size(14.dp)) }) },
            ) {
                if (suggestions.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 12.dp)) {
                        suggestions.forEach { s ->
                            GhostButton(label = "${s.strategyLabel} ($${money(s.dayTotal)}/day)", leading = { Icon(Lucide.Sparkles, contentDescription = null, tint = c.primary, modifier = Modifier.size(12.dp)) }, onClick = { newPackage(s.strategyLabel, visitsFromPattern(s)) })
                        }
                    }
                }
                if (packages.isEmpty()) {
                    EmptyHint("Start from a suggestion or an empty package, then change any visit's time and length. No pinned visit required.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        packages.forEach { pkg ->
                            PackageCard(
                                pkg = pkg,
                                priced = pricePackage(pkg, ctx),
                                durations = durations,
                                visitDurations = visitDurations,
                                overnightDuration = overnightDuration,
                                days = days,
                                nights = nights,
                                startDate = startDate,
                                maxGapHours = rules.maxGapHours,
                                warnings = gapWarnings(pkg.visits, rules.wakeStart, rules.wakeEnd, rules.maxGapHours, com.tribetails.auntieos.domain.Coverage(null, null, false)),
                                isDetail = detailId == pkg.id,
                                onPatch = { block -> patchPackage(pkg.id, block) },
                                onDuplicate = {
                                    val copy = pkg.copy(id = uid(), name = "${pkg.name} copy", visits = pkg.visits.map { it.copy(id = uid()) }, dayOverrides = emptyMap())
                                    packages = packages + copy; detailId = copy.id
                                },
                                onRemove = { packages = packages.filter { it.id != pkg.id }; if (detailId == pkg.id) detailId = null },
                                onToggleDetail = { detailId = if (detailId == pkg.id) null else pkg.id },
                                wakeStart = rules.wakeStart,
                            )
                        }
                    }
                }
            }

            // ── day-by-day detail ────────────────────────────────────────────
            if (detailPkg != null && detailPriced != null && days > 0) {
                DenPanel(title = "${if (clientName.isNotBlank()) "$clientName — " else ""}${detailPkg.name}", subtitle = "$days day${if (days != 1) "s" else ""}${if (startDate.isNotBlank()) " · ${dateLabel(startDate, 0)} – ${dateLabel(startDate, days - 1)}" else ""}") {
                    val quote = quoteText(QuoteInput(clientName, startDate, days, detailPkg, detailPriced))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        GhostButton(label = "Copy quote", leading = { Icon(Lucide.Copy, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(14.dp)) }, onClick = { clipboard.setText(AnnotatedString(quote)) })
                        GhostButton(label = "Share", leading = { Icon(Lucide.Share2, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(14.dp)) }, onClick = {
                            val send = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_SUBJECT, "TribeTails Coverage Package"); putExtra(Intent.EXTRA_TEXT, quote) }
                            context.startActivity(Intent.createChooser(send, "Share quote"))
                        })
                        PrimaryButton(label = "Print / Save PDF", leading = { Icon(Lucide.Printer, contentDescription = null, tint = c.background, modifier = Modifier.size(14.dp)) }, onClick = { printQuote(context, clientName, quote) })
                    }
                    Spacer(Modifier.height(12.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        detailPriced.rows.forEach { row ->
                            DayDetailRow(
                                row = row, pkg = detailPkg, durations = durations, startDate = startDate, wakeStart = rules.wakeStart,
                                onPatch = { block -> patchPackage(detailPkg.id, block) },
                            )
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(modifier = Modifier.fillMaxWidth().background(c.surface, RoundedCornerShape(12.dp)).padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(if (clientName.isNotBlank()) "$clientName's package" else "Package total", style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                            Text("${detailPkg.name} · $days day${if (days != 1) "s" else ""}${if (detailPriced.discountPct > 0) " · ${detailPkg.discountLabel.ifBlank { "Discount" }} ${detailPriced.discountPct.toInt()}% off $${money(detailPriced.subtotal)}" else ""}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        }
                        Text("$${money(detailPriced.total)}", style = AuntieTheme.typography.displayMedium, color = c.primary, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PackageCard(
    pkg: Package,
    priced: com.tribetails.auntieos.domain.PricedPackage,
    durations: List<Duration>,
    visitDurations: List<Duration>,
    overnightDuration: Duration?,
    days: Int,
    nights: Int,
    startDate: String,
    maxGapHours: Double,
    warnings: List<String>,
    isDetail: Boolean,
    wakeStart: String,
    onPatch: ((Package) -> Package) -> Unit,
    onDuplicate: () -> Unit,
    onRemove: () -> Unit,
    onToggleDetail: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth()
            .border(width = if (isDetail) 1.5.dp else 1.dp, color = if (isDetail) c.primary else c.border, shape = RoundedCornerShape(12.dp))
            .background(if (isDetail) c.surfaceGlass else c.surface, RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieField(value = pkg.name, onValueChange = { v -> onPatch { it.copy(name = v) } }, placeholder = "Package name", modifier = Modifier.weight(1f))
            AuntieIconBtn(onClick = onDuplicate) { Icon(Lucide.Copy, contentDescription = "Duplicate", tint = c.textDim, modifier = Modifier.size(16.dp)) }
            AuntieIconBtn(onClick = onRemove) { Icon(Lucide.Trash2, contentDescription = "Delete package", tint = c.textDim, modifier = Modifier.size(16.dp)) }
        }

        SectionLabel("Every day of the stay")
        pkg.visits.sortedBy { it.time }.forEach { v ->
            VisitEditorRow(visit = v, durations = durations, onPatch = { patch -> onPatch { p -> p.copy(visits = p.visits.map { if (it.id == v.id) patch(it) else it }) } }, onRemove = { onPatch { p -> p.copy(visits = p.visits.filter { it.id != v.id }) } })
        }
        if (pkg.visits.isEmpty()) Text("No visits yet.", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        GhostButton(label = "Add visit", onClick = {
            onPatch { p -> p.copy(visits = p.visits + Visit(uid(), timeToMinutes(wakeStart) ?: 720, visitDurations.firstOrNull()?.id ?: "", "Check-in")) }
        }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.primary, modifier = Modifier.size(14.dp)) })

        if (warnings.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Lucide.TriangleAlert, contentDescription = null, tint = c.primary, modifier = Modifier.size(14.dp))
                Column { warnings.forEach { Text("$it — over your ${numText(maxGapHours)}h max gap on a night with no overnight", style = AuntieTheme.typography.bodySmall, color = c.textDim) } }
            }
        }

        SectionLabel("Overnights")
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TimeField(label = "Starts", value = pkg.overnightStart, onChange = { v -> onPatch { it.copy(overnightStart = v) } }, modifier = Modifier.weight(1f))
            AuntieField(value = numText(pkg.overnightBufferHours), onValueChange = { v -> onPatch { it.copy(overnightBufferHours = v.toDoubleOrNull() ?: 0.0) } }, label = "Buffer (hrs)", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
        }
        if (overnightDuration != null) {
            val endMin = timeToMinutes(pkg.overnightStart)?.let { it + overnightDuration.minutes }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Lucide.Moon, contentDescription = null, tint = c.textDim, modifier = Modifier.size(12.dp))
                Text("${overnightDuration.label} → covers until ${endMin?.let { minutesToTime(it) } ?: ""}, plus one free visit the next day", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        if (nights == 0) {
            Text(if (days > 0) "Single day — no nights." else "Set a date range above.", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        } else if (overnightDuration == null) {
            Text("No overnight duration defined (add one to the menu).", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                (0 until nights).forEach { i ->
                    AuntieChip(selected = pkg.overnightNights[i] == true, onClick = { onPatch { it.copy(overnightNights = it.overnightNights + (i to (it.overnightNights[i] != true))) } }, label = dateLabel(startDate, i, monthDayOnly = true).ifBlank { "N${i + 1}" })
                }
            }
        }

        SectionLabel("Discount")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieField(value = pkg.discountLabel, onValueChange = { v -> onPatch { it.copy(discountLabel = v) } }, placeholder = "e.g. Military", modifier = Modifier.weight(2f))
            AuntieField(value = if (pkg.discountPct == 0.0) "" else numText(pkg.discountPct), onValueChange = { v -> onPatch { it.copy(discountPct = v.toDoubleOrNull() ?: 0.0) } }, placeholder = "0", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
        }

        if (days == 0) {
            Text("Set a date range to price this.", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(top = 8.dp)) {
                TotalLine("Subtotal", "$${money(priced.subtotal)}", c.textDim)
                if (priced.discountPct > 0) TotalLine("${pkg.discountLabel.ifBlank { "Discount" }} (${priced.discountPct.toInt()}%)", "−$${money(priced.discount)}", c.primary)
                TotalLine("Total", "$${money(priced.total)}", c.textPrimary, bold = true)
                GhostButton(label = if (isDetail) "Hide day-by-day" else "View day-by-day", onClick = onToggleDetail)
            }
        }
    }
}

@Composable
private fun VisitEditorRow(visit: Visit, durations: List<Duration>, onPatch: ((Visit) -> Visit) -> Unit, onRemove: () -> Unit) {
    val c = AuntieTheme.colors
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TimeField(label = null, value = minutesToInput(visit.time), onChange = { v -> timeToMinutes(v)?.let { m -> onPatch { it.copy(time = m) } } }, modifier = Modifier.weight(1.1f))
        AuntieDropdownField(
            value = visit.durationId,
            options = durations.map { it.id },
            onSelect = { id -> onPatch { it.copy(durationId = id) } },
            displayText = { id -> durations.firstOrNull { it.id == id }?.let { "${it.label} — $${money(it.price)}" } ?: "length…" },
            modifier = Modifier.weight(1.6f),
        )
        AuntieField(value = visit.label, onValueChange = { v -> onPatch { it.copy(label = v) } }, placeholder = "Label", modifier = Modifier.weight(1f))
        AuntieIconBtn(onClick = onRemove) { Icon(Lucide.Trash2, contentDescription = "Remove visit", tint = c.textDim, modifier = Modifier.size(14.dp)) }
    }
}

@Composable
private fun DayDetailRow(row: PricedDayRow, pkg: Package, durations: List<Duration>, startDate: String, wakeStart: String, onPatch: ((Package) -> Package) -> Unit) {
    val c = AuntieTheme.colors
    val dayVisits = effectiveVisits(pkg, row.dayIndex).sortedBy { it.time }
    Column(modifier = Modifier.fillMaxWidth().border(1.dp, c.border, RoundedCornerShape(8.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Day ${row.dayIndex + 1}", style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            if (startDate.isNotBlank()) Text(dateLabel(startDate, row.dayIndex), style = AuntieTheme.typography.bodySmall, color = c.textFaint, modifier = Modifier.weight(1f))
            else Spacer(Modifier.weight(1f))
            Text("$${money(row.dayCost)}", style = AuntieTheme.typography.titleSmall, color = c.primary)
        }
        Text(
            if (row.isOvernight && row.overnightStartMin != null) "Overnight — ${row.overnightLabel} from ${minutesToTime(row.overnightStartMin.toDouble())}"
            else if (row.canOvernight) "No overnight" else "Client returns — no overnight",
            style = AuntieTheme.typography.bodySmall, color = c.textDim,
        )

        if (row.customized) {
            dayVisits.forEach { v ->
                VisitEditorRow(visit = v, durations = durations, onPatch = { patch -> onPatch { p -> p.copy(dayOverrides = p.dayOverrides + (row.dayIndex to (p.dayOverrides[row.dayIndex] ?: emptyList()).map { if (it.id == v.id) patch(it) else it })) } }, onRemove = { onPatch { p -> p.copy(dayOverrides = p.dayOverrides + (row.dayIndex to (p.dayOverrides[row.dayIndex] ?: emptyList()).filter { it.id != v.id })) } })
            }
            if (dayVisits.isEmpty()) Text("No visits this day.", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            GhostButton(label = "Add visit to this day", onClick = { onPatch { p -> p.copy(dayOverrides = p.dayOverrides + (row.dayIndex to (p.dayOverrides[row.dayIndex] ?: emptyList()) + Visit(uid(), timeToMinutes(wakeStart) ?: 720, durations.firstOrNull { it.kind == "visit" }?.id ?: "", "Check-in"))) } }, leading = { Icon(Lucide.Plus, contentDescription = null, tint = c.primary, modifier = Modifier.size(12.dp)) })
        } else {
            row.items.forEach { it2 ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(minutesToTime(it2.time.toDouble()), style = AuntieTheme.typography.bodySmall, color = if (it2.free) c.textFaint else c.textPrimary, fontWeight = FontWeight.SemiBold)
                    Text("${it2.label} (${it2.durationLabel})${if (it2.freeReason != null) " — ${it2.freeReason}" else ""}", style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.weight(1f))
                    Text(if (it2.free) "—" else "$${money(it2.price)}", style = AuntieTheme.typography.bodySmall, color = if (it2.free) c.textFaint else c.textPrimary)
                }
            }
            if (row.items.isEmpty()) Text("No visits this day", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            if (row.isOvernight && row.overnightStartMin != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(minutesToTime(row.overnightStartMin.toDouble()), style = AuntieTheme.typography.bodySmall, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                    Text(row.overnightLabel, style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.weight(1f))
                    Text("$${money(row.overnightCost)}", style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (row.customized) {
                Text("Customized", style = AuntieTheme.typography.labelSmall, color = c.primary)
                AuntieTextBtn(onClick = { onPatch { p -> p.copy(dayOverrides = p.dayOverrides - row.dayIndex) } }) { Text("Reset to template") }
            } else {
                AuntieTextBtn(onClick = { onPatch { p -> p.copy(dayOverrides = p.dayOverrides + (row.dayIndex to p.visits.map { it.copy(id = uid()) })) } }) { Text("Customize this day") }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text.uppercase(Locale.US), style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.primary, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun TotalLine(label: String, value: String, color: androidx.compose.ui.graphics.Color, bold: Boolean = false) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = if (bold) AuntieTheme.typography.titleSmall else AuntieTheme.typography.bodySmall, color = color)
        Text(value, style = if (bold) AuntieTheme.typography.titleSmall else AuntieTheme.typography.bodySmall, color = color, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal)
    }
}

/** A "HH:MM" time entered as HOUR + MINUTE dropdowns (the app's time idiom). */
@Composable
private fun TimeField(label: String?, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val mins = timeToMinutes(value)
    val hour = (mins?.div(60))?.coerceIn(0, 23) ?: 9
    val minute = mins?.rem(60) ?: 0
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (label != null) Text(label.uppercase(Locale.US), style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieDropdownField(value = hour, options = (0..23).toList(), onSelect = { onChange(hhmm(it, minute)) }, displayText = { "%02d".format(it) }, modifier = Modifier.weight(1f))
            AuntieDropdownField(value = minute, options = MINUTE_STEPS, onSelect = { onChange(hhmm(hour, it)) }, displayText = { "%02d".format(it) }, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun DateField(label: String, value: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label.uppercase(Locale.US), style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Box(modifier = Modifier.fillMaxWidth().border(1.dp, c.border, RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 12.dp)) {
            Text(value.ifBlank { "Pick a date" }, style = AuntieTheme.typography.bodyMedium, color = if (value.isBlank()) c.textFaint else c.textPrimary)
        }
    }
}

private val MINUTE_STEPS = (0..55 step 5).toList()
private fun hhmm(h: Int, m: Int): String = "%02d:%02d".format(h, m)

/** Drop a trailing ".0" so "30.0" shows as "30" while "22.5" stays "22.5". */
private fun numText(d: Double): String = if (d == floor(d)) d.toLong().toString() else d.toString()
private fun money(d: Double): String = String.format(Locale.US, "%.2f", d)
private fun pinnedTimeLabel(p: PinnedTime): String {
    val mins = timeToMinutes(p.time) ?: return ""
    return minutesToTime(mins.toDouble())
}

/** Print / Save-PDF the quote via Android's print framework (offscreen WebView). */
private fun printQuote(context: Context, clientName: String, quote: String) {
    val escaped = quote.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    val html = "<html><body><pre style=\"font-family:monospace;font-size:12px;white-space:pre-wrap;\">$escaped</pre></body></html>"
    val jobName = "TribeTails Coverage Package" + if (clientName.isNotBlank()) " – $clientName" else ""
    val webView = WebView(context)
    webView.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
            val printManager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
            printManager.print(jobName, view.createPrintDocumentAdapter(jobName), PrintAttributes.Builder().build())
        }
    }
    webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
}
