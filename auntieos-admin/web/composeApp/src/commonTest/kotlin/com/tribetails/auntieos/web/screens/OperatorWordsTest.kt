package com.tribetails.auntieos.web.screens

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/** #1592: the operator reads words, never a stored key. The web and Android rules exactly. */
class OperatorWordsTest {

    @Test
    fun notificationHeadlineReadsTheKeyAsWordsWhenThereIsNoTitle() {
        assertEquals("Account welcome kinfolk", notificationHeadline("account.welcome.kinfolk", ""))
        assertEquals("Account welcome kinfolk", notificationHeadline("account.welcome.kinfolk", "account.welcome.kinfolk"))
        assertEquals("Welcome to MyTribe", notificationHeadline("account.welcome.kinfolk", "Welcome to MyTribe"))
        assertEquals("Notification", notificationHeadline("", ""))
    }

    @Test
    fun categoriesReadAsWords() {
        assertEquals("Visits", notificationCategoryLabel("visit"))
        assertEquals("Billing", notificationCategoryLabel("invoice"))
        assertEquals("Other", notificationCategoryLabel(""))
        assertEquals("Other", notificationCategoryLabel("uncategorized"))
        assertEquals("Booking requests", notificationCategoryLabel("booking_requests"))
    }

    @Test
    fun appliesToAndSchemaCountReadAsPlainPhrases() {
        assertEquals("Nothing yet", appliesToLabel("NONE"))
        assertEquals("KinTales", appliesToLabel("KINTALE"))
        assertEquals("Tribe profile", appliesToLabel("TRIBE_PROFILE"))
        assertEquals("1 schema", schemaCountLabel(1))
        assertEquals("3 schemas", schemaCountLabel(3))
    }

    @Test
    fun serviceKeysReadAsTheOperatorsKinCareName() {
        val rates = mapOf("30Minute" to "25", "60Minute" to "45")
        assertEquals("30Minute", bookingServiceName("30minute", rates))
        assertEquals("60Minute", bookingServiceName("visit_60", rates))
        assertEquals("60Minute", bookingServiceName("60Mins", rates))
        assertEquals("visit_60", bookingServiceName("visit_60", rates + ("Dog Walk 60Min" to "40")))
        assertEquals("Off-Book Visit", bookingServiceName("Off-Book Visit", rates))
        assertEquals("Visit", bookingServiceName(" ", rates))
        assertEquals("visit_60", bookingServiceName("visit_60", null))
    }

    @Test
    fun `#1592 template preview hint and activity time warning name no machinery`() {
        val marks = listOf("Firestore", "Timestamp", "audit writer", "SendGrid", "dumb pipe", "ISO-8601")
        val note = unreadableTimesNote(2, 40)
        for (text in listOf(TEMPLATE_PREVIEW_HINT, note)) {
            for (m in marks) assertFalse(text.contains(m), "\"$text\" carries \"$m\"")
        }
        assertEquals(
            "2 of 40 entries have a time this screen cannot read, so their day and order below are a best guess.",
            note,
        )
    }
}
