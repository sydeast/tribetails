package com.kinfolk.portal.screens.kintales

import com.kinfolk.portal.portal.CommentAuthorRole
import com.kinfolk.portal.portal.KinTaleComment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2378: the MyTribe app marks the signed-in reader's own KinTale comment the
 * way the web portal does (kinTalesApi.ts commentAuthorLabel / commentInitial /
 * commentAvatarClass), so the two portals agree.
 */
class KinTaleCommentOwnerTest {
    private fun c(
        role: CommentAuthorRole = CommentAuthorRole.Kinfolk,
        uid: String? = "me",
        name: String? = null,
        isPerson: Boolean? = null,
        guest: String? = null,
    ) = KinTaleComment(
        id = "c",
        authorRole = role,
        authorDisplayName = name,
        authorUid = uid,
        authorNameIsPerson = isPerson,
        guestName = guest,
        body = "b",
        createdAtMs = 1L,
    )

    @Test
    fun REGRESSION_ownComment_withOnlyTheHouseholdName_readsYou_notTheHousehold() {
        assertEquals("You", kinTaleCommentRowLabel(c(name = "The Ortega household", isPerson = false), "me"))
        assertEquals("You", kinTaleCommentRowLabel(c(name = "A member of the household", isPerson = false), "me"))
        assertEquals("You", kinTaleCommentRowLabel(c(name = null), "me"))
    }

    @Test
    fun ownComment_namedPerson_readsNameYou() {
        assertEquals("Casey (you)", kinTaleCommentRowLabel(c(name = "Casey", isPerson = true), "me"))
        // A server that does not say whether the name is the person's: trust the name, like the web portal.
        assertEquals("Casey (you)", kinTaleCommentRowLabel(c(name = "Casey", isPerson = null), "me"))
    }

    @Test
    fun someoneElsesComment_isUnchanged() {
        assertEquals("Sam", kinTaleCommentRowLabel(c(uid = "other", name = "Sam", isPerson = true), "me"))
        assertEquals("The Ortega household", kinTaleCommentRowLabel(c(uid = "other", name = "The Ortega household", isPerson = false), "me"))
        assertEquals("Auntie Maya", kinTaleCommentRowLabel(c(role = CommentAuthorRole.Admin, uid = "me", name = "Maya"), "me"))
    }

    @Test
    fun noSignedInReader_marksNothing() {
        assertFalse(isOwnKinTaleComment(c(uid = "me"), null))
        assertFalse(isOwnKinTaleComment(c(uid = "me"), " "))
        assertFalse(isOwnKinTaleComment(c(uid = null), "me"))
        assertEquals("Casey", kinTaleCommentRowLabel(c(name = "Casey", isPerson = true), null))
    }

    @Test
    fun aGuestOrStaffNoteWithTheSameUidIsNeverYours() {
        assertFalse(isOwnKinTaleComment(c(role = CommentAuthorRole.Guest, guest = "Pat"), "me"))
        assertFalse(isOwnKinTaleComment(c(guest = "Pat"), "me"))
        assertFalse(isOwnKinTaleComment(c(role = CommentAuthorRole.Admin), "me"))
        assertTrue(isOwnKinTaleComment(c(), "me"))
    }

    @Test
    fun ownAvatar_takesTheComposerLetterAndTone() {
        val viewer = KinTaleViewer(uid = "me", name = "Robin")
        val household = c(name = "The Ortega household", isPerson = false)
        val own = ownKinTaleCommentInitial(listOf(household), viewer)
        assertEquals("R", own)
        assertEquals("R", kinTaleCommentInitial(household, "me", own))
        assertEquals(KinTaleAvatarTone.Me, kinTaleCommentAvatarTone(household, "me", 1))
        // The server named the person: that name gives the letter everywhere, composer included.
        val named = c(name = "Casey", isPerson = true)
        val ownNamed = ownKinTaleCommentInitial(listOf(c(uid = "other", name = "Sam", isPerson = true), named), viewer)
        assertEquals("C", ownNamed)
        assertEquals("C", kinTaleCommentInitial(named, "me", ownNamed))
    }

    @Test
    fun otherAvatars_cycleThreeTones_andUseTheAuthorsLetter() {
        val other = c(uid = "other", name = "Sam", isPerson = true)
        assertEquals(
            listOf(KinTaleAvatarTone.C1, KinTaleAvatarTone.C2, KinTaleAvatarTone.C3, KinTaleAvatarTone.C1),
            (0..3).map { kinTaleCommentAvatarTone(other, "me", it) },
        )
        assertEquals("S", kinTaleCommentInitial(other, "me", "R"))
        assertEquals("M", kinTaleCommentInitial(c(role = CommentAuthorRole.Admin, name = "Maya"), "me", "R"))
        assertEquals("A", kinTaleCommentInitial(c(role = CommentAuthorRole.Admin, name = null), "me", "R"))
        assertEquals("P", kinTaleCommentInitial(c(role = CommentAuthorRole.Guest, uid = null, guest = "Pat"), "me", "R"))
        assertEquals("G", kinTaleCommentInitial(c(role = CommentAuthorRole.Guest, uid = null), "me", "R"))
        assertEquals("K", kinTaleCommentInitial(c(uid = "other"), "me", "R"))
    }

    @Test
    fun unknownViewer_composerFallsBackToTheAppLetter() {
        assertEquals("T", ownKinTaleCommentInitial(emptyList(), KinTaleViewer.Unknown))
    }
}
