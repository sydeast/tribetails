package com.kinfolk.portal.screens.kintales
import com.kinfolk.portal.portal.CommentAuthorRole
import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.KinTaleComment
import com.kinfolk.portal.portal.KinTaleReaction
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1328 / #1329 / #1363 pure helpers. Mirrors web's commentAuthorLabel and focusTaleId. */
class KinTaleCommentAuthorTest {
    private fun comment(role: CommentAuthorRole, name: String? = null, guest: String? = null) = KinTaleComment(
        id = "c", authorRole = role, authorDisplayName = name, guestName = guest, body = "hi", createdAtMs = 1L,
    )
    @Test
    fun auntie_isNamedOnceThroughAuntieName() {
        assertEquals("Auntie Maya", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Admin, "Maya")))
        assertEquals("Auntie Maya", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Admin, "Auntie Maya")))
    }
    @Test
    fun householdMember_showsTheirName() {
        assertEquals("Sam", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Kinfolk, "Sam")))
    }
    @Test
    fun guest_showsTheNameTheyTyped() {
        assertEquals("Pat (guest)", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Guest, guest = "Pat")))
    }
    @Test
    fun noResolvedName_fallsBackToTheRoleWord() {
        assertEquals("Auntie", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Admin)))
        assertEquals("Kinfolk", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Kinfolk, "  ")))
        assertEquals("Guest (guest)", kinTaleCommentAuthorLabel(comment(CommentAuthorRole.Guest)))
    }
    @Test
    fun loveDescription_saysSavingWhileInFlight() {
        val r = KinTaleReaction(loved = false, loveCount = 1)
        assertEquals("Saving your love", kinTaleLoveDescription(r, toggling = true))
        assertEquals("1 person loved this", kinTaleLoveDescription(r, toggling = false))
    }
    private fun tale(id: String) = KinTale(id = id, body = "b", authorDisplayName = null, mediaIds = emptyList(), sentAtMs = null, shared = false)
    @Test
    fun focusKinTale_movesTheNamedTaleFirst_andLeavesOtherwiseAlone() {
        val tales = listOf(tale("a"), tale("b"), tale("c"))
        assertEquals(listOf("c", "a", "b"), focusKinTale(tales, "c").map { it.id })
        assertEquals(listOf("a", "b", "c"), focusKinTale(tales, "gone").map { it.id })
        assertEquals(listOf("a", "b", "c"), focusKinTale(tales, null).map { it.id })
    }
}
