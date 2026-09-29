package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #957: the email frame callables. FirebaseFunctions is mocked. */
class EmailFrameRepositoryTest {

    private fun functionsFor(name: String, data: Any?, payload: io.mockk.CapturingSlot<Any> = slot()): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(name) } returns ref
        return functions
    }

    private val answer = mapOf(
        "stored" to mapOf("accentColor" to "#123456"),
        "defaults" to mapOf("accentColor" to "#df8431", "footerText" to "Tribe Tails Pet Care. Your Kin's Favorite Auntie."),
        "updatedAt" to "2026-09-28T01:00:00.000Z",
        "updatedBy" to "owner-1",
    )

    @Test
    fun `getEmailFrame decodes stored values and defaults separately`() = runBlocking {
        val f = EmailFrameRepository(functionsFor("getEmailFrame", answer)).getEmailFrame().getOrThrow()
        assertEquals(mapOf("accentColor" to "#123456"), f.stored)
        assertEquals("#df8431", f.defaults["accentColor"])
        assertEquals("2026-09-28T01:00:00.000Z", f.updatedAt)
        assertEquals("owner-1", f.updatedBy)
    }

    @Test
    fun `getEmailFrame before the first save has nothing stored and null stamps`() = runBlocking {
        val first = mapOf("stored" to emptyMap<String, String>(), "defaults" to mapOf("accentColor" to "#df8431"), "updatedAt" to null, "updatedBy" to null)
        val f = EmailFrameRepository(functionsFor("getEmailFrame", first)).getEmailFrame().getOrThrow()
        assertTrue(f.stored.isEmpty())
        assertNull(f.updatedAt)
    }

    @Test
    fun `a payload with no defaults fails loud`() = runBlocking {
        val r = EmailFrameRepository(functionsFor("getEmailFrame", mapOf("stored" to emptyMap<String, String>()))).getEmailFrame()
        assertTrue(r.isFailure)
    }

    @Test
    fun `saveEmailFrame sends the changes as given, nulls included`() = runBlocking {
        val payload = slot<Any>()
        val repo = EmailFrameRepository(functionsFor("saveEmailFrame", answer, payload))
        repo.saveEmailFrame(mapOf("footerText" to "New", "accentColor" to null)).getOrThrow()
        assertEquals(mapOf("changes" to mapOf("footerText" to "New", "accentColor" to null)), payload.captured)
    }

    @Test
    fun `an empty save is refused before any call`() = runBlocking {
        val r = EmailFrameRepository(mockk()).saveEmailFrame(emptyMap())
        assertTrue(r.isFailure)
    }

    @Test
    fun `resetEmailFrame sends resetAll and nothing else`() = runBlocking {
        val payload = slot<Any>()
        EmailFrameRepository(functionsFor("saveEmailFrame", answer, payload)).resetEmailFrame().getOrThrow()
        assertEquals(mapOf("resetAll" to true), payload.captured)
    }

    @Test
    fun `previewEmailFrame sends the draft frame and decodes the render`() = runBlocking {
        val payload = slot<Any>()
        val repo = EmailFrameRepository(
            functionsFor("previewEmailFrame", mapOf("subject" to "S", "html" to "<p>x</p>", "text" to "T"), payload),
        )
        val p = repo.previewEmailFrame(mapOf("footerText" to "Hi")).getOrThrow()
        assertEquals("<p>x</p>", p.html)
        assertEquals(mapOf("frame" to mapOf("footerText" to "Hi")), payload.captured)
    }
}
