package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Slice 8: BookingRepository.syncGoogleBusyEventsViaServer wraps the
 * syncGoogleCalendarBusyEvents Cloud Function. These tests verify the
 * result->Int decode and the fail-loud propagation of the server message
 * (which names the sync service account). FirebaseFunctions is fully mocked so
 * no network or Android static init is required.
 */
class BookingRepositorySyncTest {

    private fun repoWith(functions: FirebaseFunctions): BookingRepository =
        BookingRepository(firestore = mockk<FirebaseFirestore>(relaxed = true), functions = functions)

    @Test
    fun `syncGoogleBusyEventsViaServer decodes imported count`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("imported" to 3, "scanned" to 3)
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("syncGoogleCalendarBusyEvents") } returns ref

        val result = repoWith(functions).syncGoogleBusyEventsViaServer(14)
        assertTrue(result.isSuccess)
        assertEquals(3, result.getOrNull())
    }

    @Test
    fun `syncGoogleBusyEventsViaServer defaults missing imported to zero`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("scanned" to 0)
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("syncGoogleCalendarBusyEvents") } returns ref

        val result = repoWith(functions).syncGoogleBusyEventsViaServer()
        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrNull())
    }

    @Test
    fun `syncGoogleBusyEventsViaServer propagates server fail-loud message`() = runBlocking {
        val serverMsg =
            "calendar_not_shared: share calendar team-cal with " +
                "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at \"See only free/busy (hide details)\" so the sync service account can read availability."
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException(serverMsg))
        every { functions.getHttpsCallable("syncGoogleCalendarBusyEvents") } returns ref

        val result = repoWith(functions).syncGoogleBusyEventsViaServer()
        assertTrue(result.isFailure)
        assertTrue(
            result.exceptionOrNull()!!.message!!
                .contains("auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com")
        )
    }
}
