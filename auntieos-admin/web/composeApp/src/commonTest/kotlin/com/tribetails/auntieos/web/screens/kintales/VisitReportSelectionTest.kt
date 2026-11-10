package com.tribetails.auntieos.web.screens.kintales
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.orderVisitReports
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** #1804: which report the Auntie Time "View KinTale" opens. */
class VisitReportSelectionTest {
    private fun sent(id: String, at: String) = KinCareReport(_id = id, sessionId = "s1", status = "SENT", sentAt = at, createdAt = at)
    private fun draft(id: String, at: String) = KinCareReport(_id = id, sessionId = "s1", status = "DRAFT", updatedAt = at, createdAt = at)
    private fun opened(all: List<KinCareReport>, picked: String? = null) =
        pickVisitReport(orderVisitReports(all, "s1"), picked)?._id
    @Test
    fun aSentTaleBeatsANewerDraft() {
        assertEquals("sent1", opened(listOf(draft("d1", "2026-11-10T20:00:00Z"), sent("sent1", "2026-11-10T17:00:00Z"))))
    }
    @Test
    fun newestSentFirst() {
        val all = listOf(sent("a", "2026-11-09T10:00:00Z"), sent("c", "2026-11-10T18:00:00Z"), sent("b", "2026-11-10T09:00:00Z"))
        assertEquals(listOf("c", "b", "a"), orderVisitReports(all, "s1").map { it._id })
        assertEquals("c", opened(all))
    }
    @Test
    fun aPickedSentTaleWins() {
        val all = listOf(sent("a", "2026-11-09T10:00:00Z"), sent("c", "2026-11-10T18:00:00Z"))
        assertEquals("a", opened(all, picked = "a"))
    }
    @Test
    fun aStalePickFallsBackToNewest() {
        assertEquals("c", opened(listOf(sent("c", "2026-11-10T18:00:00Z")), picked = "gone"))
    }
    @Test
    fun onlyDraftsOpenTheNewestDraft() {
        assertEquals("d2", opened(listOf(draft("d1", "2026-11-09T00:00:00Z"), draft("d2", "2026-11-10T00:00:00Z"))))
    }
    @Test
    fun otherVisitsAreIgnoredAndNoneIsNull() {
        val other = sent("x", "2026-11-10T00:00:00Z").copy(sessionId = "s2")
        assertNull(opened(listOf(other)))
    }
}
