package com.tribetails.auntieos.web.data

import kotlinx.coroutines.test.runTest
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1837: the desktop Notifications screen reads the signed-in staff member's
 * own notifications and nobody else's.
 *
 * The read used to list the whole collection and filter in memory, keeping
 * every row when there was no uid. These pin the three things that replaced
 * it: the query is asked for one recipient, no uid means no rows and no query,
 * and a row addressed to someone else never reaches the screen.
 */
class OwnNotificationsTest {

    private fun row(id: String, recipientUid: String) =
        NotificationEntry(_id = id, key = "kincare.requested", recipientUid = recipientUid)

    @Test
    fun `asks for the signed-in uid and returns those rows`() = runTest {
        val asked = mutableListOf<String>()
        val rows = ownNotifications("staff-1") { uid ->
            asked += uid
            listOf(row("a", "staff-1"), row("b", "staff-1"))
        }
        assertEquals(listOf("staff-1"), asked)
        assertEquals(listOf("a", "b"), rows.map { it._id })
    }

    @Test
    fun `no uid means no rows and no query`() = runTest {
        for (uid in listOf(null, "", "   ")) {
            var queried = false
            val rows = ownNotifications(uid) {
                queried = true
                listOf(row("household", "kin-a"))
            }
            assertTrue(rows.isEmpty(), "uid=<$uid> must show nothing")
            assertFalse(queried, "uid=<$uid> must not query at all")
        }
    }

    @Test
    fun `a row addressed to a household or another staff member is dropped`() = runTest {
        val rows = ownNotifications("staff-1") {
            listOf(
                row("mine", "staff-1"),
                row("household", "kin-a"),
                row("other-staff", "staff-2"),
                row("no-recipient", ""),
            )
        }
        assertEquals(listOf("mine"), rows.map { it._id })
    }

    /**
     * The stream itself has to send the predicate to the server. An in-memory
     * filter over a whole-collection list is what the rules now deny, so the
     * source is pinned: the notifications read goes through `listWhereEq` on
     * `recipientUid` and never through the unfiltered `list`.
     */
    @Test
    fun `the stream queries by recipientUid on the server`() {
        val source = listOf(
            "src/jvmMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.jvm.kt",
            "composeApp/src/jvmMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.jvm.kt",
        ).map(::File).first { it.exists() }.readText()
        val body = source
            .substringAfter("internal actual fun platformNotificationsStream()")
            .substringBefore("internal actual fun platformDossierStream")
        assertTrue(
            body.contains("""listWhereEq<NotificationEntry>("notifications", "recipientUid", uid)"""),
            "the notifications stream must query recipientUid == uid server-side",
        )
        assertFalse(
            body.contains("""list<NotificationEntry>("notifications")"""),
            "the notifications stream must not list the whole collection",
        )
    }
}
