package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.draftsAwaitingReview
import com.tribetails.auntieos.web.data.kinTaleListDrafts
import kotlinx.coroutines.runBlocking
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
 * #2294: the console had no Push type, so a stored Push draft opened as a
 * KinTale. #2293: a held Push draft could be sent again only while the screen
 * stayed open. These pin the Push chip, the callable, the sentences and the
 * held draft's way back.
 */
class HouseholdPushTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun aPushDraftOpensAsAPushNotAKinTale() {
        assertEquals(MessageType.Push, messageTypeOfDraft("push"))
        assertEquals(MessageType.Push, messageTypeOfDraft(" PUSH "))
        assertEquals(MessageType.Visit, messageTypeOfDraft("social_post"))
        assertTrue(MessageType.Push.needsRecipient)
        assertEquals("for Dana · Push", draftCalloutLine("Dana", "push"))
        // A Push is not an external channel; `sendHouseholdPush` sends it.
        assertNull(approveDeliveryChannel(MessageType.Push))
    }

    @Test
    fun theCallableGetsTheHouseholdTheDraftAndTheApprovedWords() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("sendHouseholdPush" to """{"ok":true,"outcome":"sent","reason":null}""")
        val r = FirestoreClient().sendHouseholdPush("kf1", "gd1", "  Nova says hi.  ")
        assertTrue(r is WriteResult.Ok)
        assertEquals(HouseholdPushResult("sent", null), decodeHouseholdPushResult((r as WriteResult.Ok).value))
        assertEquals("sendHouseholdPush", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("kf1", sent["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals("gd1", sent["draftId"]?.jsonPrimitive?.content)
        assertEquals("Nova says hi.", sent["body"]?.jsonPrimitive?.content)
    }

    @Test
    fun aRefusedSendSurfacesTheServersWordsAndNeverReadsAsSent() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("sendHouseholdPush" to "This draft was written for a different household.")
        val r = FirestoreClient().sendHouseholdPush("kf1", "gd1", "x")
        assertTrue(r is WriteResult.Err)
        val err = r as WriteResult.Err
        val notice = householdPushCallFailed(err.code, err.message)
        // #2381: a failed call may be a send that went out and lost its reply,
        // so it never says what did or did not reach the household.
        assertEquals("Not confirmed", notice.title)
        assertEquals(
            "The draft is approved, but the push was not confirmed: This draft was written for a different household. " +
                "Try again. A push that already went out is not sent twice.",
            notice.body,
        )
        assertFalse(notice.body.contains("Nothing reached"))
        assertTrue(notice.retryable)
    }

    @Test
    fun anAnswerTheConsoleCannotReadIsNeverASend() {
        assertEquals("held", decodeHouseholdPushResult(null).outcome)
        assertEquals("held", decodeHouseholdPushResult("not json").outcome)
        assertEquals("held", decodeHouseholdPushResult("""{"outcome":"bogus"}""").outcome)
        assertEquals(HouseholdPushResult("listed", "no_device"), decodeHouseholdPushResult("""{"outcome":"listed","reason":"no_device"}"""))
    }

    @Test
    fun onlyASentPushSaysItWentOutAndOnlyAHeldOneOffersTryAgain() {
        val sent = householdPushNotice(HouseholdPushResult("sent", null), "Dana")
        assertEquals("Push sent", sent.title)
        assertFalse(sent.retryable)
        val listed = householdPushNotice(HouseholdPushResult("listed", "household_push_off"), "Dana")
        assertTrue(listed.body.contains("their settings keep pushes for your messages off"))
        assertFalse(listed.retryable)
        val held = householdPushNotice(HouseholdPushResult("held", "household_notices_off"), "Dana")
        assertEquals("Not sent", held.title)
        assertTrue(held.body.contains("Switch on \"Send notices to households\""))
        assertTrue(held.retryable)
        assertTrue(householdPushNotice(HouseholdPushResult("held", "notice_turned_off"), "Dana").body.contains("turned off"))
    }

    @Test
    fun aPushApproveNeedsAHouseholdAndAShortEnoughLine() {
        assertEquals("This push is not addressed to a household. Choose one before sending.", pushApproveBlocker(null, "Hi"))
        assertEquals("The message is empty. Write something before approving.", pushApproveBlocker("kf1", "  "))
        assertEquals("A push can be at most 1000 characters. This one is 1001.", pushApproveBlocker("kf1", "a".repeat(1001)))
        assertNull(pushApproveBlocker("kf1", "a".repeat(1000)))
    }

    @Test
    fun aHeldPushDraftIsListedUnderDraftsAgainButNotCountedOnHome() {
        val held = json.decodeFromString(
            GeneratedDraft.serializer(),
            """{"_id":"held","status":"approved","communication_type":"push","kinfolk_id":"kf1",
               "generated_copy":"Hi","pushOutcome":"held","pushReason":"household_notices_off",
               "pushAttemptedAt":"2026-11-17T10:00:00.000Z","createdOn":"2026-11-17T09:00:00.000Z"}""",
        )
        assertTrue(held.isHeldPush)
        assertEquals("household_notices_off", held.pushReason)
        val sent = held.copy(_id = "sent", pushOutcome = "sent")
        val noStamp = held.copy(_id = "nostamp", pushOutcome = "")
        val sms = held.copy(_id = "sms", communication_type = "sms")
        val pending = GeneratedDraft(_id = "pending", status = "generated", generatedCopy = "A note.", communication_type = "push", createdOn = "2026-11-16T00:00:00Z")
        val all = listOf(held, sent, noStamp, sms, pending)
        // #2381: the approved push with no answer on it is listed too.
        assertEquals(listOf("held", "nostamp", "pending"), kinTaleListDrafts(all).map { it._id })
        assertEquals(listOf("pending"), draftsAwaitingReview(all).map { it._id })
    }
    // ── #2381: delete, and a send that never answered ────────────────────────
    @Test
    fun anApprovedPushWhoseSendNeverAnsweredStaysUnderDraftsAndOpensNotConfirmed() {
        // `pushClaimedAt` is the server's claim (#2389); the console reads past it.
        val unanswered = json.decodeFromString(
            GeneratedDraft.serializer(),
            """{"_id":"u1","status":"approved","communication_type":"push","kinfolk_id":"kf1",
               "generatedCopy":"Hi","pushClaimedAt":"2026-11-17T10:00:00.000Z","createdOn":"2026-11-17T09:00:00.000Z"}""",
        )
        assertTrue(unanswered.isUnansweredPush)
        assertFalse(unanswered.isHeldPush)
        assertFalse(unanswered.isUnsent)
        listOf("sent", "listed", "held").forEach { assertFalse(unanswered.copy(pushOutcome = it).isUnansweredPush, it) }
        assertFalse(unanswered.copy(communication_type = "email").isUnansweredPush)
        assertFalse(unanswered.copy(communication_type = "visit_report").isUnansweredPush)
        assertFalse(unanswered.copy(status = "generated").isUnansweredPush)
        val approvedEmail = unanswered.copy(_id = "email", communication_type = "email")
        assertEquals(listOf("u1"), kinTaleListDrafts(listOf(unanswered, approvedEmail)).map { it._id })
        assertEquals(emptyList(), draftsAwaitingReview(listOf(unanswered)).map { it._id })
        val notice = householdPushNotice(HouseholdPushResult(PUSH_UNANSWERED, null), "Dana")
        assertEquals("Not confirmed", notice.title)
        assertEquals(
            "The last send did not answer, so it is not known whether this push reached Dana. " +
                "Try again. A push that already went out is not sent twice.",
            notice.body,
        )
        assertTrue(notice.retryable)
        // Never the server's word.
        assertEquals("held", decodeHouseholdPushResult("""{"outcome":"unanswered"}""").outcome)
    }
    @Test
    fun aPushThatDidNotGoOutKeepsItsDeleteAndOneThatReachedTheHouseholdDoesNot() {
        val held = householdPushNotice(HouseholdPushResult("held", "household_notices_off"), "Dana")
        val unanswered = householdPushNotice(HouseholdPushResult(PUSH_UNANSWERED, null), "Dana")
        val sent = householdPushNotice(HouseholdPushResult("sent", null), "Dana")
        val listed = householdPushNotice(HouseholdPushResult("listed", "no_device"), "Dana")
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = false, notice = null))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = held))
        assertTrue(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = unanswered))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = sent))
        assertFalse(canDeleteDraft(hasDraft = true, sent = false, approved = true, notice = listed))
        assertFalse(canDeleteDraft(hasDraft = true, sent = true, approved = false, notice = null))
        assertFalse(canDeleteDraft(hasDraft = false, sent = false, approved = false, notice = null))
        // The confirm says "not sent" only when that is known.
        assertEquals("It has not been sent. Deleting it cannot be undone.", deleteDraftConfirmLine(null))
        assertEquals("It has not been sent. Deleting it cannot be undone.", deleteDraftConfirmLine(held))
        assertEquals("Deleting it cannot be undone.", deleteDraftConfirmLine(unanswered))
    }
    @Test
    fun deletingAHeldPushDraftGoesThroughTheOwnerOnlyCallable() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("deleteGeneratedDraft" to """{"ok":true,"draftId":"gd1"}""")
        val r = FirestoreClient().deleteGeneratedDraft(" gd1 ")
        assertTrue(r is WriteResult.Ok)
        assertEquals("deleteGeneratedDraft", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("gd1", sent["draftId"]?.jsonPrimitive?.content)
    }
    @Test
    fun aRefusedDeleteSurfacesTheServersWords() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("deleteGeneratedDraft" to "This draft no longer exists. It may already have been deleted.")
        val r = FirestoreClient().deleteGeneratedDraft("gd1")
        assertTrue(r is WriteResult.Err)
        assertEquals("This draft no longer exists. It may already have been deleted.", (r as WriteResult.Err).message)
    }
    // ── #2389: the approved words, one push per draft ────────────────────────
    @Test
    fun editingAPushThatDidNotGoOutReturnsItToUnapprovedAndNothingElseDoes() {
        assertTrue(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("held", "notice_turned_off"), "Dana")))
        assertTrue(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult(PUSH_UNANSWERED, null), "Dana")))
        assertTrue(editReturnsToUnapproved(householdPushCallFailed(null, "timeout")))
        assertFalse(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("sent", null), "Dana")))
        assertFalse(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("already_sent", null), "Dana")))
        assertFalse(editReturnsToUnapproved(householdPushNotice(HouseholdPushResult("listed", "no_device"), "Dana")))
        assertFalse(editReturnsToUnapproved(null))
    }
    @Test
    fun theScreenDropsAHeldNoticeOnARealEditAndKeepsItOtherwise() {
        val held = householdPushNotice(HouseholdPushResult("held", "notice_turned_off"), "Dana")
        val sent = householdPushNotice(HouseholdPushResult("sent", null), "Dana")
        // An edit: back to unapproved, so the Approve button is live and Try again is gone.
        assertNull(pushNoticeAfterEdit(held, "Hi", "Hi there"))
        // The same words set again (a fresh result landing) is not an edit.
        assertEquals(held, pushNoticeAfterEdit(held, "Hi", "Hi"))
        // A push that went out stays as it is, whatever is typed.
        assertEquals(sent, pushNoticeAfterEdit(sent, "Hi", "Hi there"))
        assertNull(pushNoticeAfterEdit(null, "Hi", "Hi there"))
    }
    @Test
    fun anAnswerThatRefusesTheWordsLeavesNoNoticeAndEveryOtherAnswerIsShown() {
        assertNull(pushNoticeAfterAnswer(householdPushCallFailed(PUSH_WORDS_CHANGED_CODE, null)))
        val busy = householdPushCallFailed(PUSH_IN_FLIGHT_CODE, null)
        assertEquals(busy, pushNoticeAfterAnswer(busy))
        val sent = householdPushNotice(HouseholdPushResult("sent", null), "Dana")
        assertEquals(sent, pushNoticeAfterAnswer(sent))
    }
    @Test
    fun aPushAnotherScreenIsSendingComesBackWithItsCodeAndSaysToWait() = runBlocking {
        val message = "This push is being sent right now. Wait a moment, then try again."
        JvmFirestoreFixtures.callableErrors = mapOf("sendHouseholdPush" to message)
        JvmFirestoreFixtures.callableErrorCodes = mapOf("sendHouseholdPush" to PUSH_IN_FLIGHT_CODE)
        val err = FirestoreClient().sendHouseholdPush("kf1", "gd1", "x") as WriteResult.Err
        assertEquals(HouseholdPushNotice("Sending now", message, retryable = true), householdPushCallFailed(err.code, err.message))
    }
    @Test
    fun wordsEditedAfterApprovalComeBackWithTheirCodeAndSendTheDraftBackToUnapproved() = runBlocking {
        val message = "The words changed after this draft was approved. Approve it again to send them."
        JvmFirestoreFixtures.callableErrors = mapOf("sendHouseholdPush" to message)
        JvmFirestoreFixtures.callableErrorCodes = mapOf("sendHouseholdPush" to PUSH_WORDS_CHANGED_CODE)
        val err = FirestoreClient().sendHouseholdPush("kf1", "gd1", "x") as WriteResult.Err
        val notice = householdPushCallFailed(err.code, err.message)
        assertTrue(notice.needsApproval)
        assertEquals(message, notice.body)
    }
    @Test
    fun theServersTwoRefusalsAreReadByTheirCodeAndAnythingElseIsNotConfirmed() {
        val words = householdPushCallFailed(PUSH_WORDS_CHANGED_CODE, "The words changed after this draft was approved. Approve it again to send them.")
        assertTrue(words.needsApproval)
        assertFalse(words.retryable)
        assertEquals("The words changed after this draft was approved. Approve it again to send them.", words.body)
        val busy = householdPushCallFailed(PUSH_IN_FLIGHT_CODE, "This push is being sent right now. Wait a moment, then try again.")
        assertEquals("Sending now", busy.title)
        assertTrue(busy.retryable)
        assertFalse(busy.needsApproval)
        val silent = householdPushCallFailed(null, null)
        assertEquals(
            "The draft is approved, but the push was not confirmed: the server did not answer. " +
                "Try again. A push that already went out is not sent twice.",
            silent.body,
        )
        assertTrue(silent.retryable)
        listOf(words, busy, silent).forEach { assertFalse(it.body.contains("Nothing reached") || it.body.startsWith("Sent"), it.body) }
    }
}
