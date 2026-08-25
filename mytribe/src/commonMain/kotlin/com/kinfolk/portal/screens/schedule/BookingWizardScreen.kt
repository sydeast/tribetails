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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingPattern
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.BookingVisit
import com.kinfolk.portal.portal.TimeBlock
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
import kotlinx.datetime.isoDayNumber
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

    /**
     * C1 / #544: date key -> closure name for the whole booking horizon, so
     * the month picker can refuse a company holiday in ANY month it can page
     * to without a second read. Empty means "nothing known closed" — a failed
     * or still-running read degrades to the pre-C1 behavior (every day
     * offered) rather than blocking the wizard on a secondary call, because
     * `requestBooking` refuses a closed date server-side either way.
     */
    var closedDates by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val today = remember { Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()).date }
    val horizonEnd = remember(today) { bookingHorizonEnd(today) }

    /** "All Kin in this home" is default; flip via Choose-specific to multi-pick. */
    var allKinMode by remember { mutableStateOf(true) }
    var selectedKinIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    // #541 / #543: a LIST of KinCares, each with its own time of day, not one
    // service and one clock. See KinCareSlot in RecurringBooking.kt.
    var slots by remember { mutableStateOf<List<KinCareSlot>>(emptyList()) }
    var slotSeq by remember { mutableStateOf(0) }
    var pattern by remember { mutableStateOf(if (startWeekly) BookingPattern.Weekly else BookingPattern.Individual) }
    var selectedDates by remember { mutableStateOf<List<LocalDate>>(emptyList()) }
    // 16.3 weekly recurrence: which weekdays (0=Sun..6=Sat) + how many weeks.
    var weeklyDays by remember { mutableStateOf<Set<Int>>(emptySet()) }
    var weekCount by remember { mutableStateOf(4) }
    var notes by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }

    /**
     * Time-block booking (operator requirement 2026-08-24): what this business
     * lets a household choose. A failed or still-running read leaves
     * [BookingPolicy.CLOCK_ONLY] in place — the pre-time-block behaviour, and
     * the exact shape `getBookingPolicy` itself falls back to when its own
     * settings read fails. A secondary read must not decide whether the wizard
     * opens, and the server refuses whatever it will not accept regardless.
     */
    var policy by remember { mutableStateOf(BookingPolicy.CLOCK_ONLY) }
    /** null means "whatever this business opens on"; set once the household uses the toggle. */
    var modeChoice by remember { mutableStateOf<BookingMode?>(null) }

    LaunchedEffect(kinfolkId) {
        try {
            kin = portalApi.getMyKin(kinfolkId).kin.filter { it.status == com.kinfolk.portal.portal.KinStatus.Active }
            services = portalApi.getServiceCatalog().services
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load wizard"
        }
        // Deliberately AFTER, and in its own try: closures are a secondary
        // read. Losing them must not take the whole wizard down with it.
        try {
            closedDates = portalApi
                .getBusinessClosures(bookingDateKey(today), bookingDateKey(horizonEnd))
                .associate { it.date to it.name }
        } catch (_: Throwable) {
            closedDates = emptyMap()
        }
        // Same posture again: the booking policy is a secondary read, and
        // losing it leaves the wizard on clock times rather than dead.
        try {
            policy = portalApi.getBookingPolicy()
        } catch (_: Throwable) {
            policy = BookingPolicy.CLOCK_ONLY
        }
    }

    /**
     * The mode in force. Derived rather than stored, so it can never be a mode
     * the business does not allow — including in the moment between the wizard
     * opening and the policy arriving.
     */
    val mode: BookingMode = run {
        val preferred = modeChoice ?: initialBookingMode(policy)
        when {
            preferred == BookingMode.TimeBlock && !policy.allowTimeBlockBooking -> BookingMode.SpecificTime
            preferred == BookingMode.SpecificTime && !policy.allowSpecificTimeBooking -> BookingMode.TimeBlock
            else -> preferred
        }
    }
    val timing = remember(mode, policy) {
        BookingTiming(mode, if (mode == BookingMode.TimeBlock) policy.timeBlocks else emptyList())
    }
    /** Both modes on offer: the only case where the household has a choice to make. */
    val canChooseMode = policy.allowTimeBlockBooking && policy.allowSpecificTimeBooking

    val catalog: List<Service> = services ?: emptyList()
    val resolvedKinIds: List<String> = if (allKinMode) {
        kin?.map { it.id } ?: emptyList()
    } else {
        selectedKinIds.toList()
    }
    /**
     * Single source of truth for the visit list, BOTH patterns: the SAME
     * expanded list is used by the Step 3 count, the estimate, the Step 5
     * review's enumerated dates, and submit — so the plan a kinfolk confirms is
     * exactly what is sent. The Individual pattern used to be the exception,
     * building its visits only inside the submit handler, which is how #546 and
     * #547 happened: nothing on screen had a visit list to price, so it priced
     * the catalog entry instead and never moved. Recomputed only when the plan
     * changes (deliberately NOT on a ticking clock).
     */
    val plannedVisits: List<BookingVisit> = remember(pattern, selectedDates, weeklyDays, weekCount, slots, catalog, timing) {
        if (pattern == BookingPattern.Weekly) {
            buildWeeklyVisits(
                nowMs = Clock.System.now().toEpochMilliseconds(),
                weeklyDays = weeklyDays,
                weeks = weekCount,
                slots = slots,
                services = catalog,
                timing = timing,
            )
        } else {
            buildVisits(selectedDates, slots, catalog, timing = timing)
        }
    }
    /**
     * Visits the plan already puts in the PAST — the server refuses every one
     * of them. See [pastPlannedVisits]: a window offers ONE start time, so
     * today's Midday visits are past from the moment it opens and there is no
     * control left to nudge.
     */
    val pastVisits = remember(plannedVisits) {
        pastPlannedVisits(plannedVisits, Clock.System.now().toEpochMilliseconds())
    }
    /** #546: the running estimate, derived from the plan above and from nothing else. */
    val estimate = remember(plannedVisits, catalog) { estimateBookingTotal(plannedVisits, catalog) }
    val weeklyPotential = weeklyPotentialCount(weeklyDays, weekCount, slots.size)
    // True when the cap (or the future-only filter) dropped requested occurrences.
    val weeklyCapped = pattern == BookingPattern.Weekly && plannedVisits.isNotEmpty() && weeklyPotential > plannedVisits.size

    /**
     * C1: every date in the plan that [closedDates] says is closed. The
     * Individual picker already refuses to let one be tapped, so this mainly
     * catches the Weekly pattern, which has no per-date control to disable —
     * a generated weekly date can land on a closure with nothing short of
     * this telling the household before the whole request comes back refused.
     */
    val closedDatesInPlan: List<String> = remember(pattern, selectedDates, plannedVisits, closedDates) {
        if (closedDates.isEmpty()) {
            emptyList()
        } else if (pattern == BookingPattern.Individual) {
            selectedDates.map { bookingDateKey(it) }.filter { closedDates.containsKey(it) }
        } else {
            val tz = TimeZone.currentSystemDefault()
            plannedVisits
                .map { bookingDateKey(Instant.fromEpochMilliseconds(it.startTimeMs).toLocalDateTime(tz).date) }
                .filter { closedDates.containsKey(it) }
                .distinct()
        }
    }

    val individualBlocker: String? =
        if (selectedDates.isEmpty()) "Tap at least one date." else slotsBlocker(slots, timing)
    val scheduleReady = closedDatesInPlan.isEmpty() && pastVisits.isEmpty() && when (pattern) {
        BookingPattern.Individual -> individualBlocker == null
        BookingPattern.Weekly -> weeklyVisitsBlocker(weeklyDays, weekCount, slots, timing) == null
    }

    val canAdvance = when (step) {
        1 -> if (allKinMode) (kin?.isNotEmpty() == true) else selectedKinIds.isNotEmpty()
        2 -> slots.isNotEmpty()
        3 -> scheduleReady
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
            2 -> Step2KinCareSelect(
                services = services!!,
                slots = slots,
                onAdd = { id ->
                    slotSeq += 1
                    slots = slots + KinCareSlot(
                        slotId = "slot-$slotSeq",
                        serviceId = id,
                        time = DEFAULT_VISIT_TIME,
                        // In block mode a fresh KinCare lands in the FIRST
                        // window rather than on "choose one": a picker whose
                        // every row starts unset is a blocker dressed as a
                        // control, and it moves in one tap.
                        timeBlockId = if (mode == BookingMode.TimeBlock) policy.timeBlocks.firstOrNull()?.id else null,
                    )
                },
                onRemove = { slotId -> slots = slots.filterNot { it.slotId == slotId } },
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
                slots = slots,
                services = catalog,
                onSlotTimeChange = { slotId, t ->
                    slots = slots.map { if (it.slotId == slotId) it.copy(time = t) else it }
                },
                onSlotBlockChange = { slotId, blockId ->
                    slots = slots.map { if (it.slotId == slotId) it.copy(timeBlockId = blockId) else it }
                },
                mode = mode,
                canChooseMode = canChooseMode,
                onModeChange = { modeChoice = it },
                timeBlocks = policy.timeBlocks,
                pastVisitCount = pastVisits.size,
                individualBlocker = individualBlocker,
                visitCount = plannedVisits.size,
                weeklyEmitted = plannedVisits.size,
                weeklyCapped = weeklyCapped,
                today = today,
                horizonEnd = horizonEnd,
                closedDates = closedDates,
                closedDatesInPlan = closedDatesInPlan,
            )
            4 -> Step4ExtraLoveAndContext(notes = notes, onNotesChange = { notes = it })
            5 -> Step5Review(
                kinNames = if (allKinMode) listOf("All Kin in this home")
                else kin!!.filter { it.id in selectedKinIds }.mapNotNull { it.name },
                kinCareSummary = summariseSlots(slots, catalog),
                notes = notes,
                pattern = pattern,
                visits = plannedVisits,
                timeBlocks = policy.timeBlocks,
                estimateLabel = formatEstimate(estimate),
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
                                    if (slots.isEmpty()) error("Choose a KinCare Duration first.")
                                    // The SAME array step 3 and Review have been showing.
                                    val visits = plannedVisits
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
                        enabled = !submitting && slots.isNotEmpty() && plannedVisits.isNotEmpty() && scheduleReady,
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
    // #545: step 4 is Extra Love & Context. It was labelled "Invoice" for a step
    // that showed kinfolk an invoice-policy note and asked them for nothing.
    val labels = listOf("Pets", "KinCare Duration", "Dates", "Extra Love", "Review")
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
/**
 * #541 + #543: step 2 builds the day's KinCare LIST, not a single choice.
 *
 * Tapping a card used to REPLACE the choice, so a second duration silently
 * unpicked the first (#541) and two KinCares in one day were unreachable
 * (#543). A card is now an ADD control — tap it again for a second one of the
 * same duration, which is how the morning-and-evening walk gets asked for — and
 * the list below is where a KinCare is taken back out. Adding on the card and
 * removing in the list keeps one control from having to mean both.
 *
 * Each KinCare's time of day is set on step 3, next to the dates.
 */
private fun Step2KinCareSelect(
    services: List<Service>,
    slots: List<KinCareSlot>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Choose KinCare Duration", style = type.heritageTitle)
        Text(
            "How long should each visit run? Add as many as this booking needs. Tap a duration twice for two of them in the same day.",
            style = type.sansBody,
        )
        services.groupBy { it.category ?: "KinCare Durations" }.forEach { (cat, list) ->
            Spacer(Modifier.height(KinfolkSpacing.xs))
            Text(cat, style = type.sansLabel)
            list.forEach { s ->
                val count = slots.count { it.serviceId == s.id }
                GlassCard(
                    modifier = Modifier.fillMaxWidth().clickable(onClickLabel = "Add ${s.name}") { onAdd(s.id) },
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
                        when {
                            count > 1 -> Text("×$count", style = type.sansLabel.copy(color = KinfolkBrand.KinTeal))
                            count == 1 -> SelectedIndicator()
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(KinfolkSpacing.xs))
        Text("KinCare in each day", style = type.sansLabel)
        if (slots.isEmpty()) {
            Text("Nothing added yet. Tap a duration above.", style = type.sansMeta)
        } else {
            slots.forEachIndexed { idx, slot ->
                val service = services.firstOrNull { it.id == slot.serviceId }
                val name = service?.name ?: slot.serviceId
                GlassCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    contentPadding = PaddingValues(KinfolkSpacing.m),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${idx + 1}. $name", style = type.sansBody)
                        TextButton(onClick = { onRemove(slot.slotId) }) { Text("Remove $name") }
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
    /** #541/#543: the day's KinCare list. One time field is rendered per entry. */
    slots: List<KinCareSlot>,
    services: List<Service>,
    onSlotTimeChange: (String, String) -> Unit,
    /** Time-block booking: which named window this KinCare goes in. */
    onSlotBlockChange: (String, String) -> Unit = { _, _ -> },
    mode: BookingMode = BookingMode.SpecificTime,
    /** True only when the business allows BOTH, which is the only case with a choice to render. */
    canChooseMode: Boolean = false,
    onModeChange: (BookingMode) -> Unit = {},
    timeBlocks: List<TimeBlock> = emptyList(),
    /** Visits the plan already puts in the past; the server refuses every one of them. */
    pastVisitCount: Int = 0,
    /** First reason the Individual pattern is not sendable, or null. */
    individualBlocker: String? = null,
    /** Visits the whole plan currently expands to (dates x KinCares). */
    visitCount: Int = 0,
    weeklyEmitted: Int = 0,
    weeklyCapped: Boolean = false,
    /** #544: lower bound of the pickable window; also the earliest month reachable. */
    today: LocalDate,
    /** #544: upper bound of the pickable window; also the latest month reachable. */
    horizonEnd: LocalDate,
    /** C1: date key -> closure name, from `getBusinessClosures`. */
    closedDates: Map<String, String> = emptyMap(),
    /** C1: dates already in the plan that land on one of [closedDates]. */
    closedDatesInPlan: List<String> = emptyList(),
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
            Text("Tap dates to add or remove from the booking. Closed dates can't be selected.", style = type.sansBody)
            SimpleMonthPicker(
                selectedDates = selectedDates,
                onToggle = onToggleDate,
                today = today,
                horizonEnd = horizonEnd,
                closedDates = closedDates,
            )
        }

        Spacer(Modifier.height(KinfolkSpacing.s))
        // Time-block booking (operator requirement 2026-08-24). The mode is a
        // BOOKING-level choice, not a per-KinCare one: the operator asked for
        // blocks instead of clocks, not for a mixture. Rendered only when the
        // business allows both — with one mode on offer there is nothing to
        // decide, and a disabled toggle would be a control that lies.
        if (canChooseMode) {
            Text("How do you want to set the time?", style = type.heritageSection)
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                KinChip(
                    label = "Time Blocks",
                    selected = mode == BookingMode.TimeBlock,
                    onClick = { onModeChange(BookingMode.TimeBlock) },
                )
                KinChip(
                    label = "A Specific Time",
                    selected = mode == BookingMode.SpecificTime,
                    onClick = { onModeChange(BookingMode.SpecificTime) },
                )
            }
        }

        // #543: one control PER KinCare, not one for the booking. Two KinCares
        // of the same duration in a day are only two things at all because they
        // differ here — by the clock in specific-time mode, by the window in
        // block mode.
        Text(if (mode == BookingMode.TimeBlock) "Time Blocks" else "Visit Times", style = type.sansLabel)
        if (mode == BookingMode.TimeBlock) {
            Text(
                "Your Auntie arrives at some point during the block you pick. That leaves her room to get between homes without rushing anyone.",
                style = type.sansMeta,
            )
        }
        if (slots.isEmpty()) {
            Text("No KinCare chosen yet. Go back a step to add one.", style = type.sansMeta)
        } else {
            slots.forEachIndexed { idx, slot ->
                val name = services.firstOrNull { it.id == slot.serviceId }?.name ?: slot.serviceId
                if (mode == BookingMode.TimeBlock) {
                    Text("${idx + 1}. $name", style = type.sansBody)
                    Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                        timeBlocks.forEach { block ->
                            KinChip(
                                label = timeBlockLabel(block),
                                selected = slot.timeBlockId == block.id,
                                onClick = { onSlotBlockChange(slot.slotId, block.id) },
                            )
                        }
                    }
                } else {
                    KinField(
                        value = slot.time,
                        onValueChange = { onSlotTimeChange(slot.slotId, it) },
                        label = "${idx + 1}. $name time (HH:MM)",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        if (pattern == BookingPattern.Weekly) {
            val blocker = weeklyVisitsBlocker(weeklyDays, weekCount, slots)
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
        } else if (individualBlocker != null) {
            Text(
                individualBlocker,
                style = if (selectedDates.isEmpty()) {
                    type.sansMeta
                } else {
                    type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral)
                },
            )
        } else {
            Text(
                "${selectedDates.size} ${if (selectedDates.size == 1) "date" else "dates"} selected, " +
                    "$visitCount ${if (visitCount == 1) "visit" else "visits"}",
                style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
            )
        }

        // C1: a closed date already in the plan. The picker cannot produce one,
        // but a weekly rule can, and nothing else would say so before the whole
        // request came back refused.
        if (closedDatesInPlan.isNotEmpty()) {
            val which = if (closedDatesInPlan.size == 1) {
                "${closedDatesInPlan.first()} is closed"
            } else {
                "${closedDatesInPlan.size} of these dates are closed (${closedDatesInPlan.joinToString(", ")})"
            }
            val them = if (closedDatesInPlan.size == 1) "it" else "them"
            Text(
                "$which. Remove $them to continue. A closed date can't be booked.",
                style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
            )
        }

        // A block offers ONE start time, so once today's window has opened
        // there is no control left for the household to nudge. Say so here
        // rather than let the whole request come back refused.
        if (pastVisitCount > 0) {
            val howMany = if (pastVisitCount == 1) "1 visit in this plan has" else "$pastVisitCount visits in this plan have"
            val fix = if (mode == BookingMode.TimeBlock) "Pick a later block" else "Pick a later time"
            Text(
                "$howMany already started. $fix, or drop today from the dates.",
                style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
            )
        }
    }
}

/** Weekday chip labels indexed 0=Sun..6=Sat (matches weeklyDays / weekdayIndex). */
private val WEEKDAY_LABELS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

/** What a freshly added KinCare's time starts at. The household changes it in step 3. */
private const val DEFAULT_VISIT_TIME = "09:00"

/**
 * #545: step 4 is what the step indicator has always called it.
 *
 * What used to sit here was headed "Invoice Options" and offered no option: it
 * told kinfolk an Auntie raises the invoice after she confirms, and gave them a
 * Next button. Kinfolk do not choose how they are billed, so nothing belonged
 * on this step but the note the indicator already promised — which was stranded
 * at the bottom of Review. It lives here now, and the invoice card is deleted
 * rather than hidden: no composable remains to reach.
 *
 * The note is submitted with the booking request, and stays editable on
 * BookingDetailsScreen until 3hr before the visit starts.
 */
@Composable
private fun Step4ExtraLoveAndContext(notes: String, onNotesChange: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text("Extra Love & Context", style = type.heritageTitle)
        Text("Anything your Auntie should know before she arrives? Optional.", style = type.sansBody)
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

@Composable
private fun Step5Review(
    kinNames: List<String>,
    kinCareSummary: String,
    notes: String,
    pattern: BookingPattern,
    visits: List<BookingVisit>,
    /** Time-block booking: needed to NAME the window each visit was booked into. */
    timeBlocks: List<TimeBlock> = emptyList(),
    estimateLabel: String,
    capped: Boolean,
    submitting: Boolean,
    error: String?,
) {
    val type = LocalKinfolkTypography.current
    val rendered = renderPlannedVisits(visits, blocks = timeBlocks)
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
                ReviewRow("KinCare", kinCareSummary.ifBlank { "—" })
                ReviewRow("Pattern", if (pattern == BookingPattern.Individual) "Individual Dates" else "Repeating Schedule")
                ReviewRow("Estimated Price", estimateLabel)
                ReviewRow("Extra Love & Context", notes.ifBlank { "None added" })
                if (capped) {
                    Text(
                        "Capped at $MAX_RECURRING_VISITS visits. Reduce days or weeks to request fewer.",
                        style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                    )
                }
            }
        }
        // #547: "Pattern = Dates. Actually display those dates." Review used to
        // print "3 visits" and leave the household to remember which three. Every
        // visit is enumerated, spelled the way
        // docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md spells
        // one ("Thu, Sep 4 at 9:00 AM").
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                Text(
                    if (rendered.size == 1) "1 visit" else "${rendered.size} visits",
                    style = type.heritageSection,
                )
                if (rendered.isEmpty()) {
                    Text("No visits in this booking yet.", style = type.sansMeta)
                } else {
                    rendered.forEach { v ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(plannedVisitLine(v), style = type.sansBody)
                            Text(v.serviceName, style = type.sansMeta)
                        }
                    }
                }
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

/** Month names for the picker header, indexed by `Month.ordinal` (0 = January). */
private val MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

private val WEEKDAY_HEADERS = listOf("S", "M", "T", "W", "T", "F", "S")

/**
 * #544: a real, pageable calendar month.
 *
 * It used to be a flat 28-day block anchored to the 1st of the current month
 * with no way to leave that month, so a household could not book ahead at
 * all — and the 29th through 31st of every long month were never offered.
 * Now: real month lengths, weekday-aligned, back bounded at [today]'s month
 * and forward at [horizonEnd]'s (see BookingCalendar.kt, whose web mirror is
 * lib/bookingWizardLogic.ts). A day outside the bookable window, or one
 * [closedDates] says is a company holiday, still renders — dimmed and inert —
 * so the grid reads as a calendar rather than growing holes.
 */
@Composable
private fun SimpleMonthPicker(
    selectedDates: List<LocalDate>,
    onToggle: (LocalDate) -> Unit,
    today: LocalDate,
    horizonEnd: LocalDate,
    closedDates: Map<String, String>,
) {
    val type = LocalKinfolkTypography.current
    var anchor by remember(today) { mutableStateOf(LocalDate(today.year, today.month, 1)) }
    val daysToShow = remember(anchor) { bookingMonthDays(anchor) }
    // dayOfWeek.isoDayNumber is 1=Mon..7=Sun; the grid starts on Sunday.
    val leadingBlanks = daysToShow.first().dayOfWeek.isoDayNumber % 7
    val cells: List<LocalDate?> = List(leadingBlanks) { null } + daysToShow

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MonthNavButton(
                label = "‹",
                contentDescription = "Previous month",
                enabled = canPageBack(anchor, today),
                onClick = { anchor = shiftMonth(anchor, -1) },
            )
            Text("${MONTH_NAMES[anchor.month.ordinal]} ${anchor.year}", style = type.heritageSection)
            MonthNavButton(
                label = "›",
                contentDescription = "Next month",
                enabled = canPageForward(anchor, horizonEnd),
                onClick = { anchor = shiftMonth(anchor, 1) },
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            WEEKDAY_HEADERS.forEach { w ->
                Box(modifier = Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                    Text(w, style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted), textAlign = TextAlign.Center)
                }
            }
        }
        cells.chunked(7).forEach { week ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                week.forEach { d ->
                    if (d == null) {
                        Spacer(Modifier.size(40.dp))
                        return@forEach
                    }
                    val sel = selectedDates.contains(d)
                    val closed = closedDates.containsKey(bookingDateKey(d))
                    val pickable = !closed && isBookableDay(d, today, horizonEnd)
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .background(
                                color = if (sel) KinfolkBrand.KinTeal else KinfolkBrand.GlassSurfaceDim,
                                shape = CircleShape,
                            )
                            .then(if (pickable) Modifier.clickable { onToggle(d) } else Modifier),
                        contentAlignment = Alignment.Center,
                    ) {
                        val color = when {
                            sel -> Color.White
                            pickable -> KinfolkBrand.Navy
                            else -> KinfolkBrand.NavyMuted
                        }
                        Text(
                            d.day.toString(),
                            style = type.sansMeta.copy(
                                color = color,
                                textDecoration = if (closed) TextDecoration.LineThrough else null,
                            ),
                        )
                    }
                }
            }
        }
    }
}

/** Small circular ‹ / › control for the month header. Inert (and dimmed) at a bound. */
@Composable
private fun MonthNavButton(
    label: String,
    contentDescription: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = Modifier
            .size(36.dp)
            .background(color = KinfolkBrand.GlassSurfaceDim, shape = CircleShape)
            .then(if (enabled) Modifier.clickable(onClickLabel = contentDescription) { onClick() } else Modifier)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = type.heritageSection.copy(color = if (enabled) KinfolkBrand.Navy else KinfolkBrand.NavyMuted),
            textAlign = TextAlign.Center,
        )
    }
}

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

// `buildVisits` and the local `parseHourMinute` moved to RecurringBooking.kt when
// #541/#543 made them slot-shaped: both patterns expand through the same two pure
// functions there, and the web mirror (lib/bookingWizardLogic.ts) matches them
// function for function.
