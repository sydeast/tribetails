package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.serviceTone

/**
 * #1592: what the operator reads in place of a stored key. Display only; every
 * stored value, filter key and search haystack is unchanged. Mirrors the web
 * admin (`lib/notificationsFeed.ts`, `lib/formSchemaFormat.ts`,
 * `lib/bookingFormat.ts#bookingServiceName`) and Android so the clients say the
 * same words.
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

/** A notification card's headline: its catalog title, else its key as words, never the key itself. */
fun notificationHeadline(key: String, title: String): String {
    val k = key.trim()
    val t = title.trim()
    if (t.isNotEmpty() && t != k) return t
    return humanizeKey(k).ifEmpty { "Notification" }
}

private const val UNCATEGORIZED = "uncategorized"

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

private val STATED_DURATION =
    Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)
private val BARE_TRAILING_NUMBER = Regex("""(?:^|[^0-9A-Za-z])(\d{1,4})$""")

private fun statedMinutes(name: String): Int? =
    STATED_DURATION.findAll(name)
        .map { mr -> mr.groupValues[1].toInt().let { n -> if (mr.groupValues[2].startsWith("h", true)) n * 60 else n } }
        .maxOrNull()

private fun storedMinutes(raw: String?): Int? {
    val minutes = raw?.trim()?.toDoubleOrNull() ?: return null
    if (!minutes.isFinite() || minutes <= 0) return null
    return kotlin.math.round(minutes).toInt()
}

private fun normaliseServiceKey(raw: String): String = raw.lowercase().replace(Regex("[^a-z0-9]"), "")

/**
 * What a visit's service is CALLED, resolved against the operator's KinCare
 * catalog (#1592: rows printed `visit_60` and `30minute`). The catalog key
 * matched on letters and digits, else the one KinCare that runs as long as the
 * label states (a bare trailing number reads as minutes); ambiguous or unmatched
 * keeps the stored text, and only a blank field becomes "Visit".
 */
fun bookingServiceName(
    rawServiceType: String?,
    serviceRates: Map<String, String>?,
    serviceDurations: Map<String, String>? = null,
): String {
    val label = rawServiceType?.trim().orEmpty()
    if (label.isEmpty()) return "Visit"
    val keys = serviceRates.orEmpty().keys.map { it.trim() }.filter { it.isNotEmpty() }
    val wanted = normaliseServiceKey(label)
    keys.firstOrNull { normaliseServiceKey(it) == wanted }?.let { return it }
    val minutes = statedMinutes(label)
        ?: BARE_TRAILING_NUMBER.find(label)?.groupValues?.get(1)?.toInt()?.takeIf { it > 0 }
    if (minutes != null) {
        val sameLength = keys.filter { (storedMinutes(serviceDurations?.get(it)) ?: statedMinutes(it)) == minutes }
        if (sameLength.size == 1) return sameLength.first()
    }
    return label
}

/**
 * The KinCare catalog a stored service is named and coloured against:
 * `business_settings.serviceRates` and `serviceDurations` together (#1592), one
 * value for every Schedule mark so the agenda, the week blocks and the legend
 * resolve a stored `visit_60` the same way. Same shape as Android's.
 */
data class ServiceCatalog(
    val serviceRates: Map<String, String> = emptyMap(),
    val serviceDurations: Map<String, String> = emptyMap(),
) {
    /** [bookingServiceName] against this catalog. */
    fun nameOf(rawServiceType: String?): String = bookingServiceName(rawServiceType, serviceRates, serviceDurations)
}

/**
 * THE tone of a stored booking service, for every mark that colours a visit:
 * the legend swatch, the agenda pill, the week block (#1592). Keyed on the
 * NAME [bookingServiceName] resolves, never the stored text, so a block and the
 * legend row for its KinCare are one colour and a rename moves both. Same rule
 * as the web `bookingServiceTone` and Android's.
 */
fun bookingServiceTone(rawServiceType: String?, catalog: ServiceCatalog): AuntieStatusTone =
    serviceTone(catalog.nameOf(rawServiceType))

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
