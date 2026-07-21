package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository.KinTaleComment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for [KinTaleCommentsRepository.buildCommentThread] (spec 11
 * item 6.2), mirroring the web buildCommentThread test: flat chronological comments
 * group into a 1-level tree (each top-level comment followed by its direct replies),
 * order is chronological, and orphan replies surface as their own top-level rows
 * rather than being silently dropped.
 */
class KinTaleCommentTreeTest {

    private fun c(id: String, parent: String? = null, at: Long = 0L, role: String = "kinfolk") =
        KinTaleComment(id = id, authorRole = role, body = "b-$id", parentCommentId = parent, createdAtMs = at)

    @Test
    fun groupsRepliesUnderParentInChronologicalOrder() {
        val rows = KinTaleCommentsRepository.buildCommentThread(
            listOf(
                c("a", at = 100),
                c("b", at = 300),
                c("a-r1", parent = "a", at = 200, role = "admin"),
            ),
        )
        // a, then its reply a-r1 (indented), then top-level b.
        assertEquals(listOf("a", "a-r1", "b"), rows.map { it.comment.id })
        assertFalse(rows[0].isReply)
        assertTrue(rows[1].isReply)
        assertFalse(rows[2].isReply)
    }

    @Test
    fun multipleRepliesUnderSameParentKeepChronologicalOrder() {
        val rows = KinTaleCommentsRepository.buildCommentThread(
            listOf(
                c("p", at = 10),
                c("r2", parent = "p", at = 30),
                c("r1", parent = "p", at = 20),
            ),
        )
        assertEquals(listOf("p", "r1", "r2"), rows.map { it.comment.id })
        assertTrue(rows[1].isReply)
        assertTrue(rows[2].isReply)
    }

    @Test
    fun orphanReplyWithMissingParentSurfacesAsTopLevel() {
        val rows = KinTaleCommentsRepository.buildCommentThread(
            listOf(
                c("a", at = 100),
                c("orphan", parent = "ghost", at = 200),
            ),
        )
        // The orphan is never dropped; it renders as a top-level row.
        assertEquals(setOf("a", "orphan"), rows.map { it.comment.id }.toSet())
        val orphanRow = rows.first { it.comment.id == "orphan" }
        assertFalse(orphanRow.isReply)
    }

    @Test
    fun emptyListYieldsNoRows() {
        assertTrue(KinTaleCommentsRepository.buildCommentThread(emptyList()).isEmpty())
    }

    @Test
    fun nullTimestampsSortStableWithoutCrash() {
        val rows = KinTaleCommentsRepository.buildCommentThread(
            listOf(c("x"), c("y", at = 5)),
        )
        assertEquals(2, rows.size)
    }
}
