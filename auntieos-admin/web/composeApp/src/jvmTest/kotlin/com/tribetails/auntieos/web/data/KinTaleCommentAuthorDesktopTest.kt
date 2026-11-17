package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.screens.kintales.kinTaleCommentAuthorLabel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * #1923: the desktop console reads the thread through the getKinTaleComments
 * callable, which names each author on the server. Before this it dropped the
 * name it was sent and printed "Kinfolk" for every household reply.
 */
class KinTaleCommentAuthorDesktopTest {
    private val callableResult = """
        {"comments":[
          {"id":"c2","authorRole":"admin","authorUid":"a1","authorDisplayName":"Maya","guestName":null,
           "body":"reply","parentCommentId":"c1","createdAtMs":2},
          {"id":"c1","authorRole":"kinfolk","authorUid":"k1","authorDisplayName":"Casey","authorNameIsPerson":true,
           "guestName":null,"body":"<b>so</b> good, see you at the <side gate>","parentCommentId":null,"createdAtMs":1},
          {"id":"c3","authorRole":"kinfolk","authorUid":"k2","authorDisplayName":"A member of the household",
           "authorNameIsPerson":false,"guestName":null,"body":"hi","parentCommentId":null,"createdAtMs":3},
          {"id":"c4","authorRole":"guest","authorUid":null,"authorDisplayName":"Grandma Rose","guestName":"Grandma Rose",
           "body":"cute","parentCommentId":null,"createdAtMs":4},
          {"id":"c5","authorRole":"kinfolk","authorUid":"k3","authorDisplayName":" ","guestName":null,
           "body":"old","parentCommentId":null,"createdAtMs":5}
        ]}
    """.trimIndent()

    @Test
    fun parse_keepsTheServerName_andTheBodyAsTyped() {
        val comments = parseCommentsResult(callableResult)
        assertEquals(listOf("c1", "c2", "c3", "c4", "c5"), comments.map { it._id })
        assertEquals(listOf("Casey", "Maya", "A member of the household", "Grandma Rose", null), comments.map { it.authorDisplayName })
        assertEquals("<b>so</b> good, see you at the <side gate>", comments[0].body)
    }

    @Test
    fun label_REGRESSION_householdReplyReadsByName_notKinfolk() {
        val labels = parseCommentsResult(callableResult).map(::kinTaleCommentAuthorLabel)
        assertEquals(listOf("Casey", "Auntie", "A member of the household", "Grandma Rose", "Kinfolk"), labels)
        labels.forEach { assertFalse(it.contains('@'), "an email reached the label: $it") }
    }

    @Test
    fun label_guestFallsBackToTypedName_thenGuest() {
        assertEquals("Pat", kinTaleCommentAuthorLabel(KinTaleComment(authorRole = "guest", guestName = "Pat")))
        assertEquals("Guest", kinTaleCommentAuthorLabel(KinTaleComment(authorRole = "guest")))
    }

    @Test
    fun parse_emptyOrMissingComments_isEmpty() {
        assertEquals(emptyList(), parseCommentsResult("""{"comments":[]}"""))
        assertEquals(emptyList(), parseCommentsResult("""{}"""))
        assertNull(KinTaleComment().authorDisplayName)
    }
}
