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
        // #2381: a call with no answer may have gone out, so it never says what reached the household.
        assertEquals("Not confirmed", s.pushNotice!!.title)
        assertEquals(
            "The draft is approved, but the push was not confirmed: unavailable. " +
                "Try again. A push that already went out is not sent twice.",
            s.pushNotice!!.body,
        )
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
    // ── #2293: a held Push draft opened again later ────────────────────────
    private val heldDraft = com.tribetails.auntieos.data.model.Draft(
        id = "gd1",
        status = "approved",
        communicationType = "push",
        kinfolkId = "kf1",
        kinfolkName = "Rosa",
        generatedCopy = "Biscuit says hi from the park.",
        pushOutcome = "held",
        pushReason = "household_notices_off",
    )
    @Test fun `a held Push draft opens approved, says why, and Try again sends the approved words`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.success(HouseholdPushResult("sent", null))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        val opened = vm.uiState.value
        assertEquals("gd1", opened.savedDraftId)
        assertEquals("Not sent", opened.pushNotice?.title)
        assertTrue(opened.pushNotice!!.body.contains("Notices to households are switched off"))
        assertTrue(opened.pushNotice!!.retryable)
        vm.retryHouseholdPush()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.sendHouseholdPush("kf1", "gd1", "Biscuit says hi from the park.") }
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
        assertEquals("Push sent", vm.uiState.value.pushNotice?.title)
        assertFalse(vm.uiState.value.pushNotice!!.retryable)
    }
    @Test fun `a held Push draft still held keeps its Try again, and a failed call never claims a send`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns
            Result.failure(RuntimeException("This draft was written for a different household."))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.retryHouseholdPush()
        advanceUntilIdle()
        val notice = vm.uiState.value.pushNotice!!
        assertFalse(notice.title == "Push sent")
        assertTrue(notice.body.contains("different household"))
    }
    @Test fun `a Push draft that went out opens as a plain draft with no notice`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft.copy(pushOutcome = "sent", pushReason = ""))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        assertNull(vm.uiState.value.pushNotice)
        assertNull(vm.uiState.value.savedDraftId)
    }

    // ── #2381: delete, and a send that never answered ──────────────────────
    private val unansweredDraft get() = heldDraft.copy(pushOutcome = "", pushReason = "")
    @Test fun `HAPPY a held Push draft offers Delete, and deleting it goes through the server`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.deleteGeneratedDraft("gd1") } returns Result.success(Unit)
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        val opened = vm.uiState.value
        assertTrue(canDeleteDraft(opened.draftId != null, sent = false, approved = opened.savedDraftId != null, notice = opened.pushNotice))
        vm.deleteDraft()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.deleteGeneratedDraft("gd1") }
        val s = vm.uiState.value
        assertTrue(s.draftDeleted)
        assertNull(s.pushNotice)
        assertNull(s.savedDraftId)
        assertEquals("Draft deleted.", s.successMessage)
        coVerify(exactly = 0) { repo.sendHouseholdPush(any(), any(), any()) }
    }
    @Test fun `ERROR a refused delete keeps the held draft and its Try again`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.deleteGeneratedDraft("gd1") } returns Result.failure(RuntimeException("The draft could not be deleted."))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.deleteDraft()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertFalse(s.draftDeleted)
        assertFalse(s.isDeletingDraft)
        assertEquals("The draft could not be deleted.", s.error)
        assertEquals("gd1", s.savedDraftId)
        assertTrue(s.pushNotice!!.retryable)
    }
    @Test fun `the Delete rule keeps a draft that reached its household and offers one that did not`() {
        val held = householdPushNotice(HouseholdPushResult("held", "household_notices_off"), "Dana")
        val unanswered = householdPushNotice(HouseholdPushResult(PUSH_UNANSWERED, null), "Dana")
        val sentNotice = householdPushNotice(HouseholdPushResult("sent", null), "Dana")
        val listed = householdPushNotice(HouseholdPushResult("listed", "no_device"), "Dana")
        // Not approved yet: Delete, as before.
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = false, notice = null))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = held))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = unanswered))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = sentNotice))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = listed))
        // An approved email, a KinTale already sent, and nothing saved.
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = null))
        assertFalse(canDeleteDraft(hasDraft = true, sent = true, approved = false, notice = null))
        assertFalse(canDeleteDraft(hasDraft = false, sent = false, approved = false, notice = null))
        // The confirm says "not sent" only when that is known.
        assertEquals("It has not been sent. Deleting it cannot be undone.", deleteDraftConfirmLine(null))
        assertEquals("It has not been sent. Deleting it cannot be undone.", deleteDraftConfirmLine(held))
        assertEquals("Deleting it cannot be undone.", deleteDraftConfirmLine(unanswered))
    }
    @Test fun `HAPPY an approved Push whose send never answered opens not confirmed, and Try again finds out`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(unansweredDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.success(HouseholdPushResult("already_sent", null))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        val opened = vm.uiState.value
        assertEquals("gd1", opened.savedDraftId)
        assertEquals("Not confirmed", opened.pushNotice?.title)
        assertEquals(
            "The last send did not answer, so it is not known whether this push reached Rosa Parks. " +
                "Try again. A push that already went out is not sent twice.",
            opened.pushNotice?.body,
        )
        assertTrue(opened.pushNotice!!.retryable)
        vm.retryHouseholdPush()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.sendHouseholdPush("kf1", "gd1", "Biscuit says hi from the park.") }
        assertEquals("This push already went to Rosa Parks. Nothing new was sent.", vm.uiState.value.pushNotice?.body)
        assertFalse(vm.uiState.value.pushNotice!!.retryable)
    }
    @Test fun `the server never names a push unanswered`() {
        assertEquals("held", decodeHouseholdPushResult(mapOf("outcome" to PUSH_UNANSWERED)).outcome)
    }
    // ── #2389: the approved words, one push per draft ──────────────────────
    @Test fun `HAPPY editing a held Push returns it to unapproved, and approving stores the new words before sending them`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.success(HouseholdPushResult("sent", null))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.setGeneratedCopy("Biscuit says hi from the park. See you soon.")
        val edited = vm.uiState.value
        assertNull(edited.savedDraftId)
        assertNull(edited.pushNotice)
        // Try again is gone with the notice; nothing sends the edited words unapproved.
        vm.retryHouseholdPush()
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.sendHouseholdPush(any(), any(), any()) }
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        coVerifyOrder {
            repo.approveDraft("gd1", "Biscuit says hi from the park. See you soon.", "kf1")
            repo.sendHouseholdPush("kf1", "gd1", "Biscuit says hi from the park. See you soon.")
        }
        assertEquals("Push sent", vm.uiState.value.pushNotice?.title)
    }
    @Test fun `NEGATIVE setting the same words, or editing a push that went out, changes nothing`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.setGeneratedCopy("Biscuit says hi from the park.")
        assertEquals("gd1", vm.uiState.value.savedDraftId)
        assertTrue(vm.uiState.value.pushNotice!!.retryable)
        assertFalse(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("sent", null), "Dana")))
        assertFalse(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("listed", "no_device"), "Dana")))
        assertFalse(editReturnsToUnapproved(null))
    }
    private fun refusal(code: String, message: String): com.google.firebase.functions.FirebaseFunctionsException {
        val e = mockk<com.google.firebase.functions.FirebaseFunctionsException>(relaxed = true)
        io.mockk.every { e.details } returns mapOf("code" to code)
        io.mockk.every { e.message } returns message
        return e
    }
    @Test fun `NEGATIVE when the server refuses the words the draft goes back to unapproved and says why`() = runTest(testDispatcher) {
        val message = "The words changed after this draft was approved. Approve it again to send them."
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.failure(refusal(PUSH_WORDS_CHANGED_CODE, message))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.retryHouseholdPush()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertNull(s.savedDraftId)
        assertNull(s.pushNotice)
        assertEquals(message, s.error)
        assertFalse(s.isRetryingPush)
    }
    @Test fun `NEGATIVE a push another screen is sending says to wait and keeps Try again`() = runTest(testDispatcher) {
        val message = "This push is being sent right now. Wait a moment, then try again."
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.failure(refusal(PUSH_IN_FLIGHT_CODE, message))
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.retryHouseholdPush()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertEquals("gd1", s.savedDraftId)
        assertEquals(HouseholdPushNotice("Sending now", message, retryable = true), s.pushNotice)
    }
    @Test fun `NEGATIVE two taps on Try again send once`() = runTest(testDispatcher) {
        val answer = kotlinx.coroutines.CompletableDeferred<Result<HouseholdPushResult>>()
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(heldDraft)
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } coAnswers { answer.await() }
        // A dispatcher that does not run the coroutine until told to: the tap
        // itself has to leave the guard behind, not the coroutine it starts.
        val queued = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        Dispatchers.setMain(queued)
        vm.retryHouseholdPush()
        assertTrue(vm.uiState.value.isRetryingPush)
        vm.retryHouseholdPush()
        advanceUntilIdle()
        answer.complete(Result.success(HouseholdPushResult("sent", null)))
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.sendHouseholdPush(any(), any(), any()) }
        assertFalse(vm.uiState.value.isRetryingPush)
        assertEquals("Push sent", vm.uiState.value.pushNotice?.title)
    }
    @Test fun `NEGATIVE two taps on the push approve approve and send once`() = runTest(testDispatcher) {
        coEvery { repo.sendHouseholdPush(any(), any(), any()) } returns Result.success(HouseholdPushResult("sent", null))
        val vm = pushDraft()
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        vm.requestApprove()
        vm.approveDraft()
        assertTrue(vm.uiState.value.isSaving)
        vm.approveDraft()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.approveDraft(any(), any(), any()) }
        coVerify(exactly = 1) { repo.sendHouseholdPush(any(), any(), any()) }
    }
    @Test fun `a failed call is worded by what is known`() {
        assertEquals(
            HouseholdPushNotice("Not confirmed", "The draft is approved, but the push was not confirmed: the server did not answer. Try again. A push that already went out is not sent twice.", true),
            householdPushCallFailed(null, null),
        )
        // A sentence from the server keeps one full stop.
        assertTrue(householdPushCallFailed(null, "The connection dropped.").body.contains("not confirmed: The connection dropped. Try again."))
        assertTrue(householdPushCallFailed(PUSH_WORDS_CHANGED_CODE, null).needsApproval)
        assertFalse(householdPushCallFailed(PUSH_WORDS_CHANGED_CODE, null).retryable)
        assertTrue(householdPushCallFailed(PUSH_IN_FLIGHT_CODE, null).retryable)
        listOf(null, PUSH_IN_FLIGHT_CODE, PUSH_WORDS_CHANGED_CODE).forEach { code ->
            val n = householdPushCallFailed(code, null)
            assertFalse(n.body, n.body.contains("Nothing reached") || n.body.startsWith("Sent"))
        }
    }
}
