package com.tribetails.auntieos.session

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GetTokenResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #454. The 2026-08-17 admin walk lost six consecutive securetoken refreshes
 * inside one 13-second window and then recovered, and not one line anywhere
 * recorded that it had happened. This app had the same blind spot through its
 * own auth path: `AuthStateListener` does not fire on a failed refresh, and
 * every `getIdToken` call site swallows its failure into that one operation.
 *
 * These drive a refresh that fails and assert the session says so, retries on a
 * widening gap, clears itself when the network comes back, and gives up loudly
 * when retrying cannot help.
 *
 * No Robolectric: `FirebaseAuth` / `FirebaseUser` / `GetTokenResult` are
 * mockk-stubbed and `getIdToken` returns completed Tasks, so `await()` resolves
 * inline on the JVM. Same idiom as `AuthGateTest`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionHealthMonitorTest {

    /** Every wait the loop asked for, in order. */
    private val waits = mutableListOf<Long>()

    @After
    fun tearDown() {
        SessionHealthMonitor.resetForTests()
    }

    private fun healthy(): () -> Result<Unit> = { Result.success(Unit) }

    private fun networkFailure(): () -> Result<Unit> =
        { Result.failure(FirebaseNetworkException("Failed to fetch")) }
    private fun unretryableFailure(): () -> Result<Unit> =
        { Result.failure(IllegalStateException("no token")) }

    /**
     * Runs the monitor against a scripted sequence of probe outcomes, ending the
     * loop once the script is spent so `runTest` is not left waiting on an
     * endless one. Returns the state the monitor settled on.
     *
     * The ending is a [CancellationException] on purpose: it is the one way out
     * of a running coroutine that reads as "stopped" rather than "failed", so a
     * spent script cannot be mistaken for a defect.
     */
    private fun runScript(vararg outcomes: () -> Result<Unit>): SessionHealth {
        lateinit var settled: SessionHealth
        runTest {
            var probes = 0
            SessionHealthMonitor.configureForTests(
                probe = {
                    val next = outcomes.getOrNull(probes)
                    probes += 1
                    next?.invoke() ?: Result.success(Unit)
                },
                waitFor = { millis ->
                    if (probes >= outcomes.size) throw CancellationException("script spent")
                    waits += millis
                },
            )
            // A scope of our own on the test scheduler, rather than
            // `backgroundScope`: the monitor's auth collector never completes,
            // and this way the test owns exactly when it stops.
            val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
            SessionHealthMonitor.start(
                scope = scope,
                sessionUids = MutableStateFlow<String?>("admin-uid"),
            )
            testScheduler.advanceUntilIdle()
            settled = SessionHealthMonitor.state.value
            scope.cancel()
        }
        return settled
    }

    @Test
    fun `a session that still mints says nothing`() {
        val settled = runScript(healthy(), healthy())
        assertEquals(SessionHealth.Ok, settled)
        // A healthy session waits the full interval between probes, twice.
        assertEquals(listOf(SESSION_PROBE_INTERVAL_MILLIS, SESSION_PROBE_INTERVAL_MILLIS), waits)
    }

    @Test
    fun `a refused refresh is reported rather than swallowed`() {
        assertEquals(SessionHealth.Unreachable(failures = 1), runScript(networkFailure()))
    }

    @Test
    fun `consecutive refusals retry on a widening gap`() {
        runScript(networkFailure(), networkFailure(), networkFailure(), networkFailure())
        assertEquals(
            listOf(
                SESSION_PROBE_INTERVAL_MILLIS,
                sessionRetryDelayMillis(1),
                sessionRetryDelayMillis(2),
                sessionRetryDelayMillis(3),
            ),
            waits,
        )
        assertTrue("the gap must grow, not repeat", waits[2] > waits[1])
    }

    @Test
    fun `it clears itself when the network comes back, like the walk did`() {
        // The walk's shape exactly: six refusals, then a success.
        val settled = runScript(
            networkFailure(),
            networkFailure(),
            networkFailure(),
            networkFailure(),
            networkFailure(),
            networkFailure(),
            healthy(),
        )
        assertEquals(SessionHealth.Ok, settled)
    }

    @Test
    fun `a failure retrying cannot fix stops the loop and asks for a sign-in`() {
        // Three outcomes are scripted, but the first is terminal: the loop must
        // consume exactly one wait and never probe again.
        val settled = runScript(unretryableFailure(), healthy(), healthy())
        assertEquals(SessionHealth.Expired, settled)
        assertEquals(listOf(SESSION_PROBE_INTERVAL_MILLIS), waits)
    }

    @Test
    fun `signing out forgets a degraded session`() = runTest {
        SessionHealthMonitor.configureForTests(
            probe = { networkFailure()() },
            waitFor = { millis ->
                if (waits.size >= 1) throw CancellationException("one probe is enough")
                waits += millis
            },
        )
        val uids = MutableStateFlow<String?>("admin-uid")
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        SessionHealthMonitor.start(scope = scope, sessionUids = uids)
        testScheduler.advanceUntilIdle()
        assertTrue(SessionHealthMonitor.state.value is SessionHealth.Unreachable)

        uids.value = null
        testScheduler.advanceUntilIdle()
        assertEquals(SessionHealth.Ok, SessionHealthMonitor.state.value)
        scope.cancel()
    }

    // -----------------------------------------------------------------------
    // The real probe against a stubbed SDK: the seam the walk's failure
    // actually arrives through.
    // -----------------------------------------------------------------------

    @Test
    fun `the real probe reads the CACHED token, never forcing a round trip`() = runTest {
        val user = mockk<FirebaseUser>()
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns user
        every { user.getIdToken(false) } returns Tasks.forResult(mockk<GetTokenResult>())

        assertTrue(probeCurrentUserToken { auth }.isSuccess)
        // forceRefresh = false is what keeps a healthy session free: the SDK
        // hands back the cached token and touches the network only when it must.
        verify(exactly = 1) { user.getIdToken(false) }
    }

    @Test
    fun `the real probe surfaces the SDK's network failure instead of hiding it`() = runTest {
        val user = mockk<FirebaseUser>()
        val auth = mockk<FirebaseAuth>()
        val boom = FirebaseNetworkException("Failed to fetch")
        every { auth.currentUser } returns user
        every { user.getIdToken(false) } returns Tasks.forException(boom)

        val result = probeCurrentUserToken { auth }

        assertTrue(result.isFailure)
        assertTrue(isRetryableRefreshFailure(result.exceptionOrNull()!!))
    }

    @Test
    fun `nobody signed in is not a broken session`() = runTest {
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns null

        assertTrue(probeCurrentUserToken { auth }.isSuccess)
    }
}
