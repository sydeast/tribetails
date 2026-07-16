package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.*
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

    suspend fun createBooking(booking: EnhancedBooking): Result<String> = runCatching {
        AuntieLog.i("Creating enhanced booking for kinfolk: ${booking.kinfolkId}")
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
     * them (which then writes back via [AuntieRepository.patchKinCareDoc]). The
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

    suspend fun createTimeSlot(timeSlot: BookingTimeSlot): Result<String> = runCatching {
        AuntieLog.d("Creating time slot for date: ${timeSlot.date}")
        val now = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val timeSlotWithTimestamp = timeSlot.copy(createdAt = now)

        val docRef = if (timeSlot.id.isBlank()) {
            firestore.collection("booking_time_slots").document()
        } else {
            firestore.collection("booking_time_slots").document(timeSlot.id)
        }

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

    suspend fun updateTimeSlot(timeSlot: BookingTimeSlot): Result<Unit> = runCatching {
        AuntieLog.d("Updating time slot: ${timeSlot.id}")
        firestore.collection("booking_time_slots").document(timeSlot.id)
            .set(timeSlot).await()
        Unit
    }.onFailure { AuntieLog.e("Error updating time slot ${timeSlot.id}", it) }

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
 * path can write status back via [AuntieRepository.patchKinCareDoc].
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
 */
data class ManageSeriesResult(
    val affectedVisits: Int,
    val failedVisits: Int = 0,
    val sessionsCreated: Int = 0,
)
