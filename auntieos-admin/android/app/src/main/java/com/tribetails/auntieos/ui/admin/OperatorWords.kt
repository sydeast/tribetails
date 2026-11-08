package com.tribetails.auntieos.ui.admin

/**
 * #1592: what the operator reads in place of a stored key. Display only; every
 * stored value, filter key and search haystack is unchanged. Mirrors the web
 * build (`lib/notificationsFeed.ts`, `lib/activityDetail.ts`,
 * `lib/formSchemaFormat.ts`) so the two clients say the same words.
 */

/** `account.welcome.kinfolk` as "Account welcome kinfolk": the last resort for a key with no label. */
fun humanizeKey(raw: String): String {
    val words = raw.trim()
        .split(Regex("[._\\-\\s]+"))
        .filter { it.isNotEmpty() }
        .joinToString(" ")
        .lowercase()
    return words.replaceFirstChar { it.uppercaseChar() }
}

private const val UNCATEGORIZED = "uncategorized"

/** Category words, in the vocabulary the notification settings sections already use. */
private val CATEGORY_LABELS = mapOf(
    "account" to "Account",
    "home" to "Home and pets",
    "invoice" to "Billing",
    "kintale" to "KinTales",
    "marketing" to "Newsletters",
    "messages" to "Messages",
    "ratings" to "Ratings",
    "schedule" to "Schedule",
    "security" to "Security",
    "visit" to "Visits",
    UNCATEGORIZED to "Other",
)

/** A stored notification category as the operator reads it. The chip's filter value stays the stored one. */
fun notificationCategoryLabel(category: String?): String {
    val key = category?.trim().orEmpty().ifEmpty { UNCATEGORIZED }
    return CATEGORY_LABELS[key.lowercase()] ?: humanizeKey(key)
}

/**
 * The audit trail's actor role in words. The server writes `AUNTIE` for every
 * staff caller, the owner included, so it reads "Staff"; PRIMARY and SECONDARY
 * are the household's kinfolk. Blank stays blank so the row is dropped.
 */
fun actorRoleLabel(role: String): String = when (val key = role.trim().uppercase()) {
    "" -> ""
    "AUNTIE" -> "Staff"
    "PRIMARY" -> "Primary kinfolk"
    "SECONDARY" -> "Secondary kinfolk"
    "SYSTEM" -> "System"
    else -> humanizeKey(key)
}

private val APPLIES_TO_LABELS = mapOf(
    "NONE" to "Nothing yet",
    "KINFOLK" to "Kinfolk profiles",
    "KIN" to "Kin profiles",
    "HOUSEHOLD" to "Households",
    "SESSION" to "KinCare visits",
    "BOOKING" to "Bookings",
    "KINTALE" to "KinTales",
)

/** Where a form shows up, in words: the editor read "Applies to NONE". */
fun appliesToLabel(appliesTo: String): String {
    val key = appliesTo.trim().uppercase()
    return APPLIES_TO_LABELS[key] ?: humanizeKey(key).ifEmpty { APPLIES_TO_LABELS.getValue("NONE") }
}

/** "1 schema", "2 schemas": the chip read "1 schemas". */
fun schemaCountLabel(count: Int): String = "$count ${if (count == 1) "schema" else "schemas"}"
