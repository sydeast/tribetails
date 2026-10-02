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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1083: the do-not-send list callables. FirebaseFunctions is mocked, the decode is pure. */
class MessageSuppressionRepositoryTest {

    private fun functionsFor(name: String, data: Any?, payload: io.mockk.CapturingSlot<Any> = slot()): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(name) } returns ref
        return functions
    }

    private val bounced = mapOf(
        "recipient" to "gone@example.com",
        "recipientRedacted" to "g***@example.com",
        "channel" to "email",
        "reason" to "hard_bounce",
        "source" to "smtp2go",
        "suppressedAtMs" to 1759400000000L,
        "optedOut" to true,
        "eventId" to "evt-9",
    )

    @Test
    fun `list sends the filter and cursor and decodes every field`() = runBlocking {
        val payload = slot<Any>()
        val repo = MessageSuppressionRepository(
            functionsFor("listMessageSuppressions", mapOf("items" to listOf(bounced), "nextCursor" to "abc"), payload),
        )

        val page = repo.list(reason = "hard_bounce", cursor = "prev").getOrThrow()

        assertEquals(mapOf("reason" to "hard_bounce", "cursor" to "prev"), payload.captured)
        assertEquals("abc", page.nextCursor)
        val row = page.items.single()
        assertEquals("gone@example.com", row.recipient)
        assertEquals("g***@example.com", row.recipientRedacted)
        assertEquals("email", row.channel)
        assertEquals("hard_bounce", row.reason)
        assertEquals("smtp2go", row.source)
        assertEquals(1759400000000L, row.suppressedAtMs)
        assertTrue(row.optedOut)
        assertEquals("evt-9", row.eventId)
        assertTrue(row.clearable)
    }

    @Test
    fun `list omits the cursor on the first page`() = runBlocking {
        val payload = slot<Any>()
        val repo = MessageSuppressionRepository(
            functionsFor("listMessageSuppressions", mapOf("items" to emptyList<Any>(), "nextCursor" to null), payload),
        )

        repo.list(reason = "all").getOrThrow()

        assertEquals(mapOf("reason" to "all"), payload.captured)
    }

    @Test
    fun `decode survives a thin row and drops one with no address`() {
        val page = MessageSuppressionRepository.decodePage(
            mapOf("items" to listOf(mapOf("recipient" to "a@b.co"), mapOf("nope" to 1))),
        )

        val row = page.items.single()
        assertEquals("opt_out", row.reason)
        assertEquals("admin", row.source)
        assertEquals("email", row.channel)
        assertEquals(0L, row.suppressedAtMs)
        assertNull(row.eventId)
        assertNull(page.nextCursor)
        assertTrue(row.optedOut)
        assertFalse(row.clearable)
    }

    @Test
    fun `a bounce only row is not opted out`() {
        val page = MessageSuppressionRepository.decodePage(
            mapOf("items" to listOf(bounced + ("optedOut" to false))),
        )

        assertFalse(page.items.single().optedOut)
    }

    @Test
    fun `decode tolerates a null payload`() {
        val page = MessageSuppressionRepository.decodePage(null)

        assertTrue(page.items.isEmpty())
        assertNull(page.nextCursor)
    }

    @Test
    fun `clear sends the full address trimmed and reads the result back`() = runBlocking {
        val payload = slot<Any>()
        val repo = MessageSuppressionRepository(
            functionsFor(
                "clearMessageSuppression",
                mapOf("ok" to true, "channel" to "email", "recipientRedacted" to "g***@example.com", "optOutKept" to true),
                payload,
            ),
        )

        val res = repo.clear("  gone@example.com ").getOrThrow()

        assertEquals(mapOf("recipient" to "gone@example.com"), payload.captured)
        assertEquals("g***@example.com", res.recipientRedacted)
        assertTrue(res.optOutKept)
    }
}
