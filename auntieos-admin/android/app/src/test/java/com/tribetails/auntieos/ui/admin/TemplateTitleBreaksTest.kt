package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/** #1889: a key shown as a title wraps at its separators, and nothing else changes. */
class TemplateTitleBreaksTest {
    @Test fun `a key gets a break after each separator`() {
        assertEquals(
            "security.\u200BfailedLogin.\u200Battempts.\u200Boperator",
            titleWithBreaks("security.failedLogin.attempts.operator"),
        )
    }

    @Test fun `the words read the same once the breaks are removed`() {
        val key = "invoice-paid_notice.operator"
        assertEquals(key, titleWithBreaks(key).replace("\u200B", ""))
    }

    @Test fun `a title with spaces and a trailing separator are left alone`() {
        assertEquals("Visit reminder v1.2", titleWithBreaks("Visit reminder v1.2"))
        assertEquals("draft.", titleWithBreaks("draft."))
    }
}
