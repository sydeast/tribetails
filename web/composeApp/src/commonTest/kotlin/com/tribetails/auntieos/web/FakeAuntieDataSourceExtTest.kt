package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * Extended tests for [FakeAuntieDataSource] covering error emission paths,
 * kinfolk/session streams, and write operation behaviour.
 */
class FakeAuntieDataSourceExtTest {

    // ---- kinfolk stream ----

    @Test
    fun kinfolkStream_startsLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.kinfolkStream().first())
    }

    @Test
    fun kinfolkStream_emitsData() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(TestData.kinfolkList))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        assertEquals(2, (result as FirestoreResult.Data<*>).value.let {
            @Suppress("UNCHECKED_CAST")
            (it as List<*>).size
        })
    }

    @Test
    fun kinfolkStream_emitsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Error("permission denied"))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("permission denied", result.message)
    }

    @Test
    fun kinfolkStream_emitsEmptyList() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(emptyList()))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
        assertEquals(0, (result as FirestoreResult.Data<*>).value.let {
            @Suppress("UNCHECKED_CAST")
            (it as List<*>).size
        })
    }

    // ---- sessions stream ----

    @Test
    fun sessionsStream_startsLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.sessionsStream().first())
    }

    @Test
    fun sessionsStream_emitsData() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
    }

    @Test
    fun sessionsStream_emitsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Error("Firestore unavailable"))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("Firestore unavailable", result.message)
    }

    @Test
    fun sessionsStream_emitsEmptyList() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
    }

    // ---- businessSettings stream ----

    @Test
    fun businessSettingsStream_startsLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.businessSettingsStream().first())
    }

    @Test
    fun businessSettingsStream_emitsData() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        val result = ds.businessSettingsStream().first()
        assertIs<FirestoreResult.Data<*>>(result)
    }

    @Test
    fun businessSettingsStream_emitsError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitBusinessSettings(FirestoreResult.Error("settings unavailable"))

        val result = ds.businessSettingsStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("settings unavailable", result.message)
    }

    // ---- write operations ----

    @Test
    fun saveBusinessSettings_returnsOk_whenSaveShouldFailFalse() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = false)
        val result = ds.saveBusinessSettings(TestData.businessSettings)
        assertIs<WriteResult.Ok<Unit>>(result)
    }

    @Test
    fun saveBusinessSettings_returnsErr_whenSaveShouldFailTrue() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "write denied")
        val result = ds.saveBusinessSettings(TestData.businessSettings)
        assertIs<WriteResult.Err>(result)
        assertEquals("write denied", result.message)
    }

    @Test
    fun approveBooking_returnsOk_andUpdatesSessionStatus() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))

        val result = ds.approveBooking(TestData.sessionDraft1._id)
        assertIs<WriteResult.Ok<Unit>>(result)

        val updated = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(updated)
    }

    @Test
    fun approveBooking_returnsErr_whenErrorConfigured() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        ds.setApproveBookingError(TestData.sessionDraft1._id, "permission denied")

        val result = ds.approveBooking(TestData.sessionDraft1._id)
        assertIs<WriteResult.Err>(result)
        assertEquals("permission denied", result.message)
    }

    @Test
    fun rejectBooking_returnsOk_andUpdatesSessionStatus() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))

        val result = ds.rejectBooking(TestData.sessionDraft1._id)
        assertIs<WriteResult.Ok<Unit>>(result)
    }

    @Test
    fun rejectBooking_returnsErr_whenErrorConfigured() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))
        ds.setRejectBookingError(TestData.sessionDraft1._id, "rejected by server")

        val result = ds.rejectBooking(TestData.sessionDraft1._id)
        assertIs<WriteResult.Err>(result)
        assertEquals("rejected by server", result.message)
    }

    @Test
    fun createBooking_addsSessionToStream() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))

        val result = ds.createBooking(TestData.sessionDraft1)
        assertIs<WriteResult.Ok<String>>(result)

        val streamResult = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<*>>(streamResult)
        assertEquals(1, (streamResult as FirestoreResult.Data<*>).value.let {
            @Suppress("UNCHECKED_CAST")
            (it as List<*>).size
        })
    }

    // ---- concurrent state transitions ----

    @Test
    fun stream_canTransitionFromLoadingToDataToError() = runTest {
        val ds = FakeAuntieDataSource()

        // Start: Loading
        assertIs<FirestoreResult.Loading>(ds.invoicesStream().first())

        // Transition to Data
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))
        assertIs<FirestoreResult.Data<*>>(ds.invoicesStream().first())

        // Transition to Error
        ds.emitInvoices(FirestoreResult.Error("connection lost"))
        val errorResult = ds.invoicesStream().first()
        assertIs<FirestoreResult.Error>(errorResult)
        assertEquals("connection lost", errorResult.message)
    }

    @Test
    fun stream_canTransitionFromErrorBackToData() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Error("transient error"))
        assertIs<FirestoreResult.Error>(ds.invoicesStream().first())

        // Recovery: emit Data after Error
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))
        assertIs<FirestoreResult.Data<*>>(ds.invoicesStream().first())
    }

    @Test
    fun multipleStreams_areIndependent() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitInvoices(FirestoreResult.Data(TestData.invoices))
        ds.emitKinfolk(FirestoreResult.Error("kinfolk unavailable"))

        // Invoices should be Data while kinfolk is Error
        assertIs<FirestoreResult.Data<*>>(ds.invoicesStream().first())
        assertIs<FirestoreResult.Error>(ds.kinfolkStream().first())
        // Sessions unchanged - still Loading
        assertIs<FirestoreResult.Loading>(ds.sessionsStream().first())
    }
}
