package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ExternalSendResult
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
 * #1625: approving a Text or Email draft on Android sends it through
 * `sendExternalMessage`, after a confirm and after the approve write lands, the
 * way the web admin does. Before this, the approve only stamped the draft and
 * the household never got the message.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateApproveSendTest {
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
            GenerateResponse(generatedCopy = "Hi Rosa, Biscuit did great today.", draftId = "d1", kinfolkId = "kf1"),
        )
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    private suspend fun kotlinx.coroutines.test.TestScope.draftFor(type: String, subject: String = "Visit update"): CommunicateViewModel {
        val vm = CommunicateViewModel(repo = repo)
        advanceUntilIdle()
        vm.setCommType(type)
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.setSubject(subject)
        vm.setRawNotes("notes")
        vm.generate()
        advanceUntilIdle()
        return vm
    }

    @Test fun `an Email approve asks first, then approves, then sends to the household`() = runTest(testDispatcher) {
        coEvery { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(ExternalSendResult("email", "pm1", "r***@example.com"))
        val vm = draftFor("email")

        vm.requestApprove()
        assertTrue(vm.uiState.value.approveConfirmOpen)
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
        coVerify(exactly = 0) { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) }

        vm.approveDraft()
        advanceUntilIdle()

        coVerifyOrder {
            repo.approveDraft("d1", "Hi Rosa, Biscuit did great today.", "kf1")
            repo.sendExternalMessage("email", "rosa@example.com", "Visit update", "Hi Rosa, Biscuit did great today.", true, false)
        }
        val s = vm.uiState.value
        assertEquals("d1", s.savedDraftId)
        assertFalse(s.approveConfirmOpen)
        assertNull(s.error)
        assertTrue(s.successMessage!!.contains("sent by email to r***@example.com"))
        // #1592: the toast named the draft by its database id ("Draft #d1").
        assertFalse(s.successMessage!!, s.successMessage!!.contains("d1"))
    }

    @Test fun `a Text approve sends an SMS to the household phone, no subject`() = runTest(testDispatcher) {
        coEvery { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(ExternalSendResult("sms", "SM1", "***0001"))
        val vm = draftFor("sms", subject = "ignored for text")

        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()

        coVerify(exactly = 1) { repo.sendExternalMessage("sms", "555-0001", null, any(), true, false) }
        assertTrue(vm.uiState.value.successMessage!!.contains("sent by text"))
    }

    @Test fun `a refused send keeps the draft approved and says the household did not get it`() = runTest(testDispatcher) {
        coEvery { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("recipient_opted_out"))
        val vm = draftFor("email")

        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()

        val s = vm.uiState.value
        assertEquals("d1", s.savedDraftId)
        assertTrue(s.error!!.startsWith("The draft is approved, but the send failed"))
        assertNull(s.successMessage)
    }

    @Test fun `a failed approve write sends nothing`() = runTest(testDispatcher) {
        coEvery { repo.approveDraft(any(), any(), any()) } returns Result.failure(RuntimeException("PERMISSION_DENIED"))
        val vm = draftFor("email")

        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) }
        assertNull(vm.uiState.value.savedDraftId)
    }

    @Test fun `a KinTale approve takes the #1563 portal path, never an email or text`() = runTest(testDispatcher) {
        coEvery { repo.publishGeneratedDraft(any(), any(), any()) } returns Result.success("r1")
        val vm = draftFor("visit_report")

        vm.requestApprove()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.approveConfirmOpen)
        assertEquals("r1", vm.uiState.value.publishedReportId)
        coVerify(exactly = 1) { repo.publishGeneratedDraft("d1", any(), any()) }
        coVerify(exactly = 0) { repo.sendExternalMessage(any(), any(), any(), any(), any(), any()) }
    }

    @Test fun `an Email approve with no subject is refused before anything is written`() = runTest(testDispatcher) {
        val vm = draftFor("email", subject = "")

        vm.requestApprove()
        advanceUntilIdle()

        assertEquals("Email needs a subject.", vm.uiState.value.error)
        assertFalse(vm.uiState.value.approveConfirmOpen)
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
    }

    @Test fun `cancelling the confirm writes and sends nothing`() = runTest(testDispatcher) {
        val vm = draftFor("sms")
        vm.requestApprove()
        vm.cancelApproveConfirm()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.approveConfirmOpen)
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
    }

    // ── the pure rules ─────────────────────────────────────────────────────

    @Test fun `only email and sms deliver`() {
        assertEquals(ExternalChannel.Email, approveDeliveryChannel("email"))
        assertEquals(ExternalChannel.Sms, approveDeliveryChannel("sms"))
        listOf("visit_report", "blog_post", "social_post", "push", "general").forEach {
            assertNull(it, approveDeliveryChannel(it))
        }
    }

    @Test fun `the blocker names the missing address`() {
        val noEmail = Kinfolk(id = "k", firstName = "Dana", lastName = "Wren", email = "", phoneNumber = "")
        assertEquals(
            "Dana Wren has no email address on file. Add one in Directory before sending.",
            approveSendBlocker(ExternalChannel.Email, noEmail, "Hi", "body"),
        )
        assertEquals(
            "Dana Wren has no phone number on file. Add one in Directory before sending.",
            approveSendBlocker(ExternalChannel.Sms, noEmail, "", "body"),
        )
        assertNull(approveSendBlocker(null, noEmail, "", "body"))
        assertEquals(
            "The message is empty. Write something before approving.",
            approveSendBlocker(null, noEmail, "", "  "),
        )
    }
}
