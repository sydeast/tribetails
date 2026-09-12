package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ISSUE #755: the KinCare types editor's pure half. Mirror of the web
 * `KinCareRatesEditor.test.tsx` fold and sort cases, so a rate card edited on
 * the phone writes the document the web editor would.
 */
class KinCareTypesEditorTest {

    private val threeTypes = kinCareRows(
        rates = linkedMapOf("Overnight" to "80.00", "30Minute" to "15.00", "Consultation" to ""),
        durations = mapOf("Overnight" to "720"),
    )

    @Test
    fun `rows come out in stored order with their stored duration beside them`() {
        assertEquals(
            listOf(
                KinCareTypeRow("Overnight", "720", "80.00"),
                KinCareTypeRow("30Minute", "", "15.00"),
                KinCareTypeRow("Consultation", "", ""),
            ),
            threeTypes,
        )
    }

    @Test
    fun `folding drops blank names, trims, and lets the last duplicate win`() {
        val rows = listOf(
            KinCareTypeRow(" Walk ", "", " 10.00 "),
            KinCareTypeRow("", "30", "5.00"),
            KinCareTypeRow("Walk", "", "12.00"),
        )
        assertEquals(mapOf("Walk" to "12.00"), foldKinCareRates(rows))
    }

    @Test
    fun `durations stay sparse, a blank duration writes no key at all`() {
        val rows = listOf(
            KinCareTypeRow("Walk", " 45 ", "10.00"),
            KinCareTypeRow("Overnight", "", "80.00"),
            KinCareTypeRow("", "30", ""),
        )
        assertEquals(mapOf("Walk" to "45"), foldKinCareDurations(rows))
    }

    @Test
    fun `an added blank row folds to nothing, so an abandoned add is not dirty`() {
        val rows = threeTypes + KinCareTypeRow.BLANK
        assertEquals(foldKinCareRates(threeTypes), foldKinCareRates(rows))
        assertEquals(foldKinCareDurations(threeTypes), foldKinCareDurations(rows))
    }

    @Test
    fun `sorting by name`() {
        assertEquals(
            listOf("30Minute", "Consultation", "Overnight"),
            sortedKinCareView(threeTypes, KinCareSortKey.NAME).map { it.value.type },
        )
    }

    @Test
    fun `sorting by rate puts an unset price last rather than free`() {
        assertEquals(
            listOf("30Minute", "Overnight", "Consultation"),
            sortedKinCareView(threeTypes, KinCareSortKey.RATE).map { it.value.type },
        )
        assertEquals(Double.MAX_VALUE, kinCareRateRank(""), 0.0)
        assertEquals(Double.MAX_VALUE, kinCareRateRank("free"), 0.0)
        assertEquals(28.0, kinCareRateRank("\$28"), 0.0)
    }

    @Test
    fun `sorting by duration prefers the stored minutes over the name`() {
        assertEquals(
            listOf("30Minute", "Overnight", "Consultation"),
            sortedKinCareView(threeTypes, KinCareSortKey.DURATION).map { it.value.type },
        )
    }

    @Test
    fun `a sorted view keeps every row's STORED index, so an edit lands on the right row`() {
        val byName = sortedKinCareView(threeTypes, KinCareSortKey.NAME)
        // Third on screen under this sort is Overnight, stored first.
        assertEquals(0, byName[2].index)
        assertEquals("Overnight", byName[2].value.type)
        assertEquals(
            threeTypes.indices.toList(),
            sortedKinCareView(threeTypes, KinCareSortKey.STORED).map { it.index },
        )
    }

    @Test
    fun `the duration placeholder shows what the name implies and nothing when a length is stored`() {
        assertEquals("30 (from the name)", kinCareDurationPlaceholder(KinCareTypeRow("30Minute", "", "")))
        assertEquals("Not set", kinCareDurationPlaceholder(KinCareTypeRow("Consultation", "", "")))
        assertEquals("", kinCareDurationPlaceholder(KinCareTypeRow("30Minute", "45", "")))
        assertNull(kinCareRowMinutes(KinCareTypeRow("Consultation", "", "")))
        assertEquals(720, kinCareRowMinutes(KinCareTypeRow("Overnight", "720", "")))
    }

    @Test
    fun `the preview label is the booking wizard's own, with a blank name shown as Untitled`() {
        assertEquals("Walk · \$10.00", kinCarePreviewLabel(KinCareTypeRow("Walk", "", "10.00")))
        assertEquals("Overnight", kinCarePreviewLabel(KinCareTypeRow("Overnight", "", "")))
        assertEquals("Untitled", kinCarePreviewLabel(KinCareTypeRow.BLANK))
    }

    @Test
    fun `the type count reads as a sentence fragment`() {
        assertEquals("1 type", kinCareTypeCount(1))
        assertEquals("3 types", kinCareTypeCount(3))
    }
}
