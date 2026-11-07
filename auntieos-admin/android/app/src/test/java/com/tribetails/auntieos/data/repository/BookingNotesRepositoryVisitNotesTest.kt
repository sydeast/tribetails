package com.tribetails.auntieos.data.repository
import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * #1580: Android reads and writes a visit's internal notes through the two
 * callables, by session, so it shows the same one list web Bookings and Auntie
 * Time show. Operator ruling 2026-11-05: two kinds, shared and admin-only; the
 * writer marks each note.
 */
class BookingNotesRepositoryVisitNotesTest {
    private fun stub(functions: FirebaseFunctions, name: String, response: Any?): io.mockk.CapturingSlot<Map<String, Any?>> {
        val ref = mockk<HttpsCallableReference>()
        val payload = slot<Map<String, Any?>>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns response
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(name) } returns ref
        return payload
    }
    private fun repo(functions: FirebaseFunctions) =
        BookingNotesRepository(functions = functions, firestore = mockk<FirebaseFirestore>())
    @Test
    fun `a shared note goes by session id, marked shared`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, "addInternalBookingNote", mapOf("noteId" to "n1", "visibility" to "shared", "storedOn" to "thread"))
        val res = repo(functions).addVisitInternalNote("vis_v1", "  Fed at 5  ").getOrThrow()
        assertEquals(mapOf("sessionId" to "vis_v1", "body" to "Fed at 5", "visibility" to "shared"), payload.captured)
        assertEquals("shared", res.visibility)
    }
    @Test
    fun `an admin-only note says so on the wire`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, "addInternalBookingNote", mapOf("noteId" to "a1", "visibility" to "adminOnly", "storedOn" to "thread"))
        repo(functions).addVisitInternalNote("vis_v1", "Rate goes up", adminOnly = true).getOrThrow()
        assertEquals("adminOnly", payload.captured["visibility"])
    }
    @Test
    fun `the list decodes both kinds and the mark permission`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(
            functions,
            "listVisitInternalNotes",
            mapOf(
                "notes" to listOf(
                    mapOf("id" to "a1", "body" to "Rate goes up", "authorRole" to "admin", "authorName" to "Syd", "createdAtMs" to 1000, "visibility" to "adminOnly", "source" to "thread"),
                ),
                "canMarkAdminOnly" to true,
                "hasBookingRecord" to true,
            ),
        )
        val res = repo(functions).listVisitInternalNotes("vis_v1").getOrThrow()
        assertEquals(mapOf("sessionId" to "vis_v1"), payload.captured)
        assertEquals("adminOnly", res.notes.single().visibility)
        assertEquals(1000.0, res.notes.single().createdAtMs!!, 0.0)
        assertTrue(res.canMarkAdminOnly)
    }
    @Test
    fun `a blank note never reaches the server`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        assertFalse(repo(functions).addVisitInternalNote("vis_v1", "   ").isSuccess)
    }
}
