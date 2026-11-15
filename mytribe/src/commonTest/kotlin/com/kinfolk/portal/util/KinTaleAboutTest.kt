package com.kinfolk.portal.util

import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.KinTaleChecklistItem
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * #2056: a KinTale says which KinCare, which day and which Kin it is about, and
 * a care task ticked for one Kin names that Kin. Mirrors the "what a tale is
 * about" block of mytribe/web/src/api/kinTalesApi.test.ts.
 */
class KinTaleAboutTest {

    private val zone = TimeZone.of("America/Chicago")
    private val nov2026 = LocalDate(2026, 11, 14).atStartOfDayIn(zone).toEpochMilliseconds()

    private fun tale(
        serviceLabel: String? = null,
        kinNames: List<String> = emptyList(),
    ) = KinTale(
        id = "t1",
        body = "A fine walk.",
        authorDisplayName = "Maya",
        mediaIds = emptyList(),
        sentAtMs = null,
        shared = false,
        serviceLabel = serviceLabel,
        kinNames = kinNames,
    )

    @Test
    fun kinAreListedTheWayAPersonWouldSayThem() {
        assertEquals("Biscuit", kinNameList(listOf("Biscuit")))
        assertEquals("Biscuit and Mochi", kinNameList(listOf("Biscuit", "Mochi")))
        assertEquals("Biscuit, Mochi, Pip and Tux", kinNameList(listOf("Biscuit", "Mochi", "Pip", "Tux")))
    }

    @Test
    fun noNamesAndBlankNamesListNothing() {
        assertEquals("", kinNameList(emptyList()))
        assertEquals("", kinNameList(listOf("", "  ")))
        assertEquals("Biscuit", kinNameList(listOf(" ", "Biscuit")))
    }

    @Test
    fun theAboutLineNamesTheKinCareAndTheKinOrWhicheverItHas() {
        assertEquals(
            "30 Minute Quick Check · Biscuit and Mochi",
            kinTaleAboutLine(tale("30 Minute Quick Check", listOf("Biscuit", "Mochi"))),
        )
        assertEquals("30 Minute Quick Check", kinTaleAboutLine(tale("30 Minute Quick Check")))
        assertEquals("Biscuit", kinTaleAboutLine(tale(kinNames = listOf("Biscuit"))))
    }

    @Test
    fun anOlderTaleWithNeitherHasNoLine() {
        assertEquals("", kinTaleAboutLine(tale()))
        assertEquals("", kinTaleAboutLine(tale("   ", listOf(""))))
        assertFalse(kinTaleAboutLine(tale()).contains("null"))
    }

    @Test
    fun theVisitDayPrintsWithTheYearOnlyWhenItIsNotThisOne() {
        assertEquals("Tue, Nov 10", kinTaleVisitDayLabel("2026-11-10", nov2026, zone))
        assertEquals("Mon, Nov 10, 2025", kinTaleVisitDayLabel("2025-11-10", nov2026, zone))
    }

    @Test
    fun theKeyIsACalendarDayInEveryZone() {
        // Read through an instant, 2026-11-01 would be Oct 31 west of Greenwich.
        assertEquals("Sun, Nov 1", kinTaleVisitDayLabel("2026-11-01", nov2026, TimeZone.of("Pacific/Honolulu")))
        assertEquals("Sun, Nov 1", kinTaleVisitDayLabel("2026-11-01", nov2026, TimeZone.of("Asia/Tokyo")))
    }

    @Test
    fun aMissingOrUnreadableKeyPrintsNoDay() {
        assertNull(kinTaleVisitDayLabel(null, nov2026, zone))
        assertNull(kinTaleVisitDayLabel("", nov2026, zone))
        assertNull(kinTaleVisitDayLabel("March 3", nov2026, zone))
        assertNull(kinTaleVisitDayLabel("2026-13-40", nov2026, zone))
        assertNull(kinTaleVisitDayLabel("2026-11-10T15:00:00.000Z", nov2026, zone))
    }

    @Test
    fun aTaskDoneForNamedKinSaysSoAndAVisitTaskIsJustItsName() {
        assertEquals("Fed for Biscuit", careTaskLabel(KinTaleChecklistItem("fed", "Fed", listOf("Biscuit"))))
        assertEquals("Fed for Biscuit and Pip", careTaskLabel(KinTaleChecklistItem("fed", "Fed", listOf("Biscuit", "Pip"))))
        assertEquals("Lights turned off", careTaskLabel(KinTaleChecklistItem("lights_off", "Lights turned off")))
    }
}
