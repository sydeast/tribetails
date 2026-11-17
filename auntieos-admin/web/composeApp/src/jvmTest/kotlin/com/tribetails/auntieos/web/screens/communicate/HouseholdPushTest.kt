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
        val notice = householdPushCallFailed((r as WriteResult.Err).message, "Dana")
        assertEquals("Not sent", notice.title)
        assertTrue(notice.body.contains("different household"))
        assertTrue(notice.body.endsWith("Nothing reached Dana."))
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
        val pending = GeneratedDraft(_id = "pending", status = "generated", communication_type = "push", createdOn = "2026-11-16T00:00:00Z")
        val all = listOf(held, sent, noStamp, sms, pending)
        assertEquals(listOf("held", "pending"), kinTaleListDrafts(all).map { it._id })
        assertEquals(listOf("pending"), draftsAwaitingReview(all).map { it._id })
    }
}
