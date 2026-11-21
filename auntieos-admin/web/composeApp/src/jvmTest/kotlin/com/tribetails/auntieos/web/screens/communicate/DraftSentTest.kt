package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2428: a Communicate draft that already went out opened again as needing
 * approval, with Approve and Delete, and approving an Email or Text there sent
 * the household the same message a second time. On the console an Email or
 * Text approve did not switch its own button off either.
 *
 * The screen has no UI test. These pin every rule it reads: which stored
 * drafts are gone, what each says, whether Approve and Delete are offered, and
 * the one send with its order.
 */
class DraftSentTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private val utc = TimeZone.UTC

    private val email = GeneratedDraft(
        _id = "gd1",
        status = "generated",
        communication_type = "email",
        kinfolk_id = "kf1",
        kinfolk_name = "Dana Halbrook",
        generated_copy = "Nova is booked for Friday.",
        generated_title = "Friday",
    )
    private val text = email.copy(communication_type = "", communicationType = "sms", generated_title = "")
    private val push = email.copy(communication_type = "push", generated_title = "", status = "approved")

    // ── which stored drafts already went out ─────────────────────────────────

    @Test
    fun HAPPY_anEmailOrTextReadsAsGoneWhenStampedOrApproved() {
        assertEquals("email", email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").sentMessageChannel)
        assertEquals("sms", text.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z").sentMessageChannel)
        // Approved with no stamp: an older version approved it and sent it straight afterwards.
        assertEquals("email", email.copy(status = "approved").sentMessageChannel)
        assertEquals("sms", text.copy(status = " Approved ").sentMessageChannel)
        // The stamp alone counts, whatever the status reads.
        assertEquals("email", email.copy(sentAt = "2026-11-20T16:00:00.000Z").sentMessageChannel)
    }

    @Test
    fun NEGATIVE_aDraftNobodyApprovedAndEveryOtherTypeHasNotGoneAsAMessage() {
        assertNull(email.sentMessageChannel)
        assertNull(text.copy(status = "pending").sentMessageChannel)
        for (type in listOf("push", "visit_report", "social_post", "blog_post", "general", "")) {
            assertNull(email.copy(communication_type = type, status = "approved").sentMessageChannel, type)
        }
    }

    @Test
    fun HAPPY_aPushOnTheirPhoneOrTheirListIsSent_aHeldOrUnansweredOneIsNot() {
        assertTrue(push.copy(pushOutcome = "sent").isSentPush)
        assertTrue(push.copy(pushOutcome = "listed", pushReason = "no_device").isSentPush)
        assertFalse(push.copy(pushOutcome = "held").isSentPush)
        assertFalse(push.isSentPush)
        assertFalse(email.copy(status = "approved", pushOutcome = "sent").isSentPush)
        // The two lists #2381 files under Drafts are untouched: a sent Push is neither.
        assertFalse(push.copy(pushOutcome = "sent").isHeldPush)
        assertFalse(push.copy(pushOutcome = "listed").isUnansweredPush)
    }

    @Test
    fun wentOutCoversAKinTaleAPushAnEmailAndAText() {
        assertTrue(email.copy(communication_type = "visit_report", publishedReportId = "r1").wentOut)
        assertTrue(push.copy(pushOutcome = "listed").wentOut)
        assertTrue(email.copy(status = "approved").wentOut)
        assertTrue(text.copy(status = "approved").wentOut)
        assertFalse(email.wentOut)
        assertFalse(push.copy(pushOutcome = "held").wentOut)
        assertFalse(email.copy(communication_type = "blog_post", status = "approved").wentOut)
    }

    @Test
    fun theStoredDraftDecodesWithItsSentStamp() {
        val json = Json { ignoreUnknownKeys = true }
        val d = json.decodeFromString(
            GeneratedDraft.serializer(),
            """{"communication_type":"email","status":"approved","sentAt":"2026-11-20T16:00:00.000Z","sentTo":"c***@hanasamku.com","sentChannel":"email"}""",
        )
        assertEquals("2026-11-20T16:00:00.000Z", d.sentAt)
        assertEquals("email", d.sentMessageChannel)
    }

    // ── what an opened one says ──────────────────────────────────────────────

    @Test
    fun HAPPY_aStampedEmailSaysWhoHowAndWhen() {
        assertEquals(
            SentDraftNotice("Already sent", "Sent to Dana Halbrook by email on Nov 20, 2026. It is not sent again."),
            sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"), "Dana Halbrook", utc),
        )
        // The business zone decides the day.
        assertEquals(
            "Sent to Dana Halbrook by email on Nov 19, 2026. It is not sent again.",
            sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T03:00:00.000Z"), "Dana Halbrook", TimeZone.of("America/Chicago"))?.body,
        )
    }

    @Test
    fun SAD_aStampThatCannotBeReadLeavesTheDateOut() {
        assertEquals(
            SentDraftNotice("Already sent", "Sent to the household by text. It is not sent again."),
            sentDraftNotice(text.copy(status = "approved", sentAt = "soon"), " ", utc),
        )
        assertEquals("", sentDayOf(null, utc))
        assertEquals("", sentDayOf("", utc))
        assertEquals("Nov 3, 2026", sentDayOf(" 2026-11-03T16:00:00.000Z ", utc))
    }

    @Test
    fun HAPPY_anApprovedOneWithNoStampSaysApprovedNeverThatADeliveryWasRecorded() {
        assertEquals(
            SentDraftNotice("Already approved", "This email for Dana Halbrook was approved on Nov 3, 2026. Approving sends it, so it is not sent again."),
            sentDraftNotice(email.copy(status = "approved", approvedAt = "2026-11-03T16:00:00.000Z"), "Dana Halbrook", utc),
        )
        assertEquals(
            "This text for Dana Halbrook was approved. Approving sends it, so it is not sent again.",
            sentDraftNotice(text.copy(status = "approved"), "Dana Halbrook", utc)?.body,
        )
    }

    @Test
    fun NEGATIVE_aDraftThatHasNotGoneAndAPushGetNoMessageNotice() {
        assertNull(sentDraftNotice(email, "Dana Halbrook", utc))
        assertNull(sentDraftNotice(push.copy(pushOutcome = "sent"), "Dana Halbrook", utc))
    }

    @Test
    fun HAPPY_aSentPushOpensWithTheServersStoredAnswer() {
        assertEquals(HouseholdPushResult("sent", null), sentPushResult(push.copy(pushOutcome = "sent")))
        assertEquals(HouseholdPushResult("listed", "no_device"), sentPushResult(push.copy(pushOutcome = "listed", pushReason = "no_device")))
        assertNull(sentPushResult(push.copy(pushOutcome = "held")))
        assertNull(sentPushResult(push))
        assertNull(sentPushResult(email.copy(status = "approved")))
        val notice = householdPushNotice(sentPushResult(push.copy(pushOutcome = "listed", pushReason = "household_push_off"))!!, "Dana Halbrook")
        assertEquals("On their notifications list", notice.title)
        assertFalse(notice.retryable)
    }

    // ── neither button ───────────────────────────────────────────────────────

    @Test
    fun NEGATIVE_aDraftThatWentOutHasNoApproveAndNoDelete() {
        val sentEmail = sentDraftNotice(email.copy(status = "approved", sentAt = "2026-11-20T16:00:00.000Z"), "Dana Halbrook", utc)
        val sentPush = householdPushNotice(HouseholdPushResult("sent", null), "Dana Halbrook")
        val listedPush = householdPushNotice(HouseholdPushResult("listed", "no_device"), "Dana Halbrook")

        // An Email or Text that went out.
        assertFalse(mayApprove(sent = false, pushNotice = null, sentNotice = sentEmail))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = sentEmail != null, notice = null))
        assertFalse(draftNeedsApproval(sent = false, approved = sentEmail != null))

        // A Push on their phone, and one only on their list.
        for (notice in listOf(sentPush, listedPush)) {
            assertFalse(mayApprove(sent = false, pushNotice = notice, sentNotice = null))
            assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = notice))
            assertFalse(draftNeedsApproval(sent = false, approved = true))
            // Editing its words does not bring Approve back: the notice stays.
            // Approving one again with new words rewrote the notice they already had.
            assertEquals(notice, pushNoticeAfterEdit(notice, "Old words.", "New words."))
        }

        // A sent KinTale.
        assertFalse(mayApprove(sent = true, pushNotice = null, sentNotice = null))
    }

    @Test
    fun HAPPY_aDraftNobodyApprovedKeepsBothButtons_andAHeldPushKeepsDelete() {
        assertTrue(mayApprove(sent = false, pushNotice = null, sentNotice = null))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = false, notice = null))
        assertTrue(draftNeedsApproval(sent = false, approved = false))
        val held = householdPushNotice(HouseholdPushResult("held", "household_notices_off"), "Dana Halbrook")
        assertFalse(mayApprove(sent = false, pushNotice = held, sentNotice = null))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = held))
    }

    // ── the one send ─────────────────────────────────────────────────────────

    @Test
    fun HAPPY_theCallableGetsTheDraftTheHouseholdAndTheWords_andNoAddress() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "sendGeneratedDraft" to """{"ok":true,"outcome":"sent","channel":"email","recipientRedacted":"c***@hanasamku.com","sentAt":"2026-11-20T16:00:00.000Z"}""",
        )
        val r = FirestoreClient().sendGeneratedDraft(" gd1 ", "kf1", "  Nova is booked for Friday.  ", " Friday ")
        assertTrue(r is WriteResult.Ok)
        assertEquals(DraftSendResult("sent", "c***@hanasamku.com"), decodeDraftSendResult((r as WriteResult.Ok).value))
        assertEquals("sendGeneratedDraft", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals(setOf("draftId", "kinfolkId", "body", "subject"), sent.keys)
        assertEquals("gd1", sent["draftId"]?.jsonPrimitive?.content)
        assertEquals("kf1", sent["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals("Nova is booked for Friday.", sent["body"]?.jsonPrimitive?.content)
        assertEquals("Friday", sent["subject"]?.jsonPrimitive?.content)
    }

    @Test
    fun HAPPY_aTextCarriesNoSubject() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendGeneratedDraft" to """{"ok":true,"outcome":"sent"}""")
        FirestoreClient().sendGeneratedDraft("gd2", "kf1", "See you Friday.", null)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals(setOf("draftId", "kinfolkId", "body"), sent.keys)
    }

    @Test
    fun NEGATIVE_onlyTheLiteralWordClaimsASend() {
        assertEquals("sent", decodeDraftSendResult("""{"outcome":"sent"}""").outcome)
        assertEquals("already_sent", decodeDraftSendResult("""{"outcome":"already_sent","recipientRedacted":"c***@hanasamku.com"}""").outcome)
        assertEquals("already_sent", decodeDraftSendResult("""{"outcome":"SENT"}""").outcome)
        assertEquals("already_sent", decodeDraftSendResult("""{"ok":true}""").outcome)
        assertEquals("already_sent", decodeDraftSendResult("not json").outcome)
        assertEquals("already_sent", decodeDraftSendResult(null).outcome)
        assertEquals("", decodeDraftSendResult(null).recipientRedacted)
    }

    @Test
    fun HAPPY_aSendThatWentOutIsLoggedAfterIt_andTheScreenHoldsASentNotice() = runBlocking {
        val order = mutableListOf<String>()
        val outcome = runDraftSend(
            channel = ExternalChannel.Email,
            household = "Dana Halbrook",
            send = { order += "send"; WriteResult.Ok("""{"outcome":"sent","recipientRedacted":"c***@hanasamku.com"}""") },
            audit = { order += "audit" },
        )
        assertEquals(listOf("send", "audit"), order)
        assertEquals(DraftSendOutcome.Sent(SentDraftNotice("Sent", "Approved and sent by email to c***@hanasamku.com.")), outcome)
        // With that notice held, the same draft has no Approve and no Delete.
        val notice = (outcome as DraftSendOutcome.Sent).notice
        assertFalse(mayApprove(sent = false, pushNotice = null, sentNotice = notice))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = null))
    }

    @Test
    fun NEGATIVE_aDraftThatHadAlreadyGoneIsNotLoggedAgainAndClaimsNoNewSend() = runBlocking {
        var audits = 0
        val outcome = runDraftSend(
            channel = ExternalChannel.Sms,
            household = "Dana Halbrook",
            send = { WriteResult.Ok("""{"outcome":"already_sent","recipientRedacted":""}""") },
            audit = { audits += 1 },
        )
        assertEquals(0, audits)
        assertEquals(
            DraftSendOutcome.AlreadySent(SentDraftNotice("Already sent", "This message already went to Dana Halbrook. Nothing new was sent.")),
            outcome,
        )
    }

    @Test
    fun NEGATIVE_anOldConsoleSendingTheSameDraftTwiceSendsOnce() = runBlocking {
        // The server's answers, in order: the first call sends, every later one is `already_sent`.
        val answers = ArrayDeque(listOf("""{"outcome":"sent","recipientRedacted":"c***@hanasamku.com"}""", """{"outcome":"already_sent"}"""))
        var audits = 0
        val first = runDraftSend(ExternalChannel.Email, "Dana Halbrook", send = { WriteResult.Ok(answers.removeFirst()) }, audit = { audits += 1 })
        val second = runDraftSend(ExternalChannel.Email, "Dana Halbrook", send = { WriteResult.Ok(answers.removeFirst()) }, audit = { audits += 1 })
        assertTrue(first is DraftSendOutcome.Sent)
        assertTrue(second is DraftSendOutcome.AlreadySent)
        assertEquals(1, audits)
    }

    @Test
    fun ERROR_aRefusedSendSaysWhyLogsNothingAndLeavesApproveLive() = runBlocking {
        var audits = 0
        val outcome = runDraftSend(
            channel = ExternalChannel.Email,
            household = "Dana Halbrook",
            send = { WriteResult.Err("Dana Halbrook has no email address on file. Add one in Directory before sending.") },
            audit = { audits += 1 },
        )
        assertEquals(0, audits)
        assertEquals(DraftSendOutcome.Refused("Dana Halbrook has no email address on file. Add one in Directory before sending."), outcome)
        // Nothing is held, so the draft still has Approve and Delete.
        assertTrue(mayApprove(sent = false, pushNotice = null, sentNotice = null))
    }

    @Test
    fun ERROR_aRefusedCallSurfacesTheServersWordsAndNeverReadsAsSent() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("sendGeneratedDraft" to "This draft was written for a different household.")
        val outcome = runDraftSend(
            channel = ExternalChannel.Email,
            household = "Dana Halbrook",
            send = { FirestoreClient().sendGeneratedDraft("gd1", "kf2", "Words.", "Subject") },
            audit = { error("a refused send is never logged as approved") },
        )
        assertEquals(DraftSendOutcome.Refused("This draft was written for a different household."), outcome)
    }

    @Test
    fun theSentLinesNameTheChannelAndNeverARawAddress() {
        assertEquals("Approved and sent by text.", justSentNotice(ExternalChannel.Sms, DraftSendResult("sent", "")).body)
        assertEquals("This message already went to the household. Nothing new was sent.", alreadySentNotice(" ").body)
        assertEquals("This message already went to the household. Nothing new was sent.", alreadySentNotice(null).body)
    }
}
