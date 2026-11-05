package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * #1561: the callables the household's screens have on the wire right now, so
 * the #1282 warm-up ([PortalWarmup]) can wait for them. The warm-up makes the
 * NEXT screen fast and must never slow the CURRENT one: on web it put twenty
 * reads ahead of a deep-linked invoice's own `getMyInvoices`, which then left
 * 18 s after the visit. This is the same rule for Android, desktop and js.
 *
 * The shell wraps its one [FunctionsClient] with [track], so every screen read
 * is counted. The warm-up reads through `withoutSessionReaction()`, which the
 * tracked client forwards to the INNER client's, so the warm-up's own calls are
 * never counted and cannot hold themselves up. Direct Firestore reads
 * (`getMyKin`, `getVetClinics`) are not callables and are not counted: they
 * wake no Cloud Run instance and share no queue with the warm-up.
 */
class ForegroundCalls {
    private val inFlight = MutableStateFlow(0)
    private val started = MutableStateFlow(0L)

    /** How many tracked calls are running. */
    val running: StateFlow<Int> get() = inFlight

    /** [client], with every call counted while it runs. */
    fun track(client: FunctionsClient): FunctionsClient = Tracked(client)

    private inner class Tracked(private val inner: FunctionsClient) : FunctionsClient {
        override suspend fun call(name: String, payload: JsonObject?): JsonObject {
            started.update { it + 1 }
            inFlight.update { it + 1 }
            try {
                return inner.call(name, payload)
            } finally {
                inFlight.update { it - 1 }
            }
        }

        override fun withoutSessionReaction(): FunctionsClient = inner.withoutSessionReaction()
    }

    /**
     * Returns once no tracked call has been running for [quiet], or after
     * [maxWait] whatever the screens are doing. The quiet window is what lets
     * the screen the shell just composed launch its reads (the NavHost and
     * the warm-up's effect start in the same frame) and covers a screen's
     * second wave, the reads it starts from the first one's answer. A call
     * that starts and ends inside the window restarts it.
     */
    suspend fun awaitSettled(quiet: Duration = QUIET, maxWait: Duration = MAX_WAIT) {
        withTimeoutOrNull(maxWait) {
            while (true) {
                inFlight.first { it == 0 }
                val before = started.value
                delay(quiet)
                if (inFlight.value == 0 && started.value == before) return@withTimeoutOrNull
            }
        }
    }

    companion object {
        val QUIET: Duration = 500.milliseconds
        val MAX_WAIT: Duration = 10.seconds
    }
}
