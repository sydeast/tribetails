package com.kinfolk.portal.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.BookingPattern
import com.kinfolk.portal.portal.BookingVisit
import com.kinfolk.portal.screens.schedule.util.ReviewRow
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.Service
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.formatUsd
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime

/** Orchestrates the 5-step booking wizard. */
@Composable
fun BookingWizardScreen(
    kinfolkId: String,
    portalApi: PortalApi,
    onClose: () -> Unit,
    onComplete: () -> Unit,
    startWeekly: Boolean = false,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(1) }
    var kin by remember { mutableStateOf<List<Kin>?>(null) }
    var services by remember { mutableStateOf<List<Service>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }

    /** "All Kin in this home" is default; flip via Choose-specific to multi-pick. */
    var allKinMode by remember { mutableStateOf(true) }
    var selectedKinIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var selectedServiceId by remember { mutableStateOf<String?>(null) }
    var pattern by remember { mutableStateOf(if (startWeekly) BookingPattern.Weekly else BookingPattern.Individual) }
    var selectedDates by remember { mutableStateOf<List<LocalDate>>(emptyList()) }
    // 16.3 weekly recurrence: which weekdays (0=Sun..6=Sat) + how many weeks.
    var weeklyDays by remember { mutableStateOf<Set<Int>>(emptySet()) }
    var weekCount by remember { mutableStateOf(4) }
    var visitTime by remember { mutableStateOf("09:00") }
    var notes by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId) {
        try {
            kin = portalApi.getMyKin(kinfolkId).kin.filter { it.status == com.kinfolk.portal.portal.KinStatus.Active }
            services = portalApi.getServiceCatalog().services
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load wizard"
        }
    }

    val selectedService = services?.firstOrNull { it.id == selectedServiceId }
    val resolvedKinIds: List<String> = if (allKinMode) {
        kin?.map { it.id } ?: emptyList()
    } else {
        selectedKinIds.toList()
    }
    // Single source of truth for the weekly series: the SAME expanded list is used
    // by the Step 3 count, the Step 5 review, and submit (so the number the kinfolk
    // confirms is exactly what is sent). Recomputed only when the rule changes.
    val weeklyPreview: List<BookingVisit> = remember(pattern, weeklyDays, weekCount, visitTime, selectedServiceId) {
        val svc = selectedService
        val t = parseHourMinute(visitTime)
        if (pattern == BookingPattern.Weekly && svc != null && t != null && weeklyDays.isNotEmpty() && weekCount >= 1) {
            buildWeeklyVisits(
                nowMs = Clock.System.now().toEpochMilliseconds(),
                weeklyDays = weeklyDays, weeks = weekCount, time = t,
                serviceId = svc.id, serviceName = svc.name, priceCents = svc.priceCents ?: svc.priceMinCents,
            )
        } else {
            emptyList()
        }
    }
    val weeklyPotential = weeklyPotentialCount(weeklyDays, weekCount)
    // True when the cap (or the future-only filter) dropped requested occurrences.
    val weeklyCapped = pattern == BookingPattern.Weekly && weeklyPreview.isNotEmpty() && weeklyPotential > weeklyPreview.size

    val canAdvance = when (step) {
        1 -> if (allKinMode) (kin?.isNotEmpty() == true) else selectedKinIds.isNotEmpty()
        2 -> selectedServiceId != null
        3 -> when (pattern) {
            BookingPattern.Individual -> selectedDates.isNotEmpty() && parseHourMinute(visitTime) != null
            BookingPattern.Weekly -> weeklyVisitsBlocker(weeklyDays, weekCount, visitTime) == null
        }
        4 -> true
        else -> true
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenHeader(title = "New Booking")
        WizardStepIndicator(current = step)

        if (loadError != null) {
            Text(
                "Couldn't load: $loadError",
                style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                modifier = Modifier.padding(KinfolkSpacing.l),
            )
            return@Column
        }
        if (kin == null || services == null) {
            Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.xl), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
            }
            return@Column
        }

        when (step) {
            1 -> Step1KinSelect(
                kin = kin!!,
                allKinMode = allKinMode,
                onToggleAllMode = { allKinMode = it },
                selectedIds = selectedKinIds,
                onToggle = { id ->
                    selectedKinIds = if (selectedKinIds.contains(id)) selectedKinIds - id else selectedKinIds + id
                },
            )
            2 -> Step2ServiceSelect(
                services = services!!,
                selectedId = selectedServiceId,
                onSelect = { selectedServiceId = it },
            )
            3 -> Step3ScheduleDates(
                pattern = pattern,
                onPatternChange = { pattern = it },
                selectedDates = selectedDates,
                onToggleDate = { d ->
                    selectedDates = if (selectedDates.contains(d)) selectedDates - d else selectedDates + d
                },
                weeklyDays = weeklyDays,
                onToggleWeekday = { day ->
                    weeklyDays = if (weeklyDays.contains(day)) weeklyDays - day else weeklyDays + day
                },
                weekCount = weekCount,
                onWeekCountChange = { weekCount = it },
                visitTime = visitTime,
                onVisitTimeChange = { visitTime = it },
                serviceLabel = selectedService?.name ?: "Service",
                weeklyEmitted = weeklyPreview.size,
                weeklyCapped = weeklyCapped,
            )
            4 -> Step4InvoiceOptions()
            5 -> Step5Review(
                kinNames = if (allKinMode) listOf("All Kin in this home")
                else kin!!.filter { it.id in selectedKinIds }.mapNotNull { it.name },
                service = selectedService,
                dates = selectedDates,
                visitTime = visitTime,
                notes = notes,
                onNotesChange = { notes = it },
                pattern = pattern,
                visitCount = if (pattern == BookingPattern.Weekly) weeklyPreview.size else selectedDates.size,
                capped = weeklyCapped,
                submitting = submitting,
                error = submitError,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onClose) { Text("Cancel") }
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                if (step > 1) {
                    KinGhostButton(label = "Back", onClick = { step -= 1 })
                }
                if (step < 5) {
                    KinButton(
                        label = "Next",
                        onClick = { step += 1 },
                        enabled = canAdvance,
                    )
                } else {
                    KinButton(
                        label = if (submitting) "Creating…" else "Create Booking",
                        onClick = {
                            submitting = true
                            submitError = null
                            scope.launch {
                                try {
                                    val svc = selectedService ?: error("no service")
                                    // Individual = tapped dates; Weekly (16.3) = the same
                                    // expanded preview shown in Step 3 + Review (one source of truth).
                                    val visits = if (pattern == BookingPattern.Weekly) {
                                        weeklyPreview
                                    } else {
                                        buildVisits(selectedDates, visitTime, svc)
                                    }
                                    if (visits.isEmpty()) error("No visits to book. Check the days and weeks.")
                                    // The wizard groups its visits into one envelope; the
                                    // returned batchId is not used for nav, so just reload.
                                    portalApi.requestBookingMultiVisit(
                                        kinfolkId = kinfolkId,
                                        kinIds = resolvedKinIds,
                                        pattern = pattern,
                                        weeklyDays = if (pattern == BookingPattern.Weekly) weeklyDays.sorted() else null,
                                        visits = visits,
                                        notes = notes.ifBlank { null },
                                    )
                                    onComplete()
                                } catch (t: Throwable) {
                                    submitError = t.message ?: "Could not create booking"
                                } finally {
                                    submitting = false
                                }
                            }
                        },
                        enabled = !submitting && selectedService != null && when (pattern) {
                            BookingPattern.Individual -> selectedDates.isNotEmpty() && parseHourMinute(visitTime) != null
                            BookingPattern.Weekly -> weeklyVisitsBlocker(weeklyDays, weekCount, visitTime) == null
                        },
                    )
                }
            }
        }
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

// ---- step composables ----

/** Teal check-circle + "Selected" label used on picked wizard cards. */
@Composable
private fun SelectedIndicator() {
    val type = LocalKinfolkTypography.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = KinfolkBrand.KinTeal,
            modifier = Modifier.size(16.dp),
        )
        Text("Selected", style = type.sansLabel.copy(color = KinfolkBrand.KinTeal))
    }
}

@Composable
private fun WizardStepIndicator(current: Int) {
    val type = LocalKinfolkTypography.current
    // Indicator labels are intentionally short — step section headings render the long form.
    val labels = listOf("Pets", "Service", "Dates", "Invoice", "Review")
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        labels.forEachIndexed { idx, label ->
            val n = idx + 1
            val active = n == current
            val done = n < current
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
                Box(
                    modifier = Modifier.size(28.dp).background(
                        color = when {
                            done -> KinfolkBrand.KinTeal
                            active -> KinfolkBrand.KinfolkOrange
                            else -> KinfolkBrand.NavyHairline
                        },
                        shape = CircleShape,
                    ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("$n", style = type.sansLabel.copy(color = Color.White))
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    label,
                    style = type.sansMeta.copy(color = if (active) KinfolkBrand.Navy else KinfolkBrand.NavyMuted),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun Step1KinSelect(
    kin: List<Kin>,
    allKinMode: Boolean,
    onToggleAllMode: (Boolean) -> Unit,
    selectedIds: Set<String>,
    onToggle: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Select Client & Pets", style = type.heritageTitle)
        Text(
            "Most bookings cover everyone. We'll default to all Kin in your home unless you'd like to pick specific Kin for this visit.",
            style = type.sansBody,
        )
        if (kin.isEmpty()) {
            Text(
                "No Kin on file yet. Add your pets first: open the menu (top right) and choose The Kin.",
                style = type.sansBody.copy(color = KinfolkBrand.NavySoft),
            )
            return@Column
        }

        // All-Kin default card
        GlassCard(
            modifier = Modifier.fillMaxWidth().clickable { onToggleAllMode(true) },
            shape = RoundedCornerShape(14.dp),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text("All Kin in this home", style = type.heritageTitle)
                    val names = kin.mapNotNull { it.name }.joinToString(", ")
                    if (names.isNotEmpty()) Text(names, style = type.sansLabel)
                }
                if (allKinMode) SelectedIndicator()
            }
        }

        // Choose-specific toggle
        KinGhostButton(
            label = if (allKinMode) "Choose specific Kin" else "Use All Kin instead",
            onClick = { onToggleAllMode(!allKinMode) },
            modifier = Modifier.fillMaxWidth(),
        )

        if (allKinMode) return@Column

        kin.forEach { k ->
            val sel = selectedIds.contains(k.id)
            GlassCard(
                modifier = Modifier.fillMaxWidth().clickable { onToggle(k.id) },
                shape = RoundedCornerShape(14.dp),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text(k.name ?: "Unnamed Kin", style = type.heritageTitle)
                        val sub = listOfNotNull(k.breed ?: k.species, k.ageYears?.let { "${it.toInt()} yrs" }).joinToString(" • ")
                        if (sub.isNotEmpty()) Text(sub, style = type.sansLabel)
                    }
                    if (sel) {
                        SelectedIndicator()
                    }
                }
            }
        }
    }
}

@Composable
private fun Step2ServiceSelect(
    services: List<Service>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Choose Service", style = type.heritageTitle)
        Text("Choose the service you'd like for this booking.", style = type.sansBody)
        services.groupBy { it.category ?: "Services" }.forEach { (cat, list) ->
            Spacer(Modifier.height(KinfolkSpacing.xs))
            Text(cat, style = type.sansLabel)
            list.forEach { s ->
                val sel = s.id == selectedId
                GlassCard(
                    modifier = Modifier.fillMaxWidth().clickable { onSelect(s.id) },
                    shape = RoundedCornerShape(14.dp),
                    contentPadding = PaddingValues(KinfolkSpacing.l),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column {
                            Text(s.name, style = type.heritageTitle)
                            val priceStr = priceLabel(s)
                            Text(priceStr, style = type.sansLabel)
                        }
                        if (sel) SelectedIndicator()
                    }
                }
            }
        }
    }
}

@Composable
private fun Step3ScheduleDates(
    pattern: BookingPattern,
    onPatternChange: (BookingPattern) -> Unit,
    selectedDates: List<LocalDate>,
    onToggleDate: (LocalDate) -> Unit,
    weeklyDays: Set<Int>,
    onToggleWeekday: (Int) -> Unit,
    weekCount: Int,
    onWeekCountChange: (Int) -> Unit,
    visitTime: String,
    onVisitTimeChange: (String) -> Unit,
    serviceLabel: String,
    weeklyEmitted: Int = 0,
    weeklyCapped: Boolean = false,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Schedule Dates", style = type.heritageTitle)
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            BookingPattern.entries.forEach { p ->
                OutlinedButton(
                    onClick = { onPatternChange(p) },
                    colors = ButtonDefaults.outlinedButtonColors(
                        containerColor = if (pattern == p) KinfolkBrand.KinTeal else Color.Transparent,
                        contentColor = if (pattern == p) Color.White else KinfolkBrand.Navy,
                    ),
                ) {
                    Text(if (p == BookingPattern.Individual) "Individual Dates" else "Repeating Schedule")
                }
            }
        }

        if (pattern == BookingPattern.Weekly) {
            // 16.3 weekly recurrence: pick weekdays + how many weeks. Visits are
            // expanded client-side (buildWeeklyVisits) and sent as a 'weekly' series.
            Text("Repeat on", style = type.heritageSection)
            Text("Each chosen day repeats every week.", style = type.sansBody)
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                WEEKDAY_LABELS.forEachIndexed { idx, label ->
                    KinChip(
                        label = label,
                        selected = weeklyDays.contains(idx),
                        onClick = { onToggleWeekday(idx) },
                    )
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.s))
            Text("For how many weeks", style = type.sansLabel)
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                listOf(2, 4, 6, 8).forEach { n ->
                    KinChip(
                        label = "$n",
                        selected = weekCount == n,
                        onClick = { onWeekCountChange(n) },
                    )
                }
            }
        } else {
            Text("Choose Individual Dates", style = type.heritageSection)
            Text("Tap dates to add or remove from the booking.", style = type.sansBody)
            SimpleMonthPicker(
                selectedDates = selectedDates,
                onToggle = onToggleDate,
            )
        }

        Spacer(Modifier.height(KinfolkSpacing.s))
        Text("Daily Visit", style = type.sansLabel)
        KinField(
            value = visitTime,
            onValueChange = onVisitTimeChange,
            label = "Time (HH:MM)",
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Service: $serviceLabel", style = type.sansBody)
        if (pattern == BookingPattern.Weekly) {
            val blocker = weeklyVisitsBlocker(weeklyDays, weekCount, visitTime)
            Text(
                blocker ?: "$weeklyEmitted visit(s) over $weekCount weeks. Your Auntie confirms each visit.",
                style = type.sansMeta.copy(color = if (blocker == null) KinfolkBrand.KinTeal else KinfolkBrand.SnuggleCoral),
            )
            if (weeklyCapped) {
                // Fail-loud: never silently drop requested occurrences past the cap.
                Text(
                    "That's more than we can book at once. Only the first $MAX_RECURRING_VISITS visits will be requested. Reduce the days or weeks to send fewer.",
                    style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                )
            }
        } else if (selectedDates.isEmpty()) {
            Text("No dates selected yet.", style = type.sansMeta)
        } else {
            Text("${selectedDates.size} ${if (selectedDates.size == 1) "date" else "dates"} selected", style = type.sansLabel.copy(color = KinfolkBrand.KinTeal))
        }
    }
}

/** Weekday chip labels indexed 0=Sun..6=Sat (matches weeklyDays / weekdayIndex). */
private val WEEKDAY_LABELS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

@Composable
private fun Step4InvoiceOptions() {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Invoice Options", style = type.heritageTitle)
        Text(
            "Auntie creates and sends the invoice once she confirms. You'll be able to add any extra context for Auntie in the next step.",
            style = type.sansBody,
        )
    }
}

@Composable
private fun Step5Review(
    kinNames: List<String>,
    service: Service?,
    dates: List<LocalDate>,
    visitTime: String,
    notes: String,
    onNotesChange: (String) -> Unit,
    pattern: BookingPattern,
    visitCount: Int,
    capped: Boolean,
    submitting: Boolean,
    error: String?,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Review & Confirm", style = type.heritageTitle)
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                ReviewRow("Kin", kinNames.joinToString(", ").ifBlank { "—" })
                ReviewRow("Service", service?.name ?: "—")
                ReviewRow("Pattern", if (pattern == BookingPattern.Individual) "Individual Dates" else "Repeating Schedule")
                ReviewRow("Visits", if (visitCount == 1) "1 visit" else "$visitCount visits")
                ReviewRow("Time", visitTime)
                if (service != null) ReviewRow("Estimated Price", priceLabel(service))
                if (capped) {
                    Text(
                        "Capped at $MAX_RECURRING_VISITS visits. Reduce days or weeks to request fewer.",
                        style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                    )
                }
            }
        }
        // Extra Love & Context — editable kinfolk-facing note. Submitted with the
        // booking request; later editable on BookingDetailsScreen until 3hr before start.
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text("Extra Love & Context", style = type.heritageTitle)
                KinField(
                    value = notes,
                    onValueChange = onNotesChange,
                    label = "e.g. She's a bit shy today, or the gate is tricky to open…",
                    singleLine = false,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "This note will be highlighted for Auntie during the visit.",
                    style = type.sansLabel.copy(color = KinfolkBrand.SnuggleCoral),
                )
            }
        }
        if (error != null) {
            Text(error, style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral))
        }
        if (submitting) {
            CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
        }
    }
}

// ReviewRow moved to `screens/schedule/util/ReviewRow.kt` for reuse by BookingDetailsScreen.

@Composable
private fun SimpleMonthPicker(
    selectedDates: List<LocalDate>,
    onToggle: (LocalDate) -> Unit,
) {
    val today = remember { Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date }
    val type = LocalKinfolkTypography.current
    val daysToShow = remember(today) {
        val firstEpoch = LocalDate(today.year, today.month, 1).toEpochDays()
        (0 until 28L).map { i -> LocalDate.fromEpochDays(firstEpoch + i) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        daysToShow.chunked(7).forEach { week ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                week.forEach { d ->
                    val sel = selectedDates.contains(d)
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .background(
                                color = if (sel) KinfolkBrand.KinTeal else KinfolkBrand.GlassSurfaceDim,
                                shape = CircleShape,
                            )
                            .clickable { onToggle(d) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            d.dayOfMonth.toString(),
                            style = type.sansMeta.copy(color = if (sel) Color.White else KinfolkBrand.Navy),
                        )
                    }
                }
            }
        }
    }
}

private fun parseHourMinute(s: String): LocalTime? = try {
    val parts = s.split(":")
    if (parts.size != 2) null else LocalTime(parts[0].toInt(), parts[1].toInt())
} catch (_: Throwable) { null }

private fun priceLabel(s: Service): String {
    val p = s.priceCents
    val min = s.priceMinCents
    val max = s.priceMaxCents
    return when {
        p != null -> "${formatUsd(p / 100.0)}${if (s.isOvernight) " / night" else ""}"
        min != null && max != null -> "${formatUsd(min / 100.0)} – ${formatUsd(max / 100.0)}"
        min != null -> "from ${formatUsd(min / 100.0)}"
        else -> ""
    }
}

private fun buildVisits(dates: List<LocalDate>, time: String, service: Service): List<BookingVisit> {
    val tz = TimeZone.currentSystemDefault()
    val t = parseHourMinute(time) ?: error("invalid time")
    return dates.map { d ->
        val dt = LocalDateTime(d.year, d.month, d.dayOfMonth, t.hour, t.minute)
        val instant: Instant = dt.toInstant(tz)
        BookingVisit(
            startTimeMs = instant.toEpochMilliseconds(),
            endTimeMs = null,
            serviceId = service.id,
            serviceName = service.name,
            priceCents = service.priceCents ?: service.priceMinCents,
        )
    }
}
