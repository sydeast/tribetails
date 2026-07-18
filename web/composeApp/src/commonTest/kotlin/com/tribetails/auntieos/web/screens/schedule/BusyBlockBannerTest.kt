package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.TestMode
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #4 (2026-06-08): the "Couldn't load busy blocks" banner fired even when Google
 * Calendar sync was never configured, because the booking_time_slots read was
 * denied (no rule) and the error surfaced unconditionally. The banner must only
 * show when calendar sync is set up AND the stream errored.
 */
class BusyBlockBannerTest {

    @Test fun `no banner when calendar sync not configured even on error`() {
        assertFalse(
            shouldShowBusyBlockError(
                calendarSyncConfigured = false,
                busyState = FirestoreResult.Error("Missing or insufficient permissions"),
            ),
        )
    }

    @Test fun `no banner when configured but stream is loading or data`() {
        assertFalse(shouldShowBusyBlockError(true, FirestoreResult.Loading))
        assertFalse(shouldShowBusyBlockError(true, FirestoreResult.Data(emptyList<String>())))
    }

    @Test fun `banner only when configured and errored`() {
        assertTrue(
            shouldShowBusyBlockError(
                calendarSyncConfigured = true,
                busyState = FirestoreResult.Error("network unreachable"),
            ),
        )
    }

    // Stage-0I sandbox: booking_time_slots is a global collection a test admin cannot
    // read, yet calendarSyncId may still resolve (configured = true). The banner must
    // stay suppressed for a test admin — there is no sandbox equivalent to load.
    @Test fun `no banner in the sandbox even when configured and errored`() {
        assertFalse(
            shouldShowBusyBlockError(
                calendarSyncConfigured = true,
                busyState = FirestoreResult.Error("Missing or insufficient permissions"),
                testMode = TestMode(active = true, testTribeId = "test-kinfolk-001"),
            ),
        )
    }

    @Test fun `banner still shows for a normal admin when test mode is OFF`() {
        assertTrue(
            shouldShowBusyBlockError(true, FirestoreResult.Error("boom"), TestMode.OFF),
        )
    }
}
