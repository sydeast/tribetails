package com.tribetails.auntieos.web.data
import com.tribetails.auntieos.web.screens.settings.kinCareRows
import com.tribetails.auntieos.web.screens.settings.kinCareRowsApplied
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * Issue #1095: the console's settings save writes `serviceDurations` and
 * `serviceStartTimeBooking` as whole maps. [MaskApplyingFirestore] applies each
 * PATCH the way Firestore does, so these assert the STORED document: a cleared
 * flag or a renamed KinCare must be gone, not left behind.
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
        (platformBusinessSettingsStream().first() as FirestoreResult.Data).value
    private fun keys(field: String) =
        fs.getAt(fs.docs.getValue(path), listOf(field))?.get("mapValue").let { (it as JsonObject?)?.get("fields") as JsonObject? }?.keys
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
    fun clearingTheLastFlagWritesAnEmptyMapNotALeftoverKey() = runBlocking<Unit> {
        seed()
        val loaded = load()
        val rows = kinCareRows(loaded.serviceRates, loaded.serviceDurations, loaded.serviceStartTimeBooking)
            .map { it.copy(startTime = false) }
        platformSaveBusinessSettings(kinCareRowsApplied(loaded, rows))
        assertEquals(emptySet(), keys("serviceStartTimeBooking"))
        assertEquals(setOf("Overnight"), keys("serviceDurations"), "the length stays, only the flag was cleared")
    }
    @Test
    fun aKinCareSaveMasksOnlyTheMapsItChangedAndKeepsOtherFields() = runBlocking<Unit> {
        seed()
        val loaded = load()
        val rows = kinCareRows(loaded.serviceRates, loaded.serviceDurations, loaded.serviceStartTimeBooking)
            .map { if (it.type == "30Minute") it.copy(duration = "30") else it }
        platformSaveBusinessSettings(kinCareRowsApplied(loaded, rows))
        assertEquals(setOf("serviceDurations", "updatedAt"), fs.masks.single()!!.toSet())
        assertEquals(setOf("Overnight", "30Minute"), keys("serviceDurations"))
        assertEquals(str("TribeTails"), fs.docs.getValue(path)["businessName"])
    }
}
