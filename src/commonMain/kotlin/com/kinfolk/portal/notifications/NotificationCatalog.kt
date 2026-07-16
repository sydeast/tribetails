package com.kinfolk.portal.notifications

/**
 * Kinfolk-side mirror of the notification catalog.
 *
 * Source of truth: `MyTribe/functions/src/notifications/catalog.ts`. This
 * file is a hand-curated subset: only entries with `kinfolkFacing=true` and
 * `alwaysEnabled=false` are exposed in the kinfolk UI. Keep this file in sync
 * with the TS catalog whenever a kinfolk-facing notification is added.
 *
 * TODO(E5b): Replace this with a `getNotificationCatalog` callable so the UI
 * loads a filtered catalog at runtime, eliminating drift between codebases.
 *
 * Notification revamp note: the server now filters by audience and ALSO returns
 * always-on keys (booking confirmations, receipts, password reset, ...) with
 * every channel locked plus an operator lockReason. This static fallback is a
 * degraded fail-loud path and deliberately does NOT mirror those keys.
 */

enum class NotificationChannel(val id: String, val label: String) {
    EMAIL("email", "Email"),
    SMS("sms", "SMS"),
    PUSH("push", "Push"),
}

enum class MarketingCategory(val id: String, val label: String) {
    NEWSLETTER("newsletter", "Newsletters & Announcements"),
    SURVEY("survey", "Surveys & Community Events"),
    MARKETING("marketing", "Marketing & Promotions"),
}

data class NotificationKey(
    val key: String,
    val title: String,
    val description: String,
    val allowedChannels: Set<NotificationChannel>,
    val required: Set<NotificationChannel> = emptySet(),
    // Run-4 #13: channels the business admin LOCKED. Shown but read-only; the kinfolk
    // can't change them (the server also enforces this at dispatch).
    val lockedChannels: Set<NotificationChannel> = emptySet(),
    // Notification revamp: operator-authored reason why a locked/required
    // notification stays on. Shown on the key row in place of the default
    // "Required by Tribe Tails" line. Always null in the static fallback below;
    // operator prose only arrives via getNotificationCatalog.
    val lockReason: String? = null,
    val marketingCategory: MarketingCategory? = null,
)

data class CategoryDef(
    val id: String,
    val title: String,
    val description: String,
    val keys: List<NotificationKey>,
)

private val EMAIL = NotificationChannel.EMAIL
private val SMS = NotificationChannel.SMS
private val PUSH = NotificationChannel.PUSH
private val ALL = setOf(EMAIL, SMS, PUSH)
private val EMAIL_PUSH = setOf(EMAIL, PUSH)
private val EMAIL_ONLY = setOf(EMAIL)

val KINFOLK_CATEGORIES: List<CategoryDef> = listOf(
    CategoryDef(
        id = "visit",
        title = "Visit Updates",
        description = "Real-time status as your Auntie arrives, departs, or marks a visit unavailable.",
        keys = listOf(
            NotificationKey(
                key = "kincare.auntie.on_my_way",
                title = "Auntie On Her Way",
                description = "When your Auntie is en route to your KinCare visit.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.auntie.arrived",
                title = "Auntie Arrived",
                description = "When your Auntie checks in at the start of a visit.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.auntie.departed",
                title = "Auntie Departed",
                description = "When your Auntie wraps up and leaves.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.report.sent",
                title = "Visit Report Ready",
                description = "When your KinTale visit report is published.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.unavailable",
                title = "Visit Marked Unavailable",
                description = "Usually triggered when home access is blocked.",
                allowedChannels = ALL,
            ),
        ),
    ),
    CategoryDef(
        id = "kintale",
        title = "KinTales",
        description = "Daily stories, photos, and notes from your Auntie.",
        keys = listOf(
            NotificationKey(
                key = "kintale.published",
                title = "New KinTale Published",
                description = "When a new story posts to the app.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kintale.comment.added",
                title = "Comments Added",
                description = "Five-minute trailing digest of new comments on your KinTales.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "kintale.note.added",
                title = "Note Added to KinTale",
                description = "When your Auntie writes a note on the kinfolk-facing box of a KinTale.",
                allowedChannels = EMAIL_PUSH,
            ),
        ),
    ),
    CategoryDef(
        id = "invoice",
        title = "Invoices & Payments",
        description = "Invoice updates, reminders, and payment confirmations.",
        keys = listOf(
            NotificationKey(
                key = "invoice.updated",
                title = "Invoice Updated",
                description = "When an invoice or quote is updated.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "invoice.reminder",
                title = "Invoice Reminder",
                description = "Friendly reminder ahead of an invoice due date.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "invoice.payment.applied",
                title = "Payment Applied",
                description = "When a payment or credit is applied to an invoice.",
                allowedChannels = EMAIL_PUSH,
            ),
        ),
    ),
    CategoryDef(
        id = "schedule",
        title = "Upcoming Care",
        description = "Reminders for KinCare visits coming up on your calendar.",
        keys = listOf(
            NotificationKey(
                key = "kincare.upcoming.reminder",
                title = "Upcoming KinCare Reminder",
                description = "Default: 24–48 hours ahead. Adjustable per delivery channel.",
                allowedChannels = ALL,
            ),
        ),
    ),
    CategoryDef(
        id = "home",
        title = "Home & Pets",
        description = "Acknowledgements when your home information or pet records change.",
        keys = listOf(
            NotificationKey(
                key = "pets.updated",
                title = "Pet Records Updated",
                description = "30-minute debounced summary of pet adds, edits, or removals.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "profile.updated",
                title = "Profile Updated",
                description = "30-minute debounced summary of profile field changes.",
                allowedChannels = EMAIL_PUSH,
            ),
        ),
    ),
    CategoryDef(
        id = "marketing",
        title = "Newsletters & Community",
        description = "Opt-in announcements, surveys, and promotions. Disable any anytime.",
        keys = listOf(
            NotificationKey(
                key = "newsletter.announcement",
                title = "Newsletters & Announcements",
                description = "Periodic news from your Auntie business.",
                allowedChannels = EMAIL_PUSH,
                marketingCategory = MarketingCategory.NEWSLETTER,
            ),
            NotificationKey(
                key = "survey.event",
                title = "Surveys & Events",
                description = "Community surveys and event invitations.",
                allowedChannels = EMAIL_PUSH,
                marketingCategory = MarketingCategory.SURVEY,
            ),
            NotificationKey(
                key = "marketing.optin",
                title = "Marketing Promotions",
                description = "Promotional offers and product news. Includes unsubscribe footer.",
                allowedChannels = EMAIL_ONLY,
                marketingCategory = MarketingCategory.MARKETING,
            ),
        ),
    ),
)

val ALL_KINFOLK_KEYS: List<NotificationKey> = KINFOLK_CATEGORIES.flatMap { it.keys }
val ALL_MARKETING_CATEGORIES: List<MarketingCategory> = MarketingCategory.entries
