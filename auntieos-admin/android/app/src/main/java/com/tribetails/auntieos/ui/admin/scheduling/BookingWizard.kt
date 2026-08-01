package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsBilling
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsCommunication
import com.tribetails.auntieos.data.repository.NewBookingVisit
import java.time.LocalDate

/**
 * D1: the pure state machine behind the Android five-step New-booking-request
 * wizard. Kept out of the composable so every gate, every payload field and
 * every recurrence expansion is unit-testable without Compose or Firebase.
 *
 * THIS IS A PORT OF THE WEB WIZARD'S `auntieos-admin/src/lib/bookingWizard.ts`,
 * shipped in PR #157, not a parallel design. Same five steps in the same order,
 * same fields collected at each step, same blocker copy, same 60-visit ceiling,
 * same "template snapshot" semantics for per-day visits. Android differs in how
 * a step is CONTAINED and navigated (see `NewBookingWizard.kt`), never in what
 * the operator can express or which fields reach the server.
 *
 * TWO DELIBERATE DIVERGENCES, both additive and both called out in the PR body:
 *
 *  1. [plannedDates] expands the WEEKLY pattern to every concrete occurrence,
 *     where web's `plannedDayIsos` returns only the start date. That is why the
 *     closed-date gate below can see a holiday in week 3 of a recurrence; on web
 *     the same booking is only refused by the server, after the whole batch is
 *     lost.
 *  2. [stepBlocker] refuses a company-holiday date outright at the Dates step.
 *     `guardCompanyHolidayConflict` refuses it server-side with no override
 *     (PR #204), so offering the date at all would be offering a submit that
 *     cannot succeed.
 *
 * All date math is LOCAL and delegates to [NewBookingMath]; weekdays use the
 * JS/backend convention (0 = Sunday) so [BookingWizardState.weeklyDays] passes
 * to the callable unchanged.
 */

/** The callable's `visits` array cap (`z.array(VisitArgs).min(1).max(60)`). */
const val BOOKING_WIZARD_MAX_VISITS = 60

/** The only `billing.mode` the callable's zod enum accepts today. */
const val BILLING_MODE_NEW_INVOICE = "new-invoice"

/**
 * The five steps, in web's order, with web's rail labels verbatim. Step 2's web
 * panel heading says "Select a Service" while its rail says "Choose Service";
 * Android shows one title per step, so it uses the rail label for both.
 */
enum class BookingWizardStep(val label: String, val subtitle: String) {
    CLIENT("Select Kinfolk & Kin", "Whose household is this booking for."),
    SERVICE("Choose Service", "Choose the service this booking is for."),
    DATES("Schedule Dates", "When the visits happen, and what happens on each."),
    INVOICE("Invoice Options", "How this booking should be billed once the visits are done."),
    REVIEW("Review & Confirm", "Check the details below before confirming."),
    ;

    /** 1-based, for the "STEP n OF 5" kicker. */
    val number: Int get() = ordinal + 1

    val previous: BookingWizardStep? get() = entries.getOrNull(ordinal - 1)
    val next: BookingWizardStep? get() = entries.getOrNull(ordinal + 1)
}

/** Individual dates, or a weekly pattern the client expands to concrete visits. */
enum class BookingWizardMode { DATES, WEEKLY }

/**
 * One visit within a day: its own wall-clock time, service and place. Several of
 * these on one day is the multiple-visits-per-day case the single-page dialog
 * could not express at all (it had one shared time for the whole request).
 */
data class VisitSlot(
    val id: Long,
    val hour: Int = 9,
    val minute: Int = 0,
    val serviceName: String = "",
    /**
     * Always null on the wire. A `serviceRates` key is a NAME, not a
     * `base_services` document id, so sending it would make the server's
     * `resolveService` log a resolve-miss on every visit. Web's wizard does the
     * same (`applyServiceToTemplate` forces `serviceId: null`).
     */
    val serviceId: String? = null,
    val location: String = "",
) {
    /** "09:00", the operator's local wall clock. */
    val timeLabel: String get() = "%02d:%02d".format(hour, minute)
}

/** One picked calendar day and the visits planned on it. */
data class DayPlan(val date: LocalDate, val visits: List<VisitSlot>)

/**
 * Everything the five steps collect. Every field maps to exactly one place in
 * the `createMultiDateBookingRequest` payload; nothing here is decorative.
 */
data class BookingWizardState(
    /** Step 1 -> `kinfolkId`. */
    val kinfolkId: String = "",
    /** Step 1 -> `kinIds` (omitted from the payload when empty, as on web). */
    val kinIds: List<String> = emptyList(),
    /** Step 2 -> seeds every visit's `serviceName`. */
    val serviceName: String = "",
    /** Step 3 -> `pattern`. */
    val mode: BookingWizardMode = BookingWizardMode.DATES,
    /** Step 3: the per-day plan a newly picked date is snapshotted from. */
    val template: List<VisitSlot> = listOf(VisitSlot(id = 1L)),
    /** Step 3, individual mode -> `visits[]`. */
    val plans: List<DayPlan> = emptyList(),
    /** Step 3, weekly mode: the day the recurrence walks forward from. */
    val startDate: LocalDate = LocalDate.now().plusDays(1),
    /** Step 3, weekly mode -> `weeklyDays` (0 = Sunday). */
    val weeklyDays: Set<Int> = emptySet(),
    /** Step 3, weekly mode: how many weeks the recurrence covers. */
    val weeks: Int = 4,
    /** Step 4 -> `billing.mode`. */
    val billingMode: String = BILLING_MODE_NEW_INVOICE,
    /** Step 5 -> `communication.emailConfirmation`. */
    val emailConfirmation: Boolean = false,
    /** Step 5 -> `communication.timeVisibility`. */
    val timeVisibility: Boolean = false,
    /** Step 5 -> `notes` (omitted from the payload when blank, as on web). */
    val notes: String = "",
    /** Monotonic source of [VisitSlot.id]s, so Compose keys stay stable. */
    val nextSlotId: Long = 2L,
)

// ---------------------------------------------------------------------------
// Step 1: household + kin
// ---------------------------------------------------------------------------

/**
 * Changing the household clears [BookingWizardState.kinIds]: kin belong to one
 * household, so carrying a previous household's kin forward would submit ids
 * that are not on this booking's family. Web does the same.
 */
fun BookingWizardState.withKinfolk(id: String): BookingWizardState =
    if (id == kinfolkId) this else copy(kinfolkId = id, kinIds = emptyList())

fun BookingWizardState.toggleKin(kinId: String): BookingWizardState =
    copy(kinIds = if (kinId in kinIds) kinIds - kinId else kinIds + kinId)

// ---------------------------------------------------------------------------
// Step 2: service
// ---------------------------------------------------------------------------

/**
 * Picking a service rewrites every TEMPLATE slot, exactly as web's
 * `applyServiceToTemplate` does. Already-snapshotted [DayPlan]s keep whatever
 * they were given, which is the documented "changes apply only to dates you pick
 * after this" behavior; the Review step reads the built visits rather than this
 * field, so a back-edit can never make Review disagree with what is submitted.
 */
fun BookingWizardState.withServiceName(name: String): BookingWizardState =
    copy(
        serviceName = name,
        template = template.map { it.copy(serviceName = name, serviceId = null) },
    )

// ---------------------------------------------------------------------------
// Step 3: dates and per-day visits
// ---------------------------------------------------------------------------

private fun BookingWizardState.snapshotTemplate(): Pair<List<VisitSlot>, Long> {
    var id = nextSlotId
    val snapshot = template.map { it.copy(id = id++) }
    return snapshot to id
}

/** Adds the day (snapshotting the template onto it) or removes it if already picked. */
fun BookingWizardState.toggleDate(date: LocalDate): BookingWizardState {
    if (plans.any { it.date == date }) {
        return copy(plans = plans.filterNot { it.date == date })
    }
    val (snapshot, nextId) = snapshotTemplate()
    return copy(
        plans = (plans + DayPlan(date, snapshot)).sortedBy { it.date },
        nextSlotId = nextId,
    )
}

fun BookingWizardState.clearDates(): BookingWizardState = copy(plans = emptyList())

/** Seeds the new row from the last one, so "another visit at 2pm" is two taps. */
fun BookingWizardState.addTemplateSlot(): BookingWizardState =
    copy(
        template = template + (template.lastOrNull() ?: VisitSlot(id = nextSlotId)).copy(id = nextSlotId),
        nextSlotId = nextSlotId + 1,
    )

/** The last row on the template cannot be removed: a day with no visits is not a plan. */
fun BookingWizardState.removeTemplateSlot(id: Long): BookingWizardState =
    if (template.size <= 1) this else copy(template = template.filterNot { it.id == id })

fun BookingWizardState.updateTemplateSlot(id: Long, edit: (VisitSlot) -> VisitSlot): BookingWizardState =
    copy(template = template.map { if (it.id == id) edit(it) else it })

fun BookingWizardState.addDayVisit(date: LocalDate): BookingWizardState {
    var nextId = nextSlotId
    val plans = plans.map { plan ->
        if (plan.date != date) plan else {
            val seed = (plan.visits.lastOrNull() ?: VisitSlot(id = nextId)).copy(id = nextId)
            nextId += 1
            plan.copy(visits = plan.visits + seed)
        }
    }
    return copy(plans = plans, nextSlotId = nextId)
}

/** The last visit on a day cannot be removed; unpick the day instead. */
fun BookingWizardState.removeDayVisit(date: LocalDate, id: Long): BookingWizardState =
    copy(
        plans = plans.map { plan ->
            if (plan.date != date || plan.visits.size <= 1) plan
            else plan.copy(visits = plan.visits.filterNot { it.id == id })
        },
    )

fun BookingWizardState.updateDayVisit(
    date: LocalDate,
    id: Long,
    edit: (VisitSlot) -> VisitSlot,
): BookingWizardState =
    copy(
        plans = plans.map { plan ->
            if (plan.date != date) plan
            else plan.copy(visits = plan.visits.map { if (it.id == id) edit(it) else it })
        },
    )

fun BookingWizardState.toggleWeekday(jsWeekday: Int): BookingWizardState =
    copy(weeklyDays = if (jsWeekday in weeklyDays) weeklyDays - jsWeekday else weeklyDays + jsWeekday)

// ---------------------------------------------------------------------------
// Derived: the concrete calendar days and the concrete visits
// ---------------------------------------------------------------------------

/**
 * Every calendar day this request will land on, weekly recurrences EXPANDED.
 *
 * Web's `plannedDayIsos` returns `[startDateIso]` in weekly mode, so its
 * calendar warnings and closure reasoning never see occurrences 2..n and a
 * four-week Monday recurrence whose third Monday is a company holiday fails only
 * at submit, losing the whole batch. This expands, so [stepBlocker] can refuse it
 * while the operator is still on the Dates step.
 */
fun plannedDates(state: BookingWizardState): List<LocalDate> = when (state.mode) {
    BookingWizardMode.DATES -> state.plans.map { it.date }.sorted()
    BookingWizardMode.WEEKLY -> {
        if (state.weeklyDays.isEmpty() || state.weeks < 1) {
            emptyList()
        } else {
            (0 until state.weeks * 7)
                .map { state.startDate.plusDays(it.toLong()) }
                .filter { NewBookingMath.jsWeekday(it) in state.weeklyDays }
        }
    }
}

private fun VisitSlot.toVisit(startTimeMs: Long) = NewBookingVisit(
    startTimeMs = startTimeMs,
    serviceName = serviceName.trim(),
    // No end-time control on either surface: the callable takes `endTimeMs`
    // nullable and the service's own duration governs. Sending a guessed end
    // would be inventing data the operator never entered.
    endTimeMs = null,
    serviceId = serviceId?.takeIf { it.isNotBlank() },
    // Blank means "no place given", which is a null on the wire, not "".
    // The callable's `location` is `.trim().min(1)`, so "" would be rejected.
    location = location.trim().takeIf { it.isNotEmpty() },
)

/**
 * The concrete `visits[]` this request submits, ascending. In weekly mode EVERY
 * template slot repeats on EVERY occurrence, so two template visits across three
 * weekdays for four weeks is 24 concrete visits; the callable stores those
 * concrete visits and treats `pattern`/`weeklyDays` as envelope metadata.
 */
fun buildVisits(state: BookingWizardState): List<NewBookingVisit> {
    val out = mutableListOf<NewBookingVisit>()
    when (state.mode) {
        BookingWizardMode.WEEKLY -> state.template.forEach { slot ->
            NewBookingMath
                .expandWeekly(state.startDate, slot.hour, slot.minute, state.weeklyDays, state.weeks)
                .forEach { ms -> out += slot.toVisit(ms) }
        }
        BookingWizardMode.DATES -> state.plans.forEach { plan ->
            plan.visits.forEach { slot ->
                out += slot.toVisit(NewBookingMath.localMs(plan.date, slot.hour, slot.minute))
            }
        }
    }
    // Sorted by time, then name, so two visits at the same minute have a stable
    // order rather than one that depends on map iteration.
    return out.sortedWith(compareBy({ it.startTimeMs }, { it.serviceName }))
}

/** `pattern` as the callable's zod enum spells it. */
fun bookingPattern(state: BookingWizardState): String =
    if (state.mode == BookingWizardMode.WEEKLY) "weekly" else "individual"

/** `weeklyDays`, ascending. Null in individual mode, where the field is omitted. */
fun bookingWeeklyDays(state: BookingWizardState): List<Int>? =
    if (state.mode == BookingWizardMode.WEEKLY) state.weeklyDays.sorted() else null

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

private fun shortDate(date: LocalDate): String =
    "${date.month.name.lowercase().replaceFirstChar { it.uppercase() }.take(3)} ${date.dayOfMonth}"

/**
 * The reason [step] cannot be left yet, or null when it is satisfied. Copy is
 * web's verbatim wherever web has a gate; the closed-date gate is Android-only
 * and its copy is new.
 *
 * [closedDayName] answers "is this day a company holiday, and what is it called",
 * so this stays pure: the Firestore read lives in `BookingWizardAvailability.kt`.
 */
fun stepBlocker(
    state: BookingWizardState,
    step: BookingWizardStep,
    nowMs: Long,
    closedDayName: (LocalDate) -> String? = { null },
): String? = when (step) {
    BookingWizardStep.CLIENT ->
        if (state.kinfolkId.isBlank()) "Pick a household first." else null

    BookingWizardStep.SERVICE ->
        if (state.serviceName.isBlank()) "Pick a service first." else null

    BookingWizardStep.DATES -> datesBlocker(state, nowMs, closedDayName)

    // No gate: the one billing mode is preselected, and Review's own controls
    // are all optional. Both match web, which returns null for both steps.
    BookingWizardStep.INVOICE, BookingWizardStep.REVIEW -> null
}

private fun datesBlocker(
    state: BookingWizardState,
    nowMs: Long,
    closedDayName: (LocalDate) -> String?,
): String? {
    val visits = buildVisits(state)
    if (visits.isEmpty()) {
        return if (state.mode == BookingWizardMode.WEEKLY) {
            "Pick a start date and at least one weekday."
        } else {
            "Pick at least one date."
        }
    }
    if (visits.any { it.serviceName.isBlank() }) return "Every visit needs a service."
    if (!NewBookingMath.allInFuture(visits.map { it.startTimeMs }, nowMs)) {
        return "Every visit has to be in the future."
    }
    if (visits.size > BOOKING_WIZARD_MAX_VISITS) {
        return "That is ${visits.size} visits. The most a single request can carry is " +
            "$BOOKING_WIZARD_MAX_VISITS, so shorten the recurrence or split the booking."
    }
    // A closed day is refused server-side with no override (PR #204), so it is a
    // hard gate here rather than a warning the operator can submit past.
    plannedDates(state).forEach { date ->
        val name = closedDayName(date)
        if (name != null) {
            return "${shortDate(date)} is closed for $name. The business will refuse that date, " +
                "so pick another."
        }
    }
    return null
}

/**
 * The earliest step still holding a hole, checked in order. Submit re-runs this
 * and jumps back rather than firing a request the server would refuse.
 */
fun firstBlockedStep(
    state: BookingWizardState,
    nowMs: Long,
    closedDayName: (LocalDate) -> String? = { null },
): BookingWizardStep? =
    BookingWizardStep.entries.firstOrNull { stepBlocker(state, it, nowMs, closedDayName) != null }

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * Exactly what the wizard hands the ViewModel, one field per callable argument.
 * A data class rather than eight lambda parameters so a test can assert the
 * whole payload, and so adding a field to the callable is a compile error here
 * rather than a silently dropped value.
 */
data class BookingWizardSubmission(
    val kinfolkId: String,
    val kinIds: List<String>,
    val visits: List<NewBookingVisit>,
    val notes: String?,
    val pattern: String,
    val weeklyDays: List<Int>?,
    val billing: CreateMultiDateBookingRequestArgsBilling,
    val communication: CreateMultiDateBookingRequestArgsCommunication,
    val overrideBusyConflict: Boolean,
)

/**
 * Builds the submission. [overrideBusyConflict] is true only on the operator's
 * explicit "Create anyway" after a busy refusal; nothing sets it on a first try.
 *
 * `notes` is nulled when blank and `kinIds` left empty rather than sent as an
 * empty array, mirroring web's conditional spreads: the callable treats an
 * omitted key and a blank value identically, so sending the blank would just be
 * noise on the wire.
 */
fun bookingSubmission(
    state: BookingWizardState,
    overrideBusyConflict: Boolean = false,
): BookingWizardSubmission = BookingWizardSubmission(
    kinfolkId = state.kinfolkId,
    kinIds = state.kinIds,
    visits = buildVisits(state),
    notes = state.notes.trim().takeIf { it.isNotEmpty() },
    pattern = bookingPattern(state),
    weeklyDays = bookingWeeklyDays(state),
    billing = CreateMultiDateBookingRequestArgsBilling(mode = state.billingMode),
    communication = CreateMultiDateBookingRequestArgsCommunication(
        emailConfirmation = state.emailConfirmation,
        timeVisibility = state.timeVisibility,
    ),
    overrideBusyConflict = overrideBusyConflict,
)
