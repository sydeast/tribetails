package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.notificationTargetRoute
import com.tribetails.auntieos.ui.sessionIdForVisit
import com.tribetails.auntieos.ui.visitIdForSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Step 4: the pure decisions behind the per-notification quick actions.
 *   - [applicableNotificationActions] decides which buttons (Open / Approve / Deny)
 *     a row shows from its targetType / targetId.
 *   - [notificationTargetRoute] maps targetType / targetId to a nav route for the
 *     "open linked item" action.
 * Both are pure so the action wiring is exhaustively testable without Firebase or
 * a live NavController.
 */
class NotificationQuickActionsTest {

    // ── applicableNotificationActions ────────────────────────────────────────────

    @Test fun `booking target enables open AND approve-deny`() {
        val a = applicableNotificationActions("booking", "bk-1")
        assertTrue(a.canOpen)
        assertTrue(a.canApproveDeny)
    }

    @Test fun `invoice target enables open but not approve-deny`() {
        val a = applicableNotificationActions("invoice", "inv-1")
        assertTrue(a.canOpen)
        assertFalse(a.canApproveDeny)
    }

    @Test fun `kintale and kinfolk targets enable open only`() {
        assertTrue(applicableNotificationActions("kintale", "rpt-1").canOpen)
        assertFalse(applicableNotificationActions("kintale", "rpt-1").canApproveDeny)
        assertTrue(applicableNotificationActions("kinfolk", "kf-1").canOpen)
        assertFalse(applicableNotificationActions("kinfolk", "kf-1").canApproveDeny)
    }

    @Test fun `unknown type or blank id enables neither`() {
        assertFalse(applicableNotificationActions("", "x").canOpen)
        assertFalse(applicableNotificationActions("system", "x").canOpen)
        assertFalse(applicableNotificationActions("booking", "").canOpen)
        assertFalse(applicableNotificationActions("booking", "   ").canApproveDeny)
    }

    @Test fun `type match is case and whitespace insensitive`() {
        val a = applicableNotificationActions(" Booking ", "bk-1")
        assertTrue(a.canOpen)
        assertTrue(a.canApproveDeny)
    }

    @Test fun `kinfolk target enables create-quote`() {
        assertTrue(applicableNotificationActions("kinfolk", "kf-1").canCreateQuote)
        assertFalse(applicableNotificationActions("invoice", "inv-1").canCreateQuote)
        assertFalse(applicableNotificationActions("booking", "bk-1").canCreateQuote)
        assertFalse(applicableNotificationActions("kinfolk", "").canCreateQuote)
    }

    // ── notificationTargetRoute ──────────────────────────────────────────────────

    // ISSUE #389. This used to pass the BARE envelope visit id into
    // KinCareDetail, which matches it against `kin_care_sessions` ids, and
    // those carry the `vis_` prefix, so it never matched and the screen showed
    // "not found" for a visit that exists.
    @Test fun `booking routes to kin care detail on the DERIVED session id`() {
        assertEquals("kin_care_detail/vis_bk-1", notificationTargetRoute("booking", "bk-1"))
    }

    @Test fun `booking leaves a targetId that is already a session id alone`() {
        assertEquals("kin_care_detail/vis_bk-1", notificationTargetRoute("booking", "vis_bk-1"))
    }

    @Test fun `invoice routes to invoice detail`() {
        assertEquals("invoice_detail/inv-1", notificationTargetRoute("invoice", "inv-1"))
    }

    @Test fun `kinfolk routes to kinfolk profile`() {
        assertEquals("kinfolk_profile/kf-1", notificationTargetRoute("kinfolk", "kf-1"))
    }

    // ISSUE #389. This used to drop the id and open the logs LIST, which is the
    // operator's complaint verbatim: the button opened the feature instead of
    // the record. Android has no route keyed by report id alone, so one was
    // added, and it resolves the report's session and opens that report.
    @Test fun `kintale routes to the report itself, carrying its id`() {
        assertEquals("kintale_report/rpt-1", notificationTargetRoute("kintale", "rpt-1"))
    }

    @Test fun `unknown type or blank id routes nowhere`() {
        assertNull(notificationTargetRoute("system", "x"))
        assertNull(notificationTargetRoute("", "x"))
        assertNull(notificationTargetRoute("invoice", ""))
        assertNull(notificationTargetRoute("booking", "   "))
    }

    // ── the visit-id / session-id bridge ─────────────────────────────────────────
    // Mirrors `sessionIdForVisit` / `visitIdForSession` in the React admin's
    // `src/api/bookings.ts`, pinned by the same cases in `api/bookingIds.test.ts`.
    // The session doc is minted at `vis_{visitId}` by approveBookingSeriesCore.ts
    // and re-derived by manageBookingSeries.ts and batchUpdateBookings.ts.

    @Test fun `prefixes a bare envelope visit id`() {
        assertEquals("vis_v123", sessionIdForVisit("v123"))
    }

    @Test fun `recovers the visit id from a session id`() {
        assertEquals("v123", visitIdForSession("vis_v123"))
    }

    @Test fun `round-trips a visit id through the session id and back`() {
        for (visitId in listOf("v123", "abc-def", "VIS_upper", "vis", "9", "visit_1")) {
            assertEquals(visitId, visitIdForSession(sessionIdForVisit(visitId)))
        }
    }

    @Test fun `round-trips a session id through the visit id and back`() {
        for (sessionId in listOf("vis_v123", "vis_abc-def", "vis_9")) {
            assertEquals(sessionId, sessionIdForVisit(visitIdForSession(sessionId)))
        }
    }

    @Test fun `deriving twice cannot double the prefix`() {
        assertEquals("vis_v123", sessionIdForVisit(sessionIdForVisit("v123")))
    }

    @Test fun `leaves an unprefixed session id alone rather than inventing a visit id`() {
        assertEquals("ad-hoc-session", visitIdForSession("ad-hoc-session"))
    }

    @Test fun `trims, and answers a blank id with a blank id rather than a bare prefix`() {
        assertEquals("vis_v123", sessionIdForVisit("  v123  "))
        assertEquals("", sessionIdForVisit(""))
        assertEquals("", sessionIdForVisit("   "))
    }

    // ── archived filter (Step 4) ─────────────────────────────────────────────────
    // The default inbox hides archived notifications. The repository filters them out
    // (archivedAt non-blank => archived); this guards the predicate the screen relies on.

    @Test fun `archivedAt marker means archived`() {
        val active = NotificationEntry(id = "n1", archivedAt = null)
        val alsoActive = NotificationEntry(id = "n2", archivedAt = "")
        val archived = NotificationEntry(id = "n3", archivedAt = "2026-06-05T10:00:00Z")
        val visible = listOf(active, alsoActive, archived).filter { it.archivedAt.isNullOrBlank() }
        assertEquals(listOf("n1", "n2"), visible.map { it.id })
    }
}
