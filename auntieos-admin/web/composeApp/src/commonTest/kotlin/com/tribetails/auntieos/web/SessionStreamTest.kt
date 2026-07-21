package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * Tests for the sessions stream state machine emitted by [FakeAuntieDataSource].
 * Covers all [FirestoreResult] variants, empty list, multiple sessions, field integrity,
 * and status lifecycle values.
 */
class SessionStreamTest {

    @Test
    fun sessionsStream_initialState_isLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.sessionsStream().first())
    }

    @Test
    fun sessionsStream_emptyList_noError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals(0, result.value.size)
    }

    @Test
    fun sessionsStream_populatedList_hasCorrectCount() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals(3, result.value.size)
    }

    @Test
    fun sessionsStream_error_surfacesMessage() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Error("Firestore unavailable"))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("Firestore unavailable", result.message)
    }

    @Test
    fun sessionsStream_data_preservesDraftStatus() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("DRAFT", result.value.first().status)
    }

    @Test
    fun sessionsStream_data_preservesScheduledStatus() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionScheduled1)))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("SCHEDULED", result.value.first().status)
    }

    @Test
    fun sessionsStream_data_preservesCompletedStatus() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionCompleted1)))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("COMPLETED", result.value.first().status)
    }

    @Test
    fun sessionsStream_data_preservesFieldValues() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(TestData.sessionDraft1)))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)

        val session = result.value.first()
        assertEquals("sess-1", session._id)
        assertEquals("kf-1", session.kinfolkId)
        assertEquals("Rosa Parks", session.kinfolkName)
        assertEquals("Dog Walking", session.serviceType)
        assertEquals("DRAFT", session.status)
    }

    @Test
    fun sessionsStream_filterByStatus_draftSessions() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)

        val drafts = result.value.filter { it.status == "DRAFT" }
        assertEquals(1, drafts.size)
        assertEquals("sess-1", drafts.first()._id)
    }

    @Test
    fun sessionsStream_filterByKinfolkId_returnsCorrectSessions() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)

        val forKf1 = result.value.filter { it.kinfolkId == "kf-1" }
        assertEquals(2, forKf1.size)
    }

    @Test
    fun sessionsStream_transitionsFromLoadingToData() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.sessionsStream().first())

        ds.emitSessions(FirestoreResult.Data(TestData.sessions))
        assertIs<FirestoreResult.Data<*>>(ds.sessionsStream().first())
    }

    @Test
    fun sessionsStream_transitionsFromDataToError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(TestData.sessions))
        assertIs<FirestoreResult.Data<*>>(ds.sessionsStream().first())

        ds.emitSessions(FirestoreResult.Error("lost connection"))
        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("lost connection", result.message)
    }

    @Test
    fun approveBooking_sessionNotInStream_returnsErr() = runTest {
        val ds = FakeAuntieDataSource()
        // Sessions stream is still Loading - approveBooking on a non-existent session
        // must return Err, not silently succeed (silent no-ops on missing data are bugs)
        val result = ds.approveBooking("non-existent-id")
        assertIs<com.tribetails.auntieos.web.data.WriteResult.Err>(result)
    }

    @Test
    fun rejectBooking_sessionNotInStream_returnsErr() = runTest {
        val ds = FakeAuntieDataSource()
        val result = ds.rejectBooking("non-existent-id")
        assertIs<com.tribetails.auntieos.web.data.WriteResult.Err>(result)
    }
}
