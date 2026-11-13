package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1593: `platformSaveBusinessSettings` sends the changed fields to the
 * `saveBusinessSettings` callable through the revocation-aware path, and pins
 * the wire shape the server reads.
 *
 * The baseline is seeded the way the screen seeds it: the settings stream
 * emits the fixture, which is the console's last read.
 */
class SaveBusinessSettingsCallableTest {

    private val loaded = BusinessSettings(
        _id = BUSINESS_SETTINGS_DOC_ID,
        businessName = "Tribe Tails",
        weatherLocation = "Austin, TX",
        businessHours = mapOf("Monday" to "09:00-17:00", "Tuesday" to "09:00-17:00"),
        updatedAt = "2026-11-01T00:00:00Z",
        updatedBy = "someone@tribetails.com",
    )

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun read(settings: BusinessSettings = loaded): BusinessSettings = runBlocking {
        JvmFirestoreFixtures.businessSettings = settings
        (platformBusinessSettingsStream().first() as FirestoreResult.Data).value
    }

    private fun answerOk() {
        JvmFirestoreFixtures.callableResponses = mapOf(SAVE_BUSINESS_SETTINGS_CALLABLE to """{"updatedAt":"x","updatedBy":"y"}""")
    }

    private fun saveCalls() = JvmFirestoreFixtures.callablePayloads.filter { it.first == SAVE_BUSINESS_SETTINGS_CALLABLE }

    private fun lastChanges(): JsonObject {
        val payload = Json.parseToJsonElement(saveCalls().last().second).jsonObject
        assertEquals(setOf("changes"), payload.keys, "the request is { changes } and nothing else")
        return payload.getValue("changes").jsonObject
    }

    private fun save(s: BusinessSettings) = runBlocking { platformSaveBusinessSettings(s) }

    // ── baseline ─────────────────────────────────────────────────────────────

    @Test
    fun withNoReadYetNothingIsSentAndTheSaveSaysSo() {
        val r = save(loaded.copy(weatherLocation = "Round Rock, TX"))
        assertEquals(WriteResult.Err("Settings have not loaded yet. Reload and try again."), r)
        assertNull(JvmFirestoreFixtures.lastCallableName, "no call, and no whole-model write either")
        assertNull(JvmFirestoreFixtures.lastWrite, "no direct REST write")
    }

    @Test
    fun anUnchangedSaveIsOkAndMakesNoCall() {
        read(); answerOk()
        assertEquals(WriteResult.Ok(Unit), save(loaded))
        assertTrue(saveCalls().isEmpty())
    }

    @Test
    fun oneChangedFieldIsTheWholeRequest() {
        read(); answerOk()
        assertEquals(WriteResult.Ok(Unit), save(loaded.copy(weatherLocation = "Round Rock, TX")))
        assertEquals(SAVE_BUSINESS_SETTINGS_CALLABLE, JvmFirestoreFixtures.lastCallableName)
        assertEquals(buildJsonObject { put("weatherLocation", "Round Rock, TX") }, lastChanges())
        assertNull(JvmFirestoreFixtures.lastWrite, "nothing is written to Firestore directly")
    }

    @Test
    fun serverOwnedFieldsAreNeverSent() {
        read(); answerOk()
        val edited = loaded.copy(
            _id = "other",
            updatedAt = "2030-01-01T00:00:00Z",
            updatedBy = "me@tribetails.com",
            businessPhone = "512-555-0142",
        )
        save(edited)
        val changes = lastChanges()
        assertEquals(setOf("businessPhone"), changes.keys)
        for (owned in BUSINESS_SETTINGS_SERVER_OWNED) assertFalse(owned in changes, owned)
    }

    @Test
    fun aSavedChangeMovesTheBaselineSoTheNextSaveSendsNothing() {
        read(); answerOk()
        val edited = loaded.copy(weatherLocation = "Round Rock, TX")
        save(edited)
        save(edited)
        assertEquals(1, saveCalls().size)
    }

    // ── refusal ──────────────────────────────────────────────────────────────

    @Test
    fun aRefusalComesBackWithTheServerSentenceAndCodeAndLeavesTheBaseline() {
        read()
        val sentence = "Enter the price for \"Drop-in\" in dollars, like 25 or 25.50."
        JvmFirestoreFixtures.callableErrors = mapOf(SAVE_BUSINESS_SETTINGS_CALLABLE to sentence)
        JvmFirestoreFixtures.callableErrorCodes = mapOf(SAVE_BUSINESS_SETTINGS_CALLABLE to "settings_refused")
        val edited = loaded.copy(serviceRates = mapOf("Drop-in" to "abc"))
        assertEquals(WriteResult.Err(sentence, "settings_refused"), save(edited))
        // Not moved: pressing Save again sends the same change again.
        save(edited)
        assertEquals(2, saveCalls().size)
        assertEquals(buildJsonObject { putJsonObject("serviceRates") { put("Drop-in", "abc") } }, lastChanges())
    }

    // ── wire shape ───────────────────────────────────────────────────────────

    @Test
    fun theRateCardGoesWholeSoARemovedTypeIsRemoved() {
        read(loaded.copy(serviceRates = mapOf("Drop-in" to "25", "Overnight" to "90"))); answerOk()
        save(loaded.copy(serviceRates = mapOf("Drop-in" to "30")))
        assertEquals(buildJsonObject { put("Drop-in", "30") }, lastChanges()["serviceRates"])
    }

    @Test
    fun weeklyHoursSendOnlyTheDayThatChanged() {
        read(); answerOk()
        save(loaded.copy(businessHours = loaded.businessHours + ("Monday" to "10:00-16:00")))
        assertEquals(buildJsonObject { putJsonObject("businessHours") { put("Monday", "10:00-16:00") } }, lastChanges())
    }

    @Test
    fun paymentOptionsSendOnlyTheMethodThatChangedAndNeverEchoAnUnknownId() {
        val stored = buildJsonObject {
            putJsonObject("klarna") { put("enabled", false); put("instructions", "") }
            putJsonObject("zelle") { put("enabled", true); put("instructions", "Zelle the business line.") }
            putJsonObject("applepay") { put("enabled", true) }
        }
        read(loaded.copy(paymentOptions = stored)); answerOk()
        val edited = buildJsonObject {
            putJsonObject("klarna") { put("enabled", true); put("instructions", "") }
            put("zelle", stored.getValue("zelle"))
            put("applepay", stored.getValue("applepay"))
        }
        save(loaded.copy(paymentOptions = edited))
        assertEquals(
            buildJsonObject { putJsonObject("paymentOptions") { putJsonObject("klarna") { put("enabled", true) } } },
            lastChanges(),
        )
    }

    @Test
    fun aPortalLimitSendsOnlyTheHomeSectionsList() {
        val portal = MyTribePortalConfig(
            themeId = "retired-theme",
            home = PortalHome(listOf(HomeSectionCfg("upNext", true, 0), HomeSectionCfg("tales", true, 0))),
        )
        read(loaded.copy(mytribePortal = portal)); answerOk()
        val edited = portal.copy(home = PortalHome(listOf(HomeSectionCfg("upNext", true, 5), HomeSectionCfg("tales", true, 0))))
        save(loaded.copy(mytribePortal = edited))
        val sent = lastChanges().getValue("mytribePortal").jsonObject
        assertEquals(setOf("home"), sent.keys, "the stored theme is not echoed back")
        val sections = sent.getValue("home").jsonObject.getValue("sections").jsonArray
        assertEquals(2, sections.size, "a list goes whole: the server replaces arrays")
        assertEquals(JsonPrimitive(5), sections[0].jsonObject["limit"])
    }

    @Test
    fun aClearedSendHourGoesAsAnExplicitNull() {
        read(loaded.copy(scheduleDigestHour = 7)); answerOk()
        save(loaded.copy(scheduleDigestHour = null))
        assertEquals(buildJsonObject { put("scheduleDigestHour", JsonNull) }, lastChanges())
    }

    @Test
    fun timeBlocksGoAsAListWithTheActiveKey() {
        read(); answerOk()
        val blocks = listOf(TimeBlockDefinition(id = "am", label = "Morning", startTime = "08:00", endTime = "11:00", isActive = false))
        save(loaded.copy(timeBlocks = blocks))
        val sent = lastChanges().getValue("timeBlocks")
        assertTrue(sent is JsonArray)
        assertEquals(
            buildJsonObject {
                put("id", "am"); put("label", "Morning"); put("startTime", "08:00"); put("endTime", "11:00"); put("active", false)
            },
            sent.jsonArray.single(),
        )
    }

    /**
     * #2205: a tag list never rides along with a settings save. A whole list here
     * replaced the stored one, and the server now refuses a changed list; tags
     * change one named tag at a time through `changeBusinessTags`.
     */
    @Test
    fun aTagListNeverGoesOutWithASettingsSave() {
        read(loaded.copy(householdTags = listOf(TagDef(name = "Stale")))); answerOk()
        save(loaded.copy(householdTags = listOf(TagDef(name = "VIP")), petTags = listOf(TagDef(name = "Shy")), weatherLocation = "Round Rock, TX"))
        assertEquals(setOf("weatherLocation"), lastChanges().keys)
    }

    @Test
    fun aTagOnlyEditMakesNoSettingsCall() {
        read(); answerOk()
        assertEquals(WriteResult.Ok(Unit), save(loaded.copy(householdTags = listOf(TagDef(name = "VIP")))))
        assertTrue(saveCalls().isEmpty())
    }
}
