package com.kinfolk.portal.screens.messages
import com.kinfolk.portal.portal.ConversationMessage
import com.kinfolk.portal.portal.SenderRole
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
class MessageDaysTest {
    // 2026-11-01 18:00 UTC = noon in Chicago (CST after the Nov 1 fall-back).
    private val now = 1_793_556_000_000L
    private fun msg(id: String, role: SenderRole, ms: Long?) =
        ConversationMessage(id, role, "u", "b", ms, null, null)
    @Test
    fun labels_todayYesterdayWeekdayDate() {
        assertEquals("Today", messageDayLabel(now - 60_000, now))
        assertEquals("Yesterday", messageDayLabel(now - 86_400_000L, now))
        assertEquals("Thursday", messageDayLabel(now - 3 * 86_400_000L, now))
        assertEquals("October 5", messageDayLabel(now - 27 * 86_400_000L, now))
        assertEquals("October 5, 2025", messageDayLabel(now - 392 * 86_400_000L, now))
    }
    @Test
    fun daysAreCutInChicagoNotUtc() {
        // 03:00 UTC on Nov 1 is still the evening of Oct 31 in Chicago.
        val lateOct31 = now - 15 * 3_600_000L
        assertEquals("2026-10-31", messageDayKey(lateOct31))
        assertEquals("Yesterday", messageDayLabel(lateOct31, now))
    }
    @Test
    fun separator_onlyWhenTheDayChanges() {
        val a = msg("a", SenderRole.Auntie, now - 86_400_000L)
        val b = msg("b", SenderRole.Kinfolk, now - 86_400_000L + 60_000)
        val c = msg("c", SenderRole.Auntie, now)
        val list = listOf(a, b, c)
        assertEquals("Yesterday", daySeparatorBefore(list, 0, now))
        assertNull(daySeparatorBefore(list, 1, now))
        assertEquals("Today", daySeparatorBefore(list, 2, now))
        assertNull(daySeparatorBefore(listOf(msg("x", SenderRole.Auntie, null)), 0, now))
    }
    @Test
    fun suggestReply_onlyWhenAuntieSpokeLast() {
        assertFalse(canSuggestReply(null))
        assertFalse(canSuggestReply(emptyList()))
        assertTrue(canSuggestReply(listOf(msg("a", SenderRole.Auntie, 1))))
        assertFalse(canSuggestReply(listOf(msg("a", SenderRole.Auntie, 1), msg("b", SenderRole.Kinfolk, 2))))
    }
}
