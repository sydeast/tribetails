package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgs
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsBilling
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsCommunication
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsVisit
import com.tribetails.auntieos.data.contracts.decodeCreateMultiDateBookingRequestResult
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class BookingRepository(
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
) {

    // === Enhanced Bookings ===

    /**
     * [overrideBusyConflict] mirrors the server's `overrideBusyConflict` arg
     * (`createMultiDateBookingRequest.ts`): this repository writes straight to
     * Firestore with no callable in between, so rules cannot express the
     * overlap check a server would otherwise run, and [assertNoBookingBusyConflict]
     * runs here instead. Defaults false; the one caller that sets it true is
     * [EnhancedSchedulingViewModel.resolveConflict]'s "Force Create", the
     * existing deliberate override affordance this mirrors.
     *
     * C1: also checked against `companyHolidays` (`assertNoCompanyHolidayConflict`,
     * `CompanyHolidayConflict.kt`), unconditionally -- no override parameter
     * for that one; see its header for why.
     */
    suspend fun createBooking(booking: EnhancedBooking, overrideBusyConflict: Boolean = false): Result<String> = runCatching {
        AuntieLog.i("Creating enhanced booking for kinfolk: ${booking.kinfolkId}")
        if (!overrideBusyConflict) {
            assertNoBookingBusyConflict(firestore, booking.startDateTime, booking.endDateTime)
        }
        assertNoCompanyHolidayConflict(firestore, booking.startDateTime, booking.endDateTime)
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val bookingWithTimestamp = booking.copy(
            createdAt = now,
            updatedAt = now
        )

        val docRef = if (booking.id.isBlank()) {
            firestore.collection("enhanced_bookings").document()
        } else {
            firestore.collection("enhanced_bookings").document(booking.id)
        }

        docRef.set(bookingWithTimestamp).await()
        AuntieLog.i("Enhanced booking created/updated with ID: ${docRef.id}")
        docRef.id
    }.onFailure { AuntieLog.e("Error creating enhanced booking", it) }

    /**
     * AO-25: admin multi-date / recurring booking REQUEST, via the
     * createMultiDateBookingRequest callable. Writes the ENVELOPE model
     * (families/{kinfolkId}/bookings/{batchId}) as 'requested', so the result
     * lands in [incomingKinCareRequestsStream] (the Incoming-requests queue) for
     * approval, NOT the enhanced_bookings collection [createBooking] writes.
     *
     * [visits] carry per-visit epoch-ms start times, so non-consecutive dates
     * need no special handling; a weekly recurrence is expanded to concrete
     * visits by the caller and flagged via [pattern] = "weekly" + [weeklyDays].
     * Times are LOCAL (the caller derives ms from the operator's wall-clock pick).
     *
     * DRIFT FIX (ADR-0003 follow-up): this used to build its own payload map by
     * hand, and that hand map never had a slot for `priceCents`, `billing`,
     * `communication` or `overrideBusyConflict` at all -- not "the UI doesn't
     * collect them yet", but "there was nowhere on the wire for them to go even
     * if it did." Now the payload is built through the generated
     * `CreateMultiDateBookingRequestArgs`/`...Visit`, which has a slot for
     * every one of those four.
     *
     * D1 filled three of them in. The five-step wizard (`NewBookingWizard.kt`)
     * collects the kin on the booking, the billing mode and the two
     * communication switches, so [kinIds], [billing] and [communication] carry
     * real operator input instead of a placeholder null. `priceCents` stays
     * null on purpose and is the one field no screen will ever fill:
     * `resolveService` overwrites a client price with the catalog's (NOTE-56).
     *
     * D1 also filled in a per-visit `location`, and that one is GONE as of
     * 2026-08-04 by operator ruling: addresses come from the household, so a
     * place field on a visit was an address override the booking has no
     * business holding. The callable no longer accepts the key.
     *
     * [overrideBusyConflict] is now really used: the wizard offers "Create
     * anyway" after a [BOOKING_BUSY_CONFLICT_CODE] refusal, the same knowing
     * override [EnhancedSchedulingViewModel.resolveConflict]'s Force Create
     * has always had on the direct-write path. A company-holiday refusal has
     * no equivalent and must not grow one; see `companyHolidayConflict.ts`.
     *
     * A rejection from the callable surfaces as [BookingRequestRefusedException]
     * carrying the server's `details.code`, so callers branch on a code rather
     * than on the wording of a sentence.
     */
    suspend fun createMultiDateBookingRequest(
        kinfolkId: String,
        visits: List<NewBookingVisit>,
        notes: String? = null,
        pattern: String = "individual",
        weeklyDays: List<Int>? = null,
        kinIds: List<String>? = null,
        billing: CreateMultiDateBookingRequestArgsBilling? = null,
        communication: CreateMultiDateBookingRequestArgsCommunication? = null,
        overrideBusyConflict: Boolean = false,
    ): Result<MultiDateBookingResult> = runCatching {
        require(visits.isNotEmpty()) { "At least one visit is required." }
        val args = CreateMultiDateBookingRequestArgs(
            kinfolkId = kinfolkId,
            kinIds = kinIds,
            notes = notes?.takeIf { it.isNotBlank() },
            pattern = pattern,
            weeklyDays = weeklyDays?.map { it.toLong() },
            visits = visits.map { v ->
                CreateMultiDateBookingRequestArgsVisit(
                    startTimeMs = v.startTimeMs,
                    endTimeMs = v.endTimeMs,
                    serviceId = v.serviceId?.takeIf { it.isNotBlank() },
                    serviceName = v.serviceName,
                    // Still null, and still honest: `resolveService` discards a
                    // client price (NOTE-56), so no screen collects one.
                    priceCents = null,
                )
            },
            billing = billing,
            communication = communication,
            overrideBusyConflict = overrideBusyConflict,
        )
        val raw = try {
            functions.getHttpsCallable("createMultiDateBookingRequest").call(args.toPayload()).await().data
        } catch (e: FirebaseFunctionsException) {
            // Translate at the boundary so nothing above this line has to know
            // about Firebase types to tell a busy conflict (overridable) from a
            // company holiday (not) from a plain bad argument.
            throw BookingRequestRefusedException(
                code = conflictCodeFrom(e.details),
                message = e.message ?: "The booking request was refused.",
            )
        }
        @Suppress("UNCHECKED_CAST")
        val result = decodeCreateMultiDateBookingRequestResult(raw as? Map<String, Any?>)
        MultiDateBookingResult(
            batchId = result.batchId,
            visitIds = result.visitIds,
            // The generated decoder fail-softs a missing/wrong-typed count to 0
            // rather than the caller's own visit count; a real response always
            // carries it, so 0 here would only ever be seen against a genuinely
            // broken response, which is exactly what should NOT be papered over
            // with a guessed number.
            visitCount = result.visitCount.toInt(),
        )
    }.onFailure { AuntieLog.e("BookingRepository.createMultiDateBookingRequest failed", it) }

    suspend fun getBookings(
        startDate: String? = null,
        endDate: String? = null,
        kinfolkId: String? = null,
        status: BookingStatus? = null
    ): Result<List<EnhancedBooking>> = runCatching {
        AuntieLog.d("Fetching bookings with filters - kinfolkId: $kinfolkId, status: $status")
        var query: Query = firestore.collection("enhanced_bookings")

        // Apply filters
        startDate?.let { query = query.whereGreaterThanOrEqualTo("startDateTime", normalizeDateStart(it)) }
        endDate?.let { query = query.whereLessThanOrEqualTo("startDateTime", normalizeDateEnd(it)) }
        kinfolkId?.let { query = query.whereEqualTo("kinfolkId", it) }
        status?.let { query = query.whereEqualTo("status", it.name) }

        val snapshot = query.orderBy("startDateTime").get().await()
        snapshot.toObjects(EnhancedBooking::class.java).also {
            AuntieLog.d("Retrieved ${it.size} enhanced bookings")
        }
    }.onFailure { AuntieLog.e("Error fetching enhanced bookings", it) }

    suspend fun getBookingById(bookingId: String): Result<EnhancedBooking?> = runCatching {
        AuntieLog.d("Fetching booking by ID: $bookingId")
        val document = firestore.collection("enhanced_bookings").document(bookingId).get().await()
        document.toObject(EnhancedBooking::class.java).also {
            if (it == null) AuntieLog.w("Booking $bookingId not found")
        }
    }.onFailure { AuntieLog.e("Error fetching booking $bookingId", it) }

    suspend fun updateBooking(booking: EnhancedBooking): Result<Unit> = runCatching {
        AuntieLog.i("Updating enhanced booking: ${booking.id}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val bookingWithTimestamp = booking.copy(updatedAt = now)

        firestore.collection("enhanced_bookings").document(booking.id)
            .set(bookingWithTimestamp).await()
        AuntieLog.d("Enhanced booking updated successfully")
        Unit
    }.onFailure { AuntieLog.e("Error updating booking ${booking.id}", it) }

    suspend fun deleteBooking(bookingId: String): Result<Unit> = runCatching {
        AuntieLog.w("Deleting enhanced booking: $bookingId")
        firestore.collection("enhanced_bookings").document(bookingId).delete().await()
        AuntieLog.i("Enhanced booking $bookingId deleted")
        Unit
    }.onFailure { AuntieLog.e("Error deleting booking $bookingId", it) }

    // Archive (reversible). Mirrors AuntieRepository.archiveKinfolk semantics:
    // status flip + archivedAt/archivedReason stamp, document remains in
    // Firestore. Default lists filter archivedAt != "" out.
    suspend fun archiveBooking(bookingId: String, reason: String, archivedBy: String = "admin"): Result<Unit> = runCatching {
        AuntieLog.i("Archiving booking: $bookingId (reason: $reason)")
        firestore.collection("enhanced_bookings").document(bookingId).update(
            mapOf(
                "archivedAt"     to java.time.Instant.now().toString(),
                "archivedReason" to reason,
                "archivedBy"     to archivedBy,
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Error archiving booking $bookingId", it) }

    suspend fun unarchiveBooking(bookingId: String): Result<Unit> = runCatching {
        AuntieLog.i("Unarchiving booking: $bookingId")
        firestore.collection("enhanced_bookings").document(bookingId).update(
            mapOf(
                "archivedAt"     to "",
                "archivedReason" to "",
                "archivedBy"     to "",
            )
        ).await()
        Unit
    }.onFailure { AuntieLog.e("Error unarchiving booking $bookingId", it) }

    // === Incoming MyTribe kinCares (booking envelope) ===

    /**
     * Live stream of incoming MyTribe booking requests that need staff action.
     * Queries the collectionGroup of kinCare docs across all families where
     * status == "requested", i.e. the leaf docs under
     * families/{fid}/bookings/{batchId}/kinCares/{visitId}.
     *
     * This is additive alongside the existing enhanced_bookings pipeline: the
     * scheduling queue can surface these requested kinCares so staff can approve
     * them (which then writes back via [KinCareRepository.patchKinCareDoc]). The
     * familyId/batchId/visitId carried on each [IncomingKinCare] are the FK the
     * write-back path needs.
     *
     * Requires the kinCares collectionGroup composite index (see deploy step E.1).
     * Gated end-to-end by the mytribe.booking.envelope flag; no-op while OFF
     * because MyTribe writes no envelopes until the flag flips.
     */
    fun incomingKinCareRequestsStream(): Flow<Result<List<IncomingKinCare>>> = callbackFlow {
        val query = firestore
            .collectionGroup("kinCares")
            .whereEqualTo("status", "requested")

        val registration = query.addSnapshotListener { snap, err ->
            if (err != null) {
                // Fail-loud: surface the error so the admin sees a banner, NOT a
                // silently-empty queue (the old trySend(emptyList) hid outages).
                AuntieLog.e("incomingKinCareRequestsStream listener error", err)
                trySend(Result.failure(err))
                return@addSnapshotListener
            }
            val items = snap?.documents.orEmpty().mapNotNull { d ->
                // path: families/{fid}/bookings/{batchId}/kinCares/{visitId}
                val segments = d.reference.path.split("/")
                val familyId = segments.getOrNull(1).orEmpty()
                val batchId = segments.getOrNull(3).orEmpty()
                val visitId = d.id
                if (familyId.isBlank() || batchId.isBlank()) return@mapNotNull null
                IncomingKinCare(
                    familyId = familyId,
                    batchId = batchId,
                    visitId = visitId,
                    kinfolkId = d.getString("kinfolkId").orEmpty().ifBlank { familyId },
                    kinfolkName = d.getString("kinfolkName").orEmpty(),
                    serviceType = d.getString("serviceType").orEmpty(),
                    // requestBooking writes start/end as Firestore Timestamps; read the
                    // Timestamp and convert to ISO (fall back to a string read defensively).
                    startTime = d.getTimestamp("startTime")?.toDate()?.toInstant()?.toString()
                        ?: d.getString("startTime").orEmpty(),
                    endTime = d.getTimestamp("endTime")?.toDate()?.toInstant()?.toString()
                        ?: d.getString("endTime").orEmpty(),
                    status = d.getString("status").orEmpty(),
                    notes = d.getString("notes").orEmpty(),
                    kinfolkNotes = d.getString("kinfolkNotes").orEmpty(),
                )
            }
            AuntieLog.d("incomingKinCareRequestsStream: ${items.size} requested kinCares")
            trySend(Result.success(items))
        }
        awaitClose { registration.remove() }
    }

    // === Conflict Detection ===

    suspend fun checkBookingConflicts(
        startDateTime: String,
        endDateTime: String,
        excludeBookingId: String? = null
    ): Result<List<EnhancedBooking>> = runCatching {
        AuntieLog.d("Checking conflicts for $startDateTime to $endDateTime")
        val availability = evaluateAvailability(
            BookingAvailabilityRequest(
                startDateTime = startDateTime,
                endDateTime = endDateTime,
                excludeBookingId = excludeBookingId
            )
        ).getOrThrow()

        availability.conflictingBookings.also {
            AuntieLog.d("Found ${it.size} conflicts")
        }
    }.onFailure { AuntieLog.e("Error checking booking conflicts", it) }

    suspend fun evaluateAvailability(request: BookingAvailabilityRequest): Result<BookingAvailabilityResult> = runCatching {
        AuntieLog.d("Evaluating availability for ${request.startDateTime}")
        val requestedStart = LocalDateTime.parse(request.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val requestedEnd = LocalDateTime.parse(request.endDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val requestDate = requestedStart.toLocalDate()

        val allBlockingBookings = fetchBlockingBookings(request.excludeBookingId, request.treatDraftAsUnavailable)
        val bookingsForDay = allBlockingBookings.filter {
            val start = parseIsoDateTime(it.startDateTime) ?: return@filter false
            start.toLocalDate() == requestDate
        }
        val blocksForDay = getUnavailableSlotsForDate(requestDate)

        val conflictingBookings = bookingsForDay.filter {
            bookingTimesOverlap(
                request.startDateTime,
                request.endDateTime,
                it.startDateTime,
                it.endDateTime
            )
        }
        if (conflictingBookings.isNotEmpty()) {
            AuntieLog.d("Found ${conflictingBookings.size} conflicting bookings")
            return@runCatching BookingAvailabilityResult(
                isAvailable = false,
                reason = UnavailabilityReasonType.CONFLICTING_BOOKING,
                message = "Unavailable: conflicts with an accepted or pending booking.",
                conflictingBookings = conflictingBookings,
                suggestedOptions = buildSuggestions(requestedStart, requestedEnd, allBlockingBookings, blocksForDay, request),
                showWaitlist = true
            )
        }

        val conflictingBlocks = blocksForDay.filter { slot ->
            val blockStart = parseDateAndTime(slot.date, slot.startTime) ?: return@filter false
            val blockEnd = parseDateAndTime(slot.date, slot.endTime) ?: return@filter false
            requestedStart.isBefore(blockEnd) && requestedEnd.isAfter(blockStart)
        }
        if (conflictingBlocks.isNotEmpty()) {
            AuntieLog.d("Found ${conflictingBlocks.size} conflicting manual blocks")
            return@runCatching BookingAvailabilityResult(
                isAvailable = false,
                reason = UnavailabilityReasonType.BLOCKED_SLOT,
                message = "Unavailable: this time is blocked.",
                conflictingBlocks = conflictingBlocks,
                suggestedOptions = buildSuggestions(requestedStart, requestedEnd, allBlockingBookings, blocksForDay, request),
                showWaitlist = true
            )
        }

        // Logic for time blocks...
        val activeBlock = request.timeBlocks.firstOrNull { block ->
            if (!block.isActive) return@firstOrNull false
            val blockStart = parseDateAndTime(requestDate.format(DateTimeFormatter.ISO_LOCAL_DATE), block.startTime) ?: return@firstOrNull false
            val blockEnd = parseDateAndTime(requestDate.format(DateTimeFormatter.ISO_LOCAL_DATE), block.endTime) ?: return@firstOrNull false
            requestedStart >= blockStart && requestedStart < blockEnd
        }

        if (activeBlock != null) {
            val blockStart = parseDateAndTime(requestDate.format(DateTimeFormatter.ISO_LOCAL_DATE), activeBlock.startTime)!!
            val blockEnd = parseDateAndTime(requestDate.format(DateTimeFormatter.ISO_LOCAL_DATE), activeBlock.endTime)!!

            val bookingsInsideBlock = bookingsForDay
                .mapNotNull { booking ->
                    val bookingStart = parseIsoDateTime(booking.startDateTime) ?: return@mapNotNull null
                    val bookingEnd = parseIsoDateTime(booking.endDateTime) ?: return@mapNotNull null
                    if (bookingStart.isBefore(blockEnd) && bookingEnd.isAfter(blockStart)) booking else null
                }
                .sortedBy { it.startDateTime }

            val usedMinutes = bookingsInsideBlock.sumOf { booking ->
                val bookingStart = parseIsoDateTime(booking.startDateTime)!!
                val bookingEnd = parseIsoDateTime(booking.endDateTime)!!
                val clippedStart = if (bookingStart.isBefore(blockStart)) blockStart else bookingStart
                val clippedEnd = if (bookingEnd.isAfter(blockEnd)) blockEnd else bookingEnd
                Duration.between(clippedStart, clippedEnd).toMinutes().toInt().coerceAtLeast(0)
            }
            val travelMinutesUsed = ((bookingsInsideBlock.size - 1).coerceAtLeast(0)) * request.travelBufferMinutes
            val blockMinutes = Duration.between(blockStart, blockEnd).toMinutes().toInt().coerceAtLeast(0)
            val remainingMinutes = blockMinutes - usedMinutes - travelMinutesUsed

            val requestedDuration = Duration.between(requestedStart, requestedEnd).toMinutes().toInt().coerceAtLeast(0)
            val neededMinutes = requestedDuration + if (bookingsInsideBlock.isEmpty()) 0 else request.travelBufferMinutes

            if (neededMinutes > remainingMinutes) {
                AuntieLog.d("Time block fully booked. Remaining: $remainingMinutes, Needed: $neededMinutes")
                return@runCatching BookingAvailabilityResult(
                    isAvailable = false,
                    reason = UnavailabilityReasonType.TIME_BLOCK_FULLY_BOOKED,
                    message = "Time block is fully booked.",
                    suggestedOptions = buildSuggestions(requestedStart, requestedEnd, allBlockingBookings, blocksForDay, request),
                    showWaitlist = true
                )
            }
        }

        AuntieLog.d("Booking slot is available")
        BookingAvailabilityResult(isAvailable = true)
    }.onFailure { AuntieLog.e("Error evaluating availability", it) }

    /**
     * Slice 8: server-side Google Calendar busy import. Calls the admin-gated
     * `syncGoogleCalendarBusyEvents` Cloud Function, which reads the shared
     * calendar via Application Default Credentials (no service-account key ships
     * in the APK) and upserts each Busy interval into `booking_time_slots` as a
     * private BLOCKED slot. Returns the server's imported count.
     *
     * Fail-loud: on the not-shared / not-configured paths the callable throws an
     * HttpsError whose message NAMES the sync service account. That message
     * propagates verbatim through the failed Result so the ViewModel can surface
     * it to the operator. No client-side calendar read, no key in the bundle.
     */
    suspend fun syncGoogleBusyEventsViaServer(lookAheadDays: Int = 30): Result<Int> = runCatching {
        AuntieLog.i("Requesting server-side Google Calendar busy sync for next $lookAheadDays days")
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("syncGoogleCalendarBusyEvents")
            .call(mapOf("lookAheadDays" to lookAheadDays))
            .await()
            .data as? Map<String, Any?>
            ?: error("syncGoogleCalendarBusyEvents: non-map payload")
        val imported = (raw["imported"] as? Number)?.toInt() ?: 0
        AuntieLog.i("Server imported $imported Google Calendar busy blocks")
        imported
    }.onFailure { AuntieLog.e("Error syncing Google busy events via server", it) }

    // ── Google Calendar over OAuth (Task 7.2), the editable half ────────────
    //
    // A DIFFERENT FEATURE from syncGoogleBusyEventsViaServer above, sharing
    // nothing but the word calendar. That one reads free/busy off a shared
    // calendar as a service account; these six write our visits onto a
    // calendar belonging to a Google account the operator signs into. See
    // `mytribe/functions/CALLABLE_CONTRACT.md`, "Google Calendar over OAuth,
    // the editable half".
    //
    // NO METHOD HERE EVER RETURNS OR STORES A REFRESH TOKEN. The server's own
    // response never carries one under any key (`publicConnection` in
    // `googleCalendarConnection.ts` strips it before any callable answers), so
    // there is nothing here to accidentally log or persist. AuntieLog calls
    // below log outcomes and counts, never the raw callable payload.

    /**
     * Mints the Google consent URL. The client opens it (Custom Tab); the
     * consent screen redirects to Google's own callback, which this app never
     * sees directly, so the caller must POLL [getGoogleCalendarConnection]
     * afterward rather than assume success from a return here.
     */
    suspend fun startGoogleCalendarConnect(): Result<GoogleCalendarConnectStart> = runCatching {
        AuntieLog.i("Starting Google Calendar OAuth connect flow")
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("startGoogleCalendarConnect")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<String, Any?>
            ?: error("startGoogleCalendarConnect: non-map payload")
        GoogleCalendarConnectStart(
            authUrl = raw["authUrl"] as? String
                ?: error("startGoogleCalendarConnect: response missing authUrl"),
            expiresAt = raw["expiresAt"] as? String ?: "",
            redirectUri = raw["redirectUri"] as? String ?: "",
        )
    }.onFailure { AuntieLog.e("Error starting Google Calendar connect", it) }

    /** The poll target after the consent window opens; see [startGoogleCalendarConnect]. */
    suspend fun getGoogleCalendarConnection(): Result<GoogleCalendarConnectionState> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("getGoogleCalendarConnection")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<String, Any?>
            ?: error("getGoogleCalendarConnection: non-map payload")
        GoogleCalendarConnectionState(
            connection = decodeGoogleCalendarConnection(raw["connection"]),
            freeBusyCalendarId = raw["freeBusyCalendarId"] as? String ?: "",
            redirectUri = raw["redirectUri"] as? String ?: "",
        )
    }.onFailure { AuntieLog.e("Error reading Google Calendar connection", it) }

    /**
     * Calendars on the connected account, kept even when read-only rather than
     * filtered out: `accessRole` tells the picker which ones cannot take an
     * event, so a calendar missing from the list always means "the connection
     * is broken", never "it was there but you cannot write to it".
     */
    suspend fun listGoogleCalendars(): Result<GoogleCalendarListResult> = runCatching {
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listGoogleCalendars")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<String, Any?>
            ?: error("listGoogleCalendars: non-map payload")
        @Suppress("UNCHECKED_CAST")
        val items = raw["calendars"] as? List<Map<String, Any?>> ?: emptyList()
        GoogleCalendarListResult(
            calendars = items.mapNotNull { c ->
                val id = c["id"] as? String
                if (id.isNullOrBlank()) null
                else GoogleCalendarSummary(
                    id = id,
                    summary = (c["summary"] as? String)?.ifBlank { id } ?: id,
                    accessRole = c["accessRole"] as? String ?: "",
                    primary = c["primary"] as? Boolean ?: false,
                )
            },
            connection = decodeGoogleCalendarConnection(raw["connection"]),
            freeBusyCalendarId = raw["freeBusyCalendarId"] as? String ?: "",
        )
    }.onFailure { AuntieLog.e("Error listing Google calendars", it) }

    /**
     * Saves which calendar visits are pushed to. The server enforces
     * `writeCalendarProblem` (`GoogleCalendarTargets.kt` mirrors the same rule
     * so the picker can refuse a bad pick before this round trip); this call
     * still throws verbatim on `write_calendar_invalid` if the mirror missed a
     * case the server catches.
     */
    suspend fun setGoogleCalendarTargets(
        writeCalendarId: String,
        enabledCalendarIds: List<String>,
    ): Result<GoogleCalendarConnection> = runCatching {
        AuntieLog.i("Saving Google Calendar write target")
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("setGoogleCalendarTargets")
            .call(mapOf("writeCalendarId" to writeCalendarId, "enabledCalendarIds" to enabledCalendarIds))
            .await()
            .data as? Map<String, Any?>
            ?: error("setGoogleCalendarTargets: non-map payload")
        decodeGoogleCalendarConnection(raw["connection"])
    }.onFailure { AuntieLog.e("Error saving Google Calendar targets", it) }

    /**
     * Revokes at Google, then clears our copy. [GoogleCalendarDisconnectResult.revoked]
     * false means Google did not confirm the revoke; the caller must surface
     * [GoogleCalendarDisconnectResult.revokeError] rather than report a clean
     * disconnect, because AuntieOS may still be listed as having access on the
     * operator's Google account. Events already written to Google are NOT
     * removed by this call; the server holds no delete-on-disconnect step.
     */
    suspend fun disconnectGoogleCalendar(): Result<GoogleCalendarDisconnectResult> = runCatching {
        AuntieLog.i("Disconnecting Google Calendar")
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("disconnectGoogleCalendar")
            .call(emptyMap<String, Any?>())
            .await()
            .data as? Map<String, Any?>
            ?: error("disconnectGoogleCalendar: non-map payload")
        GoogleCalendarDisconnectResult(
            connection = decodeGoogleCalendarConnection(raw["connection"]),
            revoked = raw["revoked"] as? Boolean ?: false,
            revokeError = raw["revokeError"] as? String ?: "",
        )
    }.onFailure { AuntieLog.e("Error disconnecting Google Calendar", it) }

    /**
     * Operator-initiated push of upcoming visits onto the connected, chosen
     * calendar. No calendar id in the request: the target is resolved
     * server-side from the saved connection, so a client can never aim a
     * household's visits at someone else's calendar.
     */
    suspend fun pushVisitsToGoogleCalendar(lookAheadDays: Int = 30): Result<GoogleCalendarPushResult> = runCatching {
        AuntieLog.i("Pushing visits to Google Calendar for next $lookAheadDays days")
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("pushVisitsToGoogleCalendar")
            .call(mapOf("lookAheadDays" to lookAheadDays))
            .await()
            .data as? Map<String, Any?>
            ?: error("pushVisitsToGoogleCalendar: non-map payload")
        @Suppress("UNCHECKED_CAST")
        val skippedRaw = raw["skipped"] as? List<Map<String, Any?>> ?: emptyList()
        val pushed = (raw["pushed"] as? Number)?.toInt() ?: 0
        val removed = (raw["removed"] as? Number)?.toInt() ?: 0
        AuntieLog.i("Google Calendar push complete: pushed=$pushed removed=$removed")
        GoogleCalendarPushResult(
            pushed = pushed,
            removed = removed,
            scanned = (raw["scanned"] as? Number)?.toInt() ?: 0,
            skipped = skippedRaw.map { s ->
                GoogleCalendarPushSkip(
                    sessionId = s["sessionId"] as? String ?: "",
                    reason = s["reason"] as? String ?: "",
                )
            },
            ranAt = raw["ranAt"] as? String ?: "",
        )
    }.onFailure { AuntieLog.e("Error pushing visits to Google Calendar", it) }

    private fun bookingTimesOverlap(
        start1: String, end1: String,
        start2: String, end2: String
    ): Boolean {
        return try {
            val startTime1 = LocalDateTime.parse(start1, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            val endTime1 = LocalDateTime.parse(end1, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            val startTime2 = LocalDateTime.parse(start2, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            val endTime2 = LocalDateTime.parse(end2, DateTimeFormatter.ISO_LOCAL_DATE_TIME)

            startTime1.isBefore(endTime2) && endTime1.isAfter(startTime2)
        } catch (e: Exception) {
            false
        }
    }

    private suspend fun fetchBlockingBookings(
        excludeBookingId: String?,
        includeDraft: Boolean
    ): List<EnhancedBooking> {
        val blockingStatuses = buildList {
            add(BookingStatus.ACCEPTED.name)
            if (includeDraft) add(BookingStatus.DRAFT.name)
        }

        val snapshot = firestore.collection("enhanced_bookings")
            .whereIn("status", blockingStatuses)
            .get()
            .await()

        return snapshot.toObjects(EnhancedBooking::class.java)
            .filter { it.id != excludeBookingId }
    }

    private suspend fun getUnavailableSlotsForDate(date: LocalDate): List<BookingTimeSlot> {
        val dateValue = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        val snapshot = firestore.collection("booking_time_slots")
            .whereEqualTo("date", dateValue)
            .whereEqualTo("isAvailable", false)
            .get()
            .await()

        return snapshot.toObjects(BookingTimeSlot::class.java)
    }

    private fun parseIsoDateTime(value: String): LocalDateTime? =
        runCatching { LocalDateTime.parse(value, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }.getOrNull()

    private fun parseDateAndTime(date: String, time: String): LocalDateTime? {
        return try {
            LocalDateTime.of(LocalDate.parse(date, DateTimeFormatter.ISO_LOCAL_DATE), LocalTime.parse(time))
        } catch (_: Exception) {
            null
        }
    }

    private fun buildSuggestions(
        requestedStart: LocalDateTime,
        requestedEnd: LocalDateTime,
        blockingBookings: List<EnhancedBooking>,
        blockingSlots: List<BookingTimeSlot>,
        request: BookingAvailabilityRequest
    ): List<AvailabilityOption> {
        val duration = Duration.between(requestedStart, requestedEnd)
        val suggestions = mutableListOf<AvailabilityOption>()
        var candidate = requestedStart.plusMinutes(30)
        val cutoff = requestedStart.plusDays(7)

        while (candidate <= cutoff && suggestions.size < 3) {
            val candidateEnd = candidate.plus(duration)
            val hasBookingConflict = blockingBookings.any { booking ->
                val bookingStart = parseIsoDateTime(booking.startDateTime) ?: return@any false
                val bookingEnd = parseIsoDateTime(booking.endDateTime) ?: return@any false
                candidate.isBefore(bookingEnd) && candidateEnd.isAfter(bookingStart)
            }

            val hasBlockConflict = blockingSlots.any { slot ->
                val slotStart = parseDateAndTime(slot.date, slot.startTime) ?: return@any false
                val slotEnd = parseDateAndTime(slot.date, slot.endTime) ?: return@any false
                candidate.isBefore(slotEnd) && candidateEnd.isAfter(slotStart)
            }

            if (!hasBookingConflict && !hasBlockConflict) {
                suggestions += AvailabilityOption(
                    startDateTime = candidate.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                    endDateTime = candidateEnd.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                    reason = "Nearest open slot"
                )
            }
            candidate = candidate.plusMinutes(request.travelBufferMinutes.toLong().coerceAtLeast(15))
        }

        return suggestions
    }

    // === Time Slots ===

    /**
     * Creates a NEW blocked/available window. A create, and only a create.
     *
     * This used to choose its document with
     * `if (id.isBlank()) document() else document(id)` and then bare-`set()` the
     * whole model over whatever was already there - an UPDATE wearing a create's
     * name, through the write mode that REPLACES a document rather than patching
     * it. That is the branch #337 and #343 removed from six service creates, and
     * on THIS collection it is the very write that erases the server's
     * `createdBy`/`updatedAt` (see [BookingTimeSlotDiff]).
     *
     * No screen reaches the branch: [EnhancedSchedulingViewModel.blockTimeSlot]
     * always builds a blank-id slot. That is exactly why it is worth shutting
     * rather than leaving as a convenience - a whole-document replace nothing
     * calls, waiting for the first caller that passes an id and does not know
     * what it costs. Edits go through [updateTimeSlotFields].
     */
    suspend fun createTimeSlot(timeSlot: BookingTimeSlot): Result<String> = runCatching {
        require(timeSlot.id.isBlank()) {
            "createTimeSlot creates; an existing slot is edited with updateTimeSlotFields, " +
                "so it must not replace booking_time_slots/${timeSlot.id}"
        }
        AuntieLog.d("Creating time slot for date: ${timeSlot.date}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val timeSlotWithTimestamp = timeSlot.copy(createdAt = now)

        val docRef = firestore.collection("booking_time_slots").document()

        docRef.set(timeSlotWithTimestamp).await()
        AuntieLog.d("Time slot created with ID: ${docRef.id}")
        docRef.id
    }.onFailure { AuntieLog.e("Error creating time slot", it) }

    suspend fun getTimeSlots(
        startDate: String,
        endDate: String,
        includeUnavailable: Boolean = false
    ): Result<List<BookingTimeSlot>> = runCatching {
        AuntieLog.d("Fetching time slots from $startDate to $endDate")
        var query: Query = firestore.collection("booking_time_slots")
            .whereGreaterThanOrEqualTo("date", startDate)
            .whereLessThanOrEqualTo("date", endDate)

        if (!includeUnavailable) {
            query = query.whereEqualTo("isAvailable", true)
        }

        val snapshot = query.orderBy("date").orderBy("startTime").get().await()
        snapshot.toObjects(BookingTimeSlot::class.java).also {
            AuntieLog.d("Retrieved ${it.size} time slots")
        }
    }.onFailure { AuntieLog.e("Error fetching time slots", it) }

    /**
     * Live stream of `booking_time_slots`, mirroring the web `bookingTimeSlotsStream`.
     * The Schedule grid filters this to the BLOCKED slots (`isAvailable == false`,
     * Google Calendar busy imports written by `syncGoogleCalendarBusyEvents`) and
     * draws them as read-only "Busy" bands. Emits the full collection; the screen
     * does the BLOCKED filter so the same stream can back any future availability UI.
     *
     * Fail-loud: a listener error emits `Result.failure` (the screen surfaces a
     * banner), never a silent `emptyList`. Replaces the one-shot [getTimeSlots]
     * `.get()` the schedule previously used so busy blocks update live.
     */
    fun bookingTimeSlotsStream(): Flow<Result<List<BookingTimeSlot>>> = callbackFlow {
        val registration = firestore.collection("booking_time_slots")
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    AuntieLog.e("bookingTimeSlotsStream listener error", error)
                    trySend(Result.failure(error))
                    return@addSnapshotListener
                }
                val slots = snapshot?.toObjects(BookingTimeSlot::class.java).orEmpty()
                AuntieLog.d("bookingTimeSlotsStream: ${slots.size} time slots")
                trySend(Result.success(slots))
            }
        awaitClose { registration.remove() }
    }

    /**
     * Patches ONE `booking_time_slots/{id}` with the fields that actually
     * changed, and a fresh `updatedAt`.
     *
     * [changes] comes from [bookingTimeSlotFieldChanges] against the copy
     * Firestore handed the caller - never a re-read, and never a
     * freshly-constructed [BookingTimeSlot], against which every field differs
     * and the diff degrades back into the whole-model write this replaces.
     *
     * REPLACES `updateTimeSlot(BookingTimeSlot)`, which wrote the whole model
     * with a BARE `.set()`. Two server writers put fields on these documents
     * that the Kotlin model does not declare (`createdBy`, `updatedAt`), and a
     * bare set DELETES every field it cannot name. [BookingTimeSlotDiff] sets
     * out what each of those is worth, and why the loss is latent today rather
     * than historical: `firestore.rules:798` denies every client write to this
     * collection, so the dangerous shape never reached the server.
     *
     * An EMPTY change set is refused rather than written. The only thing such a
     * write could do is move `updatedAt` - a stamp this client does not even
     * read - to claim an edit that never happened, in a field the server owns.
     */
    suspend fun updateTimeSlotFields(
        timeSlotId: String,
        changes: Map<String, Any?>,
    ): Result<Unit> = runCatching {
        require(timeSlotId.isNotBlank()) { "updateTimeSlotFields needs a booking_time_slots document id" }
        require(changes.isNotEmpty()) { "updateTimeSlotFields called with no changed fields" }
        AuntieLog.d("Updating time slot: $timeSlotId (${changes.keys.joinToString()})")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val payload: Map<String, Any?> = changes + mapOf("updatedAt" to now)
        firestore.collection("booking_time_slots").document(timeSlotId)
            .set(payload, com.google.firebase.firestore.SetOptions.merge())
            .await()
        Unit
    }.onFailure { AuntieLog.e("Error updating time slot $timeSlotId", it) }

    suspend fun deleteTimeSlot(timeSlotId: String): Result<Unit> = runCatching {
        AuntieLog.w("Deleting time slot: $timeSlotId")
        firestore.collection("booking_time_slots").document(timeSlotId).delete().await()
        Unit
    }.onFailure { AuntieLog.e("Error deleting time slot $timeSlotId", it) }

    // === Booking Analytics & Reports ===

    suspend fun getBookingStats(
        startDate: String,
        endDate: String
    ): Result<BookingStats> = runCatching {
        AuntieLog.d("Calculating booking stats from $startDate to $endDate")
        val snapshot = firestore.collection("enhanced_bookings")
            .whereGreaterThanOrEqualTo("startDateTime", normalizeDateStart(startDate))
            .whereLessThanOrEqualTo("startDateTime", normalizeDateEnd(endDate))
            .get().await()

        val bookings = snapshot.toObjects(EnhancedBooking::class.java)

        BookingStats(
            totalBookings = bookings.size,
            acceptedBookings = bookings.count { it.status == BookingStatus.ACCEPTED },
            completedBookings = bookings.count { it.status == BookingStatus.COMPLETED },
            draftBookings = bookings.count { it.status == BookingStatus.DRAFT },
            rejectedBookings = bookings.count { it.status == BookingStatus.REJECTED },
            totalRevenue = bookings.filter { it.status == BookingStatus.COMPLETED }
                .sumOf { it.totalPrice },
            averageBookingValue = bookings.filter { it.totalPrice > 0 }
                .map { it.totalPrice }.average().takeIf { !it.isNaN() } ?: 0.0
        ).also {
            AuntieLog.d("Stats calculated: total bookings ${it.totalBookings}")
        }
    }.onFailure { AuntieLog.e("Error calculating booking stats", it) }

    // === Pricing Calculation ===

    /**
     * Unwrap a pricing input, or fail the whole quote naming what could not be read.
     *
     * Every read feeding calculateBookingPrice used to end in `.getOrDefault(emptyList())`,
     * so an unreadable surcharge table produced the same answer as an empty one: a
     * confident total that silently undercharged. Prices are the one place a
     * plausible-looking wrong number is worse than an error, so a failed read now
     * fails the quote. Note this is only about READ FAILURE. Genuinely absent data
     * (an empty table, an unknown promo code) still prices normally.
     */
    private fun <T> Result<T>.orFailQuote(what: String): T =
        getOrElse { throw IllegalStateException("Could not load $what for this quote: ${it.message}", it) }

    suspend fun calculateBookingPrice(
        baseServiceId: String,
        supplementalServiceIds: List<String>,
        startDateTime: String,
        endDateTime: String,
        kinfolkId: String,
        promoCode: String? = null,
        serviceRepo: ServiceRepository = ServiceRepository(),
    ): Result<BookingPriceCalculation> = runCatching {
        AuntieLog.d("Calculating booking price for kinfolk=$kinfolkId base=$baseServiceId supp=${supplementalServiceIds.size} promo=$promoCode")

        val baseService = serviceRepo.getBaseServiceById(baseServiceId).getOrNull()
            ?: error("Base service not found: $baseServiceId")
        val basePrice = baseService.basePrice

        val allSupplementals = serviceRepo.getSupplementalServices().orFailQuote("add-on services")
        val supplementals = allSupplementals.filter { it.id in supplementalServiceIds }
        val supplementalsTotal = supplementals.sumOf { it.price }

        val subtotal = basePrice + supplementalsTotal

        val start = runCatching { LocalDateTime.parse(startDateTime) }.getOrNull()
        val dayOfWeek = start?.dayOfWeek?.value  // 1=Mon..7=Sun
        val hour = start?.hour ?: -1

        // ---- Surcharges ----
        val allSurcharges = serviceRepo.getSurcharges().orFailQuote("surcharges")
        val applicableSurcharges = allSurcharges.filter { s ->
            val c = s.applicableConditions
            if (c.minimumServiceValue > 0 && subtotal < c.minimumServiceValue) return@filter false
            if (c.applicableServiceIds.isNotEmpty() && baseServiceId !in c.applicableServiceIds) return@filter false
            val matchesDay  = c.applicableDayOfWeek.isEmpty() || (dayOfWeek != null && dayOfWeek in c.applicableDayOfWeek)
            val matchesWeekend  = c.applyOnWeekends && (dayOfWeek == 6 || dayOfWeek == 7)
            val matchesAfterHours = c.applyAfterHours && start != null && isAfterHours(hour, c.afterHoursStart, c.afterHoursEnd)
            val anyTrigger = c.applyOnWeekends || c.applyOnHolidays || c.applyAfterHours || c.applicableDayOfWeek.isNotEmpty()
            // If the surcharge defines no triggers, apply to every booking (catch-all flat fee).
            (!anyTrigger) || matchesDay || matchesWeekend || matchesAfterHours
        }
        val appliedSurcharges = applicableSurcharges.map { s ->
            val amount = when (s.type) {
                SurchargeType.FIXED_AMOUNT          -> s.amount
                SurchargeType.PERCENTAGE_OF_SERVICE -> basePrice * s.amount / 100.0
                SurchargeType.PERCENTAGE_OF_TOTAL   -> subtotal * s.amount / 100.0
            }
            AppliedSurcharge(surchargeId = s.id, title = s.title, amount = amount, type = s.type)
        }
        val surchargesTotal = appliedSurcharges.sumOf { it.amount }

        // ---- Auto-applied discounts (non-promo) ----
        val today = LocalDate.now().toString()
        val allDiscounts = serviceRepo.getDiscounts().orFailQuote("discounts")
        val applicableDiscounts = allDiscounts.filter { d ->
            val c = d.conditions
            if (c.minimumPurchase > 0 && subtotal < c.minimumPurchase) return@filter false
            if (c.applicableServiceIds.isNotEmpty() && baseServiceId !in c.applicableServiceIds) return@filter false
            if (c.validFrom.isNotBlank()  && today  < c.validFrom)  return@filter false
            if (c.validUntil.isNotBlank() && today  > c.validUntil) return@filter false
            true
        }
        val appliedDiscounts = applicableDiscounts.mapNotNull { d ->
            val amount = when (d.type) {
                DiscountType.PERCENTAGE   -> -(subtotal * d.amount / 100.0)
                DiscountType.FIXED_AMOUNT -> -d.amount
            }
            if (amount == 0.0) null else AppliedDiscount(discountId = d.id, title = d.title, amount = amount, type = d.type)
        }
        val discountsTotal = appliedDiscounts.sumOf { it.amount }

        // ---- Promo code (single-shot) ----
        var promoDiscount = 0.0
        if (!promoCode.isNullOrBlank()) {
            // orFailQuote, not getOrNull: a null here means "no such code" (the operator
            // typo'd it), which is a legitimate answer that must still price. A FAILED
            // read used to collapse to that same null, silently costing the kinfolk a
            // discount they had earned.
            val promo = serviceRepo.getPromoCodeByCode(promoCode).orFailQuote("promo code '$promoCode'")
            if (promo != null && promo.isActive) {
                val withinUsage = promo.usageLimit < 0 || promo.usedCount < promo.usageLimit
                val withinDates = (promo.validFrom.isBlank()  || today >= promo.validFrom) &&
                                  (promo.validUntil.isBlank() || today <= promo.validUntil)
                val meetsMin     = subtotal >= promo.minimumPurchase
                val serviceMatch = promo.applicableServiceIds.isEmpty() || baseServiceId in promo.applicableServiceIds
                if (withinUsage && withinDates && meetsMin && serviceMatch) {
                    promoDiscount = when (promo.discountType) {
                        DiscountType.PERCENTAGE   -> -(subtotal * promo.discountAmount / 100.0)
                        DiscountType.FIXED_AMOUNT -> -promo.discountAmount
                    }
                } else {
                    AuntieLog.d("Promo '$promoCode' rejected (usage/dates/min/service mismatch)")
                }
            }
        }

        val finalTotal = (subtotal + surchargesTotal + discountsTotal + promoDiscount).coerceAtLeast(0.0)

        BookingPriceCalculation(
            basePrice = basePrice,
            supplementalServicesTotal = supplementalsTotal,
            surchargesTotal = surchargesTotal,
            discountsTotal = discountsTotal,
            promoCodeDiscount = promoDiscount,
            finalTotal = finalTotal,
            appliedSurcharges = appliedSurcharges,
            appliedDiscounts = appliedDiscounts
        )
    }.onFailure { AuntieLog.e("Error calculating booking price", it) }

    /** Treat hours within [startHourStr..endHourStr] window as after-hours. Wraps midnight. */
    private fun isAfterHours(hour: Int, startHourStr: String, endHourStr: String): Boolean {
        if (hour < 0) return false
        val start = startHourStr.substringBefore(':').toIntOrNull() ?: return false
        val end   = endHourStr.substringBefore(':').toIntOrNull() ?: return false
        return if (start <= end) hour in start until end else (hour >= start || hour < end)
    }

    private fun normalizeDateStart(value: String): String =
        if (value.length == 10) "${value}T00:00:00" else value

    private fun normalizeDateEnd(value: String): String =
        if (value.length == 10) "${value}T23:59:59" else value
}

data class BookingStats(
    val totalBookings: Int,
    val acceptedBookings: Int,
    val completedBookings: Int,
    val draftBookings: Int,
    val rejectedBookings: Int,
    val totalRevenue: Double,
    val averageBookingValue: Double
)

data class BookingPriceCalculation(
    val basePrice: Double,
    val supplementalServicesTotal: Double,
    val surchargesTotal: Double,
    val discountsTotal: Double,
    val promoCodeDiscount: Double,
    val finalTotal: Double,
    val appliedSurcharges: List<AppliedSurcharge>,
    val appliedDiscounts: List<AppliedDiscount>
)

/**
 * An incoming MyTribe booking request surfaced from the kinCares collectionGroup
 * (families/{familyId}/bookings/{batchId}/kinCares/{visitId}, status="requested").
 * Carries the parent path components (familyId/batchId/visitId) so the approve
 * path can write status back via [KinCareRepository.patchKinCareDoc].
 */
data class IncomingKinCare(
    val familyId: String = "",
    val batchId: String = "",
    val visitId: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val serviceType: String = "",
    val startTime: String = "",
    val endTime: String = "",
    val status: String = "",
    val notes: String = "",
    val kinfolkNotes: String = "",
)

/**
 * Outcome of a manageBookingSeries callable. [affectedVisits] = visits that
 * processed successfully; [failedVisits] > 0 means a PARTIAL failure (the backend
 * still returns ok and leaves the envelope 'requested'), so callers MUST surface
 * it fail-loud rather than report a clean success. [sessionsCreated] = linked
 * kin_care_sessions the backend created on APPROVE. Mirrors the AuntieOS web type.
 *
 * #536: [householdNotified] and [newlyConfirmed] are what the answer to the
 * household actually was. Approving a four-day request used to send them one
 * message PER VISIT; it now sends exactly one, naming every date, and it sends
 * NOTHING on a partial failure (the envelope is deliberately left retryable, so a
 * dispatch here would repeat on the retry) or on a re-approve of a request that
 * was already booked. A screen that wants to say the household was told has to
 * READ these, not infer it from a clean result.
 */
data class ManageSeriesResult(
    val affectedVisits: Int,
    val failedVisits: Int = 0,
    val sessionsCreated: Int = 0,
    /** Whether the one message to the household actually went out. */
    val householdNotified: Boolean = false,
    /** Visits this call moved into `confirmed`; 0 on a re-approve. */
    val newlyConfirmed: Int = 0,
)

/**
 * AO-25: one visit in a multi-date/recurring booking request. [startTimeMs] is
 * epoch ms derived from the operator's LOCAL wall-clock pick (no UTC skew).
 * [serviceId] is optional; when set the server resolves the canonical name+price.
 *
 * There is deliberately no `priceCents` here. The field exists on the callable,
 * but `resolveService` overwrites whatever a client sends with the catalog price
 * (NOTE-56), so a price control on this path would be a box whose value is
 * discarded. Web's wizard omits it for the same reason.
 *
 * There is no place field either, and that one is not an omission but a ruling
 * (2026-08-04): a visit happens at the household's address, which is read live
 * off the household doc by everything that needs it.
 */
data class NewBookingVisit(
    val startTimeMs: Long,
    val serviceName: String,
    val endTimeMs: Long? = null,
    val serviceId: String? = null,
)

/**
 * D1: a booking callable refused the request with a machine-readable reason.
 *
 * [code] is the server's `details.code` verbatim, so a client branches on
 * [BOOKING_BUSY_CONFLICT_CODE] rather than pattern-matching a human sentence
 * that is free to be reworded. Null when the refusal carried no code (a plain
 * `invalid-argument`, a transport failure, anything that is not one of the
 * guards).
 */
class BookingRequestRefusedException(val code: String?, message: String) : Exception(message)

/** `details.code` from `guardBookingBusyConflict`; the one refusal an operator may override. */
const val BOOKING_BUSY_CONFLICT_CODE = "booking_busy_conflict"

/** `details.code` from `guardCompanyHolidayConflict`. Never overridable, by design. */
const val COMPANY_HOLIDAY_CONFLICT_CODE = "company_holiday_conflict"

/**
 * Pulls `details.code` out of a callable rejection's `details` payload. Pure and
 * total: any shape that is not a map carrying a string `code` yields null.
 */
internal fun conflictCodeFrom(details: Any?): String? =
    (details as? Map<*, *>)?.get("code") as? String

/** AO-25: createMultiDateBookingRequest result (the created envelope + its visits). */
data class MultiDateBookingResult(
    val batchId: String,
    val visitIds: List<String>,
    val visitCount: Int,
)

// ── Google Calendar over OAuth (Task 7.2) result shapes ─────────────────────
//
// Named result data classes rather than reusing raw maps at call sites, same
// posture as [ManageSeriesResult] and [BatchBookingResult] above: a field the
// server adds later has exactly one place to be added on this side too.

/** `startGoogleCalendarConnect` response. [authUrl] is the Google consent screen to open. */
data class GoogleCalendarConnectStart(
    val authUrl: String,
    val expiresAt: String,
    val redirectUri: String,
)

/** `getGoogleCalendarConnection` response. */
data class GoogleCalendarConnectionState(
    val connection: GoogleCalendarConnection,
    /** `business_settings.calendarSyncId` (Task 7.1's free/busy target), echoed so
     *  the picker can apply [com.tribetails.auntieos.ui.admin.scheduling.writeCalendarProblem]
     *  without a second read. */
    val freeBusyCalendarId: String,
    val redirectUri: String,
)

/** One calendar on the connected Google account, as `listGoogleCalendars` reports it. */
data class GoogleCalendarSummary(
    val id: String,
    val summary: String,
    /** `owner`, `writer`, `reader`, `freeBusyReader`. Only the first two can take an event. */
    val accessRole: String,
    val primary: Boolean,
)

/** `listGoogleCalendars` response. */
data class GoogleCalendarListResult(
    val calendars: List<GoogleCalendarSummary>,
    val connection: GoogleCalendarConnection,
    val freeBusyCalendarId: String,
)

/** `disconnectGoogleCalendar` response. [revoked] false means the manual fix must be surfaced. */
data class GoogleCalendarDisconnectResult(
    val connection: GoogleCalendarConnection,
    val revoked: Boolean,
    /** Empty when [revoked]; otherwise what Google said, verbatim, plus the manual-fix hint. */
    val revokeError: String,
)

/** One session `pushVisitsToGoogleCalendar` could not push, and why. */
data class GoogleCalendarPushSkip(
    val sessionId: String,
    val reason: String,
)

/** `pushVisitsToGoogleCalendar` response. */
data class GoogleCalendarPushResult(
    val pushed: Int,
    val removed: Int,
    val scanned: Int,
    val skipped: List<GoogleCalendarPushSkip>,
    val ranAt: String,
)

/**
 * Normalizes a raw `connection` map into [GoogleCalendarConnection], naming
 * every field rather than trusting the map shape at each call site above.
 * Never reads a `refreshToken` key: the server projection this decodes never
 * carries one, so there is nothing here that could accidentally surface it.
 */
private fun decodeGoogleCalendarConnection(raw: Any?): GoogleCalendarConnection {
    @Suppress("UNCHECKED_CAST")
    val c = raw as? Map<String, Any?> ?: emptyMap()
    val scopes = (c["scopes"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val enabledCalendarIds = (c["enabledCalendarIds"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    return GoogleCalendarConnection(
        connected = c["connected"] as? Boolean ?: false,
        googleAccountEmail = c["googleAccountEmail"] as? String ?: "",
        connectedAt = c["connectedAt"] as? String ?: "",
        scopes = scopes,
        writeCalendarId = c["writeCalendarId"] as? String ?: "",
        enabledCalendarIds = enabledCalendarIds,
        disconnectedAt = c["disconnectedAt"] as? String ?: "",
        disconnectedError = c["disconnectedError"] as? String ?: "",
        connectLastAttemptAt = c["connectLastAttemptAt"] as? String ?: "",
        connectLastStatus = c["connectLastStatus"] as? String ?: "",
        connectLastError = c["connectLastError"] as? String ?: "",
        calendarPushLastRunAt = c["calendarPushLastRunAt"] as? String ?: "",
        calendarPushLastStatus = c["calendarPushLastStatus"] as? String ?: "",
        calendarPushLastPushed = (c["calendarPushLastPushed"] as? Number)?.toInt() ?: 0,
        calendarPushLastError = c["calendarPushLastError"] as? String ?: "",
    )
}
