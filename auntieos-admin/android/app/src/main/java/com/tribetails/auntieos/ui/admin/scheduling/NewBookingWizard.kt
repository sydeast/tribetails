package com.tribetails.auntieos.ui.admin.scheduling

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.repository.NewBookingVisit
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.admin.ServiceOption
import com.tribetails.auntieos.ui.admin.serviceChipLabel
import com.tribetails.auntieos.ui.admin.serviceOptionsFromRates
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.LocalDate
import java.time.YearMonth

/**
 * D1: the Android five-step New-booking-request wizard.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CONTAINER
 * ---------------------------------------------------------------------------
 * The five steps, their order and everything each one collects are web's,
 * shipped in PR #157 (see `BookingWizard.kt`'s header). What is Android's is the
 * CONTAINER and the NAVIGATION, and only those.
 *
 * Web renders all five as panels beside a persistent vertical stepper rail on a
 * wide canvas. A phone has neither the width for a side rail nor the height to
 * show a step's fields and the rail and a footer at once, and this app's own
 * `Dialog(usePlatformDefaultWidth = false)` booking dialogs already overflow on
 * a small screen with far less content than step 3 carries.
 *
 * So: a FULL-SCREEN dialog, one step at a time. That is Material's own guidance
 * for a multi-step task entered from a screen on mobile, and it costs nothing in
 * expressiveness. Concretely:
 *
 *  - Full-screen `Dialog`, not the app's usual inset card dialog, so step 3's
 *    calendar plus per-day visit editor has real room instead of a scroll
 *    trap. Not a bottom sheet: this app has no `ModalBottomSheet` anywhere and a
 *    sheet that always covers the full screen is a full-screen dialog wearing a
 *    handle.
 *  - Not a nav destination either. `showNewRequestDialog` is already a
 *    `SchedulingState` flag owned by the one long-lived `EnhancedSchedulingViewModel`
 *    the whole NavHost shares; making the wizard a route would mean a second
 *    place that decides when it is open.
 *  - "STEP n OF 5" kicker over the step title, the header idiom the Android
 *    mocks use, instead of web's numbered-circle rail. A five-segment progress
 *    bar sits under it; a COMPLETED segment is tappable, so web's "jump back to
 *    edit" affordance survives, but a segment ahead of you is not, because a
 *    thumb lands on those by accident.
 *  - System back goes to the previous step and only closes from step 1. On web
 *    the browser back button leaves the whole dialog; on a phone that is how you
 *    lose twenty minutes of a sixty-visit recurrence.
 *  - One pinned footer: `Back` and a full-width primary that reads
 *    "Create N visit(s)" on the last step.
 *
 * NOTHING IS DROPPED OR MERGED. All five steps exist, in order, and every field
 * web collects is collected here, including the ones the old single-page dialog
 * could not express at all: kin on the booking, per-visit place, several visits
 * on one day, billing mode, and the two communication switches.
 *
 * ---------------------------------------------------------------------------
 * CLOSURES AND CONFLICTS
 * ---------------------------------------------------------------------------
 * A company-holiday day is drawn "Closed" and is not tappable, and step 3 will
 * not advance while one is planned, because PR #204's guard refuses those
 * server-side with no override. A Google-busy day is drawn "Busy", IS tappable,
 * and produces a warning the operator may knowingly submit past; if the server
 * then refuses it, the error offers "Create anyway", which resubmits with
 * `overrideBusyConflict = true`. See `BookingWizardAvailability.kt`.
 */
@Composable
fun NewBookingWizard(
    allKinfolk: List<Kinfolk>,
    kin: List<Kin>,
    kinLoading: Boolean,
    kinError: String?,
    serviceRates: Map<String, String>,
    availability: BookingAvailability,
    inFlight: Boolean,
    error: String?,
    busyOverridable: Boolean,
    onKinfolkSelected: (String) -> Unit,
    onDismiss: () -> Unit,
    onCreate: (BookingWizardSubmission) -> Unit,
) {
    val c = AuntieTheme.colors
    var state by remember { mutableStateOf(BookingWizardState()) }
    var step by remember { mutableStateOf(BookingWizardStep.CLIENT) }
    // The furthest step reached, so the progress rail can offer a jump back to a
    // step already satisfied without offering a jump forward past a hole.
    var furthest by remember { mutableStateOf(BookingWizardStep.CLIENT) }
    // Only shown after a failed Next, so a step does not open pre-scolded.
    var showBlocker by remember { mutableStateOf(false) }

    val nowMs = System.currentTimeMillis()
    val closedDayName: (LocalDate) -> String? = { availability.closedDayName(it) }
    val blocker = stepBlocker(state, step, nowMs, closedDayName)
    val visits = remember(state) { buildVisits(state) }
    val serviceOptions = remember(serviceRates) { serviceOptionsFromRates(serviceRates) }

    fun goTo(target: BookingWizardStep) {
        step = target
        showBlocker = false
        if (target.ordinal > furthest.ordinal) furthest = target
    }

    fun goBack() {
        val previous = step.previous
        if (previous == null) {
            if (!inFlight) onDismiss()
        } else {
            goTo(previous)
        }
    }

    fun submit(override: Boolean) {
        val hole = firstBlockedStep(state, System.currentTimeMillis(), closedDayName)
        if (hole != null) {
            // Never fire a request the server would refuse: land on the hole.
            step = hole
            showBlocker = true
            return
        }
        onCreate(bookingSubmission(state, override))
    }

    BackHandler(enabled = !inFlight) { goBack() }

    Dialog(
        onDismissRequest = { if (!inFlight) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(c.background)
                .statusBarsPadding()
                .imePadding(),
        ) {
            WizardHeader(
                step = step,
                onBack = { goBack() },
                onClose = { if (!inFlight) onDismiss() },
            )
            WizardProgressRail(
                current = step,
                furthest = furthest,
                onJump = { goTo(it) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            )
            Spacer(Modifier.height(14.dp))

            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 20.dp, end = 20.dp, bottom = 24.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                if (showBlocker && blocker != null) {
                    item("blocker") {
                        AuntieBanner(tone = AuntieBannerTone.Warning, title = "Not finished yet") {
                            Text(blocker, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        }
                    }
                }
                if (availability.unknown != null) {
                    item("availability-unknown") {
                        AuntieBanner(tone = AuntieBannerTone.Warning, title = "Availability unknown") {
                            Text(
                                "${availability.unknown} Pick your dates anyway. Nothing below is checked " +
                                    "against the schedule, so the server may still refuse a closed or busy day.",
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textPrimary,
                            )
                        }
                    }
                }

                when (step) {
                    BookingWizardStep.CLIENT -> clientStep(
                        state = state,
                        allKinfolk = allKinfolk,
                        kin = kin,
                        kinLoading = kinLoading,
                        kinError = kinError,
                        onState = { state = it },
                        onKinfolkSelected = onKinfolkSelected,
                    )
                    BookingWizardStep.SERVICE -> serviceStep(
                        state = state,
                        options = serviceOptions,
                        onState = { state = it },
                    )
                    BookingWizardStep.DATES -> datesStep(
                        state = state,
                        options = serviceOptions,
                        availability = availability,
                        visits = visits,
                        onState = { state = it },
                    )
                    BookingWizardStep.INVOICE -> invoiceStep()
                    BookingWizardStep.REVIEW -> reviewStep(
                        state = state,
                        visits = visits,
                        allKinfolk = allKinfolk,
                        kin = kin,
                        error = error,
                        busyOverridable = busyOverridable,
                        inFlight = inFlight,
                        onState = { state = it },
                        onJump = { goTo(it) },
                        onCreateAnyway = { submit(true) },
                    )
                }
            }

            WizardFooter(
                step = step,
                visitCount = visits.size,
                inFlight = inFlight,
                onBack = { goBack() },
                onNext = {
                    val next = step.next
                    if (blocker != null) {
                        showBlocker = true
                    } else if (next != null) {
                        goTo(next)
                    } else {
                        submit(false)
                    }
                },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

@Composable
private fun WizardHeader(
    step: BookingWizardStep,
    onBack: () -> Unit,
    onClose: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            // The footer already carries Back and Cancel. Up here there is only
            // ever Close, so step 1 does not offer the same escape twice under
            // two different words.
            if (step.previous != null) {
                AuntieTextBtn(onClick = onBack) { Text("‹ ${step.previous?.label}") }
            } else {
                Spacer(Modifier.width(1.dp))
            }
            AuntieTextBtn(onClick = onClose, contentColor = c.textDim) { Text("Close") }
        }
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
            Text(
                "STEP ${step.number} OF ${BookingWizardStep.entries.size}",
                style = AuntieTheme.typography.labelSmall.copy(letterSpacing = 1.6.sp),
                color = c.textDim,
            )
            Spacer(Modifier.height(4.dp))
            Text(step.label, style = AuntieTheme.typography.headlineSmall, color = c.textPrimary)
            Spacer(Modifier.height(2.dp))
            Text(step.subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

/**
 * Five segments, one per step. A segment for a step already reached is tappable
 * (web's "jump back to edit"); one ahead is not, so a thumb resting on the bar
 * cannot skip a hole.
 */
@Composable
private fun WizardProgressRail(
    current: BookingWizardStep,
    furthest: BookingWizardStep,
    onJump: (BookingWizardStep) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        BookingWizardStep.entries.forEach { entry ->
            val reached = entry.ordinal <= furthest.ordinal
            val color = when {
                entry == current -> c.kinfolkOrange
                reached -> c.kinfolkOrange.copy(alpha = 0.45f)
                else -> c.border
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(4.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(color)
                    .clickable(enabled = reached && entry != current) { onJump(entry) },
            )
        }
    }
}

@Composable
private fun WizardFooter(
    step: BookingWizardStep,
    visitCount: Int,
    inFlight: Boolean,
    onBack: () -> Unit,
    onNext: () -> Unit,
) {
    val c = AuntieTheme.colors
    val isLast = step.next == null
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.surface)
            .navigationBarsPadding()
            .padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GhostButton(
                label = if (step.previous == null) "Cancel" else "Back",
                onClick = onBack,
                enabled = !inFlight,
                modifier = Modifier.fillMaxWidth(0.36f),
            )
            PrimaryButton(
                label = when {
                    !isLast -> "Next"
                    visitCount > 0 -> "Create $visitCount visit(s)"
                    else -> "Create booking"
                },
                onClick = onNext,
                enabled = !inFlight,
                loading = inFlight,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Step 1: Select Kinfolk & Kin  ->  kinfolkId, kinIds
// ---------------------------------------------------------------------------

private fun LazyListScope.clientStep(
    state: BookingWizardState,
    allKinfolk: List<Kinfolk>,
    kin: List<Kin>,
    kinLoading: Boolean,
    kinError: String?,
    onState: (BookingWizardState) -> Unit,
    onKinfolkSelected: (String) -> Unit,
) {
    item("client-household") {
        val selected = allKinfolk.firstOrNull { it.id == state.kinfolkId }
        Column {
            AuntieFieldLabel("Household", required = true)
            Spacer(Modifier.height(6.dp))
            AuntieDropdownField(
                value = selected,
                options = allKinfolk,
                onSelect = {
                    onState(state.withKinfolk(it.id))
                    onKinfolkSelected(it.id)
                },
                displayText = { it.displayName },
                placeholder = "Select a household",
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    if (allKinfolk.isEmpty()) {
        item("client-empty") {
            HintText("No households loaded. The booking needs one, so check the Directory first.")
        }
    }
    item("client-kin-label") {
        AuntieFieldLabel("Kin on this booking", optionalNote = "optional")
    }
    when {
        state.kinfolkId.isBlank() -> item("client-kin-none") {
            HintText("Pick a household to see its kin.")
        }
        kinLoading -> item("client-kin-loading") { HintText("Reading the Kin roster…") }
        kinError != null -> item("client-kin-error") {
            AuntieBanner(tone = AuntieBannerTone.Warning, title = "Kin could not be read") {
                Text(
                    "$kinError The booking still covers the whole household.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
        }
        kin.isEmpty() -> item("client-kin-empty") {
            HintText("No Kin on this household yet. The booking covers the household.")
        }
        else -> item("client-kin-chips") {
            FlowChips(
                items = kin,
                label = { it.name.ifBlank { "Unnamed Kin" } },
                selected = { it.id in state.kinIds },
                onToggle = { onState(state.toggleKin(it.id)) },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Step 2: Choose Service  ->  seeds every visit's serviceName
// ---------------------------------------------------------------------------

private fun LazyListScope.serviceStep(
    state: BookingWizardState,
    options: List<ServiceOption>,
    onState: (BookingWizardState) -> Unit,
) {
    if (options.isEmpty()) {
        item("service-free-text") {
            Column {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "No KinCare types yet") {
                    Text(
                        "Add them in Settings, under KinCare types, and they show up here. " +
                            "Until then, type the service name.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textPrimary,
                    )
                }
                Spacer(Modifier.height(12.dp))
                BottomBorderField(
                    value = state.serviceName,
                    onValueChange = { onState(state.withServiceName(it)) },
                    label = "Service",
                    placeholder = "e.g. 30 minute drop-in",
                    required = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        return
    }
    item("service-picker") {
        // A search box would earn its place on web's catalog of dozens; the
        // operator's own serviceRates map is a handful of rows, so the dropdown
        // this app already uses everywhere is fewer taps than a filter field.
        Column {
            AuntieFieldLabel("KinCare type", required = true)
            Spacer(Modifier.height(6.dp))
            AuntieDropdownField(
                value = options.firstOrNull { it.name == state.serviceName },
                options = options,
                onSelect = { onState(state.withServiceName(it.name)) },
                displayText = ::serviceChipLabel,
                placeholder = "Select a service",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            HintText(
                "Sourced from Settings, under KinCare types. The price shown is the catalog's; " +
                    "the server prices every visit from it at invoice time.",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Step 3: Schedule Dates  ->  pattern, weeklyDays, visits[]
// ---------------------------------------------------------------------------

private fun LazyListScope.datesStep(
    state: BookingWizardState,
    options: List<ServiceOption>,
    availability: BookingAvailability,
    visits: List<NewBookingVisit>,
    onState: (BookingWizardState) -> Unit,
) {
    item("dates-mode") {
        SegmentedPicker(
            options = BookingWizardMode.entries,
            selected = state.mode,
            onSelect = { onState(state.copy(mode = it)) },
            label = { if (it == BookingWizardMode.DATES) "Individual dates" else "Repeating" },
            modifier = Modifier.fillMaxWidth(),
        )
    }

    item("dates-template") {
        Column {
            AuntieFieldLabel("Daily visit schedule")
            Spacer(Modifier.height(4.dp))
            HintText(
                if (state.mode == BookingWizardMode.WEEKLY) {
                    "Every visit here repeats on every day the pattern hits."
                } else {
                    "Create several visits in one day. Changes apply only to dates you pick after this."
                },
            )
            Spacer(Modifier.height(10.dp))
            state.template.forEachIndexed { index, slot ->
                VisitSlotEditor(
                    slot = slot,
                    index = index,
                    options = options,
                    canRemove = state.template.size > 1,
                    onEdit = { edit -> onState(state.updateTemplateSlot(slot.id, edit)) },
                    onRemove = { onState(state.removeTemplateSlot(slot.id)) },
                )
                Spacer(Modifier.height(10.dp))
            }
            GhostButton(
                label = "Add another visit",
                onClick = { onState(state.addTemplateSlot()) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }

    if (state.mode == BookingWizardMode.WEEKLY) {
        item("dates-weekly") {
            Column {
                AuntieFieldLabel("Start on", required = true)
                Spacer(Modifier.height(6.dp))
                MonthCalendar(
                    availability = availability,
                    isSelected = { it == state.startDate },
                    onPick = { onState(state.copy(startDate = it)) },
                    anchor = state.startDate,
                )
                Spacer(Modifier.height(14.dp))
                AuntieFieldLabel("Repeat on", required = true)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WEEKDAY_LETTERS.forEachIndexed { day, letter ->
                        SelectPill(
                            label = letter,
                            selected = day in state.weeklyDays,
                            modifier = Modifier.weight(1f),
                            onClick = { onState(state.toggleWeekday(day)) },
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
                AuntieFieldLabel("For how long")
                Spacer(Modifier.height(6.dp))
                AuntieDropdownField(
                    value = state.weeks,
                    options = (1..12).toList(),
                    onSelect = { onState(state.copy(weeks = it)) },
                    displayText = { "$it week${if (it == 1) "" else "s"}" },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    } else {
        item("dates-calendar") {
            Column {
                AuntieFieldLabel("Dates", required = true, optionalNote = "non-consecutive is fine")
                Spacer(Modifier.height(6.dp))
                MonthCalendar(
                    availability = availability,
                    isSelected = { date -> state.plans.any { it.date == date } },
                    onPick = { onState(state.toggleDate(it)) },
                    anchor = state.plans.firstOrNull()?.date ?: LocalDate.now(),
                )
            }
        }
        if (state.plans.isNotEmpty()) {
            item("dates-selected-header") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    AuntieFieldLabel("Selected dates")
                    AuntieTextBtn(onClick = { onState(state.clearDates()) }) { Text("Clear all") }
                }
            }
            state.plans.forEach { plan ->
                item("day-${plan.date}") {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    formatDayAndDate(plan.date),
                                    style = AuntieTheme.typography.titleSmall,
                                    color = AuntieTheme.colors.textPrimary,
                                )
                                AuntieTextBtn(onClick = { onState(state.toggleDate(plan.date)) }) {
                                    Text("Remove day")
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            plan.visits.forEachIndexed { index, slot ->
                                VisitSlotEditor(
                                    slot = slot,
                                    index = index,
                                    options = options,
                                    canRemove = plan.visits.size > 1,
                                    onEdit = { edit ->
                                        onState(state.updateDayVisit(plan.date, slot.id, edit))
                                    },
                                    onRemove = { onState(state.removeDayVisit(plan.date, slot.id)) },
                                )
                                Spacer(Modifier.height(10.dp))
                            }
                            GhostButton(
                                label = "Add another visit on this day",
                                onClick = { onState(state.addDayVisit(plan.date)) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }
        }
    }

    item("dates-count") {
        HintText(
            if (visits.isEmpty()) "No visits planned yet."
            else "${visits.size} visit(s) will be requested.",
        )
    }

    val warnings = bookingSelectionWarnings(visits, availability)
    if (warnings.isNotEmpty()) {
        item("dates-warnings") {
            AuntieBanner(tone = AuntieBannerTone.Warning, title = "Check these visits") {
                Column {
                    warnings.forEach {
                        Text(it, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "You can still send the request. A busy block is refused by the server unless " +
                            "you choose Create anyway on the last step.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Step 4: Invoice Options  ->  billing.mode
// ---------------------------------------------------------------------------

private fun LazyListScope.invoiceStep() {
    item("invoice") {
        AuntieCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    "New invoice",
                    style = AuntieTheme.typography.titleSmall,
                    color = AuntieTheme.colors.textPrimary,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "A separate invoice is created for this booking once the visits are done.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }
    item("invoice-note") {
        // Honest about why there is one card and no choice: the callable's zod
        // enum is `z.enum(['new-invoice'])`, so a second card here would be a
        // control the server rejects. The step is still real: what it picks is
        // written to the envelope's `billing.mode`, which the invoice path reads.
        HintText("New invoice is the only billing mode the booking request accepts today.")
    }
}

// ---------------------------------------------------------------------------
// Step 5: Review & Confirm  ->  communication.*, notes, submit
// ---------------------------------------------------------------------------

private fun LazyListScope.reviewStep(
    state: BookingWizardState,
    visits: List<NewBookingVisit>,
    allKinfolk: List<Kinfolk>,
    kin: List<Kin>,
    error: String?,
    busyOverridable: Boolean,
    inFlight: Boolean,
    onState: (BookingWizardState) -> Unit,
    onJump: (BookingWizardStep) -> Unit,
    onCreateAnyway: () -> Unit,
) {
    if (error != null) {
        item("review-error") {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Could not create the request") {
                Column {
                    Text(error, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                    if (busyOverridable) {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "That clash is an imported Google Calendar busy block. You can book over one.",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                        Spacer(Modifier.height(8.dp))
                        GhostButton(
                            label = "Create anyway",
                            onClick = onCreateAnyway,
                            enabled = !inFlight,
                        )
                    }
                }
            }
        }
    }

    item("review-summary") {
        val household = allKinfolk.firstOrNull { it.id == state.kinfolkId }?.displayName ?: state.kinfolkId
        val kinNames = kin.filter { it.id in state.kinIds }.map { it.name.ifBlank { "Unnamed Kin" } }
        // Read off the BUILT visits, never off state.serviceName: jumping back to
        // step 2 rewrites the template but not days already snapshotted, and a
        // summary that reported the header field would name a service the
        // submitted visits do not carry.
        val services = visits.map { it.serviceName }.distinct()

        AuntieCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                ReviewRow("Household", household) { onJump(BookingWizardStep.CLIENT) }
                ReviewRow(
                    "Kin",
                    if (kinNames.isEmpty()) "Whole household" else kinNames.joinToString(", "),
                ) { onJump(BookingWizardStep.CLIENT) }
                ReviewRow(
                    "Service",
                    if (services.isEmpty()) "None" else services.joinToString(", "),
                ) { onJump(BookingWizardStep.SERVICE) }
                ReviewRow(
                    "Schedule",
                    "${visits.size} visit(s) across ${plannedDates(state).size} day(s)",
                ) { onJump(BookingWizardStep.DATES) }
                ReviewRow("Billing", "New invoice") { onJump(BookingWizardStep.INVOICE) }
            }
        }
    }

    item("review-visits") {
        AuntieCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                AuntieFieldLabel("Visits")
                Spacer(Modifier.height(8.dp))
                if (visits.isEmpty()) {
                    HintText("No visits planned.")
                } else {
                    visits.take(REVIEW_VISIT_PREVIEW).forEach { visit ->
                        val at = java.time.Instant.ofEpochMilli(visit.startTimeMs)
                            .atZone(java.time.ZoneId.systemDefault())
                        Text(
                            buildString {
                                append(formatDayAndDate(at.toLocalDate()))
                                append(" · ")
                                append(formatClock(at.hour, at.minute))
                                append(" · ")
                                append(visit.serviceName)
                                visit.location?.let { append(" · $it") }
                            },
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary,
                        )
                    }
                    if (visits.size > REVIEW_VISIT_PREVIEW) {
                        HintText("and ${visits.size - REVIEW_VISIT_PREVIEW} more.")
                    }
                }
            }
        }
    }

    item("review-communication") {
        Column {
            AuntieFieldLabel("Communication")
            Spacer(Modifier.height(8.dp))
            CheckRow(
                checked = state.emailConfirmation,
                label = "Email confirmation",
                hint = "Send the household a confirmation email when this request is approved.",
                onCheckedChange = { onState(state.copy(emailConfirmation = it)) },
            )
            Spacer(Modifier.height(10.dp))
            CheckRow(
                checked = state.timeVisibility,
                label = "Exact times",
                hint = "Off shows the household a time window instead of the exact start time.",
                onCheckedChange = { onState(state.copy(timeVisibility = it)) },
            )
        }
    }

    item("review-notes") {
        Column {
            AuntieFieldLabel("Private notes", optionalNote = "optional")
            Spacer(Modifier.height(6.dp))
            BottomBorderField(
                value = state.notes,
                onValueChange = { if (it.length <= NOTES_MAX) onState(state.copy(notes = it)) },
                label = "Notes",
                placeholder = "Anything the team should know about this booking",
                singleLine = false,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            HintText("${state.notes.length} / $NOTES_MAX")
        }
    }
}

/** The callable's `notes: z.string().max(1000)`. */
private const val NOTES_MAX = 1000

/** How many visits Review lists before collapsing the rest into a count. */
private const val REVIEW_VISIT_PREVIEW = 8

private val WEEKDAY_LETTERS = listOf("S", "M", "T", "W", "T", "F", "S")

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

@Composable
private fun HintText(text: String) {
    Text(text, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
}

@Composable
private fun ReviewRow(label: String, value: String, onEdit: () -> Unit) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = AuntieTheme.typography.labelSmall, color = c.textDim)
            Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        }
        AuntieTextBtn(onClick = onEdit) {
            Text("Edit", textDecoration = TextDecoration.Underline)
        }
    }
}

@Composable
private fun CheckRow(
    checked: Boolean,
    label: String,
    hint: String,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(verticalAlignment = Alignment.Top) {
        AuntieCheckbox(checked = checked, onCheckedChange = onCheckedChange)
        Spacer(Modifier.width(10.dp))
        Column {
            Text(label, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
            HintText(hint)
        }
    }
}

/** A selection pill. No M3 Chip/Checkbox: those are disallowed visual components. */
@Composable
private fun SelectPill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) c.surface2 else c.surface)
            .border(1.dp, if (selected) c.kinfolkOrange else c.border, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = AuntieTheme.typography.bodySmall,
            color = if (selected) c.textPrimary else c.textDim,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun <T> FlowChips(
    items: List<T>,
    label: (T) -> String,
    selected: (T) -> Boolean,
    onToggle: (T) -> Unit,
) {
    // Hand-rolled rows of three rather than FlowRow: the experimental foundation
    // layout is not in use anywhere else in this app, and a kin roster is short.
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { item ->
                    SelectPill(
                        label = label(item),
                        selected = selected(item),
                        onClick = { onToggle(item) },
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** One visit's time, service and place. The unit that made multiple-per-day possible. */
@Composable
private fun VisitSlotEditor(
    slot: VisitSlot,
    index: Int,
    options: List<ServiceOption>,
    canRemove: Boolean,
    onEdit: ((VisitSlot) -> VisitSlot) -> Unit,
    onRemove: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, c.border, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "VISIT ${index + 1}",
                style = AuntieTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
                color = c.textDim,
            )
            if (canRemove) {
                AuntieTextBtn(onClick = onRemove, contentColor = c.textDim) { Text("Remove") }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuntieDropdownField(
                value = slot.hour,
                options = (0..23).toList(),
                onSelect = { h -> onEdit { it.copy(hour = h) } },
                displayText = { formatClock(it, 0).replace(":00", "") },
                label = "START",
                modifier = Modifier.fillMaxWidth(0.5f),
            )
            AuntieDropdownField(
                value = slot.minute,
                options = MINUTE_STEPS,
                onSelect = { m -> onEdit { it.copy(minute = m) } },
                displayText = { ":%02d".format(it) },
                label = "MINUTE",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(8.dp))
        if (options.isEmpty()) {
            BottomBorderField(
                value = slot.serviceName,
                onValueChange = { name -> onEdit { it.copy(serviceName = name) } },
                label = "Service",
                required = true,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            AuntieDropdownField(
                value = options.firstOrNull { it.name == slot.serviceName },
                options = options,
                onSelect = { option -> onEdit { it.copy(serviceName = option.name, serviceId = null) } },
                displayText = ::serviceChipLabel,
                label = "SERVICE",
                placeholder = "Select a service",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(8.dp))
        BottomBorderField(
            value = slot.location,
            // The callable caps `location` at 120 characters, so the field does too
            // rather than letting the operator type past a limit and be refused.
            onValueChange = { place -> if (place.length <= LOCATION_MAX) onEdit { it.copy(location = place) } },
            label = "Place (optional)",
            placeholder = "Where this visit happens",
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** The callable's `location: z.string().trim().min(1).max(120)`. */
private const val LOCATION_MAX = 120

private val MINUTE_STEPS = listOf(0, 15, 30, 45)

/**
 * A month grid with prev/next. A closed day is drawn dim with a "Closed" badge
 * and refuses the tap; a past day likewise. A busy day is drawn with a "Busy"
 * dot and IS tappable, because a busy block is an override-able warning and the
 * operator is the business.
 */
@Composable
private fun MonthCalendar(
    availability: BookingAvailability,
    isSelected: (LocalDate) -> Boolean,
    onPick: (LocalDate) -> Unit,
    anchor: LocalDate,
) {
    val c = AuntieTheme.colors
    // Not keyed on [anchor]: it moves as dates are picked, and a grid that jumped
    // back to another month mid-selection would lose the operator's place.
    var month by remember { mutableStateOf(YearMonth.from(anchor)) }
    val today = LocalDate.now()

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            AuntieTextBtn(onClick = { month = month.minusMonths(1) }) { Text("‹ Prev") }
            Text(
                "${month.month.name.lowercase().replaceFirstChar { it.uppercase() }} ${month.year}",
                style = AuntieTheme.typography.titleSmall,
                color = c.textPrimary,
            )
            AuntieTextBtn(onClick = { month = month.plusMonths(1) }) { Text("Next ›") }
        }
        Spacer(Modifier.height(6.dp))
        Row(modifier = Modifier.fillMaxWidth()) {
            WEEKDAY_LETTERS.forEach { letter ->
                Text(
                    letter,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
            }
        }
        Spacer(Modifier.height(4.dp))

        val firstOffset = month.atDay(1).dayOfWeek.value % 7
        val length = month.lengthOfMonth()
        var day = 1
        val weeks = ((firstOffset + length + 6) / 7)
        repeat(weeks) { week ->
            Row(modifier = Modifier.fillMaxWidth()) {
                repeat(7) { dow ->
                    if ((week == 0 && dow < firstOffset) || day > length) {
                        Box(modifier = Modifier.weight(1f).aspectRatio(1f))
                    } else {
                        val date = month.atDay(day)
                        DayCell(
                            info = availability.dayAvailability(date, today),
                            selected = isSelected(date),
                            onPick = onPick,
                            modifier = Modifier.weight(1f),
                        )
                        day++
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        HintText("Closed days are refused by the server and cannot be picked. Busy days can.")
    }
}

@Composable
private fun DayCell(
    info: BookingDayAvailability,
    selected: Boolean,
    onPick: (LocalDate) -> Unit,
    modifier: Modifier,
) {
    val c = AuntieTheme.colors
    val background = when {
        selected -> c.kinfolkOrange
        info.badge == BookingDayBadge.CLOSED -> c.error.copy(alpha = 0.12f)
        info.badge == BookingDayBadge.BLOCKED -> c.warning.copy(alpha = 0.14f)
        else -> c.surface
    }
    val textColor = when {
        selected -> c.background
        !info.pickable -> c.textFaint
        else -> c.textPrimary
    }
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .padding(2.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(background)
            .clickable(enabled = info.pickable) { onPick(info.date) },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            info.date.dayOfMonth.toString(),
            style = AuntieTheme.typography.bodyMedium,
            color = textColor,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
        )
        when (info.badge) {
            BookingDayBadge.CLOSED -> Text(
                "Closed",
                style = AuntieTheme.typography.labelSmall.copy(fontSize = 8.sp),
                color = c.error,
            )
            BookingDayBadge.BLOCKED -> Box(
                modifier = Modifier
                    .padding(top = 2.dp)
                    .size(4.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(c.warning),
            )
            else -> Unit
        }
    }
}
