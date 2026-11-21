package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.DRAFT_SEND_LEASE_MS
import com.tribetails.auntieos.web.data.DraftListPlace
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.MessageDraftStanding
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.kinTaleDraftPillLabel
import com.tribetails.auntieos.web.data.kinTaleDraftsInBucket
import com.tribetails.auntieos.web.data.kinTaleGoneDrafts
import com.tribetails.auntieos.web.data.kinTaleListDrafts
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * #2452: an Email or Text whose send got no answer reopened as "Already
 * approved ... it is not sent again", which reads as sent, and on the console
 * the server's own sentence was a toast that was gone in a few seconds. The
 * two stamps the server writes for that draft were never read.
 *
 * #2440: a draft that went out was not on the KinTales list at all.
 */
@OptIn(ExperimentalTime::class)
class DraftUnconfirmedTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private val chicago = TimeZone.of("America/Chicago")
    private val now = Instant.parse("2026-11-20T18:00:00.000Z").toEpochMilliseconds()
    private fun ago(ms: Long): String = Instant.fromEpochMilliseconds(now - ms).toString()

    private val email = GeneratedDraft(
        _id = "gd1",
        status = "generated",
        communication_type = "email",
        kinfolk_id = "kf1",
        kinfolk_name = "Dana Halbrook",
        generated_copy = "Nova is booked for Friday.",
        generated_title = "Friday",
        createdOn = "2026-11-18T10:00:00.000Z",
    )
    private val text = email.copy(communication_type = "", communicationType = "sms", generated_title = "")
    private val push = email.copy(communication_type = "push", generated_title = "", status = "approved")

    /** The Email as `sendGeneratedDraft` leaves it when the provider never answered. */
    private val unconfirmed = email.copy(
        status = "approved",
        approvedAt = "2026-11-20T16:00:00.000Z",
        sendClaimedAt = "2026-11-20T16:00:00.000Z",
        sendUnconfirmedAt = "2026-11-20T16:00:31.000Z",
    )

    // ── the stamps are read ──────────────────────────────────────────────────

    @Test
    fun theStoredDraftDecodesWithItsClaimAndItsUnconfirmedMark() {
        val json = Json { ignoreUnknownKeys = true }
        val d = json.decodeFromString(
            GeneratedDraft.serializer(),
            """{"communication_type":"email","status":"approved","approvedAt":"2026-11-20T16:00:00.000Z",""" +
                """"sendClaimedAt":"2026-11-20T16:00:00.000Z","sendUnconfirmedAt":"2026-11-20T16:00:31.000Z"}""",
        )
        assertEquals("2026-11-20T16:00:00.000Z", d.sendClaimedAt)
        assertEquals("2026-11-20T16:00:31.000Z", d.sendUnconfirmedAt)
        assertEquals(MessageDraftStanding.Unconfirmed, d.messageStanding(now))
        // A doc with neither reads as it did.
        val old = json.decodeFromString(GeneratedDraft.serializer(), """{"communicationType":"sms","status":"approved"}""")
        assertEquals("", old.sendClaimedAt)
        assertEquals(MessageDraftStanding.Approved, old.messageStanding(now))
    }

    @Test
    fun theStandingOfAnEmailOrTextIsReadOffTheStamps() {
        fun claimed(agoMs: Long) = text.copy(status = "approved", sendClaimedAt = ago(agoMs))
        assertEquals(MessageDraftStanding.Sent, email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").messageStanding(now))
        assertEquals(MessageDraftStanding.Approved, email.copy(status = "approved").messageStanding(now))
        assertEquals(MessageDraftStanding.Unconfirmed, unconfirmed.messageStanding(now))
        assertEquals(MessageDraftStanding.Sending, claimed(1_000).messageStanding(now))
        assertEquals(MessageDraftStanding.Sending, claimed(DRAFT_SEND_LEASE_MS - 1).messageStanding(now))
        // A claim left by a call that died, past its two minutes, or unreadable.
        assertEquals(MessageDraftStanding.Unconfirmed, claimed(DRAFT_SEND_LEASE_MS).messageStanding(now))
        assertEquals(MessageDraftStanding.Unconfirmed, text.copy(status = "approved", sendClaimedAt = "not a time").messageStanding(now))
        // The mark wins over a fresh claim, and a stamp wins over both.
        assertEquals(MessageDraftStanding.Unconfirmed, claimed(1_000).copy(sendUnconfirmedAt = ago(500)).messageStanding(now))
        assertEquals(MessageDraftStanding.Sent, unconfirmed.copy(sentAt = "2026-11-20T16:00:40.000Z").messageStanding(now))
        // Nobody approved it, or it is another type.
        assertNull(email.messageStanding(now))
        assertNull(email.copy(sendClaimedAt = "2026-11-20T16:00:00.000Z").messageStanding(now))
        assertNull(unconfirmed.copy(communication_type = "push").messageStanding(now))
    }

    // ── opened again ─────────────────────────────────────────────────────────

    @Test
    fun HAPPY_anUnconfirmedEmailOpensWithItsOwnNoticeAndNeitherButton() {
        val notice = sentDraftNotice(unconfirmed, "Dana Halbrook", chicago, now)
        assertEquals(
            SentDraftNotice(
                "Send not confirmed",
                "The send of this email to Dana Halbrook on Nov 20, 2026 did not get an answer, so it is not known whether it reached them. " +
                    "It is not sent again from this draft. Write a new one if it has to go again.",
                confirmed = false,
            ),
            notice,
        )
        // Approve is off and Delete is not offered while the notice is held.
        assertFalse(mayApprove(sent = false, pushNotice = null, sentNotice = notice))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = notice != null, notice = null))
        assertFalse(draftNeedsApproval(sent = false, approved = notice != null))
    }

    @Test
    fun NEGATIVE_theUnconfirmedNoticeNeverReadsAsApprovedOrSent() {
        val notice = sentDraftNotice(unconfirmed, "Dana Halbrook", chicago, now)!!
        assertFalse(Regex("approved|sent\\b", RegexOption.IGNORE_CASE).containsMatchIn(notice.title), notice.title)
        assertFalse(Regex("Already|was approved|Sent to|already went").containsMatchIn(notice.body), notice.body)
        assertFalse(Regex("[–—]|sentAt|sendClaimedAt|sms").containsMatchIn(notice.body), notice.body)
        // The button stops saying "Sent" about it.
        assertEquals("Send not confirmed", approveButtonLabel(sent = false, notice = notice, approved = false, sends = true))
    }

    @Test
    fun SAD_aStaleClaimWithNoMarkOpensTheSameWay_datedByTheClaim() {
        val stale = text.copy(status = "approved", sendClaimedAt = "2026-11-01T16:00:00.000Z")
        val notice = sentDraftNotice(stale, " ", chicago, now)!!
        assertEquals("Send not confirmed", notice.title)
        assertTrue(notice.body.startsWith("The send of this text to the household on Nov 1, 2026 did not get an answer"), notice.body)
    }

    @Test
    fun SAD_aTextClaimedAMomentAgoOpensAsBeingSent() {
        val running = text.copy(status = "approved", sendClaimedAt = ago(2_000))
        assertEquals(
            SentDraftNotice(
                "Being sent",
                "This text for Dana Halbrook is being sent right now. Open it again in a few minutes to see what happened.",
                confirmed = false,
            ),
            sentDraftNotice(running, "Dana Halbrook", chicago, now),
        )
    }

    @Test
    fun theSentAndTheOldApprovedNoticesStillVouchForASend() {
        val sent = sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"), "Dana Halbrook", chicago, now)!!
        assertEquals("Already sent", sent.title)
        assertTrue(sent.confirmed)
        val old = sentDraftNotice(text.copy(status = "approved", approvedAt = "2026-11-03T16:00:00.000Z"), "Dana Halbrook", chicago, now)!!
        assertEquals("Already approved", old.title)
        assertTrue(old.confirmed)
        assertEquals("Sent", approveButtonLabel(sent = false, notice = sent, approved = false, sends = true))
        assertEquals("Sent", approveButtonLabel(sent = true, notice = null, approved = false, sends = true))
        assertEquals("Approved", approveButtonLabel(sent = false, notice = null, approved = true, sends = true))
        assertEquals("Approve and send", approveButtonLabel(sent = false, notice = null, approved = false, sends = true))
        assertEquals("Approve draft", approveButtonLabel(sent = false, notice = null, approved = false, sends = false))
    }

    // ── the sitting where it happened ────────────────────────────────────────

    @Test
    fun HAPPY_theServersUnconfirmedRefusalIsHeldOnTheScreen_notAToast() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("sendGeneratedDraft" to "The send did not get an answer.")
        JvmFirestoreFixtures.callableErrorCodes = mapOf("sendGeneratedDraft" to "draft_send_unconfirmed")
        val outcome = runDraftSend(
            channel = ExternalChannel.Email,
            household = "Dana Halbrook",
            send = { FirestoreClient().sendGeneratedDraft("gd1", "kf1", "Words.", "Subject") },
            audit = { error("an unconfirmed send is never logged as approved") },
        )
        val expected = SentDraftNotice(
            "Send not confirmed",
            "The send of this email to Dana Halbrook did not get an answer, so it is not known whether it reached them. " +
                "It is not sent again from this draft. Write a new one if it has to go again.",
            confirmed = false,
        )
        assertEquals(DraftSendOutcome.Unconfirmed(expected), outcome)
        // The screen holds that notice, which takes Approve and Delete away.
        assertFalse(mayApprove(sent = false, pushNotice = null, sentNotice = expected))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = null))
    }

    @Test
    fun NEGATIVE_theSameWordsWithoutTheCodeAreAnOrdinaryRefusal() = runBlocking {
        val outcome = runDraftSend(
            channel = ExternalChannel.Sms,
            household = "Dana Halbrook",
            send = { WriteResult.Err("The send did not get an answer.") },
            audit = { error("a refused send is never logged as approved") },
        )
        assertEquals(DraftSendOutcome.Refused("The send did not get an answer."), outcome)
    }

    @Test
    fun NEGATIVE_aSendStillRunningIsNotCalledUnconfirmed() = runBlocking {
        val outcome = runDraftSend(
            channel = ExternalChannel.Sms,
            household = "Dana Halbrook",
            send = { WriteResult.Err("This message is being sent right now.", "draft_send_in_flight") },
            audit = { error("a refused send is never logged as approved") },
        )
        assertEquals(DraftSendOutcome.Refused("This message is being sent right now."), outcome)
    }

    @Test
    fun theUnconfirmedNoticeNamesATextAndFallsBackToTheHousehold() {
        assertTrue(unconfirmedSendNotice(null, "sms").body.startsWith("The send of this text to the household did not get an answer"))
        assertTrue(unconfirmedSendNotice(" ", null).body.startsWith("The send of this message to the household did not get an answer"))
    }

    // ── the date is the business's day (#2440) ───────────────────────────────

    @Test
    fun theSentDayIsReadOnTheBusinessClock() {
        // 03:30 UTC on Nov 21 is 9:30 PM on Nov 20 in Chicago.
        val late = "2026-11-21T03:30:00.000Z"
        assertEquals("Nov 20, 2026", sentDayOf(late, chicago))
        assertEquals("Nov 21, 2026", sentDayOf(late, TimeZone.UTC))
        assertEquals(
            "Sent to Dana Halbrook by email on Nov 20, 2026. It is not sent again.",
            sentDraftNotice(email.copy(status = "approved", sentAt = late), "Dana Halbrook", chicago, now)?.body,
        )
        assertEquals(
            "Sent to Dana Halbrook by email on Nov 21, 2026. It is not sent again.",
            sentDraftNotice(email.copy(status = "approved", sentAt = late), "Dana Halbrook", TimeZone.UTC, now)?.body,
        )
    }

    // ── the KinTales list (#2440) ────────────────────────────────────────────

    @Test
    fun aDraftThatWentOutIsFiledUnderSent() {
        assertEquals(DraftListPlace.Sent, email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").listPlace(now))
        assertEquals(DraftListPlace.Sent, text.copy(status = "approved").listPlace(now))
        assertEquals(DraftListPlace.Sent, push.copy(pushOutcome = "sent").listPlace(now))
        assertEquals(DraftListPlace.Sent, push.copy(pushOutcome = "listed").listPlace(now))
        assertEquals("Sent", kinTaleDraftPillLabel(DraftListPlace.Sent))
    }

    @Test
    fun anUnconfirmedSendAndARunningOneAreNeverFiledUnderSent() {
        assertEquals(DraftListPlace.Unconfirmed, unconfirmed.listPlace(now))
        assertEquals(DraftListPlace.Sending, text.copy(status = "approved", sendClaimedAt = ago(2_000)).listPlace(now))
        assertEquals("Not confirmed", kinTaleDraftPillLabel(DraftListPlace.Unconfirmed))
        assertEquals("Sending", kinTaleDraftPillLabel(DraftListPlace.Sending))
        assertEquals("Draft", kinTaleDraftPillLabel(null))
    }

    @Test
    fun everyOtherDraftHasNoPlaceOutsideDrafts() {
        assertNull(email.listPlace(now))
        assertNull(push.copy(pushOutcome = "held").listPlace(now))
        assertNull(push.listPlace(now))
        assertNull(email.copy(communication_type = "social_post", status = "approved").listPlace(now))
        // A sent KinTale is listed as its report, never a second time as a draft.
        assertNull(email.copy(communication_type = "visit_report", status = "published", publishedReportId = "r1").listPlace(now))
        assertNull(email.copy(status = "approved", publishedReportId = "r1").listPlace(now))
    }

    @Test
    fun theListFilesEachDraftInOneBucketAndOnlyOne() {
        val pending = email.copy(_id = "pending")
        val held = push.copy(_id = "held", pushOutcome = "held")
        val sentEmail = email.copy(_id = "sentEmail", status = "approved", sentAt = "2026-11-20T16:00:00.000Z", createdOn = "2026-11-19T10:00:00.000Z")
        val oldText = text.copy(_id = "oldText", status = "approved", createdOn = "2026-11-17T10:00:00.000Z")
        val sentPush = push.copy(_id = "sentPush", pushOutcome = "listed", createdOn = "2026-11-16T10:00:00.000Z")
        val lost = unconfirmed.copy(_id = "lost")
        val running = text.copy(_id = "running", status = "approved", sendClaimedAt = ago(2_000))
        val blog = email.copy(_id = "blog", communication_type = "blog_post", status = "approved")
        val all = listOf(pending, held, sentEmail, oldText, sentPush, lost, running, blog)

        val unsent = kinTaleListDrafts(all)
        val gone = kinTaleGoneDrafts(all, now)
        assertEquals(listOf("sentEmail", "lost", "running", "oldText", "sentPush"), gone.map { it._id })

        val failed = kinTaleDraftsInBucket("Failed", unsent, gone, now).map { it._id }
        val drafts = kinTaleDraftsInBucket("Drafts", unsent, gone, now).map { it._id }
        val sent = kinTaleDraftsInBucket("Sent", unsent, gone, now).map { it._id }
        assertEquals(listOf("lost"), failed)
        assertEquals(listOf("pending", "held", "running"), drafts)
        assertEquals(listOf("sentEmail", "oldText", "sentPush"), sent)
        // Nothing twice, and the approved Blog post is still not listed.
        assertEquals((failed + drafts + sent).size, (failed + drafts + sent).toSet().size)
        assertFalse("blog" in failed + drafts + sent)
        assertEquals(emptyList(), kinTaleDraftsInBucket("Other", unsent, gone, now).map { it._id })
    }
}
