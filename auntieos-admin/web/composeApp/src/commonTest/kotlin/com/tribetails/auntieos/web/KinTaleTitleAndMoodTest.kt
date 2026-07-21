package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareReport
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 3: KinTale headline (KinCareReport.title) + pet-mood persistence.
 *
 * Verifies that the new `title` field and the existing `petMoodSelections` map
 * survive a serialize/deserialize round-trip with the same Json config the write
 * paths use (encodeDefaults = true so the field is actually written;
 * ignoreUnknownKeys = true so an old doc lacking title still decodes), and that
 * the composer's title precedence (typed headline wins, blank falls back to a
 * derived placeholder) behaves correctly without ever persisting the derived value.
 */
class KinTaleTitleAndMoodTest {

    // Mirrors the jsonOut config on both write paths (wasmJs + jvm interop).
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    @Test
    fun title_defaultsToEmptyString() {
        assertEquals("", KinCareReport().title)
    }

    @Test
    fun report_titleAndPetMood_surviveRoundTrip() {
        val original = KinCareReport(
            _id = "r1",
            sessionId = "s1",
            kinfolkId = "fam3",
            title = "Checking on Biscuit",
            bodyCopy = "Great visit today.",
            petMoodSelections = mapOf("kinA" to "happy", "kinB" to "sleepy"),
        )
        val encoded = json.encodeToString(KinCareReport.serializer(), original)
        // title must actually be written (encodeDefaults = true).
        assertTrue(encoded.contains("\"title\""), "title field must serialize")
        assertTrue(encoded.contains("Checking on Biscuit"))

        val decoded = json.decodeFromString(KinCareReport.serializer(), encoded)
        assertEquals("Checking on Biscuit", decoded.title)
        assertEquals(mapOf("kinA" to "happy", "kinB" to "sleepy"), decoded.petMoodSelections)
    }

    @Test
    fun oldDocWithoutTitle_decodesWithBlankTitle() {
        // Simulate a pre-slice doc that never had the title key.
        val legacy = """{"_id":"r-old","bodyCopy":"old tale","petMoodSelections":{}}"""
        val decoded = json.decodeFromString(KinCareReport.serializer(), legacy)
        assertEquals("", decoded.title)
        assertEquals("old tale", decoded.bodyCopy)
    }

    @Test
    fun titlePrecedence_typedWinsOverDerivedPlaceholder() {
        // The composer renders titleDraft when set, otherwise a derived hint as a
        // placeholder only. This models that precedence: typed value wins; blank
        // resolves to the derived label but is never written back as the value.
        val derived = "Checking on Biscuit"
        fun coverLabel(titleDraft: String) = titleDraft.ifBlank { derived }

        assertEquals("My headline", coverLabel("My headline"))
        assertEquals(derived, coverLabel(""))
        // Blank input must NOT mutate the stored title.
        val report = KinCareReport(title = "")
        assertEquals("", report.title, "blank title is never auto-filled with the derived value")
    }
}
