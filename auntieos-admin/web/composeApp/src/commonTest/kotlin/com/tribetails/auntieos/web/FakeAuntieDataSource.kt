package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.BookingNote
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinCareVisit
import com.tribetails.auntieos.web.data.KinTaleComment
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.ManageSeriesResult
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.data.VetClinic
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map

class FakeAuntieDataSource(
    private val saveShouldFail: Boolean = false,
    private val saveFailMessage: String = "write failed",
    private val sendShouldFail: Boolean = false,
    private val sendFailMessage: String = "send failed",
    val uploadShouldFail: Boolean = false,
    val deleteShouldFail: Boolean = false,
    private val recordPaymentShouldFail: Boolean = false,
    private val recordPaymentFailMessage: String = "write failed",
    existingReport: KinCareReport? = null,
) : AuntieDataSource {

    private val _invoices         = MutableStateFlow<FirestoreResult<List<Invoice>>>(FirestoreResult.Loading)
    private val _kinfolk          = MutableStateFlow<FirestoreResult<List<Kinfolk>>>(FirestoreResult.Loading)
    private val _sessions         = MutableStateFlow<FirestoreResult<List<KinCareSession>>>(FirestoreResult.Loading)
    private val _businessSettings = MutableStateFlow<FirestoreResult<BusinessSettings>>(FirestoreResult.Loading)
    private val _media            = MutableStateFlow<FirestoreResult<List<MediaFile>>>(FirestoreResult.Loading)
    private val _payments         = MutableStateFlow<FirestoreResult<List<Payment>>>(FirestoreResult.Loading)
    private val _trainingDocs     = MutableStateFlow<FirestoreResult<List<TrainingDocument>>>(FirestoreResult.Loading)
    private val _reports          = MutableStateFlow<FirestoreResult<List<KinCareReport>>>(
        if (existingReport != null) FirestoreResult.Data(listOf(existingReport))
        else FirestoreResult.Data(emptyList())
    )

    private val approveErrors = mutableMapOf<String, String>()
    private val rejectErrors  = mutableMapOf<String, String>()

    fun emitInvoices(result: FirestoreResult<List<Invoice>>)         { _invoices.value          = result }
    fun emitKinfolk(result: FirestoreResult<List<Kinfolk>>)          { _kinfolk.value           = result }
    fun emitSessions(result: FirestoreResult<List<KinCareSession>>)  { _sessions.value          = result }
    fun emitBusinessSettings(result: FirestoreResult<BusinessSettings>) { _businessSettings.value = result }
    fun emitMedia(result: FirestoreResult<List<MediaFile>>)          { _media.value             = result }
    fun emitPayments(result: FirestoreResult<List<Payment>>)         { _payments.value          = result }
    fun emitTrainingDocs(result: FirestoreResult<List<TrainingDocument>>) { _trainingDocs.value = result }

    fun setApproveBookingError(bookingId: String, message: String) { approveErrors[bookingId] = message }
    fun setRejectBookingError(bookingId: String, message: String)  { rejectErrors[bookingId]  = message }

    // 16.5: incoming-series queue + manageBookingSeries recording.
    private val _incoming = MutableStateFlow<FirestoreResult<List<KinCareVisit>>>(FirestoreResult.Data(emptyList()))
    fun emitIncoming(result: FirestoreResult<List<KinCareVisit>>) { _incoming.value = result }
    val seriesCalls = mutableListOf<Triple<String, String, String>>() // action, kinfolkId, batchId
    var manageBookingSeriesResult: WriteResult<ManageSeriesResult> = WriteResult.Ok(ManageSeriesResult(affectedVisits = 1))
    override fun incomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> = _incoming
    override suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): WriteResult<ManageSeriesResult> {
        seriesCalls += Triple(action, kinfolkId, batchId)
        return manageBookingSeriesResult
    }

    // ── Vet clinics: stream emitter + write recording + configurable failure ──
    private val _vetClinics = MutableStateFlow<FirestoreResult<List<VetClinic>>>(FirestoreResult.Data(emptyList()))
    fun emitVetClinics(result: FirestoreResult<List<VetClinic>>) { _vetClinics.value = result }
    val createdVetClinics = mutableListOf<VetClinic>()
    val updatedVetClinics = mutableListOf<VetClinic>()
    val deletedVetClinicIds = mutableListOf<String>()
    var vetClinicWriteShouldFail = false
    var vetClinicWriteFailMessage = "boom"

    override fun vetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> = _vetClinics.asStateFlow()
    override suspend fun createVetClinic(clinic: VetClinic): WriteResult<String> {
        createdVetClinics += clinic
        return if (vetClinicWriteShouldFail) WriteResult.Err(vetClinicWriteFailMessage) else WriteResult.Ok(clinic._id.ifBlank { "new-id" })
    }
    override suspend fun updateVetClinic(clinic: VetClinic): WriteResult<Unit> {
        updatedVetClinics += clinic
        return if (vetClinicWriteShouldFail) WriteResult.Err(vetClinicWriteFailMessage) else WriteResult.Ok(Unit)
    }
    override suspend fun deleteVetClinic(id: String): WriteResult<Unit> {
        deletedVetClinicIds += id
        return if (vetClinicWriteShouldFail) WriteResult.Err(vetClinicWriteFailMessage) else WriteResult.Ok(Unit)
    }

    // ── Kin (pets) stream: the real data source overrides allKinStream() to join
    // name/species/breed onto report headings (spec 11 item 4.1). The interface
    // default is an empty Data, so the kin-join integration test needs this seam. ──
    private val _kin = MutableStateFlow<FirestoreResult<List<Kin>>>(FirestoreResult.Data(emptyList()))
    fun emitKin(result: FirestoreResult<List<Kin>>) { _kin.value = result }
    override fun allKinStream(): Flow<FirestoreResult<List<Kin>>> = _kin.asStateFlow()

    override fun invoicesStream(): Flow<FirestoreResult<List<Invoice>>>        = _invoices.asStateFlow()
    override fun kinfolkStream():  Flow<FirestoreResult<List<Kinfolk>>>        = _kinfolk.asStateFlow()
    override fun sessionsStream(): Flow<FirestoreResult<List<KinCareSession>>> = _sessions.asStateFlow()
    override fun paymentsStream(): Flow<FirestoreResult<List<Payment>>>        = _payments.asStateFlow()

    override suspend fun recordPayment(payment: Payment): WriteResult<String> {
        if (recordPaymentShouldFail) return WriteResult.Err(recordPaymentFailMessage)
        val id = "fake-pay-${_payments.value.let { if (it is FirestoreResult.Data) it.value.size else 0 }}"
        val saved = payment.copy(_id = id)
        val current = _payments.value
        val newList = if (current is FirestoreResult.Data) current.value + saved else listOf(saved)
        _payments.value = FirestoreResult.Data(newList)
        return WriteResult.Ok(id)
    }

    /** How many times a caller asked for the settings stream (#867 review: Retry must ask again). */
    var businessSettingsStreamCalls = 0
        private set

    override fun businessSettingsStream(): Flow<FirestoreResult<BusinessSettings>> {
        businessSettingsStreamCalls++
        return _businessSettings.asStateFlow()
    }

    /** The last BusinessSettings handed to saveBusinessSettings (for assertions). */
    var lastSavedBusinessSettings: BusinessSettings? = null
        private set

    override suspend fun saveBusinessSettings(settings: BusinessSettings): WriteResult<Unit> =
        if (saveShouldFail) {
            WriteResult.Err(saveFailMessage)
        } else {
            lastSavedBusinessSettings = settings
            WriteResult.Ok(Unit)
        }

    override suspend fun approveBooking(bookingId: String): WriteResult<Unit> {
        approveErrors[bookingId]?.let { return WriteResult.Err(it) }
        val current = _sessions.value
        if (current is FirestoreResult.Data) {
            val found = current.value.any { it._id == bookingId }
            if (!found) return WriteResult.Err("Session not found: $bookingId")
            _sessions.value = FirestoreResult.Data(
                current.value.map { if (it._id == bookingId) it.copy(status = "SCHEDULED") else it }
            )
        } else {
            return WriteResult.Err("Session not found: $bookingId")
        }
        return WriteResult.Ok(Unit)
    }

    override suspend fun rejectBooking(bookingId: String): WriteResult<Unit> {
        rejectErrors[bookingId]?.let { return WriteResult.Err(it) }
        val current = _sessions.value
        if (current is FirestoreResult.Data) {
            val found = current.value.any { it._id == bookingId }
            if (!found) return WriteResult.Err("Session not found: $bookingId")
            _sessions.value = FirestoreResult.Data(
                current.value.map { if (it._id == bookingId) it.copy(status = "CANCELLED") else it }
            )
        } else {
            return WriteResult.Err("Session not found: $bookingId")
        }
        return WriteResult.Ok(Unit)
    }

    override suspend fun createBooking(booking: KinCareSession): WriteResult<String> {
        val current = _sessions.value
        val newList = if (current is FirestoreResult.Data) current.value + booking else listOf(booking)
        _sessions.value = FirestoreResult.Data(newList)
        return WriteResult.Ok(booking._id.ifBlank { "fake-id" })
    }

    override fun mediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>> =
        _media.map { result ->
            when (result) {
                is FirestoreResult.Data -> FirestoreResult.Data(
                    result.value.filter { it.entityId == entityId && it.entityType == entityType }
                )
                else -> result
            }
        }

    override suspend fun uploadMedia(
        entityId: String,
        entityType: String,
        bytes: ByteArray,
        mimeType: String,
    ): WriteResult<MediaFile> {
        if (uploadShouldFail) return WriteResult.Err("upload failed")
        val newItem = MediaFile(
            _id = "fake-media-${(_media.value as? FirestoreResult.Data)?.value?.size ?: 0}",
            entityId = entityId,
            entityType = entityType,
            mimeType = mimeType,
            storageUrl = "https://example.com/fake",
        )
        val current = _media.value
        val newList = if (current is FirestoreResult.Data) current.value + newItem else listOf(newItem)
        _media.value = FirestoreResult.Data(newList)
        return WriteResult.Ok(newItem)
    }

    /** #577: records the last (mediaId, entityId) pair the caller sent. */
    var lastDeleteArgs: Pair<String, String>? = null

    override suspend fun deleteMedia(mediaId: String, entityId: String): WriteResult<Unit> {
        lastDeleteArgs = mediaId to entityId
        if (deleteShouldFail) return WriteResult.Err("delete failed")
        val current = _media.value
        if (current is FirestoreResult.Data) {
            _media.value = FirestoreResult.Data(current.value.filter { it._id != mediaId })
        }
        return WriteResult.Ok(Unit)
    }

    // ---- setMediaProfilePhoto: records the call + toggles isProfilePhoto so the
    // gallery badge moves, clearing the flag on siblings of the same entity. ----
    var setProfileShouldFail: Boolean = false
    var setProfileFailMessage: String = "set profile failed"
    /** Records the last (mediaFileId, entityType, entityId) for assertions. */
    var lastSetProfileCall: Triple<String, String, String>? = null

    override suspend fun setMediaProfilePhoto(
        mediaFileId: String,
        entityType: String,
        entityId: String,
    ): WriteResult<Unit> {
        lastSetProfileCall = Triple(mediaFileId, entityType, entityId)
        if (setProfileShouldFail) return WriteResult.Err(setProfileFailMessage)
        val current = _media.value
        if (current is FirestoreResult.Data) {
            _media.value = FirestoreResult.Data(
                current.value.map {
                    when {
                        it._id == mediaFileId -> it.copy(isProfilePhoto = true)
                        it.entityId == entityId && it.entityType == entityType -> it.copy(isProfilePhoto = false)
                        else -> it
                    }
                },
            )
        }
        return WriteResult.Ok(Unit)
    }

    override fun reportForSessionStream(sessionId: String): Flow<FirestoreResult<KinCareReport?>> =
        _reports.map { result ->
            when (result) {
                is FirestoreResult.Data -> FirestoreResult.Data(result.value.firstOrNull { it.sessionId == sessionId })
                is FirestoreResult.Error -> FirestoreResult.Error(result.message)
                FirestoreResult.Loading -> FirestoreResult.Loading
            }
        }

    /** The most recent report handed to [saveReport], for test assertions. */
    var lastSavedReport: KinCareReport? = null
        private set

    /** How many times [saveReport] has been entered, for in-flight-guard assertions. */
    var saveReportCalls: Int = 0
        private set

    /**
     * When set, [saveReport] suspends on this gate before completing. Lets a test
     * hold the first save in-flight while it fires a second call to verify the
     * VM's isSaving guard drops it (NOTE-63). Complete the gate to release.
     */
    var saveGate: CompletableDeferred<Unit>? = null

    override suspend fun saveReport(report: KinCareReport): WriteResult<String> {
        saveReportCalls++
        saveGate?.await()
        lastSavedReport = report
        if (saveShouldFail) return WriteResult.Err(saveFailMessage)
        val id = report._id.ifBlank { "report-fake-id" }
        val saved = report.copy(_id = id)
        val current = _reports.value
        val newList = if (current is FirestoreResult.Data) {
            val exists = current.value.any { it._id == id }
            if (exists) current.value.map { if (it._id == id) saved else it }
            else current.value + saved
        } else listOf(saved)
        _reports.value = FirestoreResult.Data(newList)
        return WriteResult.Ok(id)
    }

    override fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> = _trainingDocs.asStateFlow()

    /** Captures the (report, session) last passed to [sendReport], for assertions. */
    var lastSendReport: KinCareReport? = null
        private set
    var lastSendSession: KinCareSession? = null
        private set

    /** Receipt id the fake stamps onto the SENT report (simulates first dispatchId). */
    var sendDeliveryReceiptId: String = "n8n_fake_123"

    override suspend fun sendReport(report: KinCareReport, session: KinCareSession): WriteResult<Unit> {
        lastSendReport = report
        lastSendSession = session
        // Mirror the real fail-loud routing guards before flipping to SENT.
        if (session.kinfolkId.isBlank()) return WriteResult.Err("Cannot send: no kinfolk to route to.")
        if (session.sourceBookingId.isBlank()) return WriteResult.Err("Cannot send: session not booking-originated.")
        if (sendShouldFail) return WriteResult.Err(sendFailMessage)
        val current = _reports.value
        if (current is FirestoreResult.Data) {
            _reports.value = FirestoreResult.Data(
                current.value.map {
                    if (it._id == report._id) it.copy(
                        status = "SENT",
                        sentVia = "catalog",
                        deliveryReceiptId = sendDeliveryReceiptId,
                    ) else it
                }
            )
        }
        return WriteResult.Ok(Unit)
    }

    // ---- Booking notes (in-memory, keyed by kinfolkId+bookingId) ----
    private val _bookingNotes = MutableStateFlow<Map<String, List<BookingNote>>>(emptyMap())
    private val _bookingInternalNotes = MutableStateFlow<Map<String, List<BookingNote>>>(emptyMap())
    var addBookingNoteShouldFail: Boolean = false
    var addInternalBookingNoteShouldFail: Boolean = false

    private fun noteKey(kinfolkId: String, bookingId: String) = "$kinfolkId/$bookingId"

    override fun bookingNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>> {
        val key = noteKey(kinfolkId, bookingId)
        return _bookingNotes.map { all ->
            FirestoreResult.Data(all[key].orEmpty())
        }
    }

    override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>> {
        val key = noteKey(kinfolkId, bookingId)
        return _bookingInternalNotes.map { all ->
            FirestoreResult.Data(all[key].orEmpty())
        }
    }

    override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String> {
        if (addBookingNoteShouldFail) return WriteResult.Err("add note failed")
        val key = noteKey(kinfolkId, bookingId)
        val noteId = "note-${_bookingNotes.value.values.sumOf { it.size }}"
        val note = BookingNote(_id = noteId, authorRole = "admin", body = body, createdAtMs = 0L)
        _bookingNotes.value = _bookingNotes.value + (key to (_bookingNotes.value[key].orEmpty() + note))
        return WriteResult.Ok(noteId)
    }

    override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String> {
        if (addInternalBookingNoteShouldFail) return WriteResult.Err("add internal note failed")
        val key = noteKey(kinfolkId, bookingId)
        val noteId = "internal-note-${_bookingInternalNotes.value.values.sumOf { it.size }}"
        val note = BookingNote(_id = noteId, authorRole = "admin", body = body, createdAtMs = 0L)
        _bookingInternalNotes.value = _bookingInternalNotes.value + (key to (_bookingInternalNotes.value[key].orEmpty() + note))
        return WriteResult.Ok(noteId)
    }

    // ---- KinTale comments (in-memory, keyed by taleId) ----
    val kinTaleComments = MutableStateFlow<Map<String, List<KinTaleComment>>>(emptyMap())
    /** When true, the comment stream emits a fail-loud Error (no fabricated rows). */
    var commentsStreamError: String? = null
    var addKinTaleCommentShouldFail: Boolean = false
    /** Records the last addKinTaleComment call so tests can assert the exact payload. */
    var lastAddedComment: Triple<String, String, String?>? = null

    override fun kinTaleCommentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>> =
        kinTaleComments.map { all ->
            commentsStreamError?.let { FirestoreResult.Error(it) }
                ?: FirestoreResult.Data((all[taleId].orEmpty()).sortedBy { it.createdAtMs ?: 0L })
        }

    override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?): WriteResult<String> {
        lastAddedComment = Triple(taleId, body, parentCommentId)
        if (addKinTaleCommentShouldFail) return WriteResult.Err("permission-denied")
        val id = "c-${kinTaleComments.value.values.sumOf { it.size }}"
        val comment = KinTaleComment(
            _id = id,
            authorRole = "admin",
            body = body,
            parentCommentId = parentCommentId,
            createdAtMs = (kinTaleComments.value[taleId]?.size ?: 0).toLong(),
        )
        kinTaleComments.value = kinTaleComments.value + (taleId to (kinTaleComments.value[taleId].orEmpty() + comment))
        return WriteResult.Ok(id)
    }
}
