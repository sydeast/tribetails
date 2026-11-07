package com.tribetails.auntieos.web.screens.activity
/**
 * The Activity Log's filter chips: the mock's six plus Billing (#1613).
 *
 * A category is a PARTITION: every action type lands under exactly one chip, the
 * first rule below that claims it, so the filter and the row's tile cannot
 * disagree and a billing event cannot sit under KinTales. It used to be a set of
 * overlapping substring questions ("DRAFT" was KinTales, so
 * BILLING_DRAFT_INVOICE_SENT filed there) and Admin matched almost nothing,
 * because the real admin events (THEME_*, MEMBERSHIP_*, PERM_*, RETENTION_*, ...)
 * were never listed. The admin web and the other Kotlin client carry the same
 * rules in the same order (`activityCategoryOf` in `auntieos-admin/src/lib/activityDetail.ts`);
 * change all three together.
 */
internal enum class ActivityCategory { Auth, Bookings, KinTales, Notifications, Billing, Admin }
private fun String.startsWithAny(vararg prefixes: String) = prefixes.any { startsWith(it) }
private fun String.containsAny(vararg needles: String) = needles.any { contains(it) }
private val ADMIN_PREFIXES = arrayOf(
    "ADMIN", "UPDATE_SETTINGS", "SETTINGS", "THEME_", "MEMBERSHIP_", "PERM_", "SAVE_FORM_SCHEMA",
    "DELETE_FORM_SCHEMA", "BUSINESS_", "BRANDING_", "EMAIL_FRAME_", "VET_CLINIC_", "CREATE_KINFOLK",
    "ARCHIVE_KIN", "RESTORE_KIN", "KIN_REMOVAL", "CREATE_TRAINING", "UPDATE_TRAINING", "DELETE_TRAINING",
    "SUPPL", "EXPIRATION_", "INTEGRATION_", "AUDIENCE_SEGMENT", "EXTERNAL_SUPPRESSION", "OPERATOR_",
    "RETENTION_", "ERROR_", "PROFILE_", "HOME_ACCESS", "EMERGENCY_CONTACT",
)
/** The one category an action belongs to, or null when nothing claims it (it still shows under All). First match wins; money goes first. */
internal fun activityCategoryOf(actionType: String): ActivityCategory? {
    val a = actionType.uppercase()
    return when {
        a.startsWithAny("BILLING_", "EXPENSE_") || a.containsAny("INVOICE", "PAYMENT", "QUOTE") -> ActivityCategory.Billing
        a.startsWithAny("AUTH", "SECRETS_") || a.containsAny("LOGIN", "LOGOUT") -> ActivityCategory.Auth
        a.containsAny("NOTIFICATION", "NOTIF") ||
            a.startsWithAny("CONVERSATION", "EXTERNAL_MESSAGE", "BROADCAST", "MARKETING_BLAST") -> ActivityCategory.Notifications
        a.startsWithAny(*ADMIN_PREFIXES) || a.contains("TRIAGE") -> ActivityCategory.Admin
        a.startsWithAny("CONTENT_", "MEDIA_") || a.containsAny("KINTALE", "TALE_", "DRAFT", "REPORT") -> ActivityCategory.KinTales
        a.containsAny("BOOKING", "KINCARE", "SESSION", "VISIT", "RESCHEDULE", "BLOCKED_TIME_SLOT", "CANCEL_REQUEST") -> ActivityCategory.Bookings
        else -> null
    }
}
