package com.tribetails.auntieos.ui.marketing

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.communicate.AudienceSegment
import com.tribetails.auntieos.ui.communicate.BroadcastCriteria
import com.tribetails.auntieos.ui.communicate.SegmentKind
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
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
 * Marketing blasts ViewModel. Mirrors the React admin's
 * `screens/MarketingBlasts.test.tsx`: the same behaviours, asserted against the
 * same fake-repository seam, so a regression on one client is visible on both.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MarketingBlastsViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.listAudienceSegments() } returns Result.success(emptyList())
        coEvery { repo.listMarketingBlasts() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = MarketingBlastsViewModel(repo)

    private fun row(
        id: String,
        status: BlastStatus,
        fireAtMs: Long = 1L,
        title: String = "",
    ) = MarketingBlastRow(
        id = id,
        key = "newsletter.announcement",
        title = title,
        fireAtMs = fireAtMs,
        status = status,
        audienceDescription = "All active kinfolk",
        matched = 1,
        noLinkedAccount = 0,
        dispatched = 1,
        suppressed = 0,
        failed = 0,
    )

    @Test
    fun `init loads the segments and the campaign list`() = runTest(testDispatcher) {
        val v = vm()
        advanceUntilIdle()
        coVerify { repo.listAudienceSegments() }
        coVerify { repo.listMarketingBlasts() }
        assertEquals(emptyList<MarketingBlastRow>(), v.uiState.value.blasts)
    }

    @Test
    fun `a failed campaign load leaves the list null, never an empty one that reads as nothing scheduled`() =
        runTest(testDispatcher) {
            coEvery { repo.listMarketingBlasts() } returns Result.failure(RuntimeException("permission-denied"))
            val v = vm()
            advanceUntilIdle()
            assertNull(v.uiState.value.blasts)
            assertEquals("permission-denied", v.uiState.value.blastsError)
        }

    @Test
    fun `a failed segment load still leaves an audience buildable`() = runTest(testDispatcher) {
        coEvery { repo.listAudienceSegments() } returns Result.failure(RuntimeException("offline"))
        val v = vm()
        advanceUntilIdle()
        assertTrue(v.uiState.value.segmentsError!!.contains("offline"))
        assertNotNull(v.uiState.value.audience)
    }

    @Test
    fun `preview asks for the current key and audience and keeps all four counts`() = runTest(testDispatcher) {
        coEvery { repo.previewMarketingBlastAudience(any(), any()) } returns
            Result.success(BlastReach("All active kinfolk", 10, 2, 3, 5))
        val v = vm()
        advanceUntilIdle()

        v.previewAudience()
        advanceUntilIdle()

        coVerify {
            repo.previewMarketingBlastAudience(
                MarketingKey.Newsletter,
                BlastAudience.Criteria(BroadcastCriteria()),
            )
        }
        assertEquals(BlastReach("All active kinfolk", 10, 2, 3, 5), v.uiState.value.reach)
    }

    @Test
    fun `changing the audience drops the preview, so a stale count is never read as current`() =
        runTest(testDispatcher) {
            coEvery { repo.previewMarketingBlastAudience(any(), any()) } returns
                Result.success(BlastReach(matched = 10, reachable = 10))
            val v = vm()
            advanceUntilIdle()
            v.previewAudience()
            advanceUntilIdle()
            assertNotNull(v.uiState.value.reach)

            v.setCriteriaKind(SegmentKind.Status)

            assertNull(v.uiState.value.reach)
        }

    @Test
    fun `a failed preview shows the error and no numbers at all`() = runTest(testDispatcher) {
        coEvery { repo.previewMarketingBlastAudience(any(), any()) } returns
            Result.failure(RuntimeException("deadline-exceeded"))
        val v = vm()
        advanceUntilIdle()

        v.previewAudience()
        advanceUntilIdle()

        assertNull(v.uiState.value.reach)
        assertEquals("deadline-exceeded", v.uiState.value.previewError)
    }

    @Test
    fun `the blocker names the missing send time before anything else`() = runTest(testDispatcher) {
        val v = vm()
        advanceUntilIdle()
        assertEquals("Pick a date and a time to send.", v.uiState.value.blocker(System.currentTimeMillis()))
    }

    @Test
    fun `schedule sends the key, the criteria, the merge data and the resolved fire time`() =
        runTest(testDispatcher) {
            coEvery { repo.scheduleMarketingBlast(any(), any(), any(), any(), any()) } returns
                Result.success(ScheduleBlastResult("b1", 9, 0, 9, 0, 0))
            val v = vm()
            advanceUntilIdle()

            val date = java.time.LocalDate.now().plusDays(2).toString()
            v.setSendDate(date)
            v.setSendTime("09:00")
            v.setTitle("June newsletter")
            v.setMergeFieldKey(0, "headline")
            v.setMergeFieldValue(0, "A little news")

            v.schedule()
            advanceUntilIdle()

            val data = slot<Map<String, Any?>>()
            val audience = slot<BlastAudience>()
            coVerify {
                repo.scheduleMarketingBlast(
                    MarketingKey.Newsletter,
                    any(),
                    capture(audience),
                    capture(data),
                    "June newsletter",
                )
            }
            assertEquals(BlastAudience.Criteria(BroadcastCriteria()), audience.captured)
            assertEquals(mapOf("headline" to "A little news"), data.captured)
            assertTrue(v.uiState.value.notice!!.contains("9 queued, 0 suppressed"))
            // The list is reloaded so the new campaign appears without a manual refresh.
            coVerify(exactly = 2) { repo.listMarketingBlasts() }
        }

    @Test
    fun `schedule refuses to fire while the form is blocked`() = runTest(testDispatcher) {
        val v = vm()
        advanceUntilIdle()

        v.schedule() // no send time picked

        coVerify(exactly = 0) { repo.scheduleMarketingBlast(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a failed schedule surfaces the server sentence and reports no campaign`() = runTest(testDispatcher) {
        coEvery { repo.scheduleMarketingBlast(any(), any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("failed-precondition: no_recipients"))
        val v = vm()
        advanceUntilIdle()
        v.setSendDate(java.time.LocalDate.now().plusDays(2).toString())
        v.setSendTime("09:00")

        v.schedule()
        advanceUntilIdle()

        assertTrue(v.uiState.value.scheduleError!!.contains("MyTribe account"))
        assertNull(v.uiState.value.notice)
    }

    @Test
    fun `an explicit account list goes on the wire as audienceUids`() = runTest(testDispatcher) {
        coEvery { repo.scheduleMarketingBlast(any(), any(), any(), any(), any()) } returns
            Result.success(ScheduleBlastResult("b2", 2, 0, 2, 0, 0))
        val v = vm()
        advanceUntilIdle()

        v.setMode(AudienceMode.Uids)
        v.setUidsText("u1, u2")
        v.setSendDate(java.time.LocalDate.now().plusDays(2).toString())
        v.setSendTime("09:00")

        v.schedule()
        advanceUntilIdle()

        val audience = slot<BlastAudience>()
        coVerify { repo.scheduleMarketingBlast(any(), any(), capture(audience), any(), any()) }
        assertEquals(BlastAudience.Uids(listOf("u1", "u2")), audience.captured)
    }

    @Test
    fun `a saved segment goes on the wire as a segmentId`() = runTest(testDispatcher) {
        coEvery { repo.listAudienceSegments() } returns Result.success(
            listOf(AudienceSegment("seg1", "VIPs", BroadcastCriteria(), "Tags (any): vip", 1L)),
        )
        coEvery { repo.previewMarketingBlastAudience(any(), any()) } returns Result.success(BlastReach(reachable = 3))
        val v = vm()
        advanceUntilIdle()

        v.setMode(AudienceMode.Segment)
        v.setSelectedSegment("seg1")
        v.previewAudience()
        advanceUntilIdle()

        coVerify { repo.previewMarketingBlastAudience(MarketingKey.Newsletter, BlastAudience.Segment("seg1")) }
    }

    @Test
    fun `cancel removes the queued copies and reloads the list`() = runTest(testDispatcher) {
        coEvery { repo.listMarketingBlasts() } returns Result.success(listOf(row("b1", BlastStatus.Scheduled)))
        coEvery { repo.cancelMarketingBlast("b1") } returns Result.success(9)
        val v = vm()
        advanceUntilIdle()

        v.cancel("b1")
        advanceUntilIdle()

        coVerify { repo.cancelMarketingBlast("b1") }
        assertEquals("Cancelled. 9 queued notifications removed.", v.uiState.value.notice)
        coVerify(exactly = 2) { repo.listMarketingBlasts() }
    }

    @Test
    fun `a cancel the sweep beat is surfaced, not shown as cancelled`() = runTest(testDispatcher) {
        coEvery { repo.listMarketingBlasts() } returns Result.success(listOf(row("b1", BlastStatus.Scheduled)))
        coEvery { repo.cancelMarketingBlast("b1") } returns Result.failure(RuntimeException("already_fired"))
        val v = vm()
        advanceUntilIdle()

        v.cancel("b1")
        advanceUntilIdle()

        assertTrue(v.uiState.value.blastsError!!.contains("already gone out"))
        assertNull(v.uiState.value.notice)
        assertEquals(BlastStatus.Scheduled, v.uiState.value.blasts!!.first().status)
    }

    @Test
    fun `the list splits scheduled from everything else the way the screen renders it`() = runTest(testDispatcher) {
        coEvery { repo.listMarketingBlasts() } returns Result.success(
            listOf(
                row("b1", BlastStatus.Scheduled, fireAtMs = 900),
                row("b2", BlastStatus.Sent, fireAtMs = 100),
                row("b3", BlastStatus.Cancelled, fireAtMs = 50),
            ),
        )
        val v = vm()
        advanceUntilIdle()

        assertEquals(listOf("b1"), v.uiState.value.scheduled.map { it.id })
        assertEquals(listOf("b2", "b3"), v.uiState.value.history.map { it.id })
    }
}
