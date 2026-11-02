package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.repository.KinRemovalRequestRepository
import com.tribetails.auntieos.data.repository.KinRemovalRequestRow
import com.tribetails.auntieos.data.repository.KinRemovalResolution
import com.tribetails.auntieos.data.repository.decodeKinRemovalList
import com.tribetails.auntieos.data.repository.decodeKinRemovalResolution
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.ZoneOffset

/**
 * #1408. The office's queue of household requests to remove a Kin, the wire
 * decode, and the sentences the card shows (the same as the React
 * `components/KinRemovalRequests.tsx`).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinRemovalQueueTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val repo = mockk<KinRemovalRequestRepository>()

    private val nov2 = 1_793_620_800_000L // 2026-11-02T12:00Z

    private fun row(id: String, name: String?, status: String = "pending") = KinRemovalRequestRow(
        id = id,
        kinfolkId = "kf1",
        kinId = "fk1",
        flatKinId = "k1",
        kinName = name,
        reason = null,
        status = status,
        requestedAtMs = nov2,
        resolvedAtMs = null,
        resolutionNote = null,
    )

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `loads every pending request`() = runTest(dispatcher) {
        coEvery { repo.list(null) } returns Result.success(listOf(row("a", "Biscuit"), row("b", "Moss", "declined")))
        val vm = KinRemovalQueueViewModel(repo)
        assertTrue(vm.state.value.loading)
        vm.load()
        advanceUntilIdle()
        assertFalse(vm.state.value.loading)
        assertEquals(listOf("a"), vm.state.value.requests.map { it.id })
    }

    @Test
    fun `a failed read is an error, never an empty queue`() = runTest(dispatcher) {
        coEvery { repo.list(null) } returns Result.failure(RuntimeException("network"))
        val vm = KinRemovalQueueViewModel(repo)
        vm.load()
        advanceUntilIdle()
        assertEquals("network", vm.state.value.error)
    }

    @Test
    fun `an answered request leaves the queue with the server's account`() = runTest(dispatcher) {
        coEvery { repo.list(null) } returns Result.success(listOf(row("a", "Biscuit"), row("b", "Moss")))
        coEvery { repo.resolve("a", "decline", "Next week") } returns
            Result.success(KinRemovalResolution("decline", row("a", "Biscuit", "declined"), householdNotified = false))
        val vm = KinRemovalQueueViewModel(repo)
        vm.load()
        advanceUntilIdle()
        vm.resolve("a", "decline", "Next week")
        advanceUntilIdle()
        assertEquals(listOf("b"), vm.state.value.requests.map { it.id })
        assertNull(vm.state.value.inFlight)
        assertEquals(
            "Declined. Biscuit stays on the profile. The message to the household did not go out, so tell them another way.",
            vm.state.value.message,
        )
        coVerify(exactly = 1) { repo.resolve("a", "decline", "Next week") }
    }

    @Test
    fun `a refusal keeps the row and shows the sentence`() = runTest(dispatcher) {
        coEvery { repo.list(null) } returns Result.success(listOf(row("a", "Biscuit")))
        coEvery { repo.resolve(any(), any(), any()) } returns Result.failure(RuntimeException("Admin claim required."))
        val vm = KinRemovalQueueViewModel(repo)
        vm.load()
        advanceUntilIdle()
        vm.resolve("a", "archive", "")
        advanceUntilIdle()
        assertEquals(listOf("a"), vm.state.value.requests.map { it.id })
        assertEquals("Admin claim required.", vm.state.value.actionError)
        assertEquals("a", vm.state.value.actionErrorFor)
    }

    @Test
    fun `the wire decodes numbers and nulls the way the callable sends them`() {
        val rows = decodeKinRemovalList(
            mapOf(
                "requests" to listOf(
                    mapOf(
                        "id" to "kf1_fk1", "kinfolkId" to "kf1", "kinId" to "fk1", "flatKinId" to null,
                        "kinName" to "Biscuit", "reason" to "", "status" to "pending",
                        "requestedAtMs" to 1.7936208E12, "resolvedAtMs" to null, "resolutionNote" to null,
                    ),
                    mapOf("kinName" to "no id, dropped"),
                ),
            ),
        )
        assertEquals(1, rows.size)
        assertNull(rows[0].flatKinId)
        assertNull(rows[0].reason)
        assertEquals(nov2, rows[0].requestedAtMs)

        val res = decodeKinRemovalResolution(
            mapOf("decision" to "archive", "householdNotified" to true, "request" to mapOf("id" to "kf1_fk1", "status" to "archived")),
        )
        assertEquals("archive", res.decision)
        assertTrue(res.householdNotified)
        assertEquals("archived", res.request.status)
    }

    @Test
    fun `the card reads like the web`() {
        assertEquals("Nov 2, 2026", kinRemovalDateLabel(nov2, ZoneOffset.UTC))
        assertEquals(
            "The household asked on Nov 2, 2026 to remove Biscuit from their profile.",
            kinRemovalRequestedLine(row("a", "Biscuit"), ZoneOffset.UTC),
        )
        assertEquals(
            "This Kin comes off the household's profile. Visits, invoices and KinTales are kept, and the household will be told.",
            kinRemovalConfirmLine(row("a", null), "archive"),
        )
        assertEquals(
            "Biscuit stays on the household's profile. The household will be told.",
            kinRemovalConfirmLine(row("a", "Biscuit"), "decline"),
        )
    }
}
