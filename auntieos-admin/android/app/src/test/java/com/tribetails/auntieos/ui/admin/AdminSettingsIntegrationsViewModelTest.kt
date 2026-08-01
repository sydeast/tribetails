package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.IntegrationsRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * `loadIntegrations` state mapping.
 *
 * The behaviour under test is not "does it copy a field". It is the rule the
 * whole panel rests on: A FAILED READ IS RECORDED AND NEVER FOLDED INTO AN EMPTY
 * RESULT. "Nothing is wrong" and "we could not find out" render as the same
 * screen otherwise, and the first is the one that stops an operator looking for
 * the reason invoices are not sending.
 *
 * Also pinned here: the device probes stay device probes. `loadIntegrations`
 * runs them whether or not the callable answered, because they are facts about
 * this handset (its Firestore reachability, its FCM token) that no server can
 * see, so a server failure must not blank them.
 *
 * `FirebaseMessaging.getInstance()` is not available on the JVM, so the FCM
 * probe's `runCatching` falls to `false` here. That is the real behaviour of the
 * failure path, and it is asserted as CONFIGURED (no token proved), not HEALTHY.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsIntegrationsViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var integrations: IntegrationsRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        integrations = mockk()
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() =
        AdminSettingsViewModel(repository = repo, integrationsRepository = integrations)

    private fun health(
        declaredKnown: Boolean = true,
        declaredError: String = "",
        rows: List<ServerIntegration> = listOf(stripe()),
    ) = IntegrationsHealth(
        checkedAt = "2026-07-31T12:00:00.000Z",
        declaredKnown = declaredKnown,
        declaredError = declaredError,
        integrations = rows,
    )

    private fun stripe(status: IntegrationStatus = IntegrationStatus.CONFIGURED) = ServerIntegration(
        key = "stripe",
        name = "Stripe",
        purpose = "Card payments on kinfolk invoices.",
        status = status,
        summary = "Credentials are set.",
        secrets = listOf(
            IntegrationSecretState(
                name = "STRIPE_SECRET_KEY",
                required = true,
                purpose = "Creates the payment intent.",
                declared = true,
                resolves = true,
                length = 41,
            ),
        ),
        liveness = IntegrationLiveness(outcome = "none", detail = "Not verified here."),
        remediation = "",
        externalStep = "Stripe Connect onboarding is not built here.",
        ownedBySection = "",
    )

    @Test
    fun `a successful read lands on state with no error`() = runTest(testDispatcher) {
        coEvery { integrations.getIntegrationsHealth() } returns Result.success(health())

        val vm = buildViewModel()
        vm.loadIntegrations()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull("the server's answer must be on state", state.integrationsHealth)
        assertEquals("Stripe", state.integrationsHealth?.integrations?.first()?.name)
        assertNull("a successful read leaves no error", state.integrationsError)
        assertEquals(false, state.integrationsLoading)
    }

    @Test
    fun `a failed read is recorded, and never becomes an empty list of healthy services`() =
        runTest(testDispatcher) {
            coEvery { integrations.getIntegrationsHealth() } returns
                Result.failure(RuntimeException("permission-denied"))

            val vm = buildViewModel()
            vm.loadIntegrations()
            advanceUntilIdle()

            val state = vm.uiState.value
            assertEquals("permission-denied", state.integrationsError)
            // The distinction the whole panel rests on: no answer at all, rather
            // than an empty answer that a UI would render as "all clear".
            assertNull(state.integrationsHealth)
            assertEquals(false, state.integrationsLoading)
        }

    @Test
    fun `a failure with no message still says something, never an empty banner`() =
        runTest(testDispatcher) {
            coEvery { integrations.getIntegrationsHealth() } returns Result.failure(RuntimeException())

            val vm = buildViewModel()
            vm.loadIntegrations()
            advanceUntilIdle()

            assertTrue(vm.uiState.value.integrationsError?.isNotBlank() == true)
        }

    @Test
    fun `the server's own text is passed through, not summarised`() = runTest(testDispatcher) {
        val serverText =
            "Twilio is missing TWILIO_AUTH_TOKEN. firebase functions:secrets:set TWILIO_AUTH_TOKEN"
        coEvery { integrations.getIntegrationsHealth() } returns
            Result.failure(RuntimeException(serverText))

        val vm = buildViewModel()
        vm.loadIntegrations()
        advanceUntilIdle()

        assertEquals(serverText, vm.uiState.value.integrationsError)
    }

    @Test
    fun `a retry after a failure clears the error rather than stacking on it`() =
        runTest(testDispatcher) {
            coEvery { integrations.getIntegrationsHealth() } returns
                Result.failure(RuntimeException("offline"))
            val vm = buildViewModel()
            vm.loadIntegrations()
            advanceUntilIdle()
            assertEquals("offline", vm.uiState.value.integrationsError)

            coEvery { integrations.getIntegrationsHealth() } returns Result.success(health())
            vm.loadIntegrations()
            advanceUntilIdle()

            assertNull(vm.uiState.value.integrationsError)
            assertNotNull(vm.uiState.value.integrationsHealth)
        }

    @Test
    fun `declaredKnown false survives to state, so the UI can withdraw the claim`() =
        runTest(testDispatcher) {
            coEvery { integrations.getIntegrationsHealth() } returns
                Result.success(health(declaredKnown = false, declaredError = "index would not load"))

            val vm = buildViewModel()
            vm.loadIntegrations()
            advanceUntilIdle()

            assertEquals(false, vm.uiState.value.integrationsHealth?.declaredKnown)
            assertEquals("index would not load", vm.uiState.value.integrationsHealth?.declaredError)
        }

    @Test
    fun `the device probes still run when the callable succeeded`() = runTest(testDispatcher) {
        coEvery { integrations.getIntegrationsHealth() } returns Result.success(health())

        val vm = buildViewModel()
        vm.loadIntegrations()
        advanceUntilIdle()

        val probes = vm.uiState.value.deviceProbes
        assertEquals(2, probes.size)
        assertEquals(
            IntegrationHealthState.HEALTHY,
            probes.first { it.name == "Firestore" }.state,
        )
        // No FirebaseMessaging on the JVM, so no token is proved. CONFIGURED,
        // not HEALTHY: an unproved token is not a working one.
        assertEquals(
            IntegrationHealthState.CONFIGURED,
            probes.first { it.name == "Push notifications" }.state,
        )
    }

    @Test
    fun `the device probes still run when the callable failed`() = runTest(testDispatcher) {
        coEvery { integrations.getIntegrationsHealth() } returns
            Result.failure(RuntimeException("permission-denied"))

        val vm = buildViewModel()
        vm.loadIntegrations()
        advanceUntilIdle()

        // A server failure says nothing about this handset, so its own two facts
        // must not be blanked out alongside.
        assertEquals(
            IntegrationHealthState.HEALTHY,
            vm.uiState.value.deviceProbes.first { it.name == "Firestore" }.state,
        )
    }

    @Test
    fun `a device that cannot reach Firestore reports DISCONNECTED, not UNKNOWN`() =
        runTest(testDispatcher) {
            coEvery { integrations.getIntegrationsHealth() } returns Result.success(health())
            coEvery { repo.getBusinessSettings() } returns Result.failure(RuntimeException("offline"))

            val vm = buildViewModel()
            vm.loadIntegrations()
            advanceUntilIdle()

            assertEquals(
                IntegrationHealthState.DISCONNECTED,
                vm.uiState.value.deviceProbes.first { it.name == "Firestore" }.state,
            )
        }

    @Test
    fun `the retired hard-coded rows are gone from the device list`() = runTest(testDispatcher) {
        // The regression this change exists to stop: "n8n Webhooks" carried a
        // fixed CONFIGURED pill for more than a year after n8n was retired, and
        // "Twilio Studio" asserted a state nothing had checked. Both are
        // server-side questions and the server answers them now.
        val names = buildViewModel().uiState.value.deviceProbes.map { it.name }
        assertEquals(listOf("Firestore", "Push notifications"), names)
    }
}
