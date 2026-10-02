package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.ClearSuppressionResult
import com.tribetails.auntieos.web.data.Suppression
import com.tribetails.auntieos.web.data.SuppressionPage
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1102: the do-not-send list rules, on a fake of the two callables. Mirrors the
 * admin web DoNotSendSection tests and the Android DoNotSendViewModel tests.
 */
class DoNotSendModelTest {

    private fun row(
        recipient: String,
        reason: String = "hard_bounce",
        optedOut: Boolean = reason == "opt_out",
        source: String = if (reason == "hard_bounce") "smtp2go" else "admin",
    ) = Suppression(
        recipient = recipient,
        recipientRedacted = recipient.take(1) + "***",
        channel = "email",
        reason = reason,
        source = source,
        suppressedAtMs = 1_700_000_000_000L,
        optedOut = optedOut,
        eventId = if (reason == "hard_bounce") "ev-$recipient" else null,
    )

    private class FakeSource(
        var pages: Map<String, SuppressionPage> = emptyMap(),
        var listError: String? = null,
        var clearResult: WriteResult<ClearSuppressionResult> =
            WriteResult.Ok(ClearSuppressionResult("email", "r***", optOutKept = false)),
    ) : MessageSuppressionSource {
        val listCalls = mutableListOf<Pair<String, String?>>()
        val clearCalls = mutableListOf<String>()
        override suspend fun list(reason: String, cursor: String?): WriteResult<SuppressionPage> {
            listCalls += reason to cursor
            listError?.let { return WriteResult.Err(it) }
            return WriteResult.Ok(pages["$reason/${cursor.orEmpty()}"] ?: SuppressionPage(emptyList(), null))
        }

        override suspend fun clear(recipient: String): WriteResult<ClearSuppressionResult> {
            clearCalls += recipient
            return clearResult
        }
    }

    private fun ready(m: DoNotSendModel) = m.state.value.load as DoNotSendLoad.Ready

    @Test fun `load asks for the current filter and shows the rows`() = runTest {
        val src = FakeSource(pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com")), null)))
        val m = DoNotSendModel(src)
        m.load()
        assertEquals(listOf<Pair<String, String?>>("all" to null), src.listCalls)
        assertEquals(listOf("a@example.com"), ready(m).items.map { it.recipient })
    }

    @Test fun `changing the filter reloads with that reason`() = runTest {
        val src = FakeSource()
        val m = DoNotSendModel(src)
        assertTrue(m.setFilter("opt_out"))
        assertFalse(m.setFilter("opt_out"))
        m.load()
        assertEquals(listOf<Pair<String, String?>>("opt_out" to null), src.listCalls)
    }

    @Test fun `a failed load says what failed and offers a retry state`() = runTest {
        val m = DoNotSendModel(FakeSource(listError = "boom"))
        m.load()
        assertEquals(
            DoNotSendLoad.Failed("Couldn't read the do-not-send list: boom"),
            m.state.value.load,
        )
    }

    @Test fun `load more appends the next page with its cursor`() = runTest {
        val src = FakeSource(
            pages = mapOf(
                "all/" to SuppressionPage(listOf(row("a@example.com")), "c2"),
                "all/c2" to SuppressionPage(listOf(row("b@example.com")), null),
            ),
        )
        val m = DoNotSendModel(src)
        m.load()
        m.loadMore()
        assertEquals(listOf("a@example.com", "b@example.com"), ready(m).items.map { it.recipient })
        assertNull(ready(m).nextCursor)
        assertFalse(m.state.value.loadingMore)
        assertEquals("all" to "c2", src.listCalls.last())
    }

    @Test fun `an opt-out only row cannot be asked to clear`() = runTest {
        val m = DoNotSendModel(FakeSource(pages = mapOf("all/" to SuppressionPage(listOf(row("o@example.com", "opt_out")), null))))
        m.load()
        m.askClear(ready(m).items[0])
        assertNull(m.state.value.pending)
    }

    @Test fun `clear asks first and nothing is sent until confirmed`() = runTest {
        val src = FakeSource(pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com")), null)))
        val m = DoNotSendModel(src)
        m.load()
        m.askClear(ready(m).items[0])
        assertEquals("a@example.com", m.state.value.pending?.recipient)
        assertTrue(src.clearCalls.isEmpty())
        m.cancelClear()
        assertNull(m.state.value.pending)
        assertTrue(src.clearCalls.isEmpty())
    }

    @Test fun `confirming a clear sends the full address and drops a bounce only row`() = runTest {
        val src = FakeSource(pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com"), row("b@example.com")), null)))
        val m = DoNotSendModel(src)
        m.load()
        m.askClear(ready(m).items[0])
        m.confirmClear()
        assertEquals(listOf("a@example.com"), src.clearCalls)
        assertEquals(listOf("b@example.com"), ready(m).items.map { it.recipient })
        assertEquals("Cleared r***. It can be mailed again.", m.state.value.note)
        assertNull(m.state.value.pending)
        assertFalse(m.state.value.clearing)
    }

    @Test fun `a row that was both stays on the list as an opt-out`() = runTest {
        val src = FakeSource(
            pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com", optedOut = true)), null)),
            clearResult = WriteResult.Ok(ClearSuppressionResult("email", "a***@example.com", optOutKept = true)),
        )
        val m = DoNotSendModel(src)
        m.load()
        m.askClear(ready(m).items[0])
        m.confirmClear()
        val kept = ready(m).items.single()
        assertEquals("opt_out", kept.reason)
        assertEquals("admin", kept.source)
        assertNull(kept.eventId)
        assertTrue(kept.optedOut)
        assertFalse(kept.clearable)
        assertEquals("Cleared the bounce on a***@example.com. The opt-out stays.", m.state.value.note)
    }

    @Test fun `a failed clear leaves the row and shows the server's words`() = runTest {
        val src = FakeSource(
            pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com")), null)),
            clearResult = WriteResult.Err("permission-denied"),
        )
        val m = DoNotSendModel(src)
        m.load()
        m.askClear(ready(m).items[0])
        m.confirmClear()
        assertEquals(listOf("a@example.com"), ready(m).items.map { it.recipient })
        assertEquals("permission-denied", m.state.value.error)
        assertNull(m.state.value.note)
        assertNull(m.state.value.pending)
    }

    @Test fun `a blank clear failure still says something`() = runTest {
        val src = FakeSource(
            pages = mapOf("all/" to SuppressionPage(listOf(row("a@example.com")), null)),
            clearResult = WriteResult.Err(""),
        )
        val m = DoNotSendModel(src)
        m.load()
        m.askClear(ready(m).items[0])
        m.confirmClear()
        assertEquals("The clear failed.", m.state.value.error)
    }

    // ---- copy, word for word with web and Android ----

    @Test fun `filter and row labels match the other clients`() {
        assertEquals(listOf("All", "Hard bounces", "Opt-outs"), DO_NOT_SEND_FILTERS.map { doNotSendFilterLabel(it) })
        assertEquals("Hard bounce", doNotSendReasonLabel(row("a@example.com")))
        assertEquals("Opted out", doNotSendReasonLabel(row("a@example.com", "opt_out")))
        assertEquals("smtp2go", doNotSendSourceLabel(row("a@example.com")))
        assertEquals("Admin", doNotSendSourceLabel(row("a@example.com", "opt_out")))
    }

    @Test fun `meta line shows an opt-out that also holds on a bounce`() {
        val utc = TimeZone.UTC
        assertEquals(
            "Hard bounce, Also opted out, smtp2go, 2023-11-14 22:13",
            doNotSendMetaLine(row("a@example.com", optedOut = true), utc),
        )
        assertEquals("Hard bounce, smtp2go, 2023-11-14 22:13", doNotSendMetaLine(row("a@example.com"), utc))
        assertEquals("Opted out, Admin, 2023-11-14 22:13", doNotSendMetaLine(row("o@example.com", "opt_out"), utc))
        assertEquals("(no time)", doNotSendWhenLabel(0L, utc))
    }

    @Test fun `confirm text matches web and Android`() {
        assertEquals(
            "a@example.com comes off the bounce list and Auntie can mail it again. Your name is recorded against the change.",
            doNotSendConfirmText(row("a@example.com")),
        )
        assertEquals(
            "a@example.com comes off the bounce list and Auntie can mail it again. Their opt-out stays. Your name is recorded against the change.",
            doNotSendConfirmText(row("a@example.com", optedOut = true)),
        )
    }
}
