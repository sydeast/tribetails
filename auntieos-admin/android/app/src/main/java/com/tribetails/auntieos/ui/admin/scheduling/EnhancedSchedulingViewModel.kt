package com.tribetails.auntieos.ui.admin.scheduling

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.admin.Event
import com.tribetails.auntieos.data.admin.EventType
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsBilling
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsCommunication
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BOOKING_BUSY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.BookingRequestRefusedException
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ManageSeriesResult
import com.tribetails.auntieos.data.repository.mintBookingIdempotencyKey
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarPushSkip
import com.tribetails.auntieos.data.repository.GoogleCalendarSummary
import com.tribetails.auntieos.data.repository.ScheduleOverrideKind
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.data.repository.overridableScheduleRefusal
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

data class SchedulingState(
    val bookings: List<EnhancedBooking> = emptyList(),
    val timeSlots: List<BookingTimeSlot> = emptyList(),
    // Live booking_time_slots stream error (Google-busy import + any block window).
    // Surfaced as a fail-loud banner; the grid never silently shows an empty day
    // when the stream is actually erroring. Mirrors web's "Couldn't load busy blocks".
    val busyError: String? = null,
    val baseServices: List<BaseService> = emptyList(),
    val supplementalServices: List<SupplementalService> = emptyList(),
    val allKinfolk: List<Kinfolk> = emptyList(),
    val businessHours: List<BusinessHours> = emptyList(),
    val selectedDate: LocalDate = LocalDate.now(),
    val viewMode: CalendarViewMode = CalendarViewMode.WEEK,
    val bookingMode: BookingMode = BookingMode.SPECIFIC_TIME,
    val conflictingBookings: List<EnhancedBooking> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val selectedBooking: EnhancedBooking? = null,
    val showAddBookingDialog: Boolean = false,
    // AO-25: admin multi-date / recurring booking REQUEST (envelope model). Distinct
    // from showAddBookingDialog (the direct enhanced_bookings form): a request enters
    // the Incoming-requests queue for approval. Success reuses [seriesActionMessage].
    val showNewRequestDialog: Boolean = false,
    val newRequestInFlight: Boolean = false,
    val newRequestError: String? = null,
    // D1: true only when [newRequestError] came back as a GOOGLE_BUSY_IMPORT
    // clash, the ONE refusal `overrideBusyConflict` lets an operator knowingly
    // go past. The wizard turns this into a "Create anyway" retry. A company
    // holiday sets newRequestError but never this: `guardCompanyHolidayConflict`
    // has no override parameter, so offering a retry would be offering a button
    // that cannot work.
    val newRequestBusyOverridable: Boolean = false,
    // D1: kin on the household picked at wizard step 1, for the kinIds chips.
    // Loaded on demand rather than in init{}, so opening the Schedule screen does
    // not read a kin roster for a wizard nobody opened.
    val newRequestKin: List<Kin> = emptyList(),
    val newRequestKinLoading: Boolean = false,
    // Fail-loud, never silent: an unreadable roster says so, because "this
    // household has no kin" and "the kin could not be read" must not look the
    // same to the operator.
    val newRequestKinError: String? = null,
    val showConflictDialog: Boolean = false,
    val dragState: DragState? = null,
    val availabilityResult: BookingAvailabilityResult? = null,
    // Phase 14: admin-authored BOOKING form_schemas (appliesTo == BOOKING), rendered
    // in the new-booking dialog; answers persist into EnhancedBooking.formValues.
    val bookingFormSchemas: List<FormSchema> = emptyList(),
    val bookingSchemaError: String? = null,
    // Slice 8: result of the last server-side Google Calendar busy import. On
    // success [calendarSyncMessage] reads "Imported N busy blocks"; on failure
    // [errorMessage] carries the raw server message (which names the sync SA).
    val calendarSyncMessage: String? = null,
    // The last-run receipt the callable stamps on business_settings, re-read
    // after every sync attempt and on load. Server-written, so this survives the
    // screen: without it a sync that failed yesterday and one that never ran
    // look identical, and the operator finds out by pressing the button again.
    val calendarSyncRun: CalendarSyncRun? = null,
    // Front-facing Google Calendar id setup. Round-trips to business_settings via
    // AuntieRepository. [businessSettings] is the persisted source of truth;
    // [calendarSyncIdSaved] is a transient confirmation after a successful save.
    val businessSettings: BusinessSettings = BusinessSettings(),
    val calendarSyncIdSaved: Boolean = false,
    // Stage 2 tail: bulk booking-transition result message (e.g. "Approved 3, 1 failed").
    // Surfaced as a fail-loud banner/toast; null when no batch has run.
    val bulkBookingMessage: String? = null,
    val bulkBookingInFlight: Boolean = false,
    // Stage 3 / 16.5: incoming MyTribe booking requests grouped into envelopes
    // (one row per batchId). Approve/cancel the whole series via manageBookingSeries.
    val incomingSeries: List<IncomingSeries> = emptyList(),
    val incomingError: String? = null,
    val seriesActionBatchId: String? = null, // batchId currently being approved/cancelled
    val seriesActionMessage: String? = null,
    // #438 (+ #399 item 2): the household's OWN asks on visits that already
    // exist -- move this one, cancel that one -- merged into one queue and
    // ordered oldest first. Distinct from [incomingSeries] above, which is a
    // brand-new booking waiting on approval; these are changes to a booking the
    // office already agreed to.
    val visitRequests: List<VisitRequestRow> = emptyList(),
    val visitRequestsError: String? = null,
    val visitRequestKey: String? = null, // row currently being accepted/declined
    val visitRequestMessage: String? = null,
    // Task 7.2: Google Calendar over OAuth, the editable half. A different
    // feature from calendarSyncRun above (that one is 7.1's free/busy read);
    // this one writes visits onto a calendar the operator connects to.
    val googleCalendar: GoogleCalendarUiState = GoogleCalendarUiState(),
    // #574/#575: the last SCHEDULE WRITE refusal -- block a window, unblock one,
    // move a visit -- carrying the server's own sentence, never a summary of it.
    // Its own field rather than [errorMessage] because these three are the only
    // errors on this screen an operator can act on, and the banner that shows
    // them is the one that may carry a retry button.
    val scheduleWriteError: String? = null,
    // Non-null ONLY when the refusal above is one the operator may knowingly go
    // past, and has not already tried to. A company closure and a Google
    // Calendar mirror both set [scheduleWriteError] and leave this null: their
    // guards have no override parameter at all, so a retry button would re-send
    // the identical request and fail identically. See `overridableScheduleRefusal`.
    val scheduleWriteOverride: ScheduleOverrideKind? = null,
    // The write currently in flight, so the same block/move cannot be fired twice.
    val scheduleWriteInFlight: Boolean = false,
)

/**
 * UI state for the Google Calendar OAuth connect/push card (Task 7.2). Kept as
 * its own nested state, not flattened onto [SchedulingState], because it is a
 * small state machine of its own (idle, connecting, polling, connected,
 * pushing, disconnecting) and flattening it would scatter that machine across
 * a dozen unrelated top-level fields.
 */
data class GoogleCalendarUiState(
    // Server-read projection, never carrying a refresh token; see
    // GoogleCalendarConnection in GoogleCalendarTargets.kt.
    val connection: GoogleCalendarConnection? = null,
    // Task 7.1's saved free/busy target, echoed by the server so the picker can
    // apply writeCalendarProblem locally without a second read.
    val freeBusyCalendarId: String = "",
    // The redirect URI the operator must register on the OAuth client. Seeded
    // with the known-deployed constant and overwritten with whatever the
    // server itself echoes, which is the value that actually governs.
    val redirectUri: String = GOOGLE_OAUTH_REDIRECT_URI,
    val calendars: List<GoogleCalendarSummary> = emptyList(),
    val loadingConnection: Boolean = false,
    val connecting: Boolean = false,
    // True while polling getGoogleCalendarConnection after the consent window
    // opened. The UI must render a distinct waiting state here, never claim
    // "connected" until a poll has actually observed it.
    val polling: Boolean = false,
    // The poll window ended with nothing connected. Distinct from a plain
    // error: this is what the card shows when Google never called back at all,
    // as opposed to calling back with a failure.
    val pollTimedOut: Boolean = false,
    // One-shot signal for the screen to open a browser tab. The ViewModel sets
    // it once per successful startGoogleCalendarConnect and the screen clears
    // it via consumeGoogleCalendarAuthUrl right after launching the Intent, so
    // a recomposition (rotation, a later state update) can never re-open the
    // same consent URL a second time.
    val pendingAuthUrl: String? = null,
    val savingTargets: Boolean = false,
    val pushing: Boolean = false,
    // Sessions the last push could not push, and why (no end time, etc).
    val pushSkipped: List<GoogleCalendarPushSkip> = emptyList(),
    val disconnecting: Boolean = false,
    // Routed straight from the server's own message wherever one exists (a
    // thrown HttpsError's .message, or a stamped connectLastError/revokeError).
    // Never replaced with a friendly summary: on the not-configured path this
    // IS the setup instruction, naming the missing secret and the exact
    // firebase functions:secrets:set command.
    val error: String? = null,
)

/** Poll cadence for the Google Calendar OAuth connect flow: 3s x 40 = ~2 minutes. */
private const val GOOGLE_CALENDAR_POLL_INTERVAL_MS = 3_000L
private const val GOOGLE_CALENDAR_POLL_MAX_ATTEMPTS = 40

enum class CalendarViewMode(val displayName: String) {
    DAY("Day"),
    WEEK("Week"),
    MONTH("Month"),
    AGENDA("Agenda");
    companion object {
        /**
         * ISSUE #519: the typed view of `business_settings.defaultCalendarView`,
         * which had no editor and no consumer on any surface until this change.
         * Unknown or legacy strings fall back to MONTH, the same shipped default
         * every model states, rather than throwing on a hand-edited document.
         *
         * Lives here rather than as an accessor on `BusinessSettings` because
         * this enum is a UI concept: the data model must not import from `ui/`.
         */
        fun fromWire(wire: String): CalendarViewMode =
            entries.firstOrNull { it.name == wire.trim().uppercase() } ?: MONTH
    }
}

data class DragState(
    val draggedBooking: EnhancedBooking,
    val newStartTime: LocalDateTime,
    val newEndTime: LocalDateTime
)

/**
 * Build the (startIso, endIso) reschedule pair from a local date+time, preserving the
 * original visit duration (fallback 30m). Returns null on malformed input. Pure; tested.
 * Mirrors the web `buildRescheduleTimes`.
 */
internal fun buildRescheduleTimes(date: String, time: String, originalStart: String, originalEnd: String): Pair<String, String>? {
    if (date.length != 10 || time.length != 5) return null
    val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
    val start = runCatching { LocalDateTime.parse("${date}T${time}:00") }.getOrNull() ?: return null
    val durMin = runCatching {
        val s = LocalDateTime.parse(originalStart, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val e = LocalDateTime.parse(originalEnd, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        java.time.Duration.between(s, e).toMinutes().toInt()
    }.getOrNull()?.takeIf { it > 0 } ?: 30
    val end = start.plusMinutes(durMin.toLong())
    return start.format(fmt) to end.format(fmt)
}

/**
 * Human, fail-loud summary of a batch booking transition. Always names how many
 * succeeded AND how many failed, so a partial result is never read as a clean
 * success. Maps the SCREAMING action onto a past-tense verb. Pure; unit-tested.
 */
internal fun batchBookingSummary(result: com.tribetails.auntieos.data.repository.BatchBookingResult): String {
    val verb = when (result.action.uppercase()) {
        "APPROVE" -> "Approved"
        "REJECT" -> "Rejected"
        "CANCEL" -> "Cancelled"
        else -> result.action
    }
    val failed = result.failedCount
    return if (failed == 0) "$verb ${result.updated}."
    else "$verb ${result.updated}, $failed failed."
}

class EnhancedSchedulingViewModel(
    private val bookingRepository: BookingRepository,
    private val serviceRepository: ServiceRepository,
    private val auntieRepository: AuntieRepository = com.tribetails.auntieos.AuntieOSApp.instance.repository,
    // W4-3: creating a visit, rescheduling it, patching its status and writing
    // back onto the MyTribe booking envelope are all KinCare domain.
    private val kinCareRepository: KinCareRepository = com.tribetails.auntieos.AuntieOSApp.instance.kinCareRepository,
    private val visitRequestRepository: com.tribetails.auntieos.data.repository.VisitRequestRepository =
        com.tribetails.auntieos.data.repository.VisitRequestRepository(),
) : ViewModel() {

    private val _state = MutableStateFlow(SchedulingState())
    val state: StateFlow<SchedulingState> = _state.asStateFlow()

    /**
     * The settings document as Firestore handed it over, and the only thing the
     * three settings writes on this screen may diff against.
     *
     * NULL UNTIL A LOAD SUCCEEDS, and that is the sharper half here:
     * [loadInitialData] falls back to `BusinessSettings()` when the read fails so
     * the grid still renders, and the old whole-model save then wrote that
     * near-DEFAULT document over the real one - business name, payment handles
     * and calendar id blanked in a single `set()`. [saveSettingsDiff] refuses
     * instead. Advances only after a write the server accepted.
     */
    private var settingsBaseline: BusinessSettings? = null

    init {
        loadInitialData()
        observeBusyTimeSlots()
        observeIncomingSeries()
        loadVisitRequests()
        loadGoogleCalendarState()
    }

    /**
     * Persist ONLY the settings fields [updated] changes, and report the outcome.
     *
     * The three writes on this screen (the booking-mode default, the Google
     * Calendar id, and the in-place settings updater) each edit ONE field of a
     * ~46-field union that the Settings screen, Service Management and the React
     * admin all also write. `SetOptions.merge()` guards fields outside the
     * written map and does nothing about stale ones inside it, so a whole-model
     * save from here reverted every one of those editors. The React side patches
     * per section for exactly this reason
     * (`auntieos-admin/src/api/settingsWrite.ts`); `BusinessSettingsDiff.kt`
     * carries the android half of the argument.
     *
     * An empty diff succeeds without writing: moving `updatedAt` for a save that
     * changed nothing makes the stamp lie.
     *
     * RETURNS WHETHER A WRITE ACTUALLY HAPPENED, and that Boolean is load-bearing
     * for [saveCalendarSyncId]. Success and "there was nothing to send" are the
     * same outcome to the operator but not to the audit log: an entry reading
     * "Set Google Calendar sync id" against a save that sent no bytes is the same
     * lie as a moved `updatedAt`, one collection over.
     */
    private suspend fun saveSettingsDiff(updated: BusinessSettings): Result<Boolean> {
        val baseline = settingsBaseline
            ?: return Result.failure(
                IllegalStateException("Reopen Scheduling before saving: its settings were never loaded.")
            )
        val changes = businessSettingsFieldChanges(baseline, updated)
        if (changes.isEmpty()) return Result.success(false)
        return auntieRepository.updateBusinessSettingsFields(changes).map {
            // The baseline moves to what the server now holds; without it a
            // second save re-sends the first save's fields.
            settingsBaseline = updated
            true
        }
    }

    /**
     * Stage 3 / 16.5: live incoming MyTribe booking requests, grouped into
     * per-envelope series (one row per batchId). Fail-loud: a stream error sets
     * [SchedulingState.incomingError]. No-op until kinfolk requests exist.
     */
    private fun observeIncomingSeries() {
        viewModelScope.launch {
            // Stage-0I sandbox: collectionGroup('kinCares') is cross-tenant and a test
            // admin cannot read it, so its permission-denied must NOT paint a banner.
            // Resolve once before collecting (race-free vs the stream's first emission).
            val sandbox = auntieRepository.isTestAdminActive()
            bookingRepository.incomingKinCareRequestsStream().collect { result ->
                result
                    .onSuccess { incoming ->
                        val byId = _state.value.allKinfolk.associateBy { it.id }
                        _state.value = _state.value.copy(
                            incomingSeries = groupIncomingBySeries(incoming) { kid -> byId[kid]?.displayName },
                            incomingError = null,
                        )
                    }
                    .onFailure { e ->
                        // Fail-loud: keep any existing list, surface the error — but not in
                        // the sandbox, where the denial is expected (no cross-tenant data).
                        if (!sandbox) _state.value = _state.value.copy(
                            incomingError = e.message ?: "Couldn't load incoming requests",
                        )
                    }
            }
        }
    }

    /** Approve a whole incoming series: flips every visit confirmed + creates the
     *  linked sessions server-side (manageBookingSeries). The stream then drops the
     *  series (no longer 'requested'). */
    fun approveSeries(series: IncomingSeries) = runSeriesAction(series, "APPROVE")

    /** Cancel a whole incoming series. */
    fun cancelSeries(series: IncomingSeries) = runSeriesAction(series, "CANCEL")
    /**
     * What the household actually heard about this decision (#536), for the
     * SUCCESS message only. The partial-failure branch says its own thing.
     *
     * Approving a four-day request used to send one message per VISIT, and this
     * screen said nothing about it either way. Both admin clients now report the
     * server's own answer instead of assuming a clean result means a clean
     * message: one message naming every date, or an honest account of why none
     * went out.
     *
     * ONE CONSTRAINT ON THE CANCEL BRANCH. `cancelSeries` is fed only from the
     * incoming-requests stream, which is `requested` visits, so a CANCEL from
     * this screen is always a DECLINE and `householdNotified` really does report
     * the one `kincare.request.declined`. Cancelling an ALREADY CONFIRMED series
     * is a different event: the callable dispatches nothing and `onBookingsWrite`
     * sends `kincare.booking.cancel` per visit instead, so `householdNotified`
     * would be false while the household really had been told. Do not reuse this
     * on a confirmed-series cancel without giving that case its own wording.
     *
     * Internal so the wording is unit-testable without standing up a ViewModel.
     */
    internal fun householdLine(action: String, res: ManageSeriesResult): String = when {
        action == "APPROVE" && res.newlyConfirmed == 0 ->
            "It was already booked, so nothing new was sent."
        // A DECLINE gets its own line rather than borrowing the approve one.
        // "with every date" is only true of the confirmation, which enumerates
        // the days; `kincare.request.declined` still renders the #534 span until
        // step 2 of the visit-date spec lands.
        action == "CANCEL" && res.householdNotified ->
            "The household has your answer and your reason."
        res.householdNotified ->
            "The household was told once, with every date."
        else ->
            "The message to the household did not go out, so tell them another way."
    }

    private fun runSeriesAction(series: IncomingSeries, action: String) {
        if (_state.value.seriesActionBatchId != null) return
        _state.value = _state.value.copy(seriesActionBatchId = series.batchId, seriesActionMessage = null, incomingError = null)
        viewModelScope.launch {
            auntieRepository.manageBookingSeries(action, series.kinfolkId, series.batchId)
                .onSuccess { res ->
                    val verb = if (action == "APPROVE") "Approved" else "Cancelled"
                    val who = series.kinfolkName.ifBlank { "request" }
                    if (res.failedVisits > 0) {
                        // FAIL LOUD on a partial failure: the backend leaves the
                        // envelope 'requested' for the failed visits. Surface it as
                        // an error, not a clean success message.
                        //
                        // #536: it dispatches NOTHING in this case either, so the
                        // household is still waiting. Say so. An operator who
                        // reads a partial failure as "they were told about the
                        // ones that worked" stops chasing it.
                        _state.value = _state.value.copy(
                            seriesActionBatchId = null,
                            seriesActionMessage = null,
                            incomingError = "$verb $who: ${res.affectedVisits} succeeded, ${res.failedVisits} failed and stay pending. The household has not been told. Retry after resolving.",
                        )
                    } else {
                        _state.value = _state.value.copy(
                            seriesActionBatchId = null,
                            seriesActionMessage = "$verb $who: ${res.affectedVisits} visit(s). ${householdLine(action, res)}",
                        )
                    }
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(
                        seriesActionBatchId = null,
                        incomingError = "Couldn't $action series: ${e.message}",
                    )
                }
        }
    }

    fun clearSeriesActionMessage() { _state.value = _state.value.copy(seriesActionMessage = null) }
    fun clearIncomingError() { _state.value = _state.value.copy(incomingError = null) }

    /**
     * The household's change requests on existing visits (#399 item 2, #438).
     *
     * A one-shot callable read rather than a stream, because both queues are
     * collection-group reads the server owns; this client is not allowed to run
     * them itself. The two are read INDEPENDENTLY and reported independently,
     * so a broken reschedule read cannot hide a cancellation that has been
     * waiting since July, which is the exact failure this feature exists to end.
     */
    fun loadVisitRequests() {
        viewModelScope.launch {
            // Stage-0I sandbox: the underlying reads are cross-tenant and a test
            // admin cannot make them, so their permission-denied must not paint
            // a banner. Same rule as observeIncomingSeries.
            val sandbox = auntieRepository.isTestAdminActive()
            val reschedule = visitRequestRepository.listRescheduleRequests()
            val cancel = visitRequestRepository.listCancelRequests()
            val failures = buildList {
                reschedule.exceptionOrNull()?.let { add("Reschedule requests: ${it.message ?: "the read did not land"}") }
                cancel.exceptionOrNull()?.let { add("Cancellation requests: ${it.message ?: "the read did not land"}") }
            }
            _state.value = _state.value.copy(
                visitRequests = mergeVisitRequests(
                    reschedule.getOrDefault(emptyList()),
                    cancel.getOrDefault(emptyList()),
                ),
                visitRequestsError = if (failures.isEmpty() || sandbox) {
                    null
                } else {
                    failures.joinToString(" ") + " Anything waiting there is not on this list."
                },
            )
        }
    }

    /**
     * Accepts or declines ONE request.
     *
     * Accepting is what changes the visit, and the server writes both the
     * household's kinCares doc and the flat `kin_care_sessions` row so this
     * screen and the portal cannot end up disagreeing. Declining changes
     * nothing about the visit and REQUIRES a note: "no" with no reason is not
     * an answer, and the server refuses one without it, so the check is made
     * here too rather than after a round trip.
     *
     * The resolved row is dropped locally the moment the server confirms,
     * never re-fetched and never assumed.
     */
    fun resolveVisitRequest(row: VisitRequestRow, decision: String, note: String? = null) {
        if (_state.value.visitRequestKey != null) return
        val trimmed = note?.trim()?.takeIf { it.isNotEmpty() }
        if (decision == "decline" && trimmed == null) {
            _state.value = _state.value.copy(
                visitRequestsError = "Say why, so the household knows where they stand.",
            )
            return
        }
        _state.value = _state.value.copy(
            visitRequestKey = row.key,
            visitRequestMessage = null,
            visitRequestsError = null,
        )
        viewModelScope.launch {
            val outcome = when (row) {
                is VisitRequestRow.Cancel -> visitRequestRepository.resolveCancellationRequest(
                    kinfolkId = row.kinfolkId,
                    batchId = row.batchId,
                    visitId = row.visitId,
                    decision = decision,
                    note = trimmed,
                ).map { res -> cancelOutcomeMessage(decision, res.sessionUpdated) }
                is VisitRequestRow.Reschedule -> visitRequestRepository.resolveRescheduleRequest(
                    kinfolkId = row.kinfolkId,
                    batchId = row.batchId,
                    visitId = row.visitId,
                    decision = decision,
                    note = trimmed,
                ).map { res -> rescheduleOutcomeMessage(decision, res.sessionUpdated) }
            }
            outcome
                .onSuccess { message ->
                    _state.value = _state.value.copy(
                        visitRequestKey = null,
                        visitRequests = _state.value.visitRequests.filterNot { it.key == row.key },
                        visitRequestMessage = message,
                    )
                }
                .onFailure { e ->
                    // The row STAYS. A refused decision leaves the household
                    // still waiting, and dropping the row would hide that.
                    _state.value = _state.value.copy(
                        visitRequestKey = null,
                        visitRequestsError = e.message ?: "That did not go through. Try again.",
                    )
                }
        }
    }

    private fun cancelOutcomeMessage(decision: String, sessionUpdated: Boolean): String = when {
        decision == "decline" -> "Declined. The visit stays on the schedule and the household gets your reason."
        sessionUpdated -> "Cancelled. It is off the schedule and off the household's portal."
        else -> "Cancelled. This visit was still a request, so it had no schedule row to take off."
    }

    private fun rescheduleOutcomeMessage(decision: String, sessionUpdated: Boolean): String = when {
        decision == "decline" -> "Declined. The household will see your reason on their booking."
        sessionUpdated -> "Moved. The schedule and the household now show the new time."
        else -> "Moved. This visit is still a request, so it has no schedule row to move yet."
    }

    fun clearVisitRequestMessage() { _state.value = _state.value.copy(visitRequestMessage = null) }
    fun clearVisitRequestsError() { _state.value = _state.value.copy(visitRequestsError = null) }

    /**
     * Live booking_time_slots subscription (replaces the one-shot getTimeSlots .get()).
     * Busy blocks (Google Calendar imports + manual blocks) now update on the schedule
     * as they change. Fail-loud: a stream error sets [SchedulingState.busyError] for a
     * banner rather than silently clearing the grid. Mirrors web bookingTimeSlotsStream.
     */
    private fun observeBusyTimeSlots() {
        viewModelScope.launch {
            // Stage-0I sandbox: booking_time_slots is a global collection a test admin
            // cannot read; suppress the false banner (nothing to load in the sandbox).
            val sandbox = auntieRepository.isTestAdminActive()
            bookingRepository.bookingTimeSlotsStream().collect { result ->
                result
                    .onSuccess { slots ->
                        _state.value = _state.value.copy(timeSlots = slots, busyError = null)
                    }
                    .onFailure { e ->
                        if (!sandbox) _state.value = _state.value.copy(
                            busyError = e.message ?: "Couldn't load busy blocks"
                        )
                    }
            }
        }
    }

    private fun loadInitialData() {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            try {
                // Load services, settings, and kinfolk
                val servicesResult = serviceRepository.getBaseServices()
                val supplementalResult = serviceRepository.getSupplementalServices()
                val businessHoursResult = serviceRepository.getBusinessHours()
                val kinfolkResult = auntieRepository.getKinfolk()
                // Unified settings (2026-06-05): booking config + timeBlocks now
                // live on business_settings, read via AuntieRepository.
                val businessSettingsResult = auntieRepository.getBusinessSettings()
                businessSettingsResult.onSuccess { settingsBaseline = it }
                val businessSettings = businessSettingsResult.getOrNull() ?: BusinessSettings()
                // Server-written calendar-sync receipt, read separately from the
                // settings model so a settings save can never write a stale one
                // back (see AuntieRepository.getCalendarSyncRun).
                val calendarSyncRun = auntieRepository.getCalendarSyncRun().getOrNull()

                _state.value = _state.value.copy(
                    baseServices = servicesResult.getOrNull() ?: emptyList(),
                    supplementalServices = supplementalResult.getOrNull() ?: emptyList(),
                    allKinfolk = kinfolkResult.getOrDefault(emptyList()),
                    businessHours = businessHoursResult.getOrNull() ?: emptyList(),
                    businessSettings = businessSettings,
                    calendarSyncRun = calendarSyncRun,
                    bookingMode = businessSettings.defaultBookingModeEnum,
                    // ISSUE #519: the calendar opens on the view the operator
                    // chose. `defaultCalendarView` had been decoded and defaulted
                    // by three clients and read by none of them.
                    viewMode = CalendarViewMode.fromWire(businessSettings.defaultCalendarView),
                )

                // Phase 14: load BOOKING-placed form_schemas for the new-booking dialog.
                // Fail-loud via bookingSchemaError; never a silent-empty panel.
                val schemas = runCatching {
                    val summaries = auntieRepository.listFormSchemas().getOrThrow()
                    appliesToSchemaIds(summaries, "BOOKING").mapNotNull { auntieRepository.getFormSchema(it).getOrThrow() }
                }
                _state.value = _state.value.copy(
                    bookingFormSchemas = schemas.getOrDefault(emptyList()),
                    bookingSchemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load custom fields" },
                )

                // Load bookings for current date range
                loadBookingsForDateRange()

            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to load data: ${e.message}"
                )
            }
        }
    }

    private fun loadBookingsForDateRange() {
        viewModelScope.launch {
            try {
                val startDate = _state.value.selectedDate.minusDays(7)
                    .format(DateTimeFormatter.ISO_LOCAL_DATE)
                val endDate = _state.value.selectedDate.plusDays(7)
                    .format(DateTimeFormatter.ISO_LOCAL_DATE)

                val bookingsResult = bookingRepository.getBookings(
                    startDate = startDate,
                    endDate = endDate
                )

                // timeSlots are no longer fetched one-shot here: observeBusyTimeSlots()
                // keeps state.timeSlots live (and fail-loud) for the whole VM lifetime.
                _state.value = _state.value.copy(
                    bookings = bookingsResult.getOrNull() ?: emptyList(),
                    isLoading = false
                )

            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to load bookings: ${e.message}"
                )
            }
        }
    }

    fun selectDate(date: LocalDate) {
        _state.value = _state.value.copy(selectedDate = date)
        loadBookingsForDateRange()
    }

    fun changeViewMode(mode: CalendarViewMode) {
        _state.value = _state.value.copy(viewMode = mode)
    }

    fun changeBookingMode(mode: BookingMode) {
        _state.value = _state.value.copy(bookingMode = mode)

        // Persist the default booking mode onto the unified settings doc. ONE
        // field goes out, so switching the calendar's mode can no longer rewrite
        // the calendar-sync id, the payment handles or the tag vocabularies that
        // share this document.
        viewModelScope.launch {
            val updatedSettings = _state.value.businessSettings.withBookingMode(mode)
            saveSettingsDiff(updatedSettings)
                .onSuccess { _state.value = _state.value.copy(businessSettings = updatedSettings) }
                .onFailure { e ->
                    _state.value = _state.value.copy(
                        errorMessage = "Failed to save the booking mode: ${e.message}"
                    )
                }
        }
    }

    fun createBooking(booking: EnhancedBooking, internalNote: String = "") {
        if (_state.value.isLoading) return
        _state.value = _state.value.copy(isLoading = true)
        viewModelScope.launch {

            if (_state.value.businessSettings.enableConflictDetection) {
                val availabilityResult = bookingRepository.evaluateAvailability(
                    BookingAvailabilityRequest(
                        startDateTime = booking.startDateTime,
                        endDateTime = booking.endDateTime,
                        travelBufferMinutes = _state.value.businessSettings.travelBufferMinutes,
                        timeBlocks = _state.value.businessSettings.timeBlocks
                    )
                )

                val availability = availabilityResult.getOrNull()

                if (availability != null && !availability.isAvailable) {
                    _state.value = _state.value.copy(
                        conflictingBookings = availability.conflictingBookings,
                        availabilityResult = availability,
                        selectedBooking = booking,
                        showConflictDialog = true,
                        isLoading = false
                    )
                    return@launch
                }
            }

            // No conflicts, create the booking
            val result = bookingRepository.createBooking(booking)

            if (result.isSuccess) {
                val newBookingId = result.getOrNull().orEmpty()
                if (internalNote.isNotBlank() && newBookingId.isNotBlank() && booking.kinfolkId.isNotBlank()) {
                    val notesRepo = com.tribetails.auntieos.data.repository.BookingNotesRepository()
                    notesRepo.addInternalNote(booking.kinfolkId, newBookingId, internalNote)
                        .onFailure { t ->
                            _state.value = _state.value.copy(
                                errorMessage = "Booking created but internal note save failed: ${t.message}",
                            )
                        }
                }
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "CREATE_BOOKING",
                    description      = "Created booking for ${booking.kinfolkName.ifBlank { booking.kinfolkId }} on ${booking.startDateTime}",
                    targetId         = newBookingId,
                    targetCollection = "enhanced_bookings",
                )
                loadBookingsForDateRange()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to create booking: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun updateBooking(booking: EnhancedBooking) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            if (_state.value.businessSettings.enableConflictDetection) {
                val availabilityResult = bookingRepository.evaluateAvailability(
                    BookingAvailabilityRequest(
                        startDateTime = booking.startDateTime,
                        endDateTime = booking.endDateTime,
                        excludeBookingId = booking.id,
                        travelBufferMinutes = _state.value.businessSettings.travelBufferMinutes,
                        timeBlocks = _state.value.businessSettings.timeBlocks
                    )
                )

                val availability = availabilityResult.getOrNull()

                if (availability != null && !availability.isAvailable) {
                    _state.value = _state.value.copy(
                        conflictingBookings = availability.conflictingBookings,
                        availabilityResult = availability,
                        selectedBooking = booking,
                        showConflictDialog = true,
                        isLoading = false
                    )
                    return@launch
                }
            }

            // No conflicts, update the booking
            val result = bookingRepository.updateBooking(booking)

            if (result.isSuccess) {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "UPDATE_BOOKING",
                    description      = "Updated booking for ${booking.kinfolkName.ifBlank { booking.kinfolkId }}",
                    targetId         = booking.id,
                    targetCollection = "enhanced_bookings",
                )
                loadBookingsForDateRange()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to update booking: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun deleteBooking(bookingId: String) {
        // Legacy hard-delete entry point. Preferred path: archiveBooking (reversible).
        // Kept temporarily for any call sites that haven't migrated.
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)

            val result = bookingRepository.deleteBooking(bookingId)

            if (result.isSuccess) {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "DELETE_BOOKING",
                    description      = "Hard-deleted booking",
                    targetId         = bookingId,
                    targetCollection = "enhanced_bookings",
                )
                loadBookingsForDateRange()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to delete booking: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun archiveBooking(bookingId: String, reason: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true)
            val result = bookingRepository.archiveBooking(bookingId, reason.trim())
            if (result.isSuccess) {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "ARCHIVE_BOOKING",
                    description      = if (reason.isBlank()) "Archived booking" else "Archived booking (reason: ${reason.trim()})",
                    targetId         = bookingId,
                    targetCollection = "enhanced_bookings",
                )
                loadBookingsForDateRange()
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to archive booking: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    fun unarchiveBooking(bookingId: String) {
        viewModelScope.launch {
            val result = bookingRepository.unarchiveBooking(bookingId)
            if (result.isSuccess) {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "UNARCHIVE_BOOKING",
                    description      = "Unarchived booking",
                    targetId         = bookingId,
                    targetCollection = "enhanced_bookings",
                )
                loadBookingsForDateRange()
            } else {
                _state.value = _state.value.copy(
                    errorMessage = "Failed to unarchive booking: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    // `incoming` is the originating MyTribe kinCare request when this approval came
    // from the booking-envelope queue (BookingRepository.incomingKinCareRequestsStream).
    // It carries familyId/batchId/visitId so we can write status back onto the
    // kinCare doc. Null for AuntieOS-native enhanced_bookings approvals (existing
    // call sites), in which case the write-back is skipped.
    fun approveBooking(
        booking: EnhancedBooking,
        incoming: com.tribetails.auntieos.data.repository.IncomingKinCare? = null,
    ) {
        viewModelScope.launch {
            val approved = booking.copy(
                status = BookingStatus.ACCEPTED,
                approvedAt = java.time.Instant.now().toString()
            )

            _state.value = _state.value.copy(isLoading = true)
            val updateResult = bookingRepository.updateBooking(approved)
            if (updateResult.isFailure) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to approve booking: ${updateResult.exceptionOrNull()?.message}"
                )
                return@launch
            }
            com.tribetails.auntieos.data.admin.AuditLog.fire(
                scope            = viewModelScope,
                repository       = auntieRepository,
                actionType       = "APPROVE_BOOKING",
                description      = "Approved booking for ${booking.kinfolkName.ifBlank { booking.kinfolkId }}",
                targetId         = booking.id,
                targetCollection = "enhanced_bookings",
            )

            // Bridge: create a KinCareSession so the visit appears on the Home screen,
            // but keep this idempotent by using explicit booking linkage.
            val existingSessionIds = findLinkedSessionIds(booking.id).getOrElse { lookupError ->
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Booking approved, but linked session lookup failed: ${lookupError.message}"
                )
                return@launch
            }
            if (existingSessionIds.isEmpty()) {
                val durationMinutes = try {
                    val start = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    val end = LocalDateTime.parse(booking.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    java.time.Duration.between(start, end).toMinutes().toInt()
                } catch (e: Exception) { 0 }

                val session = KinCareSession(
                    kinfolkId = booking.kinfolkId,
                    kinfolkName = booking.kinfolkName,
                    sourceBookingId = booking.id,
                    // MyTribe booking-envelope FK (additive; null for native approvals)
                    kinCareBatchId = incoming?.batchId,
                    kinCareVisitId = incoming?.visitId,
                    kinIds = booking.kinIds,
                    startTime = booking.startDateTime,
                    endTime = booking.endDateTime,
                    serviceType = booking.baseServiceTitle.ifBlank { booking.title },
                    serviceDurationMinutes = durationMinutes,
                    notes = booking.notes
                )
                kinCareRepository.createKinCareSession(session)
                    .onSuccess { kinCareSessionId ->
                        // Booking-envelope write-back: stamp the originating MyTribe
                        // kinCare doc so the kinfolk's live state resolves to confirmed
                        // with the assigned Auntie. Skipped when this approval did not
                        // originate from a MyTribe kinCare request.
                        writeBackKinCareApproval(
                            incoming = incoming,
                            enhancedBookingId = booking.id,
                            kinCareSessionId = kinCareSessionId,
                        )
                    }
                    .onFailure { e ->
                        Log.e("EnhancedSchedulingVM", "Failed to create KinCareSession from booking ${booking.id}", e)
                        _state.value = _state.value.copy(
                            errorMessage = "Booking approved but visit session failed to create: ${e.message}"
                        )
                    }
            }

            loadBookingsForDateRange()
        }
    }

    /**
     * Patches the originating MyTribe kinCare doc after an approval so the kinfolk
     * sees the confirmed visit with the assigned Auntie. No-op when [incoming] is
     * null (native enhanced_bookings approval with no kinCare envelope).
     */
    private suspend fun writeBackKinCareApproval(
        incoming: com.tribetails.auntieos.data.repository.IncomingKinCare?,
        enhancedBookingId: String,
        kinCareSessionId: String,
    ) {
        if (incoming == null) return
        val auntie = auntieRepository.getCurrentUserProfile().getOrNull()
        val patch = mapOf(
            "status" to "confirmed",
            "auntieDisplayName" to (auntie?.displayLabel ?: ""),
            "auntieAvatarUrl" to (auntie?.photoUrl ?: ""),
            "sourceBookingId" to enhancedBookingId,
            "sessionId" to kinCareSessionId,
            "updatedAt" to java.time.Instant.now().toString(),
        )
        kinCareRepository.patchKinCareDoc(
            familyId = incoming.kinfolkId.ifBlank { incoming.familyId },
            batchId = incoming.batchId,
            visitId = incoming.visitId,
            patch = patch,
        ).onFailure { e ->
            Log.e("EnhancedSchedulingVM", "Failed to write back kinCare approval for visit ${incoming.visitId}", e)
            _state.value = _state.value.copy(
                errorMessage = "Booking approved but kinCare write-back failed: ${e.message}"
            )
        }
    }

    fun cancelBooking(booking: EnhancedBooking, reason: String = "Cancelled by admin") {
        viewModelScope.launch {
            val cancelled = booking.copy(
                status = BookingStatus.REJECTED,
                cancellationReason = reason,
                cancellationDate = java.time.Instant.now().toString()
            )

            _state.value = _state.value.copy(isLoading = true)
            val updateResult = bookingRepository.updateBooking(cancelled)
            if (updateResult.isFailure) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to cancel booking: ${updateResult.exceptionOrNull()?.message}"
                )
                return@launch
            }
            com.tribetails.auntieos.data.admin.AuditLog.fire(
                scope            = viewModelScope,
                repository       = auntieRepository,
                actionType       = "REJECT_BOOKING",
                description      = "Cancelled booking for ${booking.kinfolkName.ifBlank { booking.kinfolkId }} (reason: $reason)",
                targetId         = booking.id,
                targetCollection = "enhanced_bookings",
            )

            bridgeCancellationToSession(booking, reason).onFailure { e ->
                _state.value = _state.value.copy(
                    errorMessage = "Booking cancelled, but linked session lookup/update failed: ${e.message}"
                )
            }
            loadBookingsForDateRange()
        }
    }

    /**
     * Stage 2 tail: apply ONE transition (APPROVE/REJECT/CANCEL) to many bookings at
     * once via the batchUpdateBookings callable. Fail-loud: the server-reported
     * updated/failed counts are surfaced in [SchedulingState.bulkBookingMessage]; the
     * range refreshes afterward so the sections reflect any applied transitions.
     */
    fun batchUpdateBookings(ids: List<String>, action: String) {
        if (ids.isEmpty() || _state.value.bulkBookingInFlight) return
        _state.value = _state.value.copy(bulkBookingInFlight = true, bulkBookingMessage = null)
        viewModelScope.launch {
            auntieRepository.batchUpdateBookings(ids, action)
                .onSuccess { result ->
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = auntieRepository,
                        actionType       = "BATCH_UPDATE_BOOKINGS",
                        description      = "Batch $action on ${ids.size} booking(s): ${result.updated} updated, ${result.failedCount} failed",
                        targetId         = ids.firstOrNull() ?: "",
                        targetCollection = "kinCares",
                    )
                    _state.value = _state.value.copy(
                        bulkBookingInFlight = false,
                        bulkBookingMessage = batchBookingSummary(result),
                    )
                    loadBookingsForDateRange()
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(
                        bulkBookingInFlight = false,
                        bulkBookingMessage = "Bulk $action failed: ${e.message}",
                    )
                }
        }
    }

    fun clearBulkBookingMessage() {
        _state.value = _state.value.copy(bulkBookingMessage = null)
    }

    /**
     * Reschedule the selected booking via the Stage-1 rescheduleBooking callable (§A.9).
     * End is preserved from the original visit duration (fallback 30m). Fail-loud on a
     * malformed date/time or a failed write; refreshes the range on success.
     */
    fun rescheduleSelectedBooking(date: String, time: String) {
        val booking = _state.value.selectedBooking ?: return
        val times = buildRescheduleTimes(date, time, booking.startDateTime, booking.endDateTime)
        if (times == null) {
            _state.value = _state.value.copy(
                scheduleWriteError = "Enter a valid date (YYYY-MM-DD) and time (HH:MM).",
                scheduleWriteOverride = null,
            )
            return
        }
        moveVisit(booking, times.first, times.second, override = null, closeDetail = true)
    }

    /**
     * #575: move ONE booking's visit, through the callable, with the overrides
     * the operator is allowed to take.
     *
     * THREE THINGS WERE WRONG HERE AND THEY ARE ONE PROBLEM: this screen renders
     * `enhanced_bookings`, and `rescheduleBooking` writes `kin_care_sessions`.
     *
     *  1. It sent `booking.id` — an `enhanced_bookings` document id — as
     *     `sessionId`, so the callable answered `not-found` and no reschedule
     *     from this phone had ever landed. The link between the two collections
     *     already existed and was already used by the cancellation bridge:
     *     `kin_care_sessions.sourceBookingId`. [findLinkedSessionIds] is that
     *     lookup, reused rather than reinvented.
     *  2. Nothing patched the ENVELOPE afterwards, so even a successful move
     *     would have left this screen drawing the old slot. The server cannot do
     *     it: the envelope stores zoneless local wall clock, the session stores
     *     instants, and turning one into the other needs the operator's zone.
     *     [BookingRepository.updateBookingTimes] writes the two fields that
     *     moved and nothing else — never [BookingRepository.updateBooking],
     *     which rebuilds the whole document from the model.
     *  3. There was no way past a refusal. PR #571 gave the callable a
     *     visit-overlap guard, so a move onto an occupied slot is correctly
     *     refused — and this phone had no "Move anyway", so an android operator
     *     hit a wall where a web operator got a choice. That is what [override]
     *     is, and [ScheduleOverrideKind] decides which flag it becomes.
     *
     * ZERO AND MANY ARE BOTH REFUSED BY NAME. An ACCEPTED booking whose session
     * was never created (approval predating the bridge, or a create that failed)
     * has nothing to move, and saying "no linked visit" is the only honest
     * answer. More than one linked session is a state this screen cannot resolve
     * on the operator's behalf: fanning the same window onto every one of them
     * would stack visits, so it names the count and stops.
     */
    private fun moveVisit(
        booking: EnhancedBooking,
        startIso: String,
        endIso: String,
        override: ScheduleOverrideKind?,
        closeDetail: Boolean,
    ) {
        if (_state.value.scheduleWriteInFlight) return
        _state.value = _state.value.copy(
            scheduleWriteInFlight = true,
            scheduleWriteError = null,
            scheduleWriteOverride = null,
        )
        viewModelScope.launch {
            val sessionIds = findLinkedSessionIds(booking.id).getOrElse { e ->
                failScheduleWrite("Could not look up the visit behind this booking: ${e.message}")
                return@launch
            }
            if (sessionIds.isEmpty()) {
                failScheduleWrite(
                    "No scheduled visit is linked to this booking, so there is nothing to move. " +
                        "Confirm the booking first: approving it is what creates the visit.",
                )
                return@launch
            }
            if (sessionIds.size > 1) {
                failScheduleWrite(
                    "This booking has ${sessionIds.size} visits linked to it, and moving them all to " +
                        "the same window would stack them. Move each visit from its own record.",
                )
                return@launch
            }
            val sessionId = sessionIds.first()

            kinCareRepository.rescheduleBooking(
                sessionId = sessionId,
                startTime = startIso,
                endTime = endIso,
                overrideBusyConflict = override == ScheduleOverrideKind.BUSY,
                overrideVisitConflict = override == ScheduleOverrideKind.VISIT,
            ).onSuccess {
                // The visit moved; the envelope this screen draws has to follow,
                // or the calendar keeps showing the old slot.
                val patched = bookingRepository.updateBookingTimes(booking.id, startIso, endIso)
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "RESCHEDULE_BOOKING",
                    description      = "Rescheduled visit for ${booking.kinfolkName.ifBlank { booking.kinfolkId }} to $startIso" +
                        (if (override != null) " (override: ${override.name.lowercase()} conflict)" else ""),
                    targetId         = sessionId,
                    // The write the callable made, not the envelope patch that
                    // followed it: an audit entry that named enhanced_bookings
                    // would point at a document the reschedule did not author.
                    targetCollection = "kin_care_sessions",
                )
                _state.value = _state.value.copy(
                    scheduleWriteInFlight = false,
                    scheduleWriteError = patched.exceptionOrNull()?.let {
                        // Fail loud rather than quietly: the visit really did
                        // move, and this screen is now showing a stale window.
                        "The visit moved, but this calendar could not be updated to match: ${it.message}. Refresh to see the new time."
                    },
                    scheduleWriteOverride = null,
                    dragState = null,
                    selectedBooking = if (closeDetail) null else _state.value.selectedBooking,
                )
                loadBookingsForDateRange()
            }.onFailure { e ->
                val code = (e as? BookingRequestRefusedException)?.code
                _state.value = _state.value.copy(
                    scheduleWriteInFlight = false,
                    scheduleWriteError = e.message ?: "That visit could not be moved.",
                    scheduleWriteOverride = overridableScheduleRefusal(code, alreadyOverridden = override != null),
                    dragState = null,
                )
                pendingScheduleRetry = PendingScheduleWrite.Move(booking, startIso, endIso, closeDetail)
            }
        }
    }

    /** One refusal that never reached the server: same banner, never a retry button. */
    private fun failScheduleWrite(message: String) {
        pendingScheduleRetry = null
        _state.value = _state.value.copy(
            scheduleWriteInFlight = false,
            scheduleWriteError = message,
            scheduleWriteOverride = null,
            dragState = null,
        )
    }

    /**
     * The write a "Block anyway" / "Move anyway" press re-sends.
     *
     * Held here rather than in [SchedulingState] because it is not something the
     * screen renders: the screen renders [SchedulingState.scheduleWriteOverride],
     * which is what decides whether the button is drawn at all.
     */
    private sealed interface PendingScheduleWrite {
        data class Block(val window: BlockWindow) : PendingScheduleWrite
        data class Move(
            val booking: EnhancedBooking,
            val startIso: String,
            val endIso: String,
            val closeDetail: Boolean,
        ) : PendingScheduleWrite
    }

    private var pendingScheduleRetry: PendingScheduleWrite? = null

    /**
     * Take the override the last refusal offered, and only that one.
     *
     * A no-op when [SchedulingState.scheduleWriteOverride] is null, which is the
     * whole point: a company closure and a Google Calendar mirror leave it null,
     * so there is nothing here for a stray press to send. The retry is offered
     * once — the refusal that comes back from it carries
     * `alreadyOverridden = true` into `overridableScheduleRefusal`, which
     * returns null, so the same losing move is never offered twice.
     */
    fun retryScheduleWriteWithOverride() {
        val kind = _state.value.scheduleWriteOverride ?: return
        when (val pending = pendingScheduleRetry) {
            is PendingScheduleWrite.Block -> submitBlock(pending.window, overrideVisitConflict = true)
            is PendingScheduleWrite.Move ->
                moveVisit(pending.booking, pending.startIso, pending.endIso, override = kind, closeDetail = pending.closeDetail)
            null -> Unit
        }
    }

    /** Dismiss the schedule-write banner. Clears the retry with it: the offer goes when the sentence does. */
    fun clearScheduleWriteFeedback() {
        pendingScheduleRetry = null
        _state.value = _state.value.copy(scheduleWriteError = null, scheduleWriteOverride = null)
    }

    // === Drag & Drop Functions ===

    fun startDragBooking(booking: EnhancedBooking, newStartTime: LocalDateTime) {
        val duration = try {
            val start = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            val end = LocalDateTime.parse(booking.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            java.time.Duration.between(start, end)
        } catch (e: Exception) {
            java.time.Duration.ofHours(1) // Default duration
        }

        val newEndTime = newStartTime.plus(duration)

        _state.value = _state.value.copy(
            dragState = DragState(
                draggedBooking = booking,
                newStartTime = newStartTime,
                newEndTime = newEndTime
            )
        )
    }

    fun updateDragPosition(newStartTime: LocalDateTime) {
        val currentDragState = _state.value.dragState ?: return

        val duration = try {
            java.time.Duration.between(
                LocalDateTime.parse(currentDragState.draggedBooking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                LocalDateTime.parse(currentDragState.draggedBooking.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            )
        } catch (e: Exception) {
            java.time.Duration.ofHours(1)
        }

        val newEndTime = newStartTime.plus(duration)

        _state.value = _state.value.copy(
            dragState = currentDragState.copy(
                newStartTime = newStartTime,
                newEndTime = newEndTime
            )
        )
    }

    /**
     * #575: a dropped drag is a reschedule, and goes down the SAME path the
     * detail sheet's Reschedule form does.
     *
     * WHAT IT USED TO DO: build a whole [EnhancedBooking] with new times and
     * hand it to [updateBooking], which bare-`set()`s the envelope document
     * straight from the client. That wrote no session at all, so the visit
     * itself never moved; it ran none of the server's guards (a closed day, a
     * Google busy import, a visit already in the slot); and it was a
     * whole-document replace built from screen state, which is the rebuild-write
     * this repo has been bitten by before.
     *
     * A DROP BACK WHERE THE VISIT ALREADY WAS WRITES NOTHING — no callable, no
     * audit entry, no "rescheduled" event for a move nobody made. Web's
     * `isNoOpDrop` makes the same call for the same reason.
     */
    fun completeDrag() {
        val dragState = _state.value.dragState ?: return
        val startIso = dragState.newStartTime.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val endIso = dragState.newEndTime.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val booking = dragState.draggedBooking
        if (startIso == booking.startDateTime) {
            _state.value = _state.value.copy(dragState = null)
            return
        }
        moveVisit(booking, startIso, endIso, override = null, closeDetail = false)
    }

    fun cancelDrag() {
        _state.value = _state.value.copy(dragState = null)
    }

    // === Time Slot Management ===

    /**
     * #574: block a window, validating what the operator typed BEFORE anything
     * goes out, then writing through `createBlockedTimeSlot`.
     *
     * The old path took a already-parsed `LocalDate` and two unchecked strings,
     * and the screen that fed it fell back to `LocalDate.now()` whenever the
     * date would not parse — so a typo blocked out TODAY, silently, on a day the
     * operator may well be working. Every refusal [resolveBlockWindow] can
     * return is a defect that shipped; the parse now lives in one place both
     * block-time surfaces call.
     */
    fun blockTimeSlot(
        dateText: String,
        startTime: String,
        endTime: String,
        reason: String,
        mode: BlockMode = BlockMode.TIME_BLOCK,
    ) {
        when (val resolved = resolveBlockWindow(dateText, startTime, endTime, reason, mode)) {
            is BlockWindowResult.Problem -> failScheduleWrite(resolved.message)
            is BlockWindowResult.Ok -> submitBlock(resolved.window, overrideVisitConflict = false)
        }
    }

    private fun submitBlock(window: BlockWindow, overrideVisitConflict: Boolean) {
        if (_state.value.scheduleWriteInFlight) return
        _state.value = _state.value.copy(
            scheduleWriteInFlight = true,
            scheduleWriteError = null,
            scheduleWriteOverride = null,
        )
        viewModelScope.launch {
            bookingRepository.createBlockedTimeSlot(
                date = window.date,
                startTime = window.startTime,
                endTime = window.endTime,
                notes = window.notes.ifBlank { "Blocked" },
                startTimeMs = window.startTimeMs,
                endTimeMs = window.endTimeMs,
                overrideVisitConflict = overrideVisitConflict,
            ).onSuccess { docId ->
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope            = viewModelScope,
                    repository       = auntieRepository,
                    actionType       = "BLOCK_TIME_SLOT",
                    description      = "Blocked ${window.date} ${window.startTime}-${window.endTime}" +
                        (if (window.notes.isNotBlank()) " (${window.notes})" else "") +
                        (if (overrideVisitConflict) " (override: visit conflict)" else ""),
                    targetId         = docId,
                    targetCollection = "booking_time_slots",
                )
                pendingScheduleRetry = null
                _state.value = _state.value.copy(
                    scheduleWriteInFlight = false,
                    scheduleWriteError = null,
                    scheduleWriteOverride = null,
                )
                loadBookingsForDateRange()
            }.onFailure { e ->
                val code = (e as? BookingRequestRefusedException)?.code
                _state.value = _state.value.copy(
                    scheduleWriteInFlight = false,
                    scheduleWriteError = e.message ?: "That time could not be blocked.",
                    // Narrowed to the VISIT clash on purpose: `createBlockedTimeSlot`
                    // has no busy-import guard and therefore no `overrideBusyConflict`
                    // argument, so a "Block anyway" for that code would re-send the
                    // identical request. Same narrowing the web dialog makes.
                    scheduleWriteOverride = overridableScheduleRefusal(code, alreadyOverridden = overrideVisitConflict)
                        ?.takeIf { it == ScheduleOverrideKind.VISIT },
                )
                pendingScheduleRetry = PendingScheduleWrite.Block(window)
            }
        }
    }

    /**
     * #574: unblock a window, THROUGH the callable.
     *
     * This used to be a client `booking_time_slots/{id}.delete()`, denied by
     * `firestore.rules` on every tap it ever took. A Google Calendar mirror is
     * refused by the server (the next sync writes it straight back) and the two
     * lists that draw Unblock no longer offer it on those rows at all, so the
     * refusal is a backstop rather than the operator's first news of it.
     */
    fun unblockTimeSlot(timeSlotId: String) {
        if (_state.value.scheduleWriteInFlight) return
        _state.value = _state.value.copy(
            scheduleWriteInFlight = true,
            scheduleWriteError = null,
            scheduleWriteOverride = null,
        )
        viewModelScope.launch {
            bookingRepository.deleteBlockedTimeSlot(timeSlotId)
                .onSuccess {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = auntieRepository,
                        actionType       = "UNBLOCK_TIME_SLOT",
                        description      = "Unblocked time slot",
                        targetId         = timeSlotId,
                        targetCollection = "booking_time_slots",
                    )
                    pendingScheduleRetry = null
                    _state.value = _state.value.copy(scheduleWriteInFlight = false)
                    loadBookingsForDateRange()
                }
                .onFailure { e ->
                    // No override exists for either refusal this can return
                    // (a Google mirror, a missing document), so no retry is offered.
                    pendingScheduleRetry = null
                    _state.value = _state.value.copy(
                        scheduleWriteInFlight = false,
                        scheduleWriteError = e.message ?: "That block could not be removed.",
                        scheduleWriteOverride = null,
                    )
                }
        }
    }

    /**
     * Slice 8: trigger the server-side Google Calendar busy import. The Cloud
     * Function reads the shared calendar via ADC and writes the BLOCKED slots, so
     * the client only invokes the callable and surfaces the outcome. The server's
     * fail-loud message (which NAMES the sync service account when the calendar is
     * not shared) is routed verbatim into [SchedulingState.errorMessage].
     */
    fun importGoogleBusyEvents(lookAheadDays: Int = 30) {
        viewModelScope.launch {
            // The callable resolves the calendar id server-side from the SAVED
            // business_settings value, so this checks the saved one, not a draft
            // still in the field. Refusing here means a typo can never come back
            // as "Imported 0 busy blocks", which reads as an empty calendar.
            // The callable enforces the same rule; this only saves a round trip.
            val problem = calendarIdProblem(_state.value.businessSettings.calendarSyncId)
            if (problem != null) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    calendarSyncMessage = null,
                    errorMessage = problem
                )
                return@launch
            }
            _state.value = _state.value.copy(isLoading = true, errorMessage = null, calendarSyncMessage = null)
            val result = bookingRepository.syncGoogleBusyEventsViaServer(lookAheadDays)
            // Re-read the receipt either way: the server stamps a FAILED run too,
            // and that stamp is what the card shows after the transient banner is
            // dismissed or the screen is left and reopened.
            val run = auntieRepository.getCalendarSyncRun().getOrNull()
            if (result.isSuccess) {
                val importedCount = result.getOrNull() ?: 0
                loadBookingsForDateRange()
                _state.value = _state.value.copy(
                    isLoading = false,
                    calendarSyncRun = run,
                    calendarSyncMessage = "Imported $importedCount busy blocks."
                )
                Log.d("EnhancedSchedulingViewModel", "Server imported $importedCount busy events")
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    calendarSyncRun = run,
                    errorMessage = result.exceptionOrNull()?.message
                        ?: "Failed to import Google busy events."
                )
            }
        }
    }

    /** Clears the transient calendar-sync feedback (success + error). */
    fun clearCalendarSyncFeedback() {
        _state.value = _state.value.copy(calendarSyncMessage = null, errorMessage = null, calendarSyncIdSaved = false)
    }

    /**
     * Front-facing Google Calendar id setup. Persists [calendarSyncId] onto the
     * business_settings doc via AuntieRepository so the server-side sync resolves
     * the admin-entered id (no operator secret needed). Trims input; fail-loud on
     * a failed write. Auth model is unchanged: the admin still shares the calendar
     * with the pinned sync service account.
     */
    fun saveCalendarSyncId(calendarSyncId: String) {
        viewModelScope.launch {
            // Refuse a shape that cannot work before it reaches the doc. Saving
            // it would leave the sync pointed at nothing and reporting success
            // with zero imports, which is indistinguishable from a clear
            // calendar. Mirrors the callable's own rule (CalendarSyncId.kt).
            val problem = calendarIdProblem(calendarSyncId)
            if (problem != null) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    calendarSyncIdSaved = false,
                    errorMessage = problem
                )
                return@launch
            }
            _state.value = _state.value.copy(isLoading = true, errorMessage = null, calendarSyncIdSaved = false)
            val updated = _state.value.businessSettings.copy(calendarSyncId = calendarSyncId.trim())
            val result = saveSettingsDiff(updated)
            if (result.isSuccess) {
                // ONLY when a write actually went out. Re-saving the id the doc
                // already holds diffs to nothing and sends nothing, and an audit
                // entry for it would claim a change that never happened - the
                // same lie a moved `updatedAt` tells, one collection over.
                if (result.getOrDefault(false)) {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = auntieRepository,
                        actionType       = "UPDATE_BUSINESS_SETTINGS",
                        description      = "Set Google Calendar sync id",
                        targetId         = "business_settings",
                        targetCollection = "business_settings",
                    )
                }
                _state.value = _state.value.copy(
                    isLoading = false,
                    businessSettings = updated,
                    calendarSyncIdSaved = true
                )
            } else {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = "Failed to save calendar id: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    // === Google Calendar over OAuth (Task 7.2) ===
    //
    // A DIFFERENT FEATURE from the free/busy sync above (saveCalendarSyncId /
    // importGoogleBusyEvents), sharing nothing but the word calendar. See
    // GoogleCalendarTargets.kt and CALLABLE_CONTRACT.md.

    private fun gcalUpdate(update: (GoogleCalendarUiState) -> GoogleCalendarUiState) {
        _state.value = _state.value.copy(googleCalendar = update(_state.value.googleCalendar))
    }

    /** Loads the current connection + free/busy target. Safe to call repeatedly (screen open, resume). */
    fun loadGoogleCalendarState() {
        gcalUpdate { it.copy(loadingConnection = true, error = null) }
        viewModelScope.launch {
            bookingRepository.getGoogleCalendarConnection()
                .onSuccess { result ->
                    gcalUpdate {
                        it.copy(
                            loadingConnection = false,
                            connection = result.connection,
                            freeBusyCalendarId = result.freeBusyCalendarId,
                            redirectUri = result.redirectUri.ifBlank { it.redirectUri },
                        )
                    }
                    if (result.connection.connected) refreshGoogleCalendars()
                }
                .onFailure { e ->
                    gcalUpdate {
                        it.copy(
                            loadingConnection = false,
                            error = e.message ?: "Couldn't load the Google Calendar connection.",
                        )
                    }
                }
        }
    }

    /** Re-reads only the connection doc (receipt fields, disconnect/error state), no calendar list refresh. */
    private fun refreshGoogleCalendarConnectionOnly() {
        viewModelScope.launch {
            bookingRepository.getGoogleCalendarConnection().onSuccess { result ->
                gcalUpdate {
                    it.copy(connection = result.connection, freeBusyCalendarId = result.freeBusyCalendarId)
                }
            }
        }
    }

    /**
     * Starts the OAuth flow: mints the consent URL and sets [GoogleCalendarUiState.pendingAuthUrl]
     * for the screen to open in a browser, then begins polling for the outcome.
     * On failure (most commonly `google_oauth_not_configured`) the server's
     * message is routed verbatim: it names the missing secret and the exact
     * `firebase functions:secrets:set` command, which is the whole point of
     * that message and must not be replaced with a summary.
     */
    fun connectGoogleCalendar() {
        if (_state.value.googleCalendar.connecting || _state.value.googleCalendar.polling) return
        gcalUpdate { it.copy(connecting = true, error = null, pollTimedOut = false) }
        viewModelScope.launch {
            bookingRepository.startGoogleCalendarConnect()
                .onSuccess { start ->
                    gcalUpdate {
                        it.copy(
                            connecting = false,
                            pendingAuthUrl = start.authUrl,
                            redirectUri = start.redirectUri.ifBlank { it.redirectUri },
                        )
                    }
                    pollForGoogleCalendarConnection()
                }
                .onFailure { e ->
                    gcalUpdate {
                        it.copy(
                            connecting = false,
                            error = e.message ?: "Couldn't start the Google Calendar connection.",
                        )
                    }
                }
        }
    }

    /**
     * Consumed by the screen the instant it has launched the browser for
     * [GoogleCalendarUiState.pendingAuthUrl], so a later recomposition (a
     * rotation, another state update while the tab is open) can never
     * re-launch the same one-time consent URL a second time.
     */
    fun consumeGoogleCalendarAuthUrl() {
        gcalUpdate { it.copy(pendingAuthUrl = null) }
    }

    /**
     * Polls [BookingRepository.getGoogleCalendarConnection] every
     * [GOOGLE_CALENDAR_POLL_INTERVAL_MS] for up to [GOOGLE_CALENDAR_POLL_MAX_ATTEMPTS]
     * attempts (~2 minutes), because the consent screen runs in a window this
     * app cannot read the result of directly.
     *
     * NEVER CLAIMS SUCCESS IT HAS NOT OBSERVED: the loop only reports connected
     * on a poll response whose `connection.connected` is actually true. If the
     * window ends first, [GoogleCalendarUiState.pollTimedOut] is set and
     * whatever `connectLastError` the callback itself stamped (a declined
     * consent, an exchange failure) is surfaced, because the server records
     * that receipt precisely for this moment: the window that started the flow
     * cannot read the callback's own outcome any other way.
     */
    private fun pollForGoogleCalendarConnection() {
        viewModelScope.launch {
            gcalUpdate { it.copy(polling = true, pollTimedOut = false) }
            repeat(GOOGLE_CALENDAR_POLL_MAX_ATTEMPTS) { _ ->
                delay(GOOGLE_CALENDAR_POLL_INTERVAL_MS)
                val result = bookingRepository.getGoogleCalendarConnection().getOrNull()
                if (result != null) {
                    gcalUpdate {
                        it.copy(connection = result.connection, freeBusyCalendarId = result.freeBusyCalendarId)
                    }
                    if (result.connection.connected) {
                        gcalUpdate { it.copy(polling = false) }
                        refreshGoogleCalendars()
                        return@launch
                    }
                }
            }
            val lastError = _state.value.googleCalendar.connection?.connectLastError?.takeIf { it.isNotBlank() }
            gcalUpdate { it.copy(polling = false, pollTimedOut = true, error = lastError) }
        }
    }

    /** Calendars on the connected account, for the picker. */
    fun refreshGoogleCalendars() {
        viewModelScope.launch {
            bookingRepository.listGoogleCalendars()
                .onSuccess { result ->
                    gcalUpdate {
                        it.copy(
                            calendars = result.calendars,
                            connection = result.connection,
                            freeBusyCalendarId = result.freeBusyCalendarId,
                            error = null,
                        )
                    }
                }
                .onFailure { e ->
                    gcalUpdate { it.copy(error = e.message ?: "Couldn't list the calendars on this account.") }
                }
        }
    }

    /**
     * Saves the write target. [writeCalendarProblem] (GoogleCalendarTargets.kt)
     * is checked here first so an echo-loop pick is refused before the round
     * trip; the callable enforces the same rule and its message is what
     * surfaces if this mirror ever disagrees with it.
     */
    fun saveGoogleCalendarTargets(writeCalendarId: String, enabledCalendarIds: List<String>) {
        val gcal = _state.value.googleCalendar
        if (gcal.savingTargets) return
        val problem = writeCalendarProblem(writeCalendarId, gcal.freeBusyCalendarId, gcal.connection?.googleAccountEmail ?: "")
        if (problem != null) {
            gcalUpdate { it.copy(error = problem) }
            return
        }
        gcalUpdate { it.copy(savingTargets = true, error = null) }
        viewModelScope.launch {
            bookingRepository.setGoogleCalendarTargets(writeCalendarId, enabledCalendarIds)
                .onSuccess { connection ->
                    gcalUpdate { it.copy(savingTargets = false, connection = connection) }
                }
                .onFailure { e ->
                    gcalUpdate {
                        it.copy(savingTargets = false, error = e.message ?: "Couldn't save the calendar target.")
                    }
                }
        }
    }

    /**
     * Pushes upcoming visits to the connected calendar. The connection's
     * receipt fields are re-read afterward EITHER WAY: a failed push is
     * stamped server-side too, and that stamp is what the card shows after the
     * transient error banner is dismissed or the screen is reopened, same
     * reasoning as 7.1's importGoogleBusyEvents.
     */
    fun pushGoogleCalendarVisits(lookAheadDays: Int = 30) {
        val gcal = _state.value.googleCalendar
        if (gcal.pushing) return
        gcalUpdate { it.copy(pushing = true, error = null) }
        viewModelScope.launch {
            bookingRepository.pushVisitsToGoogleCalendar(lookAheadDays)
                .onSuccess { result ->
                    gcalUpdate { it.copy(pushing = false, pushSkipped = result.skipped) }
                    refreshGoogleCalendarConnectionOnly()
                }
                .onFailure { e ->
                    gcalUpdate {
                        it.copy(pushing = false, error = e.message ?: "Couldn't push visits to Google Calendar.")
                    }
                    refreshGoogleCalendarConnectionOnly()
                }
        }
    }

    /**
     * Revokes at Google, then clears our copy. Does NOT remove any event
     * already written to Google; the server holds no delete-on-disconnect step
     * and the UI copy says so plainly. If Google did not confirm the revoke,
     * [GoogleCalendarDisconnectResult.revokeError] is surfaced rather than a
     * clean "disconnected" message, because AuntieOS may still be listed as
     * having access on the operator's Google account.
     */
    fun disconnectGoogleCalendar() {
        val gcal = _state.value.googleCalendar
        if (gcal.disconnecting) return
        gcalUpdate { it.copy(disconnecting = true, error = null) }
        viewModelScope.launch {
            bookingRepository.disconnectGoogleCalendar()
                .onSuccess { result ->
                    gcalUpdate {
                        it.copy(
                            disconnecting = false,
                            connection = result.connection,
                            calendars = emptyList(),
                            error = if (result.revoked) null else result.revokeError,
                        )
                    }
                }
                .onFailure { e ->
                    gcalUpdate {
                        it.copy(disconnecting = false, error = e.message ?: "Couldn't disconnect Google Calendar.")
                    }
                }
        }
    }

    fun clearGoogleCalendarError() {
        gcalUpdate { it.copy(error = null) }
    }

    // === Dialog Management ===

    fun showAddBookingDialog() {
        _state.value = _state.value.copy(showAddBookingDialog = true)
    }

    fun hideAddBookingDialog() {
        _state.value = _state.value.copy(showAddBookingDialog = false)
    }

    fun showNewRequestDialog() {
        _state.value = _state.value.copy(
            showNewRequestDialog = true,
            newRequestError = null,
            newRequestBusyOverridable = false,
        )
    }

    fun hideNewRequestDialog() {
        if (_state.value.newRequestInFlight) return
        _state.value = _state.value.copy(
            showNewRequestDialog = false,
            newRequestError = null,
            newRequestBusyOverridable = false,
            newRequestKin = emptyList(),
            newRequestKinError = null,
            newRequestKinLoading = false,
        )
    }

    /**
     * D1 wizard step 1: the kin on [kinfolkId], for the optional `kinIds` chips.
     *
     * Only the ACTIVE kin, matching `KinCareRepository.createKinCareSession`'s
     * own `status == "active"` filter, so the wizard cannot put a kin on a
     * booking that the session writer would then drop.
     *
     * A blank id (the operator cleared the household) empties the list rather
     * than reading the whole roster.
     */
    fun loadKinForNewRequest(kinfolkId: String) {
        if (kinfolkId.isBlank()) {
            _state.value = _state.value.copy(
                newRequestKin = emptyList(),
                newRequestKinLoading = false,
                newRequestKinError = null,
            )
            return
        }
        _state.value = _state.value.copy(newRequestKinLoading = true, newRequestKinError = null)
        viewModelScope.launch {
            auntieRepository.getKin(kinfolkId)
                .onSuccess { kin ->
                    _state.value = _state.value.copy(
                        newRequestKin = kin.filter { it.status == "active" },
                        newRequestKinLoading = false,
                        newRequestKinError = null,
                    )
                }
                .onFailure { t ->
                    _state.value = _state.value.copy(
                        newRequestKin = emptyList(),
                        newRequestKinLoading = false,
                        newRequestKinError = t.message
                            ?: "The Kin roster could not be read. The booking still covers the whole household.",
                    )
                }
        }
    }

    /**
     * AO-25: create a multi-date / recurring booking REQUEST via
     * [BookingRepository.createMultiDateBookingRequest]. On success the request
     * enters the Incoming-requests queue ([incomingKinCareRequestsStream], a live
     * listener, so the new envelope appears without a manual refresh); the dialog
     * closes and [seriesActionMessage] reports the count. Fail-loud on rejection.
     */
    fun createBookingRequest(
        kinfolkId: String,
        visits: List<com.tribetails.auntieos.data.repository.NewBookingVisit>,
        notes: String?,
        pattern: String,
        weeklyDays: List<Int>?,
        overrideBusyConflict: Boolean = false,
        // D1: the three fields the five-step wizard added. Defaulted to null so
        // the AO-25 call shape stays valid and the callable keeps receiving the
        // same payload it always did from any caller that has no wizard.
        kinIds: List<String>? = null,
        billing: CreateMultiDateBookingRequestArgsBilling? = null,
        communication: CreateMultiDateBookingRequestArgsCommunication? = null,
    ) {
        if (_state.value.newRequestInFlight) return
        _state.value = _state.value.copy(
            newRequestInFlight = true,
            newRequestError = null,
            newRequestBusyOverridable = false,
        )
        // #644: one key per submission, not per press. Held while the booking
        // being submitted is unchanged, so the automatic retry inside the
        // repository AND an operator pressing Create again both name the booking
        // the first attempt may already have made. Re-minted the moment the
        // booking itself changes, because a held key would otherwise replay the
        // OLD booking and report it as the new one.
        //
        // `overrideBusyConflict` is deliberately NOT part of the signature: a
        // refusal wrote nothing, so "Create anyway" is the same submission, and
        // if that refusal had in fact been a lost reply the shared key is what
        // stops the override booking it twice.
        val idempotencyKey = requestKeyFor(
            listOf(kinfolkId, visits, notes, pattern, weeklyDays, kinIds, billing, communication).toString(),
        )
        viewModelScope.launch {
            bookingRepository.createMultiDateBookingRequest(
                kinfolkId = kinfolkId,
                visits = visits,
                notes = notes,
                pattern = pattern,
                weeklyDays = weeklyDays,
                kinIds = kinIds?.takeIf { it.isNotEmpty() },
                billing = billing,
                communication = communication,
                overrideBusyConflict = overrideBusyConflict,
                idempotencyKey = idempotencyKey,
            ).onSuccess { result ->
                pendingRequestKey = null
                _state.value = _state.value.copy(
                    newRequestInFlight = false,
                    showNewRequestDialog = false,
                    newRequestBusyOverridable = false,
                    newRequestKin = emptyList(),
                    newRequestKinError = null,
                    seriesActionMessage = "Booking request created: ${result.visitCount} visit(s) submitted for approval. " +
                        "It enters the Incoming-requests queue and appears above once approved.",
                )
            }.onFailure { t ->
                // A busy clash is the only refusal the operator can knowingly
                // override, and only when they have not already overridden it:
                // re-offering "Create anyway" after an override already failed
                // would be offering the same losing move twice.
                val busy = !overrideBusyConflict &&
                    (t as? BookingRequestRefusedException)?.code == BOOKING_BUSY_CONFLICT_CODE
                _state.value = _state.value.copy(
                    newRequestInFlight = false,
                    newRequestError = t.message ?: "Failed to create the booking request.",
                    newRequestBusyOverridable = busy,
                )
            }
        }
    }

    /** #644: the submission signature this key was minted for, and the key. */
    private var pendingRequestKey: Pair<String, String>? = null

    private fun requestKeyFor(signature: String): String {
        pendingRequestKey?.let { (held, key) -> if (held == signature) return key }
        val minted = mintBookingIdempotencyKey()
        pendingRequestKey = signature to minted
        return minted
    }

    fun selectBooking(booking: EnhancedBooking?) {
        _state.value = _state.value.copy(selectedBooking = booking)
    }

    fun resolveConflict(forceCreate: Boolean = false) {
        if (forceCreate) {
            // Force despite conflicts. If the selectedBooking already has an id,
            // the conflict came from updateBooking (e.g. drag-drop edit) - UPDATE
            // not CREATE, otherwise we'd duplicate the doc.
            val booking = _state.value.selectedBooking ?: return
            val isUpdate = booking.id.isNotBlank()

            viewModelScope.launch {
                val result = if (isUpdate) {
                    bookingRepository.updateBooking(booking)
                        .map { booking.id }
                } else {
                    // The operator already chose "Force Create" past a shown
                    // conflict; that IS the deliberate override, so the busy-import
                    // guard the repository would otherwise run is skipped.
                    bookingRepository.createBooking(booking, overrideBusyConflict = true)
                }

                if (result.isSuccess) {
                    val targetId = result.getOrNull().orEmpty()
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope            = viewModelScope,
                        repository       = auntieRepository,
                        actionType       = if (isUpdate) "FORCE_UPDATE_BOOKING" else "FORCE_CREATE_BOOKING",
                        description      = "Force-${if (isUpdate) "updated" else "created"} booking despite conflict (${_state.value.conflictingBookings.size} conflicting bookings)",
                        targetId         = targetId,
                        targetCollection = "enhanced_bookings",
                    )
                    loadBookingsForDateRange()
                } else {
                    _state.value = _state.value.copy(
                        errorMessage = "Failed to force-${if (isUpdate) "update" else "create"} booking: ${result.exceptionOrNull()?.message}"
                    )
                }

                _state.value = _state.value.copy(
                    showConflictDialog = false,
                    conflictingBookings = emptyList(),
                    availabilityResult = null,
                    selectedBooking = null
                )
            }
        } else {
            // Cancel the conflicting booking action
            _state.value = _state.value.copy(
                showConflictDialog = false,
                conflictingBookings = emptyList(),
                availabilityResult = null,
                selectedBooking = null
            )
        }
    }

    fun clearError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    private suspend fun findLinkedSessionIds(sourceBookingId: String): Result<List<String>> =
        kinCareRepository.getKinCareSessionsBySourceBookingId(sourceBookingId)
            .map { sessions ->
                sessions
                    .filter { it.status.uppercase() != VisitStatus.CANCELLED.name }
                    .map { it.id }
            }

    /**
     * A3: cancelling the booking cancels its linked sessions THROUGH THE
     * `transitionBookingStatus` CALLABLE, not through a direct status patch.
     *
     * This used to write `{status: CANCELLED, notes: ...}` straight to
     * `kin_care_sessions` via [KinCareRepository.patchKinCareSession]. That was
     * one of the four unaudited status writes A3 closed, and `firestore.rules`
     * now refuses it from any client. Two consequences worth naming:
     *
     *  - The server runs the state machine, so a session that is already
     *    COMPLETED is REFUSED here rather than silently overwritten. That is
     *    the intended behaviour: a visit that was performed does not become
     *    un-performed because the booking envelope was later called off.
     *    [findLinkedSessionIds] already skips CANCELLED ones.
     *  - The reason line is composed server-side, onto the SESSION's own notes.
     *    The old client version built it from the ENVELOPE booking's notes and
     *    wrote the result over the session's, discarding whatever the session
     *    had recorded.
     */
    private suspend fun bridgeCancellationToSession(booking: EnhancedBooking, reason: String): Result<Unit> {
        val sessionIds = findLinkedSessionIds(booking.id).getOrElse { return Result.failure(it) }
        if (sessionIds.isEmpty()) return Result.success(Unit)

        sessionIds.forEach { sessionId ->
            kinCareRepository.cancelSession(sessionId, reason)
                .onFailure { e ->
                    Log.e("EnhancedSchedulingVM", "Failed to cancel linked KinCareSession $sessionId", e)
                    return Result.failure(e)
                }
        }
        return Result.success(Unit)
    }

    /**
     * Apply an in-place edit to the unified [BusinessSettings] and persist the
     * fields [update] actually changed. Replaces the former AdminSettings
     * updater; booking config now lives on the single business_settings doc,
     * shared with the Settings screen, Service Management and the React admin,
     * which is why only the diff goes out (see [saveSettingsDiff]).
     *
     * Fail-loud: this used to discard the write result entirely, so a rejected
     * settings write left the screen showing an edit the server never took.
     */
    fun updateBusinessSettings(update: (BusinessSettings) -> BusinessSettings) {
        val newSettings = update(_state.value.businessSettings)
        _state.value = _state.value.copy(businessSettings = newSettings)
        viewModelScope.launch {
            saveSettingsDiff(newSettings).onFailure { e ->
                _state.value = _state.value.copy(
                    errorMessage = "Failed to save settings: ${e.message}"
                )
            }
        }
    }

    // === Utility Functions ===

    fun getBookingsForDate(date: LocalDate): List<EnhancedBooking> {
        return _state.value.bookings.filter { booking ->
            try {
                val bookingDate = LocalDateTime.parse(
                    booking.startDateTime,
                    DateTimeFormatter.ISO_LOCAL_DATE_TIME
                ).toLocalDate()
                bookingDate == date
            } catch (e: Exception) {
                false
            }
        }
    }

    fun getTimeSlotsForDate(date: LocalDate): List<BookingTimeSlot> {
        val dateString = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        return _state.value.timeSlots.filter { it.date == dateString }
    }

    fun isTimeSlotAvailable(date: LocalDate, startTime: String, endTime: String): Boolean {
        val dateString = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        val requestedStart = runCatching { LocalDateTime.of(date, LocalTime.parse(startTime)) }.getOrNull() ?: return false
        val requestedEnd = runCatching { LocalDateTime.of(date, LocalTime.parse(endTime)) }.getOrNull() ?: return false

        val blockedSlots = _state.value.timeSlots.filter {
            it.date == dateString && !it.isAvailable
        }
        val blockedConflict = blockedSlots.any { slot ->
            val slotStart = runCatching { LocalDateTime.of(date, LocalTime.parse(slot.startTime)) }.getOrNull() ?: return@any false
            val slotEnd = runCatching { LocalDateTime.of(date, LocalTime.parse(slot.endTime)) }.getOrNull() ?: return@any false
            intervalsOverlap(requestedStart, requestedEnd, slotStart, slotEnd)
        }

        val bookingConflict = getBookingsForDate(date)
            .filter { it.status == BookingStatus.DRAFT || it.status == BookingStatus.ACCEPTED }
            .any { booking ->
                val bookingStart = runCatching { LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }.getOrNull() ?: return@any false
                val bookingEnd = runCatching { LocalDateTime.parse(booking.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }.getOrNull() ?: return@any false
                intervalsOverlap(requestedStart, requestedEnd, bookingStart, bookingEnd)
            }

        return !blockedConflict && !bookingConflict
    }

    private fun intervalsOverlap(
        startA: LocalDateTime,
        endA: LocalDateTime,
        startB: LocalDateTime,
        endB: LocalDateTime
    ): Boolean = startA.isBefore(endB) && endA.isAfter(startB)

    // === Legacy Event Conversion for Existing UI ===

    fun getEventsForCompatibility(): List<Event> {
        return _state.value.bookings.map { booking ->
            try {
                val startTime = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                val endTime = LocalDateTime.parse(booking.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)

                Event(
                    id = booking.id,
                    title = booking.title,
                    startTime = startTime,
                    endTime = endTime,
                    eventType = EventType.KIN_CARE,
                    status = booking.status,
                    notes = booking.notes,
                    kinName = booking.kinNames.joinToString(", ")
                )
            } catch (e: Exception) {
                Event(
                    id = booking.id,
                    title = booking.title,
                    startTime = LocalDateTime.now(),
                    endTime = LocalDateTime.now().plusHours(1),
                    eventType = EventType.KIN_CARE,
                    status = BookingStatus.DRAFT,
                    kinName = booking.kinfolkName
                )
            }
        }
    }
}
