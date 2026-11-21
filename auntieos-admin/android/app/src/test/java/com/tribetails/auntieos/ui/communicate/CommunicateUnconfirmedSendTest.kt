package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.DRAFT_SEND_LEASE_MS
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.DraftListPlace
import com.tribetails.auntieos.data.model.MessageDraftStanding
import com.tribetails.auntieos.data.model.draftFromFields
import com.tribetails.auntieos.data.model.goneGeneratedDrafts
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import com.tribetails.auntieos.ui.admin.draftRowPillLabel
import com.tribetails.auntieos.ui.admin.draftsInBucket
import com.tribetails.auntieos.ui.admin.unsentGeneratedDrafts
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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * #2452: an Email or Text whose send got no answer reopened as "Already
 * approved ... it is not sent again", which reads as sent. Nothing told it
 * apart from a draft an older version approved and sent, because the two
 * stamps the server writes for it were never read.
 *
 * #2440: a draft that went out was not on the KinTales list at all, and the
 * day in its notice was the phone's day, not the business's.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateUnconfirmedSendTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private val chicago = ZoneId.of("America/Chicago")
    private val now = Instant.parse("2026-11-20T18:00:00.000Z").toEpochMilli()

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

    /** The Email as `sendGeneratedDraft` leaves it when the provider never answered. */
    private val unconfirmed = email.copy(
        status = "approved",
        approvedAt = "2026-11-20T16:00:00.000Z",
        sendClaimedAt = "2026-11-20T16:00:00.000Z",
        sendUnconfirmedAt = "2026-11-20T16:00:31.000Z",
    )
    private val unconfirmedWords =
        "The send of this email to Rosa Parks on Nov 20, 2026 did not get an answer, so it is not known whether it reached them. " +
            "It is not sent again from this draft. Write a new one if it has to go again."

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
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
    private fun assertNeitherButton(s: CommunicateUiState) {
        assertEquals("gd1", s.savedDraftId)
        assertFalse(canDeleteDraft(s.draftId != null, s.publishedReportId != null, s.savedDraftId != null, s.pushNotice))
        assertFalse(draftNeedsApproval(sent = s.publishedReportId != null, approved = s.savedDraftId != null))
    }

    // ── the stamps are read ──────────────────────────────────────────────────

    @Test fun `draftFromFields reads the claim and the unconfirmed mark`() {
        val d = draftFromFields(
            "gd1",
            mapOf(
                "communication_type" to "email", "status" to "approved",
                "sendClaimedAt" to " 2026-11-20T16:00:00.000Z ", "sendUnconfirmedAt" to "2026-11-20T16:00:31.000Z",
            ),
        )
        assertEquals("2026-11-20T16:00:00.000Z", d.sendClaimedAt)
        assertEquals("2026-11-20T16:00:31.000Z", d.sendUnconfirmedAt)
        assertEquals(MessageDraftStanding.Unconfirmed, d.messageStanding(now))
        // A doc with neither reads as it did.
        val old = draftFromFields("gd2", mapOf("communication_type" to "sms", "status" to "approved", "sendClaimedAt" to null))
        assertEquals("", old.sendClaimedAt)
        assertEquals(MessageDraftStanding.Approved, old.messageStanding(now))
    }

    @Test fun `the standing of an Email or Text is read off the stamps`() {
        fun claimedAgo(ms: Long) = text.copy(status = "approved", sendClaimedAt = Instant.ofEpochMilli(now - ms).toString())
        assertEquals(MessageDraftStanding.Sent, email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").messageStanding(now))
        assertEquals(MessageDraftStanding.Approved, email.copy(status = "approved").messageStanding(now))
        assertEquals(MessageDraftStanding.Unconfirmed, unconfirmed.messageStanding(now))
        assertEquals(MessageDraftStanding.Sending, claimedAgo(1_000).messageStanding(now))
        assertEquals(MessageDraftStanding.Sending, claimedAgo(DRAFT_SEND_LEASE_MS - 1).messageStanding(now))
        // A claim left by a call that died, past its two minutes, or unreadable.
        assertEquals(MessageDraftStanding.Unconfirmed, claimedAgo(DRAFT_SEND_LEASE_MS).messageStanding(now))
        assertEquals(MessageDraftStanding.Unconfirmed, text.copy(status = "approved", sendClaimedAt = "not a time").messageStanding(now))
        // The mark wins over a fresh claim, and a stamp wins over both.
        assertEquals(MessageDraftStanding.Unconfirmed, claimedAgo(1_000).copy(sendUnconfirmedAt = "2026-11-20T17:59:59.500Z").messageStanding(now))
        assertEquals(MessageDraftStanding.Sent, unconfirmed.copy(sentAt = "2026-11-20T16:00:40.000Z").messageStanding(now))
        // Nobody approved it, or it is another type.
        assertNull(email.messageStanding(now))
        assertNull(email.copy(sendClaimedAt = "2026-11-20T16:00:00.000Z").messageStanding(now))
        assertNull(unconfirmed.copy(communicationType = "push").messageStanding(now))
    }

    // ── opened again ─────────────────────────────────────────────────────────

    @Test fun `HAPPY an unconfirmed Email opens with its own notice and neither button`() = runTest(testDispatcher) {
        val s = opened(unconfirmed).uiState.value
        assertEquals(SentDraftNotice("Send not confirmed", unconfirmedWords, confirmed = false), s.sentNotice)
        assertNeitherButton(s)
        assertNull(s.error)
    }

    @Test fun `NEGATIVE the unconfirmed notice never reads as approved or sent`() {
        val notice = sentDraftNotice(unconfirmed, "Rosa Parks", chicago, now)!!
        assertFalse(notice.confirmed)
        assertFalse(notice.title, Regex("approved|sent\\b", RegexOption.IGNORE_CASE).containsMatchIn(notice.title))
        assertFalse(notice.body, Regex("Already|was approved|Sent to|already went").containsMatchIn(notice.body))
        assertFalse(notice.body, Regex("[–—]|sentAt|sendClaimedAt|sms").containsMatchIn(notice.body))
        assertEquals(
            "Send not confirmed",
            approveButtonLabel(sent = false, notice = notice, approved = true, sends = true),
        )
    }

    @Test fun `SAD a stale claim with no mark opens the same way, dated by the claim`() = runTest(testDispatcher) {
        val stale = text.copy(status = "approved", sendClaimedAt = "2026-11-01T16:00:00.000Z")
        val s = opened(stale).uiState.value
        assertEquals("Send not confirmed", s.sentNotice?.title)
        assertTrue(s.sentNotice!!.body, s.sentNotice!!.body.startsWith("The send of this text to Rosa Parks on Nov 1, 2026 did not get an answer"))
        assertNeitherButton(s)
    }

    @Test fun `SAD a Text claimed a moment ago opens as being sent`() {
        val running = text.copy(status = "approved", sendClaimedAt = Instant.ofEpochMilli(now - 2_000).toString())
        assertEquals(
            SentDraftNotice(
                "Being sent",
                "This text for Rosa Parks is being sent right now. Open it again in a few minutes to see what happened.",
                confirmed = false,
            ),
            sentDraftNotice(running, "Rosa Parks", chicago, now),
        )
    }

    @Test fun `the sent and the old approved notices are unchanged and still vouch for a send`() {
        val sent = sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"), "Rosa Parks", chicago, now)!!
        assertEquals("Already sent", sent.title)
        assertTrue(sent.confirmed)
        val old = sentDraftNotice(text.copy(status = "approved", approvedAt = "2026-11-03T16:00:00.000Z"), "Rosa Parks", chicago, now)!!
        assertEquals("Already approved", old.title)
        assertTrue(old.confirmed)
        assertEquals("Sent", approveButtonLabel(sent = false, notice = sent, approved = true, sends = true))
        assertEquals("Sent", approveButtonLabel(sent = true, notice = null, approved = false, sends = true))
        assertEquals("Approved", approveButtonLabel(sent = false, notice = null, approved = true, sends = true))
        assertEquals("Approve and send", approveButtonLabel(sent = false, notice = null, approved = false, sends = true))
        assertEquals("Approve draft", approveButtonLabel(sent = false, notice = null, approved = false, sends = false))
    }

    // ── the sitting where it happened ────────────────────────────────────────

    @Test fun `HAPPY the server's unconfirmed refusal puts the notice where Approve and Delete were`() = runTest(testDispatcher) {
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } returns
            Result.failure(DraftSendUnconfirmedException("The send did not get an answer."))
        val vm = opened(email)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertFalse(s.isSaving)
        assertEquals(
            SentDraftNotice(
                "Send not confirmed",
                "The send of this email to Rosa Parks did not get an answer, so it is not known whether it reached them. " +
                    "It is not sent again from this draft. Write a new one if it has to go again.",
                confirmed = false,
            ),
            s.sentNotice,
        )
        assertNull(s.error)
        assertNull(s.successMessage)
        assertNeitherButton(s)
        coVerify(exactly = 0) { repo.deleteGeneratedDraft(any()) }
        coVerify(exactly = 0) { repo.logActivity(any()) }
    }

    @Test fun `NEGATIVE the same words without the code are an ordinary refusal, and Approve stays`() = runTest(testDispatcher) {
        coEvery { repo.sendGeneratedDraft(any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("The send did not get an answer."))
        val vm = opened(email)
        vm.requestApprove()
        vm.approveDraft()
        advanceUntilIdle()
        val s = vm.uiState.value
        assertNull(s.sentNotice)
        assertNull(s.savedDraftId)
        assertEquals("The send did not get an answer.", s.error)
    }

    @Test fun `the refusal is told by its code, never its words`() {
        val cause = RuntimeException("anything at all")
        val mapped = draftSendFailure("draft_send_unconfirmed", cause)
        assertTrue(mapped is DraftSendUnconfirmedException)
        assertSame(cause, mapped.cause)
        assertSame(cause, draftSendFailure("draft_send_in_flight", cause))
        assertSame(cause, draftSendFailure(null, cause))
        assertEquals("draft_send_unconfirmed", DRAFT_SEND_UNCONFIRMED_CODE)
    }

    // ── the date is the business's day (#2440) ───────────────────────────────

    @Test fun `the sent day is read on the business clock, not the phone's`() {
        // 03:30 UTC on Nov 21 is 9:30 PM on Nov 20 in Chicago.
        val late = "2026-11-21T03:30:00.000Z"
        assertEquals("Nov 20, 2026", sentDayOf(late, chicago))
        assertEquals("Nov 21, 2026", sentDayOf(late, ZoneId.of("UTC")))
        assertEquals("Nov 20, 2026", sentDayOf(late, ZoneId.of("Pacific/Honolulu")))
    }

    @Test fun `HAPPY the opened notice uses America Chicago when settings name no zone`() = runTest(testDispatcher) {
        val s = opened(email.copy(status = "approved", sentAt = "2026-11-21T03:30:00.000Z")).uiState.value
        assertEquals("Sent to Rosa Parks by email on Nov 20, 2026. It is not sent again.", s.sentNotice?.body)
    }

    @Test fun `HAPPY the opened notice uses the zone in business settings`() = runTest(testDispatcher) {
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings(timeZone = "UTC"))
        val s = opened(email.copy(status = "approved", sentAt = "2026-11-21T03:30:00.000Z")).uiState.value
        assertEquals("Sent to Rosa Parks by email on Nov 21, 2026. It is not sent again.", s.sentNotice?.body)
    }

    @Test fun `ERROR a failed settings read leaves America Chicago and still opens the draft`() = runTest(testDispatcher) {
        coEvery { repo.getBusinessSettings() } returns Result.failure(RuntimeException("offline"))
        val s = opened(email.copy(status = "approved", sentAt = "2026-11-21T03:30:00.000Z")).uiState.value
        assertEquals("Sent to Rosa Parks by email on Nov 20, 2026. It is not sent again.", s.sentNotice?.body)
        assertNull(s.draftLoadError)
    }

    // ── the KinTales list (#2440) ────────────────────────────────────────────

    private val push = email.copy(communicationType = "push", generatedTitle = "", status = "approved")

    @Test fun `a draft that went out is filed under Sent`() {
        assertEquals(DraftListPlace.Sent, email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").listPlace(now))
        assertEquals(DraftListPlace.Sent, text.copy(status = "approved").listPlace(now))
        assertEquals(DraftListPlace.Sent, push.copy(pushOutcome = "sent").listPlace(now))
        assertEquals(DraftListPlace.Sent, push.copy(pushOutcome = "listed").listPlace(now))
        assertEquals("Sent", draftRowPillLabel(DraftListPlace.Sent))
    }

    @Test fun `an unconfirmed send and a running one are never filed under Sent`() {
        assertEquals(DraftListPlace.Unconfirmed, unconfirmed.listPlace(now))
        assertEquals(
            DraftListPlace.Sending,
            text.copy(status = "approved", sendClaimedAt = Instant.ofEpochMilli(now - 2_000).toString()).listPlace(now),
        )
        assertEquals("Not confirmed", draftRowPillLabel(DraftListPlace.Unconfirmed))
        assertEquals("Sending", draftRowPillLabel(DraftListPlace.Sending))
        assertEquals("Draft", draftRowPillLabel(null))
    }

    @Test fun `every other draft has no place outside Drafts`() {
        assertNull(email.listPlace(now))
        assertNull(push.copy(pushOutcome = "held").listPlace(now))
        assertNull(push.listPlace(now))
        assertNull(email.copy(communicationType = "social_post", status = "approved").listPlace(now))
        // A sent KinTale is listed as its report, never a second time as a draft.
        assertNull(email.copy(communicationType = "visit_report", status = "published", publishedReportId = "r1").listPlace(now))
        assertNull(email.copy(status = "approved", publishedReportId = "r1").listPlace(now))
    }

    @Test fun `the list files each draft in one bucket, and only one`() {
        val pending = email.copy(id = "pending")
        val held = push.copy(id = "held", pushOutcome = "held")
        val sentEmail = email.copy(id = "sentEmail", status = "approved", sentAt = "2026-11-20T16:00:00.000Z", createdOn = "2026-11-19T10:00:00.000Z")
        val oldText = text.copy(id = "oldText", status = "approved", createdOn = "2026-11-17T10:00:00.000Z")
        val sentPush = push.copy(id = "sentPush", pushOutcome = "listed", createdOn = "2026-11-16T10:00:00.000Z")
        val lost = unconfirmed.copy(id = "lost")
        val running = text.copy(id = "running", status = "approved", sendClaimedAt = Instant.ofEpochMilli(now - 2_000).toString())
        val blog = email.copy(id = "blog", communicationType = "blog_post", status = "approved")
        val all = listOf(pending, held, sentEmail, oldText, sentPush, lost, running, blog)

        val unsent = unsentGeneratedDrafts(all)
        val gone = goneGeneratedDrafts(all, now)
        assertEquals(listOf("sentEmail", "lost", "running", "oldText", "sentPush"), gone.map { it.id })

        val failed = draftsInBucket("Failed", unsent, gone, now).map { it.id }
        val drafts = draftsInBucket("Drafts", unsent, gone, now).map { it.id }
        val sent = draftsInBucket("Sent", unsent, gone, now).map { it.id }
        assertEquals(listOf("lost"), failed)
        assertEquals(listOf("pending", "held", "running"), drafts)
        assertEquals(listOf("sentEmail", "oldText", "sentPush"), sent)
        // Nothing twice, and the approved Blog post is still not listed.
        assertEquals((failed + drafts + sent).size, (failed + drafts + sent).toSet().size)
        assertFalse("blog" in failed + drafts + sent)
        assertEquals(emptyList<String>(), draftsInBucket("Other", unsent, gone, now).map { it.id })
    }
}
