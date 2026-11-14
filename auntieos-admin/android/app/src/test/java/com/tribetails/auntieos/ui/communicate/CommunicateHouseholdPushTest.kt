package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
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

/**
 * #2061: approving a Push draft on Android sends it through `sendHouseholdPush`,
 * after a confirm and after the approve write, and the screen says what reached
 * the household. Before this the approve said "This type sends nothing from
 * here" and nothing sent it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateHouseholdPushTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.approveDraft(any(), any(), any()) } returns Result.success(Unit)
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { repo.generate(any()) } returns Result.success(
            GenerateResponse(generatedCopy = "Biscuit says hi from the park.", draftId = "d1", kinfolkId = "kf1"),
        )
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    private suspend fun kotlinx.coroutines.test.TestScope.pushDraft(): CommunicateViewModel {
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.setCommType("push")
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.setRawNotes("notes")
        vm.generate()
        advanceUntilIdle()
        return vm
    }

    @Test fun `a Push approve asks first, then approves, then pushes to the household`() = runTest(testDispatcher) {
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.success(HouseholdPushResult("sent", null))
        val vm = pushDraft()

        vm.requestApprove()
        assertTrue(vm.uiState.value.approveConfirmOpen)
        coVerify(exactly = 0) { repo.sendHouseholdPush(any(), any(), any()) }

        vm.approveDraft()
        advanceUntilIdle()

        coVerifyOrder {
            repo.approveDraft("d1", "Biscuit says hi from the park.", "kf1")
            repo.sendHouseholdPush("kf1", "d1", "Biscuit says hi from the park.")
        }
        val s = vm.uiState.value
        assertEquals("d1", s.savedDraftId)
        assertEquals("Push sent", s.pushNotice?.title)
        assertEquals("Sent to Rosa Parks's phone. It is on their notifications list too.", s.pushNotice?.body)
        assertFalse(s.pushNotice!!.retryable)
        coVerify(exactly = 0) { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) }
    }

    @Test fun `a push the send gate held says so plainly, and sends once tried again`() = runTest(testDispatcher) {
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returnsMany listOf(
            Result.success(HouseholdPushResult("held", "household_notices_off")),
            Result.success(HouseholdPushResult("sent", null)),
        )
        val vm = pushDraft()
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()

        val held = vm.uiState.value.pushNotice!!
        assertEquals("Not sent", held.title)
        assertTrue(held.body.contains("Notices to households are switched off"))
        assertTrue(held.retryable)

        vm.retryHouseholdPush()
        advanceUntilIdle()
        assertEquals("Push sent", vm.uiState.value.pushNotice?.title)
        coVerify(exactly = 2) { repo.sendHouseholdPush("kf1", "d1", any()) }
    }

    @Test fun `a failed push call keeps the draft approved and offers a retry`() = runTest(testDispatcher) {
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.failure(RuntimeException("unavailable"))
        val vm = pushDraft()
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()

        val s = vm.uiState.value
        assertEquals("d1", s.savedDraftId)
        assertTrue(s.pushNotice!!.body.startsWith("The draft is approved, but the push could not be sent: unavailable"))
        assertTrue(s.pushNotice!!.retryable)
        assertNull(s.successMessage)
    }

    // ── the pure rules ─────────────────────────────────────────────────────

    @Test fun `only a sent result says a push went out`() {
        assertTrue(householdPushNotice(HouseholdPushResult("sent", null), "Dana").body.startsWith("Sent to Dana's phone"))
        listOf(
            HouseholdPushResult("listed", "household_push_off"),
            HouseholdPushResult("listed", "no_device"),
            HouseholdPushResult("listed", "push_failed"),
            HouseholdPushResult("held", "household_notices_off"),
            HouseholdPushResult("held", "household_has_no_portal_account"),
            HouseholdPushResult("held", "notice_turned_off"),
        ).forEach { r ->
            val n = householdPushNotice(r, "Dana")
            assertFalse(n.body, n.body.startsWith("Sent"))
            assertEquals(r.outcome == "held", n.retryable)
        }
        assertEquals(
            "It is on Dana's notifications list. No push went to their phone, because their settings keep pushes for your messages off.",
            householdPushNotice(HouseholdPushResult("listed", "household_push_off"), "Dana").body,
        )
    }

    @Test fun `a push needs a household and fits the server's length`() {
        assertEquals(
            "This push is not addressed to a household. Choose one before sending.",
            pushApproveBlocker("push", null, "Hi"),
        )
        assertEquals("A push can be at most 1000 characters. This one is 1001.", pushApproveBlocker("push", "kf1", "x".repeat(1001)))
        assertNull(pushApproveBlocker("push", "kf1", "x".repeat(1000)))
        assertNull(pushApproveBlocker("email", null, "x".repeat(5000)))
    }
    @Test fun `an answer this client cannot read is never a send`() {
        assertEquals("held", decodeHouseholdPushResult(null).outcome)
        assertEquals("held", decodeHouseholdPushResult(mapOf("outcome" to "bogus")).outcome)
        assertEquals(HouseholdPushResult("listed", "no_device"), decodeHouseholdPushResult(mapOf("outcome" to "listed", "reason" to "no_device")))
    }
}
