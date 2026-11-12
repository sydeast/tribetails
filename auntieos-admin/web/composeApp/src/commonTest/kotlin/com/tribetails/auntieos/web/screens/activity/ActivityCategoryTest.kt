package com.tribetails.auntieos.web.screens.activity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1613: Admin was always empty, there was no Billing filter, and a billing event sat under
 * KinTales. Real action types the server writes, pinned to the one chip each belongs to.
 * The admin web test (`activityDetail.test.ts`) pins the same table and also checks that every
 * event in `auditEvents.ts` is claimed.
 */
class ActivityCategoryTest {
    private fun check(expected: ActivityCategory, vararg actions: String) {
        actions.forEach { assertEquals(expected, activityCategoryOf(it), it) }
    }
    @Test
    fun billingEventsAreBilling() = check(
        ActivityCategory.Billing,
        "BILLING_DRAFT_INVOICE_SENT", "BILLING_SESSION_DO_NOT_INVOICE_SET", "BILLING_PAYMENT_RECORDED",
        "BILLING_QUOTE_ACCEPTED", "EXPENSE_LOGGED",
    )
    @Test
    fun adminHoldsTheSettingsMembershipPermissionAndRetentionEvents() = check(
        ActivityCategory.Admin,
        "THEME_BRAND_TOKENS_UPDATED", "MEMBERSHIP_INVITE_SENT", "PERM_GRANTED", "RETENTION_DRAFTS_PURGED",
        "ADMIN_FEATURE_FLAGS_UPDATED", "SAVE_FORM_SCHEMA", "CREATE_KINFOLK", "INTEGRATION_CALENDAR_PUSH",
        "VET_CLINIC_UPDATED", "UPDATE_SETTINGS", "TRIAGE_ORPHAN_REPORT_ASSIGN", "ADMIN_TRIAGE_ORPHAN_REPORT",
    )
    @Test
    fun theOtherChipsKeepTheirOwnEvents() {
        check(ActivityCategory.Auth, "AUTH_LOGIN_SUCCESS", "LOGIN", "SECRETS_TRIBEPIN_SET")
        check(ActivityCategory.Bookings, "BOOKING_SUBMITTED", "KINCARE_ARRIVED", "RESCHEDULE_BOOKING", "CREATE_BLOCKED_TIME_SLOT", "VISIT_LIFECYCLE_SET")
        check(ActivityCategory.KinTales, "CONTENT_KINTALE_PHOTO_UPLOADED", "AI_TALE_TITLES_APPLIED", "MEDIA_FILE_DELETED", "DRAFT_APPROVED")
        check(ActivityCategory.Notifications, "NOTIFICATION_VIEWED", "BROADCAST_SENT", "CONVERSATION_REPLIED", "MARKETING_BLAST_SCHEDULED")
    }
    /** #1820: the keys declared ahead of their writers. CREATE_KIN and UPDATE_KIN are exact, so a visit stays under Bookings. */
    @Test
    fun theKeysDeclaredAheadOfTheirWritersAreFiled() {
        check(
            ActivityCategory.Admin,
            "UPDATE_KINFOLK", "UPDATE_KINFOLK_TAGS", "ARCHIVE_KINFOLK", "RESTORE_KINFOLK", "CREATE_KIN", "UPDATE_KIN",
            "UPDATE_KIN_TAGS", "SECONDARY_KINFOLK_SAVED", "SECONDARY_KINFOLK_REMOVED", "HOUSEHOLD_DATA_SAVED",
            "TEMPLATE_SAVED", "TEMPLATE_DELETED", "TEMPLATE_ASSIGNED", "TEMPLATE_UNASSIGNED", "TEMPLATE_CONVERTED",
        )
        check(ActivityCategory.KinTales, "CONTENT_KINTALE_SENT", "KINTALE_TEMPLATE_SAVED", "KINTALE_TEMPLATE_DELETED")
        check(
            ActivityCategory.Bookings,
            "VISIT_ON_MY_WAY", "VISIT_ARRIVED", "VISIT_DEPARTED", "VISIT_UNDO_ARRIVAL",
            "CREATE_KINCARE_SESSION", "UPDATE_KINCARE_SESSION",
        )
        check(ActivityCategory.Notifications, "NOTIFICATION_NOT_SENT", "NOTIFICATION_MARKED_UNREAD")
        check(ActivityCategory.Billing, "BILLING_PAYMENT_PARTIAL")
    }
    @Test
    fun anActionNothingClaimsHasNoCategory() {
        assertNull(activityCategoryOf("RECONCILE_RUN"))
        assertNull(activityCategoryOf(""))
    }
    @Test
    fun aBillingEventIsNeverUnderKinTales() {
        assertEquals(ActivityCategory.Billing, activityCategoryOf("BILLING_DRAFT_INVOICE_SENT"))
    }
}
