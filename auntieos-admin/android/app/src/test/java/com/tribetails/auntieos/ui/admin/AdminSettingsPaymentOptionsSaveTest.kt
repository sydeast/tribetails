package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.PaymentHandleField
import com.tribetails.auntieos.data.model.paymentDraftOf
import com.tribetails.auntieos.data.model.withPaymentDraft
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1177: the Payment options panel's save, end to end through the view model,
 * against a document the React admin already wrote switches into.
 *
 * The panel calls `viewModel.updateBusinessSettings(settings.withPaymentDraft(draft))`.
 * These tests make that same call and read what reaches the repository, which
 * is the field map `SetOptions.merge()` writes. The concern from the issue is
 * the diff-vs-rebuild one: a phone save must not drop the web's switches, its
 * instructions, or anything else on the document.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsPaymentOptionsSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    /** What the web wrote: Zelle on with instructions, Cash App off, plus a key from a newer build. */
    private val webOptions: Map<String, Any?> = linkedMapOf(
        "zelle" to linkedMapOf("enabled" to true, "instructions" to "Zelle to the business line."),
        "cashapp" to linkedMapOf("enabled" to false, "instructions" to ""),
        "applepay" to linkedMapOf("enabled" to true),
    )

    private val stored = BusinessSettings(
        businessName = "Tribe Tails",
        venmoHandle = "@tribetails",
        cashappHandle = "\$tribetails",
        paymentOptions = webOptions,
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
        return changes
    }

    private fun loadedViewModel(): AdminSettingsViewModel {
        val vm = AdminSettingsViewModel(repository = repo)
        vm.loadBusinessSettings()
        return vm
    }

    @Suppress("UNCHECKED_CAST")
    private fun entry(changes: Map<String, Any?>, id: String): Map<String, Any?> =
        (changes["paymentOptions"] as Map<String, Any?>)[id] as Map<String, Any?>

    @Test
    fun `turning a method on writes paymentOptions only and keeps every web entry`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()
        val settings = vm.uiState.value.businessSettings
        val draft = paymentDraftOf(settings).let { d ->
            d.copy(options = d.options + ("check" to d.options.getValue("check").copy(enabled = true, instructions = "  Payable to Tribe Tails.  ")))
        }

        vm.updateBusinessSettings(settings.withPaymentDraft(draft))
        advanceUntilIdle()

        assertEquals(setOf("paymentOptions"), changes.captured.keys)
        assertEquals(mapOf("enabled" to true, "instructions" to "Payable to Tribe Tails."), entry(changes.captured, "check"))
        assertEquals(mapOf("enabled" to true, "instructions" to "Zelle to the business line."), entry(changes.captured, "zelle"))
        assertEquals(false, entry(changes.captured, "cashapp")["enabled"])
        // A key this build does not model rides along untouched.
        assertEquals(mapOf("enabled" to true), entry(changes.captured, "applepay"))
        assertTrue(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `a handle edit writes the handle only and never rewrites the switches`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()
        val settings = vm.uiState.value.businessSettings
        val draft = paymentDraftOf(settings).let { it.copy(handles = it.handles + (PaymentHandleField.VENMO to " @new-handle ")) }

        vm.updateBusinessSettings(settings.withPaymentDraft(draft))
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("venmoHandle" to "@new-handle"), changes.captured)
    }

    @Test
    fun `another panel's save leaves the web's switches off the write`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()

        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(businessName = "Tribe Tails Care"))
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("businessName" to "Tribe Tails Care"), changes.captured)
    }

    @Test
    fun `settingsSaving is on for the wait and off once the write lands`() = runTest(testDispatcher) {
        val gate = CompletableDeferred<Result<Unit>>()
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } coAnswers { gate.await() }
        val vm = loadedViewModel()
        val settings = vm.uiState.value.businessSettings
        val draft = paymentDraftOf(settings).let { d ->
            d.copy(options = d.options + ("cash" to d.options.getValue("cash").copy(enabled = true, instructions = "Exact change.")))
        }

        vm.updateBusinessSettings(settings.withPaymentDraft(draft))
        assertTrue(vm.uiState.value.settingsSaving)

        gate.complete(Result.success(Unit))
        advanceUntilIdle()
        assertFalse(vm.uiState.value.settingsSaving)
        assertTrue(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `a failed write clears settingsSaving and reports the error`() = runTest(testDispatcher) {
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(IllegalStateException("offline"))
        val vm = loadedViewModel()
        val settings = vm.uiState.value.businessSettings
        val draft = paymentDraftOf(settings).let { d ->
            d.copy(options = d.options + ("stripe" to d.options.getValue("stripe").copy(enabled = false)))
        }

        vm.updateBusinessSettings(settings.withPaymentDraft(draft))
        advanceUntilIdle()

        assertFalse(vm.uiState.value.settingsSaving)
        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull(vm.uiState.value.error)
    }
}
