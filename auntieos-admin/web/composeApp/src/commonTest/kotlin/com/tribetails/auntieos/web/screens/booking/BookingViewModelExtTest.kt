package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.TestData
import com.tribetails.auntieos.web.data.FirestoreResult
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Additional [BookingViewModel] tests beyond the 4 already in BookingViewModelTest.
 * Covers: rejectBooking success state, empty booking list, booking list error state,
 * clearError, and concurrent approve/reject operations.
 */
class BookingViewModelExtTest {

    // ---- rejectBooking success ----

    @Test
    fun rejectBooking_clearsErrorMessage_onSuccess() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        val vm = BookingViewModel(ds)

        vm.rejectBooking(TestData.sessionDraft1._id)

        assertNull(vm.errorMessage, "errorMessage must be null after successful reject")
    }

    @Test
    fun rejectBooking_setsErrorMessage_onFailure() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        ds.setRejectBookingError(TestData.sessionDraft1._id, "permission denied")
        val vm = BookingViewModel(ds)

        vm.rejectBooking(TestData.sessionDraft1._id)

        assertNotNull(vm.errorMessage, "errorMessage must be set after failed reject")
        assertEquals(true, vm.errorMessage!!.contains("permission denied"))
    }

    @Test
    fun rejectBooking_updatesSessionStatusToCancelled() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        val vm = BookingViewModel(ds)

        vm.rejectBooking(TestData.sessionDraft1._id)

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        val sessions = (result as FirestoreResult.Data<*>).value
        @Suppress("UNCHECKED_CAST")
        val updated = (sessions as List<com.tribetails.auntieos.web.data.KinCareSession>)
            .firstOrNull { it._id == TestData.sessionDraft1._id }
        assertNotNull(updated)
        assertEquals("CANCELLED", updated.status)
    }

    // ---- empty booking list ----

    @Test
    fun bookingsStream_emitsEmptyList_whenNoSessions() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        val result = vm.bookingsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        val list = (result as FirestoreResult.Data<*>).value
        @Suppress("UNCHECKED_CAST")
        assertEquals(0, (list as List<*>).size)
    }

    // ---- booking list error state ----

    @Test
    fun bookingsStream_reflectsError_whenDataSourceEmitsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Error("Firestore unavailable"))
        val vm = BookingViewModel(ds)

        val result = vm.bookingsStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("Firestore unavailable", result.message)
    }

    @Test
    fun bookingsStream_isLoading_initialState() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = BookingViewModel(ds)

        val result = vm.bookingsStream().first()
        assertIs<FirestoreResult.Loading>(result)
    }

    // ---- clearError ----

    @Test
    fun clearError_resetsErrorMessageToNull() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        ds.setApproveBookingError(TestData.sessionDraft1._id, "network failure")
        val vm = BookingViewModel(ds)

        vm.approveBooking(TestData.sessionDraft1._id)
        assertNotNull(vm.errorMessage, "precondition: errorMessage should be set")

        vm.clearError()

        assertNull(vm.errorMessage, "errorMessage must be null after clearError")
    }

    // ---- multiple sessions ----

    @Test
    fun approveBooking_onlyUpdatesTargetSession() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))
        val vm = BookingViewModel(ds)

        // Approve only sessionDraft1
        vm.approveBooking(TestData.sessionDraft1._id)

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        @Suppress("UNCHECKED_CAST")
        val sessions = (result as FirestoreResult.Data<*>).value as List<com.tribetails.auntieos.web.data.KinCareSession>

        val approved = sessions.first { it._id == TestData.sessionDraft1._id }
        assertEquals("SCHEDULED", approved.status)

        // Other sessions should remain unchanged
        val unchanged = sessions.first { it._id == TestData.sessionScheduled1._id }
        assertEquals("SCHEDULED", unchanged.status)
    }

    @Test
    fun createBooking_appended_toExistingSessions() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionScheduled1)))
        val vm = BookingViewModel(ds)

        vm.createBooking(TestData.sessionDraft1)

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        @Suppress("UNCHECKED_CAST")
        val sessions = (result as FirestoreResult.Data<*>).value as List<*>
        assertEquals(2, sessions.size)
    }

    // H7: approveBooking on non-existent session must surface an error

    @Test
    fun approveBooking_nonExistentId_setsErrorMessage() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        val vm = BookingViewModel(ds)

        vm.approveBooking("does-not-exist")

        assertNotNull(vm.errorMessage, "approveBooking on a non-existent session must set an error message")
    }

    // H-W1: createBooking with all-default (empty) KinCareSession must validate and set error
    @Test
    fun createBooking_withEmptySession_setsError_notSilentSuccess() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        // KinCareSession() with default values - empty kinfolkId, serviceType, etc.
        vm.createBooking(com.tribetails.auntieos.web.data.KinCareSession())

        assertNotNull(
            "createBooking with an empty session must set an error - not silently accept it",
            vm.errorMessage
        )
    }

    @Test
    fun createBooking_setsError_whenCreateFails() = runTest {
        // Use a data source whose createBooking fails by overriding with a custom save-fail fake
        // Since FakeAuntieDataSource doesn't have a createShouldFail flag, we wrap with an inline override
        val ds = object : com.tribetails.auntieos.web.data.AuntieDataSource {
            private val _fake = FakeAuntieDataSource()
            override fun invoicesStream() = _fake.invoicesStream()
            override fun kinfolkStream()  = _fake.kinfolkStream()
            override fun sessionsStream() = _fake.sessionsStream()
            override fun paymentsStream() = _fake.paymentsStream()
            override suspend fun recordPayment(payment: com.tribetails.auntieos.web.data.Payment) = _fake.recordPayment(payment)
            override fun businessSettingsStream() = _fake.businessSettingsStream()
            override suspend fun saveBusinessSettings(settings: com.tribetails.auntieos.web.data.BusinessSettings) =
                com.tribetails.auntieos.web.data.WriteResult.Ok(Unit)
            override suspend fun approveBooking(bookingId: String) = com.tribetails.auntieos.web.data.WriteResult.Ok(Unit)
            override suspend fun rejectBooking(bookingId: String)  = com.tribetails.auntieos.web.data.WriteResult.Ok(Unit)
            override suspend fun createBooking(booking: com.tribetails.auntieos.web.data.KinCareSession) =
                com.tribetails.auntieos.web.data.WriteResult.Err("quota exceeded")
            override fun mediaStream(entityId: String, entityType: String) = _fake.mediaStream(entityId, entityType)
            override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) = _fake.uploadMedia(entityId, entityType, bytes, mimeType)
            override suspend fun deleteMedia(mediaId: String, entityId: String) = _fake.deleteMedia(mediaId, entityId)
            override fun reportForSessionStream(sessionId: String) = _fake.reportForSessionStream(sessionId)
            override suspend fun saveReport(report: com.tribetails.auntieos.web.data.KinCareReport) = _fake.saveReport(report)
            override suspend fun sendReport(report: com.tribetails.auntieos.web.data.KinCareReport, session: com.tribetails.auntieos.web.data.KinCareSession) = _fake.sendReport(report, session)
            override fun trainingDocsStream() = _fake.trainingDocsStream()
            override fun bookingNotesStream(kinfolkId: String, bookingId: String) = _fake.bookingNotesStream(kinfolkId, bookingId)
            override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String) = _fake.bookingInternalNotesStream(kinfolkId, bookingId)
            override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String) = _fake.addBookingNote(kinfolkId, bookingId, body)
            override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String) = _fake.addInternalBookingNote(kinfolkId, bookingId, body)
            override fun kinTaleCommentsStream(taleId: String, kinfolkId: String) = _fake.kinTaleCommentsStream(taleId, kinfolkId)
            override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?) = _fake.addKinTaleComment(taleId, kinfolkId, body, parentCommentId)
        }
        val vm = BookingViewModel(ds)

        vm.createBooking(TestData.sessionDraft1)

        assertNotNull(vm.errorMessage)
        assertEquals(true, vm.errorMessage!!.contains("quota exceeded"))
    }

    // ---- 16.5 series approve/cancel ----

    @Test
    fun approveSeries_callsManageBookingSeries_andClearsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.manageBookingSeriesResult = com.tribetails.auntieos.web.data.WriteResult.Ok(
            com.tribetails.auntieos.web.data.ManageSeriesResult(affectedVisits = 3)
        )
        val vm = BookingViewModel(ds)

        vm.approveSeries(kinfolkId = "kf1", batchId = "b1")

        assertEquals(Triple("APPROVE", "kf1", "b1"), ds.seriesCalls.single())
        assertNull(vm.errorMessage)
        assertNull(vm.seriesActionBatchId, "in-flight lock must clear after the call")
    }

    @Test
    fun cancelSeries_failure_setsErrorMessage() = runTest {
        val ds = FakeAuntieDataSource()
        ds.manageBookingSeriesResult = com.tribetails.auntieos.web.data.WriteResult.Err("nope")
        val vm = BookingViewModel(ds)

        vm.cancelSeries(kinfolkId = "kf1", batchId = "b1")

        assertEquals("CANCEL", ds.seriesCalls.single().first)
        assertNotNull(vm.errorMessage)
        assertEquals(true, vm.errorMessage!!.contains("nope"))
    }

    // 16.5 fail-loud: a partial failure (ok with failedVisits > 0) must NOT read
    // as a clean success - the admin has to see the stuck visits.
    @Test
    fun approveSeries_partialFailure_setsFailLoudBanner() = runTest {
        val ds = FakeAuntieDataSource()
        ds.manageBookingSeriesResult = com.tribetails.auntieos.web.data.WriteResult.Ok(
            com.tribetails.auntieos.web.data.ManageSeriesResult(affectedVisits = 3, failedVisits = 2)
        )
        val vm = BookingViewModel(ds)

        vm.approveSeries(kinfolkId = "kf1", batchId = "b1")

        assertNotNull(vm.errorMessage, "partial failure must surface an error banner, not silent success")
        assertEquals(true, vm.errorMessage!!.contains("3"))
        assertEquals(true, vm.errorMessage!!.contains("2"))
        assertNull(vm.seriesActionBatchId)
    }
}
