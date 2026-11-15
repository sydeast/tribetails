package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportLookup
import com.tribetails.auntieos.web.screens.kintales.kinTaleReportLookup
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2099: Open on a visit notification shows that visit, not the Bookings list.
 * #2355: Open on a KinTale notification finds the KinTale by its report.
 */
class NotificationTargetScreenTest {

    @Test
    fun aVisitNotificationOpensThatVisitsKinCareDetail() {
        // The notification carries the visit id; the detail screen matches the session id.
        assertEquals(NotificationTargetScreen.Visit("vis_v1"), notificationTargetScreen("booking", "v1"))
        assertEquals(NotificationTargetScreen.Visit("vis_v1"), notificationTargetScreen(" Booking ", " v1 "))
        // An id that already is a session id is not prefixed twice.
        assertEquals(NotificationTargetScreen.Visit("vis_v1"), notificationTargetScreen("booking", "vis_v1"))
    }

    @Test
    fun theVisitOpensWhateverItsStatus() {
        // Nothing about the status is consulted: a cancelled or completed visit opens the same way.
        val entry = NotificationEntry(key = "kincare.booking.cancel", targetType = "booking", targetId = "v9")
        val route = notificationOpenRoute(entry) as NotificationOpenRoute.Target
        assertEquals(NotificationTargetScreen.Visit("vis_v9"), notificationTargetScreen(route.targetType, route.targetId))
    }

    @Test
    fun theOtherTargetsKeepTheirScreens() {
        assertEquals(NotificationTargetScreen.Invoice("inv1"), notificationTargetScreen("invoice", "inv1"))
        assertEquals(NotificationTargetScreen.KinTale("rep1"), notificationTargetScreen("kintale", "rep1"))
        assertEquals(NotificationTargetScreen.Household("fam1"), notificationTargetScreen("kinfolk", "fam1"))
    }

    @Test
    fun anUnknownKindOrAMissingIdOpensNothing() {
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("booking", ""))
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("booking", "   "))
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("", "v1"))
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("dossier", "d1"))
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("https://evil.example", "x"))
        assertEquals(NotificationTargetScreen.None, notificationTargetScreen("settings", "x"))
    }

    // ---- #2355: the KinTale, found by its report ----

    private val reports = listOf(
        KinCareReport(_id = "rep1", sessionId = "vis_v1"),
        KinCareReport(_id = "rep2", sessionId = "vis_v1"),
        KinCareReport(_id = "orphan", sessionId = ""),
    )

    @Test
    fun aKinTaleNotificationOpensItsVisitOnThatKinTale() {
        assertEquals(KinTaleReportLookup.Found("vis_v1", "rep2"), kinTaleReportLookup(FirestoreResult.Data(reports), "rep2"))
    }

    @Test
    fun aKinTaleThatIsGoneIsMissingNotLoadingForever() {
        assertEquals(KinTaleReportLookup.Missing, kinTaleReportLookup(FirestoreResult.Data(reports), "rep-gone"))
        assertEquals(KinTaleReportLookup.Missing, kinTaleReportLookup(FirestoreResult.Data(reports), ""))
        assertEquals(KinTaleReportLookup.Missing, kinTaleReportLookup(FirestoreResult.Data(emptyList()), "rep1"))
        // A report with no visit behind it has no screen to open.
        assertEquals(KinTaleReportLookup.Missing, kinTaleReportLookup(FirestoreResult.Data(reports), "orphan"))
    }

    @Test
    fun aReadStillRunningOrFailedSaysSo() {
        assertEquals(KinTaleReportLookup.Loading, kinTaleReportLookup(FirestoreResult.Loading, "rep1"))
        assertEquals(KinTaleReportLookup.Failed("offline"), kinTaleReportLookup(FirestoreResult.Error("offline"), "rep1"))
    }
}
