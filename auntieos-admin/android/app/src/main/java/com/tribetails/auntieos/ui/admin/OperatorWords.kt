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

/** The owner, in the word the admin web header uses for that account. */
const val OWNER_ROLE_LABEL = "Operator"
/** A caretaker, in the word the admin web header uses for that account. */
const val AUNTIE_ROLE_LABEL = "Auntie"

/**
 * The role an entry's actor held (#1820): "Operator" for the owner, "Auntie"
 * for a caretaker. Mirrors `actorRoleFor` in the admin web's
 * `lib/activityDetail.ts`; change the two together.
 *
 * The stored role cannot say that on its own. The server files the owner and a
 * caretaker under one value, and until #1820 every line a client asked for was
 * stored as PRIMARY, so the owner's clock taps read "Primary kinfolk". Three
 * sources, in order:
 *
 *   1. What the server stamped on the entry when it wrote it (`payload.admin`,
 *      `payload.staffRole`), on a staff entry. The role held at the time wins.
 *   2. The staff roster ([roles], uid -> "owner" | "auntie"), whatever role is
 *      stored. This corrects the entries already stored with the wrong role.
 *   3. The stored role, through [actorRoleLabel].
 *
 * A System entry is never relabelled, and an actor the roster does not hold
 * keeps the stored role. Display only: the entry is sealed and never rewritten.
 */
fun actorRoleFor(
    storedRole: String,
    actorId: String,
    payload: Map<String, Any?> = emptyMap(),
    roles: Map<String, String> = emptyMap(),
): String {
    val stored = storedRole.trim().uppercase()
    if (stored == "SYSTEM") return actorRoleLabel(stored)
    if (stored == "AUNTIE") {
        if (payload["staffRole"] == "auntie") return AUNTIE_ROLE_LABEL
        if (payload["admin"] == true) return OWNER_ROLE_LABEL
    }
    return when (roles[actorId.trim()]) {
        "owner" -> OWNER_ROLE_LABEL
        "auntie" -> AUNTIE_ROLE_LABEL
        else -> actorRoleLabel(stored)
    }
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
/**
 * The Template Bank preview's hint. #1592: it read "Stored in Firestore,
 * rendered with Handlebars. SendGrid delivers as a dumb pipe.", which names the
 * database, the template engine and the mail vendor instead of telling the
 * operator anything about the template.
 */
const val TEMPLATE_PREVIEW_HINT = "Merge fields fill in for each recipient when it sends."
/**
 * The Activity Log's warning when some entries' times will not read. #1592: it
 * blamed "a Firestore Timestamp object" and the "audit writer", which is a
 * developer's diagnosis, not something the operator can act on.
 */
fun unreadableTimesNote(unreadable: Int, total: Int): String =
    "$unreadable of $total entries have a time this screen cannot read, so their day and order below are a best guess."
