package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.MessageSuppressionRepository
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.ClearResult
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Page
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Suppression
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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

/** #1083: the do-not-send view model against a mocked repository. */
@OptIn(ExperimentalCoroutinesApi::class)
class DoNotSendViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: MessageSuppressionRepository

    private val bounced =
        Suppression("gone@example.com", "g***@example.com", "email", "hard_bounce", "smtp2go", 1759400000000L, false, "evt-9")
    private val opted =
        Suppression("+14155552671", "+1******2671", "sms", "opt_out", "admin", 1758000000000L, true, null)
    private val both =
        Suppression("both@example.com", "b***@example.com", "email", "hard_bounce", "smtp2go", 1759500000000L, true, "evt-2")

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk()
        coEvery { repo.list(any(), any()) } returns Result.success(Page(listOf(bounced, opted), null))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun ready(vm: DoNotSendViewModel) = vm.state.value.load as DoNotSendViewModel.Load.Ready

    @Test
    fun `loads the whole list on open`() = runTest {
        val vm = DoNotSendViewModel(repo)

        assertEquals(listOf(bounced, opted), ready(vm).items)
        coVerify { repo.list("all", null) }
    }

    @Test
    fun `a failed load says why and retry loads again`() = runTest {
        coEvery { repo.list(any(), any()) } returns Result.failure(RuntimeException("boom"))
        val vm = DoNotSendViewModel(repo)
        val failed = vm.state.value.load as DoNotSendViewModel.Load.Failed
        assertTrue(failed.message.contains("boom"))

        coEvery { repo.list(any(), any()) } returns Result.success(Page(listOf(bounced), null))
        vm.load()

        assertEquals(listOf(bounced), ready(vm).items)
    }

    @Test
    fun `changing the filter re-queries by reason`() = runTest {
        val vm = DoNotSendViewModel(repo)

        vm.setFilter("hard_bounce")

        coVerify { repo.list("hard_bounce", null) }
        assertEquals("hard_bounce", vm.state.value.filter)
    }

    @Test
    fun `load more appends the next page by cursor`() = runTest {
        coEvery { repo.list("all", null) } returns Result.success(Page(listOf(bounced), "cur1"))
        coEvery { repo.list("all", "cur1") } returns Result.success(Page(listOf(opted), null))
        val vm = DoNotSendViewModel(repo)
        assertEquals("cur1", ready(vm).nextCursor)

        vm.loadMore()

        assertEquals(listOf(bounced, opted), ready(vm).items)
        assertNull(ready(vm).nextCursor)
    }

    @Test
    fun `asking to clear sends nothing until confirmed`() = runTest {
        val vm = DoNotSendViewModel(repo)

        vm.askClear(bounced)
        assertEquals(bounced, vm.state.value.pending)
        coVerify(exactly = 0) { repo.clear(any()) }

        vm.cancelClear()
        assertNull(vm.state.value.pending)
        coVerify(exactly = 0) { repo.clear(any()) }
    }

    @Test
    fun `an opt-out only row cannot be put up for clearing`() = runTest {
        val vm = DoNotSendViewModel(repo)

        vm.askClear(opted)
        vm.confirmClear()

        assertNull(vm.state.value.pending)
        coVerify(exactly = 0) { repo.clear(any()) }
    }

    @Test
    fun `confirming clears the full address, drops the row and says so`() = runTest {
        coEvery { repo.clear("gone@example.com") } returns Result.success(ClearResult("email", "g***@example.com", false))
        val vm = DoNotSendViewModel(repo)

        vm.askClear(bounced)
        vm.confirmClear()

        coVerify(exactly = 1) { repo.clear("gone@example.com") }
        assertEquals(listOf(opted), ready(vm).items)
        assertNull(vm.state.value.pending)
        assertEquals("Cleared g***@example.com. It can be mailed again.", vm.state.value.note)
    }

    @Test
    fun `clearing a bounce on an opted-out address keeps the row as an opt-out`() = runTest {
        coEvery { repo.list(any(), any()) } returns Result.success(Page(listOf(both), null))
        coEvery { repo.clear("both@example.com") } returns Result.success(ClearResult("email", "b***@example.com", true))
        val vm = DoNotSendViewModel(repo)

        vm.askClear(both)
        vm.confirmClear()

        val row = ready(vm).items.single()
        assertEquals("opt_out", row.reason)
        assertTrue(row.optedOut)
        assertEquals(false, row.clearable)
        assertNull(row.eventId)
        assertEquals("Cleared the bounce on b***@example.com. The opt-out stays.", vm.state.value.note)
    }

    @Test
    fun `a failed clear keeps the row and shows the server reason`() = runTest {
        coEvery { repo.clear(any()) } returns Result.failure(RuntimeException("That address is not on the do-not-send list."))
        val vm = DoNotSendViewModel(repo)

        vm.askClear(bounced)
        vm.confirmClear()

        assertEquals(listOf(bounced, opted), ready(vm).items)
        assertNotNull(vm.state.value.error)
        assertTrue(vm.state.value.error!!.contains("not on the do-not-send list"))
    }
}
