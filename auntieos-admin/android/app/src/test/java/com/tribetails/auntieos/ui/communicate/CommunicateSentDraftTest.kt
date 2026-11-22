package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.draftFromFields
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.ZoneId

/**
 * #2428: a Communicate draft that already went out opened again as needing
 * approval, with Approve and Delete. Approving an Email or Text there sent the
 * household the same message a second time.
 *
 * The screen's two buttons are read off the state these assert:
 *   Approve is enabled only while `savedDraftId` is null and nothing is sent.
 *   Delete is `canDeleteDraft(hasDraft, sent, approved, pushNotice)`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateSentDraftTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private val utc = ZoneId.of("UTC")

    private val email = Draft(
        id = "gd1",
        status = "generated",
        communicationType = "email",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        generatedCopy = "Biscuit is booked for Friday.",
        generatedTitle = "Friday",
        createdOn = "2026-11-18T10:00:00.000Z",
    )
    private val text = email.copy(communicationType = "sms", generatedTitle = "")
    private val push = email.copy(communicationType = "push", generatedTitle = "", status = "approved")

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.latestThreadMessage(any()) } returns Result.success(null)
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } returns
            Result.success(DraftSendResult("sent", "r***@example.com"))
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    private suspend fun kotlinx.coroutines.test.TestScope.opened(draft: Draft): CommunicateViewModel {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(draft)
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        return vm
    }

    /** Neither button: Approve is off (`savedDraftId` set) and Delete is not offered. */
    private fun assertFinished(s: CommunicateUiState) {
        assertEquals("gd1", s.savedDraftId)
        assertFalse(canDeleteDraft(s.draftId != null, s.publishedReportId != null, s.savedDraftId != null, s.pushNotice))
        assertFalse(draftNeedsApproval(sent = s.publishedReportId != null, approved = s.savedDraftId != null))
        assertFalse(s.pushNotice?.retryable == true)
    }

    // ── opening a draft that already went out ────────────────────────────────

    @Test fun `HAPPY an Email the server stamped sent opens as sent with neither button`() = runTest(testDispatcher) {
        val vm = opened(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"))
        val s = vm.uiState.value
        assertEquals("Already sent", s.sentNotice?.title)
        assertTrue(s.sentNotice!!.body, s.sentNotice!!.body.startsWith("Sent to Rosa Parks by email on Nov 20, 2026"))
        assertEquals("Biscuit is booked for Friday.", s.generatedCopy)
        assertNull(s.pushNotice)
        assertFinished(s)
    }

    @Test fun `HAPPY a Text an older version approved and sent opens as already approved`() = runTest(testDispatcher) {
        val vm = opened(text.copy(status = "approved", approvedAt = "2026-11-03T16:00:00.000Z"))
        val s = vm.uiState.value
        assertEquals("Already approved", s.sentNotice?.title)
        assertTrue(s.sentNotice!!.body, s.sentNotice!!.body.startsWith("This text for Rosa Parks was approved on Nov 3, 2026"))
        assertFinished(s)
    }

    @Test fun `HAPPY a Push that reached their phone opens with what happened and neither button`() = runTest(testDispatcher) {
        val vm = opened(push.copy(pushOutcome = "sent"))
        val s = vm.uiState.value
        assertEquals("Push sent", s.pushNotice?.title)
        assertEquals("Sent to Rosa Parks's phone. It is on their notifications list too.", s.pushNotice?.body)
        assertNull(s.sentNotice)
        assertFinished(s)
    }

    @Test fun `HAPPY a Push that only reached their notifications list opens the same way`() = runTest(testDispatcher) {
        val vm = opened(push.copy(pushOutcome = "listed", pushReason = "no_device"))
        val s = vm.uiState.value
        assertEquals("On their notifications list", s.pushNotice?.title)
        assertFinished(s)
    }

    @Test fun `NEGATIVE editing a Push already on their list does not bring Approve back`() = runTest(testDispatcher) {
        // Approving it again with new words rewrote the notice the household already had.
        val vm = opened(push.copy(pushOutcome = "listed", pushReason = "household_push_off"))
        vm.setGeneratedCopy("New words for a notice they already have.")
        assertFinished(vm.uiState.value)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        // The screen offers no Approve, and a call that got past the button writes and sends nothing.
        assertFalse(vm.uiState.value.approveConfirmOpen)
        assertEquals("On their notifications list", vm.uiState.value.pushNotice?.title)
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
        coVerify(exactly = 0) { repo.sendHouseholdPush(any(), any(), any()) }
    }

    @Test fun `NEGATIVE editing a sent Email does not bring Approve back`() = runTest(testDispatcher) {
        val vm = opened(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"))
        vm.setGeneratedCopy("Send this again.")
        assertFinished(vm.uiState.value)
        assertEquals("Already sent", vm.uiState.value.sentNotice?.title)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.sendGeneratedDraft(any(), any(), any(), any()) }
    }

    @Test fun `HAPPY an Email nobody approved opens with Approve and Delete`() = runTest(testDispatcher) {
        val vm = opened(email)
        val s = vm.uiState.value
        assertNull(s.savedDraftId)
        assertNull(s.sentNotice)
        assertNull(s.pushNotice)
        assertTrue(canDeleteDraft(s.draftId != null, s.publishedReportId != null, s.savedDraftId != null, s.pushNotice))
        assertTrue(draftNeedsApproval(sent = false, approved = false))
    }

    @Test fun `HAPPY a held Push still opens with Try again and Delete, as before`() = runTest(testDispatcher) {
        val vm = opened(push.copy(pushOutcome = "held", pushReason = "household_notices_off"))
        val s = vm.uiState.value
        assertEquals("Not sent", s.pushNotice?.title)
        assertTrue(s.pushNotice!!.retryable)
        assertNull(s.sentNotice)
        assertTrue(canDeleteDraft(s.draftId != null, false, s.savedDraftId != null, s.pushNotice))
    }

    @Test fun `HAPPY an approved Blog post, which is sent by nothing, opens as it always did`() = runTest(testDispatcher) {
        val vm = opened(email.copy(communicationType = "blog_post", status = "approved"))
        assertNull(vm.uiState.value.savedDraftId)
        assertNull(vm.uiState.value.sentNotice)
    }

    @Test fun `generating a new draft clears the sent notice of the one that was open`() = runTest(testDispatcher) {
        coEvery { repo.generate(any()) } returns Result.success(
            com.tribetails.auntieos.data.model.GenerateResponse(generatedCopy = "New words.", draftId = "d2", kinfolkId = "kf1"),
        )
        val vm = opened(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"))
        vm.setRawNotes("notes")
        vm.generate()
        advanceUntilIdle()
        assertNull(vm.uiState.value.sentNotice)
        assertNull(vm.uiState.value.savedDraftId)
        assertEquals("d2", vm.uiState.value.draftId)
    }

    // ── sending once ─────────────────────────────────────────────────────────

    @Test fun `HAPPY a stored Email is approved and sent by the server, once`() = runTest(testDispatcher) {
        val vm = opened(email)
        vm.requestApprove()
        assertTrue(vm.uiState.value.approveConfirmOpen)
        vm.approveDraft()
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.sendGeneratedDraft("gd1", "kf1", "Biscuit is booked for Friday.", "Friday") }
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
        coVerify(exactly = 0) { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) }
        val s = vm.uiState.value
        assertEquals("Draft approved and sent by email to r***@example.com.", s.successMessage)
        assertFinished(s)
    }

    @Test fun `NEGATIVE when the server says it had already gone the screen says so and claims no new send`() = runTest(testDispatcher) {
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } returns Result.success(DraftSendResult("already_sent", ""))
        val vm = opened(email)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertEquals(SentDraftNotice("Already sent", "This message already went to Rosa Parks. Nothing new was sent."), s.sentNotice)
        assertNull(s.successMessage)
        assertNull(s.error)
        assertFinished(s)
        // Not approved just now, so not logged as approved again.
        coVerify(exactly = 0) { repo.logActivity(any()) }
    }

    @Test fun `NEGATIVE an old screen sending the same draft twice asks the server twice and sends once`() = runTest(testDispatcher) {
        // The first answer is a send; the server answers every later call `already_sent`.
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } returnsMany listOf(
            Result.success(DraftSendResult("sent", "r***@example.com")),
            Result.success(DraftSendResult("already_sent", "r***@example.com")),
        )
        val first = opened(email)
        first.requestApprove()
        first.approveDraft()
        advanceUntilIdle()
        // A second screen that read the draft before it went, as an installed app would have.
        val second = opened(email)
        second.requestApprove()
        second.approveDraft()
        advanceUntilIdle()
        assertEquals("Already sent", second.uiState.value.sentNotice?.title)
        assertNull(second.uiState.value.successMessage)
        coVerify(exactly = 1) { repo.logActivity(any()) }
    }

    @Test fun `NEGATIVE two taps on the confirm send once`() = runTest(testDispatcher) {
        val answer = CompletableDeferred<Result<DraftSendResult>>()
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } coAnswers { answer.await() }
        val vm = opened(text)
        // A dispatcher that does not run the coroutine until told to: the tap
        // itself has to leave the guard behind, not the coroutine it starts.
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        vm.requestApprove()
        vm.approveDraft()
        assertTrue(vm.uiState.value.isSaving)
        vm.approveDraft()
        advanceUntilIdle()
        answer.complete(Result.success(DraftSendResult("sent", "+1******0001")))
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.sendGeneratedDraft(any(), any(), any(), any()) }
        assertFalse(vm.uiState.value.isSaving)
        assertEquals("Draft approved and sent by text to +1******0001.", vm.uiState.value.successMessage)
    }

    @Test fun `ERROR a call that throws leaves the draft unapproved and stops the spinner`() = runTest(testDispatcher) {
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } throws RuntimeException("This draft was written for a different household.")
        val vm = opened(email)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertFalse(s.isSaving)
        assertNull(s.savedDraftId)
        assertEquals("This draft was written for a different household.", s.error)
        assertNull(s.sentNotice)
    }

    // ── the pure rules ───────────────────────────────────────────────────────

    @Test fun `a draft reads as gone only on what it carries`() {
        assertEquals("email", email.copy(status = "approved").sentMessageChannel)
        assertEquals("sms", text.copy(status = " Approved ").sentMessageChannel)
        assertEquals("email", email.copy(status = "generated", sentAt = "2026-11-20T16:00:00.000Z").sentMessageChannel)
        assertNull(email.sentMessageChannel)
        assertNull(text.copy(status = "pending").sentMessageChannel)
        listOf("push", "visit_report", "social_post", "blog_post", "general", "").forEach {
            assertNull(it, email.copy(communicationType = it, status = "approved").sentMessageChannel)
        }
        assertTrue(push.copy(pushOutcome = "sent").isSentPush)
        assertTrue(push.copy(pushOutcome = "listed").isSentPush)
        // A held Push, and one whose send never answered (#2381), reached nobody.
        assertFalse(push.copy(pushOutcome = "held").isSentPush)
        assertFalse(push.isSentPush)
        assertFalse(email.copy(status = "approved", pushOutcome = "sent").isSentPush)
        assertTrue(email.copy(status = "approved").wentOut)
        assertTrue(push.copy(pushOutcome = "listed").wentOut)
        assertTrue(email.copy(communicationType = "visit_report", publishedReportId = "r1").wentOut)
        assertFalse(email.wentOut)
        assertFalse(push.copy(pushOutcome = "held").wentOut)
    }

    @Test fun `draftFromFields reads the sent stamp`() {
        val d = draftFromFields("gd1", mapOf("communication_type" to "email", "status" to "approved", "sentAt" to " 2026-11-20T16:00:00.000Z "))
        assertEquals("2026-11-20T16:00:00.000Z", d.sentAt)
        assertEquals("email", d.sentMessageChannel)
        assertEquals("", draftFromFields("gd2", mapOf("communication_type" to "email", "sentAt" to null)).sentAt)
    }

    @Test fun `the notice for a sent Email or Text`() {
        assertEquals(
            SentDraftNotice("Already sent", "Sent to Rosa Parks by email on Nov 20, 2026. It is not sent again."),
            sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"), "Rosa Parks", utc),
        )
        assertEquals(
            SentDraftNotice("Already sent", "Sent to the household by text. It is not sent again."),
            sentDraftNotice(text.copy(status = "approved", sentAt = "soon"), " ", utc),
        )
        assertEquals(
            SentDraftNotice("Already approved", "This email for Rosa Parks was approved on Nov 3, 2026. Approving sends it, so it is not sent again."),
            sentDraftNotice(email.copy(status = "approved", approvedAt = "2026-11-03T16:00:00.000Z"), "Rosa Parks", utc),
        )
        assertEquals(
            "This text for Rosa Parks was approved. Approving sends it, so it is not sent again.",
            sentDraftNotice(text.copy(status = "approved", approvedAt = ""), "Rosa Parks", utc)?.body,
        )
        assertNull(sentDraftNotice(email, "Rosa Parks", utc))
        assertNull(sentDraftNotice(push.copy(pushOutcome = "sent"), "Rosa Parks", utc))
    }

    @Test fun `the stored answer of a sent Push, and nothing for any other draft`() {
        assertEquals(HouseholdPushResult("sent", null), sentPushResult(push.copy(pushOutcome = "sent")))
        assertEquals(HouseholdPushResult("listed", "no_device"), sentPushResult(push.copy(pushOutcome = "listed", pushReason = "no_device")))
        assertNull(sentPushResult(push.copy(pushOutcome = "held")))
        assertNull(sentPushResult(push))
        assertNull(sentPushResult(email.copy(status = "approved")))
    }

    @Test fun `only the literal word claims a send`() {
        assertEquals(DraftSendResult("sent", "r***@example.com"), decodeDraftSendResult(mapOf("outcome" to "sent", "recipientRedacted" to "r***@example.com")))
        assertEquals("already_sent", decodeDraftSendResult(mapOf("outcome" to "already_sent")).outcome)
        assertEquals("already_sent", decodeDraftSendResult(mapOf("outcome" to "SENT")).outcome)
        assertEquals("already_sent", decodeDraftSendResult(emptyMap()).outcome)
        assertEquals("already_sent", decodeDraftSendResult(null).outcome)
        assertEquals("", decodeDraftSendResult(null).recipientRedacted)
    }

    @Test fun `the sent line and the needs approval rule`() {
        assertEquals("Draft approved and sent by email to r***@example.com.", draftSentMessage(ExternalChannel.Email, DraftSendResult("sent", "r***@example.com")))
        assertEquals("Draft approved and sent by text.", draftSentMessage(ExternalChannel.Sms, DraftSendResult("sent", "")))
        assertTrue(draftNeedsApproval(sent = false, approved = false))
        assertFalse(draftNeedsApproval(sent = true, approved = false))
        assertFalse(draftNeedsApproval(sent = false, approved = true))
        assertNotNull(alreadySentNotice(""))
        assertEquals("This message already went to the household. Nothing new was sent.", alreadySentNotice(" ").body)
    }

    @Test fun `an unreadable date is left out, never guessed`() {
        assertEquals("Nov 20, 2026", sentDayOf("2026-11-20T16:00:00.000Z", utc))
        assertEquals("", sentDayOf("", utc))
        assertEquals("", sentDayOf(null, utc))
        assertEquals("", sentDayOf("yesterday", utc))
    }
}
