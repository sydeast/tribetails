package com.tribetails.auntieos.web.data

import io.ktor.client.request.get
import io.ktor.client.request.post
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * #867: the desktop HTTP layer. No token means no request, a slow server ends in
 * an error the screen can show, the Functions emulator switch works, and a JVM
 * test can never reach a real host.
 */
class DesktopTransportTest {

    private val captured = mutableListOf<String>()
    private val defaultOnBlocked = NetworkGuard.onBlocked

    @AfterTest
    fun tearDown() {
        NetworkGuard.onBlocked = defaultOnBlocked
        JvmFirestoreFixtures.clear()
    }

    /** Swaps the guard's reporter for this test, so a block made on purpose is not reported as a leak. */
    private fun captureBlocks() {
        NetworkGuard.onBlocked = { captured += it }
    }

    @Test
    fun theTestRuntimeHasTheGuardSwitchedOn() {
        assertTrue(NetworkGuard.enabled, "Gradle's jvmTest task must set -D${NetworkGuard.PROPERTY}=true for every test class")
    }

    @Test
    fun aCallableWithNoTokenSendsNothingAndSaysNotSignedIn() = runBlocking {
        captureBlocks()
        val r = JvmFirestoreRest.callable("listFormSchemas", "{}")
        assertEquals(WriteResult.Err("Not signed in"), r)
        assertTrue(captured.isEmpty(), "a request was attempted with no token: $captured")
    }

    @Test
    fun theGuardThrowsForAProductionHostAndSendsNothing() = runBlocking {
        captureBlocks()
        val client = auntieHttpClient()
        val e = assertFailsWith<NetworkBlockedError> {
            client.post("https://us-central1-auntieos-ttpc.cloudfunctions.net/listFormSchemas")
        }
        assertTrue(e.message!!.contains("us-central1-auntieos-ttpc.cloudfunctions.net"), e.message)
        assertEquals(1, captured.size)
        assertTrue(captured.single().contains("cloudfunctions.net"))
    }

    /** An Error, not an Exception: the `catch (e: Exception)` blocks in the REST layer must not turn a leak into a quiet Err. */
    @Test
    fun theGuardIsNotCaughtByTheCallableCatch() {
        assertTrue(Error::class.java.isAssignableFrom(NetworkBlockedError::class.java))
    }

    @Test
    fun theGuardAllowsLoopbackAndTheConfiguredEmulatorHosts() {
        val emulators = listOf("10.0.0.7:8080", null, "192.168.1.20:5001")
        assertEquals(null, NetworkGuard.blockReason("127.0.0.1", emulators))
        assertEquals(null, NetworkGuard.blockReason("127.4.5.6", emulators))
        assertEquals(null, NetworkGuard.blockReason("localhost", emulators))
        assertEquals(null, NetworkGuard.blockReason("[::1]", emulators))
        assertEquals(null, NetworkGuard.blockReason("10.0.0.7", emulators))
        assertEquals(null, NetworkGuard.blockReason("192.168.1.20", emulators))
        assertTrue(NetworkGuard.blockReason("10.0.0.8", emulators) != null, "a private host no variable names is still refused")
        assertTrue(NetworkGuard.blockReason("firestore.googleapis.com", emulators) != null)
        assertTrue(NetworkGuard.blockReason("n8n.tribetails.com", emulators) != null)
    }

    /** #867 review: a stale emulator variable naming a real host must not open the guard for that host. */
    @Test
    fun anEmulatorVariableNamingARealHostAllowsNothing() {
        val stale = listOf("firestore.googleapis.com:443", "emu.local:5001", "8.8.8.8:8080", "172.32.0.1:8080")
        assertTrue(NetworkGuard.blockReason("firestore.googleapis.com", stale) != null)
        assertTrue(NetworkGuard.blockReason("emu.local", stale) != null)
        assertTrue(NetworkGuard.blockReason("8.8.8.8", stale) != null)
        assertTrue(NetworkGuard.blockReason("172.32.0.1", stale) != null)
    }

    @Test
    fun onlyLoopbackAndPrivateLiteralsCountAsEmulatorHosts() {
        listOf("localhost", "127.0.0.1", "127.255.0.9", "::1", "[::1]", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10")
            .forEach { assertTrue(isLoopbackOrPrivateHost(it), "$it should be trusted") }
        listOf("172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "8.8.8.8", "emu.local", "firestore.googleapis.com", "10.0.0", "10.0.0.256", "")
            .forEach { assertTrue(!isLoopbackOrPrivateHost(it), "$it should be refused") }
    }

    @Test
    fun anUntrustedEmulatorVariableIsRefusedLoudlyAndIgnored() {
        val reports = mutableListOf<String>()
        assertEquals("127.0.0.1:8080", trustedEmulatorHost("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080") { reports += it })
        assertEquals("[::1]:5001", trustedEmulatorHost("FUNCTIONS_EMULATOR_HOST", "[::1]:5001") { reports += it })
        assertEquals(null, trustedEmulatorHost("FIRESTORE_EMULATOR_HOST", "  ") { reports += it })
        assertTrue(reports.isEmpty(), "$reports")
        assertEquals(null, trustedEmulatorHost("FIRESTORE_EMULATOR_HOST", "firestore.googleapis.com:443") { reports += it })
        assertEquals(1, reports.size)
        assertTrue(reports.single().contains("FIRESTORE_EMULATOR_HOST=firestore.googleapis.com:443"), reports.single())
    }

    @Test
    fun aTimeoutSurfacesAsAnErrorWithAPlainMessage() = runBlocking {
        ServerSocket(0).use { server ->
            val held = mutableListOf<Socket>()
            // Accepts and never answers: a connection that stalls after connecting.
            thread(isDaemon = true) { runCatching { while (true) held += server.accept() } }
            val client = auntieHttpClient(requestTimeoutMs = 300)
            val e = assertFailsWith<Exception> {
                client.get("http://127.0.0.1:${server.localPort}/slow")
            }
            assertEquals(AUNTIE_TIMEOUT_MESSAGE, e.transportMessage("request failed"))

            // Through a write actual: a timeout comes back as an Err, not a throw that strands a saving flag.
            val write = transportWrite("archive failed") { client.get("http://127.0.0.1:${server.localPort}/slow"); true }
            assertEquals(WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE), write)

            // Through a screen's read path: the poll emits the error rather than hanging.
            val first = JvmFirestoreRest.pollingStream<Int> {
                client.get("http://127.0.0.1:${server.localPort}/slow"); emptyList()
            }.first()
            assertEquals(FirestoreResult.Error(AUNTIE_TIMEOUT_MESSAGE), first)
            held.forEach { runCatching { it.close() } }
        }
    }

    @Test
    fun aWriteActualReturnsErrOnFailureAndLetsTheGuardThrough() = runBlocking {
        assertEquals(WriteResult.Err("archive failed"), transportWrite("archive failed") { false })
        assertEquals(WriteResult.Ok(Unit), transportWrite("archive failed") { true })
        assertEquals(WriteResult.Err("boom"), transportWrite("archive failed") { error("boom") })
        assertFailsWith<NetworkBlockedError> { transportWrite("archive failed") { throw NetworkBlockedError("x") } }
        Unit
    }

    @Test
    fun theDefaultClientHasFiniteTimeouts() {
        assertTrue(AUNTIE_CONNECT_TIMEOUT_MS in 1..30_000)
        assertTrue(AUNTIE_REQUEST_TIMEOUT_MS in 1..120_000)
    }

    @Test
    fun aLongRunningCallableGetsTheFunctionsOwnCeiling() {
        // broadcastMessage declares timeoutSeconds: 540.
        assertTrue(callableRequestTimeoutMs("broadcastMessage") > 540_000)
        assertEquals(AUNTIE_REQUEST_TIMEOUT_MS, callableRequestTimeoutMs("listFormSchemas"))
    }

    @Test
    fun theFunctionsEmulatorHostIsUsedWhenSet() {
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1", JvmFirestoreRest.functionsBaseUrl("127.0.0.1:5001"))
        assertEquals("https://us-central1-auntieos-ttpc.cloudfunctions.net", JvmFirestoreRest.functionsBaseUrl(null))
        assertEquals("https://us-central1-auntieos-ttpc.cloudfunctions.net", JvmFirestoreRest.functionsBaseUrl("  "))
    }
}
