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
    // Operator-voice text. The admin matrix prints this one; do not show it to a
    // household when `householdDescription` exists (#1359).
    val description: String,
    // The row described to the household ("When you request a visit"). Null from
    // a callable that predates the field, and for the static fallback below,
    // whose `description` is already written to the household.
    val householdDescription: String? = null,
    // The title addressed to the household ("You accepted a quote"). Null from a
    // callable that predates the field (#1372); `title` is then the fallback.
    val householdTitle: String? = null,
    val allowedChannels: Set<NotificationChannel>,
    val required: Set<NotificationChannel> = emptySet(),
    // Run-4 #13: channels the business admin LOCKED. Shown but read-only; the kinfolk
    // can't change them (the server also enforces this at dispatch).
    val lockedChannels: Set<NotificationChannel> = emptySet(),
    // #491: what the dispatcher will actually do with each locked channel.
    // Locked means the household does not decide it, NOT that it is on — a
    // channel pinned by `lockedEnabled` that the operator never switched on
    // resolves OFF for sms and push, and this screen used to draw every locked
    // channel checked. Absent entry = on, which is what the static fallback
    // below relies on: everything it locks is catalog-required, and required
    // resolves on.
    val lockedChannelValues: Map<NotificationChannel, Boolean> = emptyMap(),
    // Notification revamp: operator-authored reason why a locked/required
    // notification stays on. Shown on the key row in place of the stock
    // "Set by Tribe Tails Pet Care. Can't be changed here." line. Always null in
    // the static fallback below; operator prose only arrives via
    // getNotificationCatalog. #451: this fallback knows nothing about the
    // operator's current gate, which is exactly why the stock line names who
    // decides instead of claiming the notification is always on.
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
                title = "Your Auntie is on the way",
                description = "When your Auntie is en route to your KinCare visit.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.auntie.arrived",
                title = "Your Auntie has arrived",
                description = "When your Auntie checks in at the start of a visit.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kincare.auntie.departed",
                title = "Your Auntie has left",
                description = "When your Auntie wraps up and leaves.",
                allowedChannels = ALL,
            ),
            // "kincare.report.sent" used to sit here. A KinTale IS the visit
            // report, so it was merged into "kintale.published" (KinTales,
            // below) on 2026-07-24 and is now a server-side alias.
            NotificationKey(
                key = "kincare.unavailable",
                title = "A visit can't go ahead",
                description = "When a KinCare visit can't go ahead, for example when your Auntie can't get into your home.",
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
                title = "Your KinTale is ready",
                description = "When your Auntie publishes the written report from a KinCare visit.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "kintale.comment.added",
                title = "New comment on your KinTale",
                description = "When someone comments on one of your KinTales. New comments arrive together in one message.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "kintale.note.added",
                title = "Your Auntie added to a KinTale",
                description = "When your Auntie adds more words or photos to a KinTale you already received.",
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
                title = "Your invoice or quote changed",
                description = "When an invoice or quote is updated.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "invoice.reminder",
                title = "Reminder to pay your invoice",
                description = "Friendly reminder ahead of an invoice due date.",
                allowedChannels = ALL,
            ),
            NotificationKey(
                key = "invoice.payment.applied",
                title = "Payment applied to your invoice",
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
                title = "Reminder before your visit",
                description = "A reminder before each KinCare visit on your schedule.",
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
                title = "Your pets were updated",
                description = "When a pet on your household is added or changed.",
                allowedChannels = EMAIL_PUSH,
            ),
            NotificationKey(
                key = "profile.updated",
                title = "Your profile was updated",
                description = "When your household profile is changed.",
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
                title = "News and announcements",
                description = "News and announcements from Tribe Tails, if you opt in.",
                allowedChannels = EMAIL_PUSH,
                marketingCategory = MarketingCategory.NEWSLETTER,
            ),
            NotificationKey(
                key = "survey.event",
                title = "Surveys and community events",
                description = "Surveys and community event invitations, if you opt in.",
                allowedChannels = EMAIL_PUSH,
                marketingCategory = MarketingCategory.SURVEY,
            ),
            NotificationKey(
                key = "marketing.optin",
                title = "Offers and updates",
                description = "General updates and offers from Tribe Tails, if you opt in.",
                allowedChannels = EMAIL_ONLY,
                marketingCategory = MarketingCategory.MARKETING,
            ),
        ),
    ),
)

val ALL_KINFOLK_KEYS: List<NotificationKey> = KINFOLK_CATEGORIES.flatMap { it.keys }
val ALL_MARKETING_CATEGORIES: List<MarketingCategory> = MarketingCategory.entries
