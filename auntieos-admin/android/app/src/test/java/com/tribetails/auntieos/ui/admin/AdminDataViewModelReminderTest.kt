package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.ReminderOutcome
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #832: the Invoices list's Send reminder. The row fires the callable straight
 * from the list, so this is where the already-sent answer and the double-tap
 * guard live for that surface.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminDataViewModelReminderTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var invoiceRepo: InvoiceRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        invoiceRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = AdminDataViewModel(
        repository = mockk<AuntieRepository>(),
        invoiceRepository = invoiceRepo,
        kinCareRepository = mockk<KinCareRepository>(),
    )

    @Test
    fun `an already-sent answer is a sentence naming when, not Reminder sent and not an error`() = runTest {
        val earlier = 1_757_840_400_000L
        coEvery { invoiceRepo.sendInvoiceReminder("inv1", any()) } returns
            Result.success(ReminderOutcome(sent = false, reason = "recent", lastReminderAtMs = earlier, nextReminderAllowedAtMs = earlier + 86_400_000L))
        val vm = vm()

        vm.sendInvoiceReminder("inv1")
        advanceUntilIdle()

        val msg = vm.invoiceActionMessage.value
        assertTrue(msg, msg!!.startsWith("Not sent: a reminder already went out"))
        assertNull(vm.error.value)
        assertEquals(emptySet<String>(), vm.remindingInvoiceIds.value)
    }

    @Test
    fun `a reminder blocked by household settings says nothing went out`() = runTest {
        coEvery { invoiceRepo.sendInvoiceReminder("inv1", any()) } returns
            Result.success(ReminderOutcome(sent = false, reason = "suppressed", lastReminderAtMs = null, nextReminderAllowedAtMs = null))
        val vm = vm()

        vm.sendInvoiceReminder("inv1")
        advanceUntilIdle()

        assertEquals(
            "Not sent: this household's notification settings block payment reminders, so no reminder went out.",
            vm.invoiceActionMessage.value,
        )
        assertNull(vm.error.value)
    }

    @Test
    fun `the row is pessimistic, in flight until the server answers, and a double tap fires once`() = runTest {
        coEvery { invoiceRepo.sendInvoiceReminder("inv1", any()) } returns
            Result.success(ReminderOutcome(sent = false, reason = "recent", lastReminderAtMs = 1L, nextReminderAllowedAtMs = 2L))
        val vm = vm()

        vm.sendInvoiceReminder("inv1")
        assertEquals(setOf("inv1"), vm.remindingInvoiceIds.value)
        vm.sendInvoiceReminder("inv1")
        advanceUntilIdle()

        coVerify(exactly = 1) { invoiceRepo.sendInvoiceReminder("inv1", any()) }
        assertEquals(emptySet<String>(), vm.remindingInvoiceIds.value)
    }

    @Test
    fun `a failure still surfaces through error and releases the row`() = runTest {
        coEvery { invoiceRepo.sendInvoiceReminder("inv1", any()) } returns
            Result.failure(IllegalStateException("Invoice is already paid; nothing to remind."))
        val vm = vm()

        vm.sendInvoiceReminder("inv1")
        advanceUntilIdle()

        assertEquals("Invoice is already paid; nothing to remind.", vm.error.value)
        assertEquals(emptySet<String>(), vm.remindingInvoiceIds.value)
    }
}
