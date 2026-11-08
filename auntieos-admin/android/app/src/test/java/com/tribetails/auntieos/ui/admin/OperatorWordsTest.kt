package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1592: the operator reads words, never a stored key. Mirrors the web build's
 * `notificationsFeed.ts`, `activityDetail.ts` and `formSchemaFormat.ts` helpers
 * so the two clients say the same thing.
 */
class OperatorWordsTest {

    @Test fun `humanizeKey splits dots, underscores and dashes`() {
        assertEquals("Account welcome kinfolk", humanizeKey("account.welcome.kinfolk"))
        assertEquals("Visit 60", humanizeKey("visit_60"))
        assertEquals("", humanizeKey("  "))
    }

    @Test fun `notification categories read as words, not slugs`() {
        assertEquals("Visits", notificationCategoryLabel("visit"))
        assertEquals("Billing", notificationCategoryLabel("invoice"))
        assertEquals("KinTales", notificationCategoryLabel("kintale"))
        assertEquals("Other", notificationCategoryLabel(""))
        assertEquals("Other", notificationCategoryLabel("uncategorized"))
        assertEquals("Booking requests", notificationCategoryLabel("booking_requests"))
    }

    @Test fun `actor roles read as words, staff never as AUNTIE`() {
        assertEquals("Staff", actorRoleLabel("AUNTIE"))
        assertEquals("Primary kinfolk", actorRoleLabel("PRIMARY"))
        assertEquals("Secondary kinfolk", actorRoleLabel("SECONDARY"))
        assertEquals("System", actorRoleLabel("SYSTEM"))
        assertEquals("", actorRoleLabel(""))
        assertEquals("Some new role", actorRoleLabel("SOME_NEW_ROLE"))
    }

    @Test fun `form schema Applies to reads as a plain phrase`() {
        assertEquals("Nothing yet", appliesToLabel("NONE"))
        assertEquals("Kinfolk profiles", appliesToLabel("KINFOLK"))
        assertEquals("Kin profiles", appliesToLabel("KIN"))
        assertEquals("Households", appliesToLabel("HOUSEHOLD"))
        assertEquals("KinCare visits", appliesToLabel("SESSION"))
        assertEquals("Bookings", appliesToLabel("BOOKING"))
        assertEquals("KinTales", appliesToLabel("KINTALE"))
        assertEquals("Tribe profile", appliesToLabel("TRIBE_PROFILE"))
    }

    @Test fun `schema count is singular for one`() {
        assertEquals("1 schema", schemaCountLabel(1))
        assertEquals("2 schemas", schemaCountLabel(2))
    }
}
