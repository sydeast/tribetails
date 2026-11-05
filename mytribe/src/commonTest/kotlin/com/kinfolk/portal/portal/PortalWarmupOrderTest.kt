package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1561: the warm-up waits for the screen the household opened. The screen
 * reads through the shell's tracked client, the warm-up through its
 * `withoutSessionReaction()` twin, and both land in one ordered log, so the
 * assertions are about what reached the backend first.
 */
class PortalWarmupOrderTest {

    private val today = LocalDate(2026, 11, 4)
    private val home = MyHomeResult(kinfolkId = "kin-1", displayName = "The Ruiz Tribe", billingAccess = true)

    /** The backend: answers everything at once except the names held open in [gates] or [hang]. */
    private class Backend : FunctionsClient {
        val log = mutableListOf<String>()
        val gates = mutableMapOf<String, CompletableDeferred<JsonObject>>()
        var hang = setOf<String>()

        override suspend fun call(name: String, payload: JsonObject?): JsonObject {
            log += name
            if (name in hang) awaitCancellation()
            return gates[name]?.await() ?: buildJsonObject { }
        }
    }

    @Test
    fun `the opened screen's read reaches the backend before any warm-up read, and the warm-up follows once it settles`() = runTest {
        val backend = Backend()
        val invoices = CompletableDeferred<JsonObject>().also { backend.gates["getMyInvoices"] = it }
        val foreground = ForegroundCalls()
        val screenClient = foreground.track(backend)
        val warmup = PortalWarmup(screenClient.withoutSessionReaction(), foreground = foreground)

        // The shell launches the warm-up and composes the start screen in the same frame.
        val warm = launch { warmup.run(home, today) }
        launch { screenClient.call("getMyInvoices", null) }
        runCurrent()
        advanceTimeBy(5_000) // a slow cold start on the screen's own read
        assertEquals(listOf("getMyInvoices"), backend.log)

        invoices.complete(buildJsonObject { })
        runCurrent()
        advanceTimeBy(ForegroundCalls.QUIET.inWholeMilliseconds - 1)
        assertEquals(listOf("getMyInvoices"), backend.log, "still inside the quiet window")

        warm.join()
        assertEquals("getMyInvoices", backend.log.first())
        assertTrue("getMyTribeProfile" in backend.log)
        assertTrue("getAccountCreditHistory" in backend.log)
        assertEquals(0, foreground.running.value, "the warm-up's own reads are never counted")
    }

    @Test
    fun `a screen read that starts during the quiet window holds the warm-up again`() = runTest {
        val backend = Backend()
        val foreground = ForegroundCalls()
        val screenClient = foreground.track(backend)
        val warmup = PortalWarmup(screenClient.withoutSessionReaction(), foreground = foreground)
        val second = CompletableDeferred<JsonObject>().also { backend.gates["getMyPaymentMethod"] = it }

        val warm = launch { warmup.run(home, today) }
        runCurrent()
        advanceTimeBy(300)
        launch { screenClient.call("getMyPaymentMethod", null) } // the screen's second wave
        runCurrent()
        advanceTimeBy(2_000)
        assertEquals(listOf("getMyPaymentMethod"), backend.log)

        second.complete(buildJsonObject { })
        warm.join()
        assertEquals("getMyPaymentMethod", backend.log.first())
        assertTrue(backend.log.size > 1)
    }

    @Test
    fun `a hung screen read does not stop the warm-up past the ceiling`() = runTest {
        val backend = Backend().apply { hang = setOf("getMyInvoices") }
        val foreground = ForegroundCalls()
        val screenClient = foreground.track(backend)
        val warmup = PortalWarmup(screenClient.withoutSessionReaction(), foreground = foreground)

        val screen = launch { screenClient.call("getMyInvoices", null) }
        val warm = launch { warmup.run(home, today) }
        runCurrent()
        advanceTimeBy(ForegroundCalls.MAX_WAIT.inWholeMilliseconds - 1)
        assertEquals(listOf("getMyInvoices"), backend.log)

        advanceTimeBy(2)
        runCurrent()
        assertTrue("getMyTribeProfile" in backend.log, "warm-up fired at the ceiling: ${backend.log}")
        screen.cancel()
        warm.cancel() // its own getMyInvoices hangs on the same backend
    }

    @Test
    fun `without a tracker the warm-up fires at once, as callers without a shell expect`() = runTest {
        val backend = Backend()
        PortalWarmup(backend).run(home, today)
        assertTrue("getMyTribeProfile" in backend.log)
    }
}
