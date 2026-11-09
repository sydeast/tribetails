package com.tribetails.auntieos.web.data
import com.tribetails.auntieos.web.screens.settings.kinCareRows
import com.tribetails.auntieos.web.screens.settings.kinCareRowsApplied
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * Issue #1095: the console's settings save writes `serviceDurations` and
 * `serviceStartTimeBooking` as whole maps. #1593: the save is now the
 * `saveBusinessSettings` callable, which REPLACES these three maps
 * (`WHOLE_MAP_SETTINGS_FIELDS`), so these assert the `changes` the callable is
 * sent: each changed map whole, so a cleared flag or a renamed KinCare is gone,
 * not left behind. The document is still read through [MaskApplyingFirestore],
 * so the baseline is a real decoded read.
 */
class KinCareMapsSaveTest {
    private val fs = MaskApplyingFirestore()
    private val path = "business_settings/$BUSINESS_SETTINGS_DOC_ID"
    @BeforeTest fun setUp() = fs.start()
    @AfterTest fun tearDown() = fs.stop()
    private fun str(s: String) = MaskApplyingFirestore.str(s)
    private fun map(vararg kv: Pair<String, JsonObject>) = MaskApplyingFirestore.map(*kv)
    private fun seed() {
        fs.docs[path] = buildJsonObject {
            put("businessName", str("TribeTails"))
            put("serviceRates", map("Overnight" to str("90"), "30Minute" to str("25")))
            put("serviceDurations", map("Overnight" to str("720")))
            put("serviceStartTimeBooking", map("Overnight" to MaskApplyingFirestore.bool(true)))
        }
    }
    private suspend fun load(): BusinessSettings =
        (platformBusinessSettingsStream().first() as FirestoreResult.Data).value.also {
            // Answered after the read, so the read itself goes to the fake Firestore.
            JvmFirestoreFixtures.callableResponses = mapOf(SAVE_BUSINESS_SETTINGS_CALLABLE to """{"updatedAt":"x","updatedBy":"y"}""")
        }
    /** The `changes` object of the one save call this test made. */
    private fun sentChanges(): JsonObject {
        val calls = JvmFirestoreFixtures.callablePayloads.filter { it.first == SAVE_BUSINESS_SETTINGS_CALLABLE }
        assertEquals(1, calls.size, "one save call")
        val payload = Json.parseToJsonElement(calls.single().second).jsonObject
        assertEquals(setOf("changes"), payload.keys)
        return payload.getValue("changes").jsonObject
    }
    private fun keys(field: String) = sentChanges().getValue(field).jsonObject.keys
    @Test
    fun theTwoMapsDecodeFromTheStoredDocument() = runBlocking<Unit> {
        seed()
        val s = load()
        assertEquals(mapOf("Overnight" to "720"), s.serviceDurations)
        assertEquals(mapOf("Overnight" to true), s.serviceStartTimeBooking)
    }
    @Test
    fun renamingAKinCareReplacesBothMapsAndLeavesNoOldKey() = runBlocking<Unit> {
        seed()
        val loaded = load()
        val rows = kinCareRows(loaded.serviceRates, loaded.serviceDurations, loaded.serviceStartTimeBooking)
            .map { if (it.type == "Overnight") it.copy(type = "Overnight Stay") else it }
        val r = platformSaveBusinessSettings(kinCareRowsApplied(loaded, rows))
        assertTrue(r is WriteResult.Ok)
        assertEquals(setOf("Overnight Stay"), keys("serviceDurations"))
        assertEquals(setOf("Overnight Stay"), keys("serviceStartTimeBooking"))
        assertEquals(setOf("Overnight Stay", "30Minute"), keys("serviceRates"))
    }
    @Test
    fun clearingTheLastFlagSendsAnEmptyMapNotALeftoverKey() = runBlocking<Unit> {
        seed()
        val loaded = load()
        val rows = kinCareRows(loaded.serviceRates, loaded.serviceDurations, loaded.serviceStartTimeBooking)
            .map { it.copy(startTime = false) }
        platformSaveBusinessSettings(kinCareRowsApplied(loaded, rows))
        assertEquals(JsonObject(emptyMap()), sentChanges()["serviceStartTimeBooking"])
        assertEquals(setOf("serviceStartTimeBooking"), sentChanges().keys, "the length stays, only the flag was cleared")
    }
    @Test
    fun aKinCareSaveSendsOnlyTheMapItChangedAndNoStamp() = runBlocking<Unit> {
        seed()
        val loaded = load()
        val rows = kinCareRows(loaded.serviceRates, loaded.serviceDurations, loaded.serviceStartTimeBooking)
            .map { if (it.type == "30Minute") it.copy(duration = "30") else it }
        platformSaveBusinessSettings(kinCareRowsApplied(loaded, rows))
        val changes = sentChanges()
        assertEquals(setOf("serviceDurations"), changes.keys, "no updatedAt: the server stamps the save")
        assertEquals(setOf("Overnight", "30Minute"), keys("serviceDurations"))
        assertEquals(JsonPrimitive("30"), changes.getValue("serviceDurations").jsonObject["30Minute"])
        assertEquals(emptyList(), fs.masks, "nothing is written to Firestore directly")
    }
}
