package com.tribetails.auntieos.data.model

import com.tribetails.auntieos.ui.kintales.DefaultKinTaleTemplate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Slice 3: KinCareReport.title default + the built-in default template's live
 * pet-mood enablement. KinCareReport is a Firestore POJO (no kotlinx codec), so
 * the round-trip guarantee is the field default + assignability; the actual
 * Firestore (de)serialization is the platform's POJO mapping.
 */
class KinCareReportTitleTest {

    @Test
    fun `title defaults to empty string`() {
        assertEquals("", KinCareReport().title)
    }

    @Test
    fun `title is assignable and read back`() {
        val r = KinCareReport(id = "r1")
        r.title = "Checking on Biscuit"
        assertEquals("Checking on Biscuit", r.title)
    }

    @Test
    fun `default template ships petMood enabled with eight stable mood options`() {
        val template = DefaultKinTaleTemplate.template
        assertTrue("default template must enable pet mood", template.petMoodEnabled)
        val keys = template.moodOptions.sortedBy { it.order }.map { it.key }
        assertEquals(
            listOf("happy", "playful", "calm", "cuddly", "anxious", "shy", "energetic", "sleepy"),
            keys,
        )
        assertTrue(template.moodOptions.all { it.label.isNotBlank() && it.emoji.isNotBlank() })
    }
}
