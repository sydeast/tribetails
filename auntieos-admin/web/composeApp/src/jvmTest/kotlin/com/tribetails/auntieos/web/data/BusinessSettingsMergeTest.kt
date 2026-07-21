package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Desktop (jvm) settings-unification guards (2026-06-05). The save path always
 * targets doc id [BUSINESS_SETTINGS_DOC_ID] and MERGES via
 * JvmFirestoreRest.mergeDoc, whose updateMask is built by the pure
 * [JvmFirestoreRest.mergeFieldPaths]. A merge mask that names exactly the body
 * keys is what stops a desktop write from deleting fields another platform owns.
 */
class BusinessSettingsMergeTest {

    private val codec = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    @Test
    fun savePathUsesCanonicalDocId() {
        // The doc id the jvm save hardcodes (and reads back from) is the canonical one.
        assertEquals("business_settings", BUSINESS_SETTINGS_DOC_ID)
    }

    @Test
    fun mergeFieldPaths_coversEveryBodyKey_andDropsIdAlias() {
        // Serialize the full model exactly as the save path does (encodeDefaults).
        val modelJson = codec.encodeToString(
            BusinessSettings.serializer(),
            BusinessSettings(_id = BUSINESS_SETTINGS_DOC_ID),
        )
        val plain = codec.parseToJsonElement(modelJson).jsonObject
        val paths = JvmFirestoreRest.mergeFieldPaths(plain)

        // _id is the doc-id alias, never a written field path.
        assertFalse(paths.contains("`_id`"), "_id must not be in the updateMask")

        // The mask must name exactly the body keys (every model field except _id).
        val expected = plain.keys.filter { it != "_id" }.map { "`$it`" }
        assertEquals(expected.toSet(), paths.toSet())

        // Spot-check a representative field from each union region survives in the mask,
        // so a partial-screen save still merges (never clobbers) these.
        listOf(
            "businessName", "timeZone", "notificationEmail", "observeUsHolidays",
            "defaultBookingMode", "timeBlocks", "enableGPSTrackingForAllVisits",
            "trackingAccuracy", "defaultEtaMinutes", "draftRetentionOptions",
            "calendarSyncId", "updatedBy",
        ).forEach { key ->
            assertTrue(paths.contains("`$key`"), "merge mask missing `$key`")
        }
    }

    @Test
    fun mergeMask_onlyNamesPresentKeys_soSiblingsSurvive() {
        // A merge write of a sparse object (e.g. one screen editing two fields) must
        // produce a mask that names ONLY those keys, leaving every other prod field
        // untouched. This is the property that prevents cross-schema field loss.
        val sparse = codec.parseToJsonElement(
            """{"_id":"business_settings","notificationEmail":false,"calendarSyncId":"x"}""",
        ).jsonObject
        val paths = JvmFirestoreRest.mergeFieldPaths(sparse)
        assertEquals(setOf("`notificationEmail`", "`calendarSyncId`"), paths.toSet())
        assertFalse(paths.contains("`businessName`"), "absent fields must not appear in the mask")
    }
}
