package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2204 / #2205 on the desktop console: tags change one named tag at a time.
 * `changeBusinessTags` is sent the named changes (never a list), and its answer,
 * both lists as stored, is what the screens show next. A delete is the #713
 * cascade through `removeBusinessTag`.
 */
class ChangeBusinessTagsCallableTest {

    private val client = FirestoreClient()
    private val teal = TagColor("teal", "var(--color-accent)")

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun sent(name: String) =
        Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.last { it.first == name }.second).jsonObject

    @Test
    fun anAddFromAProfileSendsTheOneNameAndNeverAList() {
        JvmFirestoreFixtures.callableResponses = mapOf(
            CHANGE_BUSINESS_TAGS_CALLABLE to
                """{"ok":true,"householdTags":[{"name":"VIP","color":{"token":"teal","css":"var(--color-accent)"},"icon":""},""" +
                """{"name":"Gate code","color":{"token":"teal","css":"var(--color-accent)"},"icon":""}],"petTags":[],"updatedAt":"x","updatedBy":"y"}""",
        )
        val r = runBlocking { client.addTagToVocabulary("household", "  Gate   code ") }

        val payload = sent(CHANGE_BUSINESS_TAGS_CALLABLE)
        assertEquals(setOf("changes"), payload.keys, "the request is { changes } and nothing else")
        val change = payload.getValue("changes").jsonArray.single().jsonObject
        assertEquals(JsonPrimitive("add"), change["action"])
        assertEquals(JsonPrimitive("household"), change["scope"])
        assertEquals(JsonPrimitive("Gate code"), change["name"])
        assertEquals(JsonPrimitive("teal"), change.getValue("color").jsonObject["token"])
        assertEquals(JsonPrimitive(""), change["icon"])
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == SAVE_BUSINESS_SETTINGS_CALLABLE })

        // The answer is the list as stored, a tag added elsewhere included.
        val ok = r as WriteResult.Ok
        assertEquals(listOf("VIP", "Gate code"), ok.value.household.map { it.name })
        assertEquals(emptyList(), ok.value.pet)
    }

    @Test
    fun aSaveSendsEveryNamedChangeInOneCall() {
        JvmFirestoreFixtures.callableResponses = mapOf(CHANGE_BUSINESS_TAGS_CALLABLE to """{"householdTags":[],"petTags":[]}""")
        val changes = listOf(
            TagChange(TagChange.ADD, "household", "Slow pay", teal, ""),
            TagChange(TagChange.STYLE, "pet", "Reactive", TagColor("coral", "var(--color-coral)"), "⚠️"),
        )
        runBlocking { client.changeBusinessTags(changes) }
        val rows = sent(CHANGE_BUSINESS_TAGS_CALLABLE).getValue("changes").jsonArray
        assertEquals(listOf("add", "style"), rows.map { it.jsonObject.getValue("action").jsonPrimitive.content })
        assertEquals(listOf("household", "pet"), rows.map { it.jsonObject.getValue("scope").jsonPrimitive.content })
    }

    @Test
    fun aRefusalComesBackAsTheServersSentence() {
        JvmFirestoreFixtures.callableErrors = mapOf(CHANGE_BUSINESS_TAGS_CALLABLE to "A \"VIP\" tag already exists.")
        val r = runBlocking { client.addTagToVocabulary("household", "vip") }
        assertEquals("A \"VIP\" tag already exists.", (r as WriteResult.Err).message)
    }

    @Test
    fun anAnswerWithoutTheListsSaysSoInPlainWords() {
        JvmFirestoreFixtures.callableResponses = mapOf(CHANGE_BUSINESS_TAGS_CALLABLE to """{"ok":true}""")
        val r = runBlocking { client.addTagToVocabulary("household", "Gate code") }
        val message = (r as WriteResult.Err).message
        assertEquals(TAG_LISTS_NOT_RETURNED, message)
        assertTrue("changeBusinessTags" !in message, "no function name on screen: $message")
    }

    @Test
    fun noChangesMakesNoCall() {
        val r = runBlocking { client.changeBusinessTags(emptyList()) }
        assertTrue(r is WriteResult.Err)
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    @Test
    fun aDeleteIsTheCascadeAndReportsTheCount() {
        JvmFirestoreFixtures.callableResponses = mapOf(
            REMOVE_BUSINESS_TAG_CALLABLE to """{"ok":true,"scope":"pet","name":"Shy","recordsTouched":3,"vocabRemoved":true}""",
        )
        val r = runBlocking { client.removeBusinessTag("pet", "Shy") }
        assertEquals(WriteResult.Ok(3), r)
        val payload = sent(REMOVE_BUSINESS_TAG_CALLABLE)
        assertEquals(setOf("name", "scope"), payload.keys)
        assertEquals(JsonPrimitive("pet"), payload["scope"])
    }

    @Test
    fun theAnswerIsDecodedThroughTheTolerantReadGate() {
        val after = decodeTagListsAfterChange(
            """{"householdTags":[{"name":"VIP","color":{"token":"teal","css":"x"},"icon":""},{"name":"broken"}],"petTags":"nope"}""",
        )
        assertEquals(listOf("VIP"), after?.household?.map { it.name })
        assertEquals(emptyList(), after?.pet)
        assertEquals(null, decodeTagListsAfterChange("""{"ok":true}"""))
    }
}
