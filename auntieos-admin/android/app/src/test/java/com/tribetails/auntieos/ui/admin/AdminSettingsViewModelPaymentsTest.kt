package com.tribetails.auntieos.ui.admin
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.PaymentOptionDraft
import com.tribetails.auntieos.data.model.paymentDraftOf
import com.tribetails.auntieos.data.model.withPaymentDraft
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
/** #1785: the Payments panel's save, through the view model to the repository call. */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsViewModelPaymentsTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private val changes = slot<Map<String, Any?>>()
    private val stored = BusinessSettings(
        businessName = "Den",
        paymentOptions = mapOf(
            "venmo" to mapOf("enabled" to true, "instructions" to ""),
            "oldcoin" to mapOf("enabled" to true, "instructions" to ""),
        ),
    )
    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(stored)
        coEvery { mockRepo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
    }
    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }
    private fun vm() = AdminSettingsViewModel(repository = mockRepo).also { it.loadBusinessSettings() }
    @Test
    fun `editing venmo with an unknown id stored saves and sends venmo only`() {
        val vm = vm()
        val draft = paymentDraftOf(stored).let { it.copy(options = it.options + ("venmo" to PaymentOptionDraft(false, ""))) }
        vm.updateBusinessSettings(stored.withPaymentDraft(draft))
        assertTrue(vm.uiState.value.saveSuccess)
        assertNull(vm.uiState.value.error)
        @Suppress("UNCHECKED_CAST")
        val sent = changes.captured["paymentOptions"] as Map<String, Any?>
        assertEquals(setOf("venmo"), sent.keys)
    }
    @Test
    fun `a save that touches the unknown id is refused and never reaches the repository`() {
        val vm = vm()
        val raw = (stored.paymentOptions as Map<*, *>).toMutableMap().apply { put("oldcoin", mapOf("enabled" to false)) }
        vm.updateBusinessSettings(stored.copy(paymentOptions = raw))
        assertFalse(vm.uiState.value.saveSuccess)
        assertEquals("\"oldcoin\" is not a payment method.", vm.uiState.value.error)
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }
    @Test
    fun `a save with no change writes nothing`() {
        val vm = vm()
        vm.updateBusinessSettings(stored.withPaymentDraft(paymentDraftOf(stored)))
        assertTrue(vm.uiState.value.saveSuccess)
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }
    @Test
    fun `a server failure shows its text and keeps the baseline`() {
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(RuntimeException("Keep payment instructions under 500 characters."))
        val vm = vm()
        val draft = paymentDraftOf(stored).let { it.copy(options = it.options + ("zelle" to PaymentOptionDraft(true, "x"))) }
        vm.updateBusinessSettings(stored.withPaymentDraft(draft))
        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull(vm.uiState.value.error)
    }
}
