package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #447: `AuntieRepository.updateMediaTags` is the client half of the new
 * `saveMediaTags` callable.
 *
 * Before this change the method wrote `taggedKinIds` STRAIGHT to Firestore, so
 * there was nothing to hold fixed: any list of any strings was a legal write.
 * These tests pin the wire contract the callable now owns, because the React
 * admin builds the same payload from the same field names
 * (`auntieos-admin/src/api/mediaTags.ts`) and a rename on either side has to
 * fail here rather than in production. Mirrors
 * `AuntieRepositoryBatchUpdateBookingsTest`: FirebaseFunctions is fully mocked,
 * so no network and no Android static init.
 */
class AuntieRepositoryUpdateMediaTagsTest {

    private val n8nApi = mockk<N8nApi>()

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()): AuntieRepository =
        AuntieRepository(n8n = n8nApi, authGate = authGate, functionsOverride = functions)

    /** Wires a mocked `saveMediaTags` returning [data], capturing what was sent into [payload]. */
    private fun functionsReturning(
        data: Map<String, Any?>?,
        payload: io.mockk.CapturingSlot<Map<String, Any?>>,
    ): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("saveMediaTags") } returns ref
        return functions
    }

    @Test
    fun `sends the media id and the COMPLETE tag list to saveMediaTags`() = runBlocking {
        val payload = slot<Map<String, Any?>>()
        val functions = functionsReturning(
            mapOf("ok" to true, "mediaFileId" to "m1", "taggedKinIds" to listOf("k1", "k2")),
            payload,
        )

        val result = repoWith(functions).updateMediaTags("m1", listOf("k1", "k2"))

        assertTrue(result.isSuccess)
        assertEquals(mapOf("mediaFileId" to "m1", "taggedKinIds" to listOf("k1", "k2")), payload.captured)
    }

    @Test
    fun `returns the list the SERVER stored, not the one that was sent`() = runBlocking {
        // The callable de-duplicates. Echoing the request back would leave the
        // gallery grid showing a list the document does not hold.
        val payload = slot<Map<String, Any?>>()
        val functions = functionsReturning(
            mapOf("ok" to true, "mediaFileId" to "m1", "taggedKinIds" to listOf("k1")),
            payload,
        )

        val result = repoWith(functions).updateMediaTags("m1", listOf("k1", "k1"))

        assertEquals(listOf("k1"), result.getOrNull())
    }

    @Test
    fun `an empty list is a real save that clears every tag, not a skipped call`() = runBlocking {
        val payload = slot<Map<String, Any?>>()
        val functions = functionsReturning(
            mapOf("ok" to true, "mediaFileId" to "m1", "taggedKinIds" to emptyList<String>()),
            payload,
        )

        val result = repoWith(functions).updateMediaTags("m1", emptyList())

        assertTrue(result.isSuccess)
        assertEquals(emptyList<String>(), payload.captured["taggedKinIds"])
        assertEquals(emptyList<String>(), result.getOrNull())
    }

    @Test
    fun `an unreadable response falls back to the SENT list, never to empty`() = runBlocking {
        // The write already succeeded (no exception got this far). Reporting
        // "no tags" here would repaint the grid as though the save had failed.
        val payload = slot<Map<String, Any?>>()
        val functions = functionsReturning(null, payload)

        val result = repoWith(functions).updateMediaTags("m1", listOf("k1", "k2"))

        assertTrue(result.isSuccess)
        assertEquals(listOf("k1", "k2"), result.getOrNull())
    }

    @Test
    fun `a rejected callable surfaces as a failure, never a silent success`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any<Map<String, Any?>>()) } returns
            Tasks.forException(IllegalStateException("PERMISSION_DENIED: Admin claim required."))
        every { functions.getHttpsCallable("saveMediaTags") } returns ref

        val result = repoWith(functions).updateMediaTags("m1", listOf("k1"))

        assertTrue(result.isFailure)
        assertEquals(
            "PERMISSION_DENIED: Admin claim required.",
            result.exceptionOrNull()?.message,
        )
    }

    @Test
    fun `a signed-out admin never reaches the callable`() = runBlocking {
        val payload = slot<Map<String, Any?>>()
        val functions = functionsReturning(mapOf("ok" to true), payload)
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } throws IllegalStateException("Sign in to continue.")

        val result = repoWith(functions, gate).updateMediaTags("m1", listOf("k1"))

        assertTrue(result.isFailure)
        assertFalse(payload.isCaptured)
    }
}
