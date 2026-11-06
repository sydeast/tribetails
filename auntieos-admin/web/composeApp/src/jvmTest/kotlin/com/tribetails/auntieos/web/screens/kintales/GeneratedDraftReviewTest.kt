package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.draftsAwaitingReview
import com.tribetails.auntieos.web.screens.communicate.MessageType
import com.tribetails.auntieos.web.screens.communicate.messageTypeOfDraft
import com.tribetails.auntieos.web.screens.communicate.sentNoteFor
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
 * #1563: on the desktop console a stored KinTale draft was listed on Home and
 * nowhere else, its row did nothing, "Review & send tales" opened a blank
 * Communicate, approving a KinTale reached nobody, and a draft `generate.js`
 * wrote decoded with no household and no copy. These pin the data half of the
 * fix: both spellings, which drafts are waiting, and the two callables.
 */
class GeneratedDraftReviewTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun readsTheSnakeCaseSpellingGenerateJsWrites() {
        val d = json.decodeFromString(
            GeneratedDraft.serializer(),
            """{"_id":"gd2","status":"generated","communication_type":"visit_report","kinfolk_id":"kf2",
               "kinfolk_name":"Olivia","generated_copy":"Mochi napped.","generated_title":"A sunny nap",
               "generated_at":"2026-05-23T22:47:00.000Z"}""",
        )
        assertEquals("kf2", d.householdId())
        assertEquals("Olivia", d.household())
        assertEquals("Mochi napped.", d.body())
        assertEquals("A sunny nap", d.title())
        assertEquals("2026-05-23T22:47:00.000Z", d.created())
        assertTrue(d.isUnsent)
    }

    @Test
    fun camelCaseStillWinsWhereBothArePresent() {
        val d = GeneratedDraft(_id = "a", kinfolkName = "Robyn", kinfolk_name = "Other", generatedCopy = "x", generated_copy = "y")
        assertEquals("Robyn", d.household())
        assertEquals("x", d.body())
    }

    @Test
    fun onlyUnsentDraftsAwaitReviewNewestFirst() {
        val drafts = listOf(
            GeneratedDraft(_id = "old", status = "pending", createdOn = "2026-05-01T00:00:00Z"),
            GeneratedDraft(_id = "sent", status = "published", publishedReportId = "r1", createdOn = "2026-05-30T00:00:00Z"),
            GeneratedDraft(_id = "approved", status = "approved", createdOn = "2026-05-29T00:00:00Z"),
            GeneratedDraft(_id = "new", status = "generated", generated_at = "2026-05-23T00:00:00Z"),
        )
        assertEquals(listOf("new", "old"), draftsAwaitingReview(drafts).map { it._id })
    }

    @Test
    fun draftRowTextAndSearch() {
        val d = GeneratedDraft(_id = "a", kinfolkName = "Robyn", communicationType = "visit_report",
            generatedCopy = "Biscuit ran", createdOn = "2026-05-23T22:23:00.000Z")
        assertEquals("visit report · May 23 · 22:23", draftSubmeta(d))
        assertTrue(matchesDraftSearch(d, "robyn"))
        assertTrue(matchesDraftSearch(d, "biscuit"))
        assertFalse(matchesDraftSearch(d, "olivia"))
    }

    @Test
    fun aDraftOpensOnTheChipItsTypeNames() {
        assertEquals(MessageType.Visit, messageTypeOfDraft("visit_report"))
        assertEquals(MessageType.Visit, messageTypeOfDraft(""))
        assertEquals(MessageType.Text, messageTypeOfDraft("sms"))
        assertEquals(MessageType.Email, messageTypeOfDraft("email"))
        assertEquals(MessageType.Blog, messageTypeOfDraft("blog_post"))
    }

    @Test
    fun anAlreadySentDraftSaysSo() {
        assertEquals("This KinTale was already sent to Robyn.", sentNoteFor(true, "r1", "Robyn"))
        assertNull(sentNoteFor(false, "r1", "Robyn"))
        assertNull(sentNoteFor(true, null, "Robyn"))
    }

    @Test
    fun publishSendsTheBareIdAndTheEditedCopyAndReturnsTheReport() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "publishGeneratedDraft" to """{"ok":true,"reportId":"r9","alreadyPublished":false}""",
        )
        val r = FirestoreClient().publishGeneratedDraft("gd1", "Edited copy.", "Leaf patrol")
        assertEquals(WriteResult.Ok("r9"), r)
        assertEquals("publishGeneratedDraft", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("gd1", sent["draftId"]?.jsonPrimitive?.content)
        assertEquals("Edited copy.", sent["bodyCopy"]?.jsonPrimitive?.content)
        assertEquals("Leaf patrol", sent["title"]?.jsonPrimitive?.content)
    }

    @Test
    fun aBlankTitleIsLeftOut() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("publishGeneratedDraft" to """{"reportId":"r9"}""")
        FirestoreClient().publishGeneratedDraft("gd1", "x", "  ")
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertFalse("title" in sent)
    }

    @Test
    fun aReplyWithNoReportIdFailsLoud() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("publishGeneratedDraft" to """{"ok":true}""")
        assertTrue(FirestoreClient().publishGeneratedDraft("gd1", "x", "") is WriteResult.Err)
    }

    @Test
    fun aRefusedSendSurfacesTheServersWords() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf(
            "publishGeneratedDraft" to "The household this draft is addressed to no longer exists.",
        )
        val r = FirestoreClient().publishGeneratedDraft("gd1", "x", "")
        assertTrue(r is WriteResult.Err)
        assertTrue((r as WriteResult.Err).message.contains("no longer exists"))
    }

    @Test
    fun deleteCallsTheCallableWithTheDraftId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("deleteGeneratedDraft" to """{"ok":true,"draftId":"gd1"}""")
        assertEquals(WriteResult.Ok(Unit), FirestoreClient().deleteGeneratedDraft("gd1"))
        assertEquals("deleteGeneratedDraft", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("gd1", sent["draftId"]?.jsonPrimitive?.content)
    }
}
