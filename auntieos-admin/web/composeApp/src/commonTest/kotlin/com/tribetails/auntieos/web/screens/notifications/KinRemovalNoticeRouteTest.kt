package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2121: Open on "Kinfolk asked to remove a Kin" landed on the household
 * profile, where the request cannot be answered. It opens the waiting removal
 * requests on Bookings with that one marked, as admin web does
 * (`/bookings?kinRemoval=`).
 */
class KinRemovalNoticeRouteTest {
    private fun notice(requestId: String?) = NotificationEntry(
        _id = "n1",
        key = "kin.removal.requested",
        title = "Kinfolk asked to remove a Kin",
        targetType = "kinfolk",
        targetId = "kf1",
        data = buildJsonObject {
            put("kinfolkId", JsonPrimitive("kf1"))
            put("kinId", JsonPrimitive("k1"))
            requestId?.let { put("requestId", JsonPrimitive(it)) }
        },
    )

    @Test
    fun openGoesToTheRemovalRequestNotTheHousehold() {
        assertEquals(NotificationOpenRoute.KinRemoval("kf1_k1"), notificationOpenRoute(notice("kf1_k1")))
        assertTrue(NotificationAction.OpenTarget in applicableActions(notice("kf1_k1")))
    }

    @Test
    fun withNoRequestIdTheRowKeepsItsHouseholdTarget() {
        assertEquals(NotificationOpenRoute.Target("kinfolk", "kf1"), notificationOpenRoute(notice(null)))
        assertEquals(NotificationOpenRoute.Target("kinfolk", "kf1"), notificationOpenRoute(notice("  ")))
    }

    @Test
    fun anIdThatIsNotAPlainIdNeverBuildsARoute() {
        assertEquals(NotificationOpenRoute.Target("kinfolk", "kf1"), notificationOpenRoute(notice("kf1/k1?x")))
    }

    @Test
    fun anotherKeyWithARequestIdIsUntouched() {
        val other = notice("kf1_k1").copy(key = "kin.removal.declined")
        assertEquals(NotificationOpenRoute.Target("kinfolk", "kf1"), notificationOpenRoute(other))
    }
}
