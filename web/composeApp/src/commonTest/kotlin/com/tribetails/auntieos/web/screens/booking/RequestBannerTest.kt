package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.TestMode
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Stage-0I sandbox: the "Incoming requests" collectionGroup('kinCares') query spans
 * every tenant and is unreadable by a test admin (unlike flat kin_care_sessions,
 * which the client scopes). Its permission-denied must swap the red "Couldn't
 * load ..." banner for a neutral sandbox note; a normal admin still sees the red
 * error. Non-error states never show a banner.
 */
class RequestBannerTest {
    private val sandbox = TestMode(active = true, testTribeId = "test-kinfolk-001")

    @Test fun `no banner when the stream is loading or has data`() {
        assertEquals(RequestBanner.None, requestBanner(TestMode.OFF, FirestoreResult.Loading))
        assertEquals(RequestBanner.None, requestBanner(sandbox, FirestoreResult.Loading))
        assertEquals(RequestBanner.None, requestBanner(TestMode.OFF, FirestoreResult.Data(emptyList<String>())))
        assertEquals(RequestBanner.None, requestBanner(sandbox, FirestoreResult.Data(listOf("x"))))
    }

    @Test fun `red error for a normal admin on error`() {
        assertEquals(
            RequestBanner.Error,
            requestBanner(TestMode.OFF, FirestoreResult.Error("Missing or insufficient permissions")),
        )
    }

    @Test fun `sandbox note (not red error) for a test admin on error`() {
        assertEquals(
            RequestBanner.Sandbox,
            requestBanner(sandbox, FirestoreResult.Error("Missing or insufficient permissions")),
        )
    }
}
