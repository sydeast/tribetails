package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.repository.KinRemovalRequestRow
import com.tribetails.auntieos.ui.Screen
import com.tribetails.auntieos.ui.directory.KinRemovalQueueState
import com.tribetails.auntieos.ui.directory.kinRemovalAnsweredElsewhere
import com.tribetails.auntieos.ui.notificationOpenRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1912: the `kin.removal.requested` notice targets the household on the
 * server, but Open takes the Admin to the removal requests, where the request
 * can be archived or declined. Every other key keeps its target routing.
 */
class NotificationKinRemovalRouteTest {

    private fun removal(data: Map<String, Any?> = mapOf("kinfolkId" to "fam1", "kinId" to "k1", "flatKinId" to "flat1", "requestId" to "fam1_k1")) =
        NotificationEntry(id = "n1", key = "kin.removal.requested", targetType = "kinfolk", targetId = "fam1", data = data)

    private fun row(id: String) = KinRemovalRequestRow(
        id = id,
        kinfolkId = "fam1",
        kinId = "k1",
        flatKinId = "flat1",
        kinName = "Biscuit",
        reason = null,
        status = "pending",
        requestedAtMs = 1_793_620_800_000L,
        resolvedAtMs = null,
        resolutionNote = null,
    )

    @Test
    fun `the removal notice opens the requests screen on its request`() {
        assertEquals("fam1_k1", kinRemovalNoticeRequestId(removal()))
        assertEquals("kin_removal_requests/fam1_k1", notificationOpenRoute(removal()))
        assertEquals(Screen.KinRemovalRequests.createRoute("fam1_k1"), notificationOpenRoute(removal()))
        assertTrue(applicableNotificationActions(removal()).canOpen)
    }

    @Test
    fun `a Kin with no admin record yet still opens the requests screen`() {
        val e = removal(mapOf("kinfolkId" to "fam1", "kinId" to "k1", "flatKinId" to null, "requestId" to "fam1_k1"))
        assertEquals(Screen.KinRemovalRequests.createRoute("fam1_k1"), notificationOpenRoute(e))
    }

    @Test
    fun `with no request named it falls back to the household`() {
        val e = removal(mapOf("kinfolkId" to "fam1"))
        assertNull(kinRemovalNoticeRequestId(e))
        assertEquals(Screen.KinfolkProfile.createRoute("fam1"), notificationOpenRoute(e))
    }

    @Test
    fun `the answers the household hears keep their own target`() {
        val declined = NotificationEntry(
            id = "n2", key = "kin.removal.declined", targetType = "kinfolk", targetId = "fam1",
            data = mapOf("requestId" to "fam1_k1"),
        )
        assertNull(kinRemovalNoticeRequestId(declined))
        assertEquals(Screen.KinfolkProfile.createRoute("fam1"), notificationOpenRoute(declined))
    }

    @Test
    fun `a request answered before arrival is said so, once the read has finished`() {
        val loaded = KinRemovalQueueState(loading = false, requests = listOf(row("fam2_k9")), loadedIds = setOf("fam2_k9"))
        assertTrue(kinRemovalAnsweredElsewhere(loaded, "fam1_k1"))
        assertFalse(kinRemovalAnsweredElsewhere(loaded, "fam2_k9"))
    }

    @Test
    fun `loading, a failed read and a request answered on this screen are not answered elsewhere`() {
        assertFalse(kinRemovalAnsweredElsewhere(KinRemovalQueueState(loading = true), "fam1_k1"))
        assertFalse(kinRemovalAnsweredElsewhere(KinRemovalQueueState(loading = false, error = "offline"), "fam1_k1"))
        // Answered here: the row has left `requests` but the read did return it.
        val answeredHere = KinRemovalQueueState(loading = false, requests = emptyList(), loadedIds = setOf("fam1_k1"))
        assertFalse(kinRemovalAnsweredElsewhere(answeredHere, "fam1_k1"))
        assertFalse(kinRemovalAnsweredElsewhere(KinRemovalQueueState(loading = false), ""))
    }
}
