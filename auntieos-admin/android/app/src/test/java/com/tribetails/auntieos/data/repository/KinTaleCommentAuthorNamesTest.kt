package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.CommentsState
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.KinTaleComment
import com.tribetails.auntieos.ui.kintales.kinTaleCommentAuthorLabel
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1923: admin Android reads the thread from a live listener, and the comment
 * doc holds no author name, so every household reply read "Kinfolk". The
 * repository now joins the names getKinTaleComments works out on the server.
 */
class KinTaleCommentAuthorNamesTest {

    private fun c(id: String, role: String = "kinfolk", guest: String? = null) =
        KinTaleComment(id = id, authorRole = role, guestName = guest, body = "b-$id", createdAtMs = 1L)

    private val callableResult: Map<String, Any?> = mapOf(
        "comments" to listOf(
            mapOf("id" to "c1", "authorDisplayName" to "Casey", "authorRole" to "kinfolk"),
            mapOf("id" to "c2", "authorDisplayName" to null, "authorRole" to "admin"),
            mapOf("id" to "c3", "authorDisplayName" to "A member of the household", "authorRole" to "kinfolk"),
            mapOf("id" to "c4", "authorDisplayName" to "Grandma Rose", "authorRole" to "guest"),
            "not a row",
            mapOf("authorDisplayName" to "no id"),
        ),
    )

    @Test
    fun parseAuthorNames_readsIdToName_andSkipsBadRows() {
        assertEquals(
            mapOf("c1" to "Casey", "c2" to null, "c3" to "A member of the household", "c4" to "Grandma Rose"),
            KinTaleCommentsRepository.parseAuthorNames(callableResult),
        )
        assertEquals(emptyMap<String, String?>(), KinTaleCommentsRepository.parseAuthorNames(null))
        assertEquals(emptyMap<String, String?>(), KinTaleCommentsRepository.parseAuthorNames(mapOf("comments" to "x")))
    }

    @Test
    fun REGRESSION_householdReplyIsNamedByTheServer_notKinfolk() = runTest {
        val rows = listOf(c("c1"), c("c2", role = "admin"), c("c3"), c("c4", role = "guest", guest = "Grandma Rose"))
        val out = KinTaleCommentsRepository.nameComments(flowOf(CommentsState.Loading, CommentsState.Data(rows))) {
            KinTaleCommentsRepository.parseAuthorNames(callableResult)
        }.toList()
        assertEquals(CommentsState.Loading, out[0])
        val labels = (out[1] as CommentsState.Data).comments.map(::kinTaleCommentAuthorLabel)
        assertEquals(listOf("Casey", "Auntie", "A member of the household", "Grandma Rose"), labels)
        labels.forEach { assertFalse("an email reached the label: $it", it.contains('@')) }
    }

    @Test
    fun ERROR_aFailedNameReadStillShowsTheThread_withTheRoleWord() = runTest {
        val out = KinTaleCommentsRepository.nameComments(flowOf(CommentsState.Data(listOf(c("c1"), c("g", role = "guest", guest = "Pat"))))) {
            error("unavailable")
        }.toList()
        val comments = (out.single() as CommentsState.Data).comments
        assertEquals(listOf("Kinfolk", "Pat"), comments.map(::kinTaleCommentAuthorLabel))
    }

    @Test
    fun anErrorOrAnEmptyThreadAsksForNoNames() = runTest {
        var calls = 0
        val out = KinTaleCommentsRepository.nameComments(
            flowOf(CommentsState.Error("permission-denied"), CommentsState.Data(emptyList())),
        ) { calls++; emptyMap() }.toList()
        assertEquals(listOf(CommentsState.Error("permission-denied"), CommentsState.Data(emptyList())), out)
        assertEquals(0, calls)
    }

    @Test
    fun label_blankServerName_fallsBackToTypedName_thenRoleWord() {
        assertEquals("Kinfolk", kinTaleCommentAuthorLabel(c("x").copy(authorDisplayName = "  ")))
        assertEquals("Guest", kinTaleCommentAuthorLabel(c("g", role = "guest")))
        assertEquals("Auntie", kinTaleCommentAuthorLabel(c("a", role = "admin").copy(authorDisplayName = "Maya")))
    }
}
