package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.Flow

class FirestoreAuntieDataSource(
    private val client: FirestoreClient,
) : AuntieDataSource {
    override fun invoicesStream(): Flow<FirestoreResult<List<Invoice>>> = client.invoicesStream()
    override fun kinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>> = client.kinfolkStream()
    override fun allKinStream(): Flow<FirestoreResult<List<Kin>>> = client.allKinStream()
    override fun vetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> = client.vetClinicsStream()
    override suspend fun createVetClinic(clinic: VetClinic): WriteResult<String> = client.createVetClinic(clinic)
    override suspend fun updateVetClinic(clinic: VetClinic): WriteResult<Unit> = client.updateVetClinic(clinic)
    override suspend fun deleteVetClinic(id: String): WriteResult<Unit> = client.deleteVetClinic(id)
    override fun sessionsStream(): Flow<FirestoreResult<List<KinCareSession>>> = client.sessionsStream()
    override fun sessionForIdStream(sessionId: String): Flow<FirestoreResult<KinCareSession?>> = client.sessionForIdStream(sessionId)
    override fun paymentsStream(): Flow<FirestoreResult<List<Payment>>> = client.paymentsStream()
    override suspend fun recordPayment(payment: Payment): WriteResult<String> = client.recordPayment(payment)
    override fun businessSettingsStream(): Flow<FirestoreResult<BusinessSettings>> = client.businessSettingsStream()
    override suspend fun saveBusinessSettings(settings: BusinessSettings): WriteResult<Unit> = client.saveBusinessSettings(settings)
    override suspend fun approveBooking(bookingId: String): WriteResult<Unit> = client.approveBooking(bookingId)
    override suspend fun rejectBooking(bookingId: String): WriteResult<Unit> = client.rejectBooking(bookingId)
    override suspend fun createBooking(booking: KinCareSession): WriteResult<String> = client.createBookingRequest(booking)

    override suspend fun createMultiDateBookingRequest(
        kinfolkId: String,
        visits: List<NewBookingVisitInput>,
        notes: String?,
        pattern: String,
        weeklyDays: List<Int>?,
    ): WriteResult<MultiDateBookingResult> =
        client.createMultiDateBookingRequest(kinfolkId, visits, notes, pattern, weeklyDays)
    override fun incomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> = client.incomingKinCaresStream()
    override suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): WriteResult<ManageSeriesResult> =
        client.manageBookingSeries(action, kinfolkId, batchId)
    override fun mediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>> = client.mediaStream(entityId, entityType)
    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile> = client.uploadMedia(entityId, entityType, bytes, mimeType)
    override suspend fun deleteMedia(mediaId: String): WriteResult<Unit> = client.deleteMedia(mediaId)
    override fun reportForSessionStream(sessionId: String): Flow<FirestoreResult<KinCareReport?>> = client.reportForSessionStream(sessionId)
    override suspend fun saveReport(report: KinCareReport): WriteResult<String> = client.saveReport(report)
    override suspend fun sendReport(report: KinCareReport, session: KinCareSession): WriteResult<Unit> = client.sendReport(report, session)
    override fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> = client.trainingDocsStream()
    override fun bookingNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>> =
        client.bookingNotesStream(kinfolkId, bookingId, internal = false)
    override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String): Flow<FirestoreResult<List<BookingNote>>> =
        client.bookingNotesStream(kinfolkId, bookingId, internal = true)
    override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String> =
        client.addBookingNote(kinfolkId, bookingId, body, internal = false)
    override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String): WriteResult<String> =
        client.addBookingNote(kinfolkId, bookingId, body, internal = true)
    override fun kinTaleCommentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>> =
        client.kinTaleCommentsStream(taleId, kinfolkId)
    override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?): WriteResult<String> =
        client.addKinTaleComment(taleId, kinfolkId, body, parentCommentId)
    override suspend fun createShareLink(familyId: String, kinTaleId: String, includePhotos: Boolean): WriteResult<String> =
        client.createShareLink(familyId, kinTaleId, includePhotos)
}
