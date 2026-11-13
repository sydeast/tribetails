package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2123: a visit is Completed at departure, and sending a KinTale no longer
 * decides that. With "KinTale required" on, the Auntie keeps a "Send the
 * KinTale" task for a completed visit until its KinTale is sent. The server
 * stamps `kinTaleDue: true` at completion; every send batch writes it false.
 */
class KinTaleOwedTest {

    private val codec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

    private fun completed(
        due: Boolean = true,
        sentReportCount: Int = 0,
        reportIds: List<String> = emptyList(),
        status: String = "COMPLETED",
    ) = KinCareSession(
        _id = "s1",
        status = status,
        kinTaleDue = due,
        sentReportCount = sentReportCount,
        reportIds = reportIds,
    )

    // ── kinTaleSent ─────────────────────────────────────────────────────────

    @Test
    fun aVisitWithASentReportCountHasItsKinTaleSent() {
        assertTrue(kinTaleSent(completed(sentReportCount = 1)))
        assertTrue(kinTaleSent(completed(sentReportCount = 2, reportIds = listOf("r1", "r2"))))
    }

    @Test
    fun aReportIdAloneIsADraftNotASentKinTale() {
        // Android's createKinCareReport appends a DRAFT's id to reportIds.
        assertFalse(kinTaleSent(completed(reportIds = listOf("draft-1"))))
        assertFalse(kinTaleSent(completed()))
    }

    // ── kinTaleOwed ─────────────────────────────────────────────────────────

    @Test
    fun aCompletedVisitTheServerMarkedDueIsOwedWhileTheSettingIsOn() {
        assertTrue(kinTaleOwed(completed()))
        // The stored status is read the way every other status check here reads it.
        assertTrue(kinTaleOwed(completed(status = " completed ")))
    }

    @Test
    fun aVisitTheServerNeverMarkedDueIsNotOwed() {
        // A visit completed before the setting, or while it was off, carries no stamp.
        assertFalse(kinTaleOwed(completed(due = false)))
    }

    @Test
    fun aSentKinTaleEndsTheTaskEvenBeforeTheStampIsCleared() {
        assertFalse(kinTaleOwed(completed(sentReportCount = 1)))
    }

    @Test
    fun aSavedDraftDoesNotEndTheTask() {
        assertTrue(kinTaleOwed(completed(reportIds = listOf("draft-1"))))
    }

    @Test
    fun onlyACompletedVisitCarriesTheTask() {
        for (status in listOf("DEPARTED", "ARRIVED", "SCHEDULED", "CANCELLED", "")) {
            assertFalse(kinTaleOwed(completed(status = status)), status)
        }
    }

    // ── The setting and the stamp, as they come off the documents ───────────

    @Test
    fun kinTaleRequiredReadsOffWhenTheDocumentHasNoKey() {
        // Operator ruling 2026-11-13: "Start it off".
        assertFalse(BusinessSettings().kinTaleRequired)
        assertFalse(codec.decodeFromString(BusinessSettings.serializer(), "{}").kinTaleRequired)
        assertFalse(codec.decodeFromString(BusinessSettings.serializer(), """{"businessName":"Tribe Tails"}""").kinTaleRequired)
        assertFalse(codec.decodeFromString(BusinessSettings.serializer(), """{"kinTaleRequired":false}""").kinTaleRequired)
        assertTrue(codec.decodeFromString(BusinessSettings.serializer(), """{"kinTaleRequired":true}""").kinTaleRequired)
    }

    @Test
    fun turningTheSettingOnSavesThatOneField() {
        val loaded = BusinessSettings(businessName = "Tribe Tails")
        val changes = businessSettingsSaveChanges(loaded, loaded.copy(kinTaleRequired = true), codec)
        assertEquals(mapOf("kinTaleRequired" to JsonPrimitive(true)), changes)
    }

    @Test
    fun turningTheSettingOffSavesThatOneField() {
        val loaded = BusinessSettings(businessName = "Tribe Tails", kinTaleRequired = true)
        val changes = businessSettingsSaveChanges(loaded, loaded.copy(kinTaleRequired = false), codec)
        assertEquals(mapOf("kinTaleRequired" to JsonPrimitive(false)), changes)
    }

    @Test
    fun anUntouchedSettingIsNotSaved() {
        val loaded = BusinessSettings(businessName = "Tribe Tails", kinTaleRequired = true)
        val changes = businessSettingsSaveChanges(loaded, loaded.copy(businessPhone = "(512) 555-0199"), codec)
        assertEquals(setOf("businessPhone"), changes.keys)
    }

    @Test
    fun aSessionWithNoStampIsNotDue() {
        assertFalse(KinCareSession().kinTaleDue)
    }

    // ── Words ───────────────────────────────────────────────────────────────

    @Test
    fun aSentKinTaleSaysSoAndNothingAboutTheVisit() {
        assertEquals("KinTale sent. Kinfolk will hear from you soon.", KINTALE_SENT_MESSAGE)
    }
}
