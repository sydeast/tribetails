package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

interface AuntieDataSource {
    fun invoicesStream(): Flow<FirestoreResult<List<Invoice>>>
    fun kinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>>
    /**
     * All kin (pets) across households, used to join real name/species onto a
     * report's per-kin checklist (spec 11 item 4.1) so headings read
     * "Biscuit · Dog · Labrador" instead of a raw kinId. Default emits an empty
     * set so existing test fakes keep working: callers fall back to the raw id,
     * never invent a name.
     */
    fun allKinStream(): Flow<FirestoreResult<List<Kin>>> =
        flowOf(FirestoreResult.Data(emptyList()))

    /**
     * Shared vet-clinic catalog (vet_clinics) for the Settings "Vet clinics"
     * manager (spec 29 item 8). Defaults emit empty / fail-loud so existing test
     * fakes keep compiling; the real settings data source overrides these.
     * There is no deleteVetClinic callable, so delete stays gated dark in the UI.
     */
    fun vetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> =
        flowOf(FirestoreResult.Data(emptyList()))
    suspend fun createVetClinic(clinic: VetClinic): WriteResult<String> =
        WriteResult.Err("createVetClinic not supported by this data source")
    suspend fun updateVetClinic(clinic: VetClinic): WriteResult<Unit> =
        WriteResult.Err("updateVetClinic not supported by this data source")
    suspend fun deleteVetClinic(id: String): WriteResult<Unit> =
        WriteResult.Err("deleteVetClinic not supported by this data source")

    /**
     * Server-bound "Set as profile photo" for a media gallery cell. Defaults to a
     * fail-loud Err so existing test fakes keep compiling; the FirestoreClient
     * media data source overrides this to call the setMediaProfilePhoto callable.
     */
    suspend fun setMediaProfilePhoto(mediaFileId: String, entityType: String, entityId: String): WriteResult<Unit> =
        WriteResult.Err("setMediaProfilePhoto not supported by this data source")

    fun sessionsStream(): Flow<FirestoreResult<List<KinCareSession>>>

    /**
     * Live single session for [sessionId] (carries the persisted [GpsSummary]).
     * Default derives off [sessionsStream] so existing test fakes that only
     * provide a sessions list keep working; the production data source can
     * override for a narrower query.
     */
    fun sessionForIdStream(sessionId: String): Flow<FirestoreResult<KinCareSession?>> =
        kotlinx.coroutines.flow.flow {
            sessionsStream().collect { res ->
                when (res) {
                    is FirestoreResult.Data -> emit(FirestoreResult.Data(res.value.firstOrNull { it._id == sessionId }))
                    is FirestoreResult.Error -> emit(FirestoreResult.Error(res.message))
                    FirestoreResult.Loading -> emit(FirestoreResult.Loading)
                }
            }
        }

    fun paymentsStream(): Flow<FirestoreResult<List<Payment>>>
    suspend fun recordPayment(payment: Payment): WriteResult<String>

    // Booking write operations - sessions in DRAFT status are the "pending bookings" concept
    suspend fun approveBooking(bookingId: String): WriteResult<Unit>
    suspend fun rejectBooking(bookingId: String): WriteResult<Unit>
    suspend fun createBooking(booking: KinCareSession): WriteResult<String>

    /**
     * AO-25: admin multi-date / recurring booking request (envelope model). Inert
     * default so the many screen-local fakes that never create bookings need no
     * change; the real FirestoreAuntieDataSource overrides it.
     */
    suspend fun createMultiDateBookingRequest(
        kinfolkId: String,
        visits: List<NewBookingVisitInput>,
        notes: String? = null,
        pattern: String = "individual",
        weeklyDays: List<Int>? = null,
        /** #644: see FirestoreClient.createMultiDateBookingRequest. */
        idempotencyKey: String? = null,
    ): WriteResult<MultiDateBookingResult> = WriteResult.Err("Multi-date booking is not available here.")

    // 16.5: incoming MyTribe booking-envelope requests (collectionGroup kinCares,
    // status=='requested') + series approve/cancel. Defaults are inert so the many
    // screen-local fakes that never touch the queue need no change; the real
    // FirestoreClient-backed sources override both.
    fun incomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> =
        kotlinx.coroutines.flow.flowOf(FirestoreResult.Data(emptyList()))
    suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): WriteResult<ManageSeriesResult> =
        WriteResult.Err("manageBookingSeries not supported by this data source")

    fun businessSettingsStream(): Flow<FirestoreResult<BusinessSettings>>
    suspend fun saveBusinessSettings(settings: BusinessSettings): WriteResult<Unit>

    fun mediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>>
    suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile>
    // Run-4 #4b: multi-file upload. Default delegates to the single [uploadMedia] so
    // existing data sources keep working; the gallery overrides it with the real
    // multi-pick path. An empty Ok list = the picker was cancelled.
    suspend fun pickAndUploadMedia(entityId: String, entityType: String, max: Int = 10): WriteResult<List<MediaFile>> =
        when (val r = uploadMedia(entityId, entityType, byteArrayOf(), "")) {
            is WriteResult.Ok  -> WriteResult.Ok(listOf(r.value))
            is WriteResult.Err -> r
        }
    /**
     * #577: routed through the `deleteMediaFile` callable, never a client write.
     *
     * [entityId] is the OPTIONAL scope cross-check and must come off the media
     * ROW, not the route: the server refuses a doc belonging to a different
     * entity, so a stale row id from one household can never delete another
     * household's media. Blank means "unscoped" and is omitted from the payload.
     */
    suspend fun deleteMedia(mediaId: String, entityId: String = ""): WriteResult<Unit>

    // KinTale report authoring
    fun reportForSessionStream(sessionId: String): Flow<FirestoreResult<KinCareReport?>>
    suspend fun saveReport(report: KinCareReport): WriteResult<String>
    /**
     * Send the report: dispatch the catalog `report_sent` notification and stamp
     * the report SENT with the first dispatchId as the delivery receipt. Needs
     * the live [session] for its kinfolkId + sourceBookingId routing keys and to
     * write the session-side reportIds/sentReportCount. Fail-loud: a dispatch
     * error returns [WriteResult.Err] and the report is NOT flipped to SENT.
     */
    suspend fun sendReport(report: KinCareReport, session: KinCareSession): WriteResult<Unit>

    fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>>

    // Booking notes - read both subcollections, write via Functions callables.
    // Kinfolk-facing subcollection (kinfolk + admin write; kinfolk read allowed).
    // Internal subcollection (admin-only read/write; PATH-level boundary).
    fun bookingNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>>
    fun bookingInternalNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>>
    /** Calls addBookingNote callable (admin-on-behalf path). Server enforces 3hr cutoff. */
    suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String>
    /** Calls addInternalBookingNote callable (admin-only). No 3hr cutoff. */
    suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String>

    // KinTale comment thread on a SENT report. Live read + admin compose via callable.
    fun kinTaleCommentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>>
    /** Calls addKinTaleComment callable; server forces authorRole='admin'. parentCommentId for a 1-level reply. */
    suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?): WriteResult<String>

    /**
     * Mints a read-only public share link for a SENT KinTale via the createShareLink
     * callable, returning the kinfolk-facing shareUrl. [familyId] is the report's
     * kinfolkId, [kinTaleId] is the report's _id. Defaults to a fail-loud Err so
     * existing test fakes keep compiling; the FirestoreClient-backed data source
     * overrides this to call the real callable.
     */
    suspend fun createShareLink(familyId: String, kinTaleId: String, includePhotos: Boolean = true): WriteResult<String> =
        WriteResult.Err("createShareLink not supported by this data source")

    /**
     * Audit-log write. Default implementation is a no-op so existing test
     * fakes don't have to provide one - production [FirestoreClient]-backed
     * data sources override this to write to the `activity_log` collection.
     */
    suspend fun logActivity(entry: ActivityLogEntry): WriteResult<String> = WriteResult.Ok("noop")
}
