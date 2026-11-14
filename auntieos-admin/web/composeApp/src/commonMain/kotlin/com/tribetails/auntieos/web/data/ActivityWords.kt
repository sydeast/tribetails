package com.tribetails.auntieos.web.data

/**
 * What an Activity Log entry's description says, in the operator's words
 * (#1747). Port of the web `lib/activityWords.ts` and Android
 * `ui/admin/ActivityWords.kt`; the three must agree.
 *
 * Four writers used to put a Firestore path in the description ("Approved
 * generated_drafts/<id> (<kinfolkId>)" from Communicate on every client, and
 * the server's "Sent draft generated_drafts/<id> as KinTale <reportId> (...)",
 * "Deleted draft generated_drafts/<id> (...)" and "Deleted unsent KinTale draft
 * kin_care_reports/<id> (...)"). The Activity Log shows a
 * description as written, so the operator read a collection path and two ids.
 *
 * The writers now write these words. The entries already stored are evidence
 * rows and are never rewritten; [activityDescriptionWords] reads them as the
 * same words at display time. The ids stay on the entry as its target, its
 * household and its payload.
 */
object ActivityWords {
    const val DRAFT_APPROVED = "Approved an Auntie AI draft"
    const val KINTALE_DRAFT_SENT = "Sent a KinTale draft"
    const val KINTALE_DRAFT_DELETED = "Deleted a KinTale draft"
    /** #1839: a look at a household stored before the server wrote it in words. */
    const val HOUSEHOLD_OPENED = "Opened a household"
}

/** The stored shapes, in full: the path, any ids after it, the household in brackets. */
private val STORED_SHAPES: List<Pair<Regex, String>> = listOf(
    Regex("""^Approved generated_drafts/\S+(?: \([^)]*\))?$""") to ActivityWords.DRAFT_APPROVED,
    Regex("""^Sent draft generated_drafts/\S+ as KinTale \S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_SENT,
    Regex("""^Deleted draft generated_drafts/\S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_DELETED,
    Regex("""^Deleted unsent KinTale draft kin_care_reports/\S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_DELETED,
)

/** Any other mention of a draft's path, for a writer this file does not know. */
private val DRAFT_PATH = Regex("""(?:generated_drafts|kin_care_reports)/[\w-]+""")

// #1752: the other writers that put an id or a catalog key in the sentence.
// The server now writes these words (`mytribe/functions/src/lib/activityWords.ts`);
// a row stored before that reads as the same words here. One difference: an old
// notification row names the notification by its key in words, because the
// catalog label lives on the server. Same table as the web `lib/activityWords.ts`.

/** `kincare.booking.confirm` as "Kincare booking confirm". */
private fun keyWords(raw: String): String {
    val words = raw.trim().split(Regex("[._\\-\\s]+")).filter { it.isNotEmpty() }.joinToString(" ").lowercase()
    return words.replaceFirstChar { it.uppercaseChar() }
}
private fun lowerKeyWords(raw: String): String = keyWords(raw).lowercase()

private val CHANNEL_WORDS = mapOf("email" to "email", "sms" to "text message", "push" to "push notification")
private fun channelWords(c: String): String = CHANNEL_WORDS[c.trim().lowercase()] ?: lowerKeyWords(c)
private fun channelList(raw: String): String {
    val words = raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.map(::channelWords)
    return when (words.size) {
        0 -> ""
        1 -> " by ${words[0]}"
        else -> " by ${words.dropLast(1).joinToString(", ")} and ${words.last()}"
    }
}

/** A stored notification key, or the id that stood in when the key was missing. */
private fun notificationQuoted(keyOrId: String): String {
    val k = keyOrId.trim()
    return if (k.contains('.')) "\"${keyWords(k)}\"" else "a notification"
}

private val STATUS_WORDS = mapOf(
    "DRAFT" to "draft",
    "PENDING" to "requested",
    "SCHEDULED" to "scheduled",
    "ON_MY_WAY" to "on the way",
    "ARRIVED" to "arrived",
    "DEPARTED" to "departed",
    "COMPLETED" to "completed",
    "CANCELLED" to "cancelled",
)
private fun statusWords(s: String): String = STATUS_WORDS[s.trim().uppercase()] ?: lowerKeyWords(s)

private val ACTION_WORDS = mapOf(
    "APPROVE" to ("Approved the visit" to "approve the visit"),
    "REJECT" to ("Declined the visit" to "decline the visit"),
    "CANCEL" to ("Cancelled the visit" to "cancel the visit"),
    "COMPLETE" to ("Completed the visit" to "complete the visit"),
    "ON_MY_WAY" to ("Marked the visit on the way" to "mark the visit on the way"),
    "ARRIVED" to ("Marked the arrival" to "mark the arrival"),
    "DEPARTED" to ("Marked the departure" to "mark the departure"),
    "UNDO_ARRIVAL" to ("Undid the arrival" to "undo the arrival"),
)
private fun done(a: String): String = ACTION_WORDS[a]?.first ?: keyWords(a)
private fun attempt(a: String): String = ACTION_WORDS[a]?.second ?: lowerKeyWords(a)

private val ARRIVAL_CHECK_WORDS = mapOf(
    "within" to "within the household radius",
    "outside" to "outside the household radius",
    "unverified" to "location not verified",
    "household_location_unknown" to "the household's location is not set",
)
private val PATTERN_WORDS = mapOf("individual" to "individual dates", "weekly" to "weekly")
private val SESSION_FIELD_WORDS = mapOf(
    "serviceType" to "service",
    "notes" to "notes",
    "serviceDurationMinutes" to "length",
    "kinIds" to "kin",
    "kinNames" to "kin",
)
private fun editedFields(raw: String): String {
    val words = raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        .map { f -> SESSION_FIELD_WORDS[f] ?: lowerKeyWords(f.replace(Regex("([a-z])([A-Z])"), "$1 $2")) }
        .distinct()
    return if (words.isEmpty()) "Edited a visit" else "Edited a visit: ${words.joinToString(", ")}"
}

private const val ACTION = "(APPROVE|REJECT|CANCEL|COMPLETE|ON_MY_WAY|ARRIVED|DEPARTED|UNDO_ARRIVAL)"

/** Stored shape -> the words the server writes now. First match wins, so the specific shapes lead. */
private val ID_SHAPES: List<Pair<Regex, (List<String>) -> String>> = listOf(
    Regex("""^Notification (\S+) delivered via (\S+)$""") to { g -> "Delivered ${notificationQuoted(g[1])} by ${channelWords(g[2])}" },
    Regex("""^Notification (.+?) dispatched to (.*)$""") to { g -> "Sent ${notificationQuoted(g[1])}${channelList(g[2])}" },
    Regex("""^Notification (\S+) archived$""") to { g -> "Archived ${notificationQuoted(g[1])}" },
    Regex("""^Notification (\S+) restored to the active inbox$""") to
        { g -> "Restored ${notificationQuoted(g[1])} to the notifications list" },
    Regex("""^Notification (\S+) viewed$""") to { g -> "Viewed ${notificationQuoted(g[1])}" },
    Regex("""^Notification (\S+) marked unread$""") to { g -> "Marked ${notificationQuoted(g[1])} unread" },
    Regex("""^$ACTION on session \S+: (\w+) -> (\w+)$""") to
        { g -> "${done(g[1])}: ${statusWords(g[2])} to ${statusWords(g[3])}" },
    Regex("""^$ACTION on session \S+: already (\w+), no write$""") to
        { g -> "Did not ${attempt(g[1])}: the visit was already ${statusWords(g[2])}" },
    Regex("""^$ACTION refused: session '[^']*' not found$""") to { g -> "Could not ${attempt(g[1])}: the visit was not found" },
    Regex("""^$ACTION refused: unreadable status on session '[^']*'$""") to
        { g -> "Could not ${attempt(g[1])}: the visit's status could not be read" },
    Regex("""^$ACTION refused: illegal from (\w+)$""") to
        { g -> "Could not ${attempt(g[1])}: the visit is ${statusWords(g[2])}" },
    Regex("""^COMPLETE refused: session '[^']*' has no (.+) recorded$""") to
        { g -> "Could not complete the visit: no ${g[1]} recorded" },
    Regex("""^COMPLETE refused: session '[^']*' arrival was recorded (\d+)m from the household \(radius (\d+)m\)$""") to
        { g -> "Could not complete the visit: arrival was recorded ${g[1]}m from the household (radius ${g[2]}m)" },
    Regex("""^$ACTION refused: (.+)$""") to { g -> "Could not ${attempt(g[1])}: ${g[2]}" },
    Regex("""^Arrival location check on session \S+: (\S+)$""") to
        { g -> "Arrival location check: ${ARRIVAL_CHECK_WORDS[g[1]] ?: lowerKeyWords(g[1])}" },
    Regex("""^Account credit of (\d+) cents given to household \S+$""") to { g ->
        val cents = g[1].toLong()
        "Gave \$${cents / 100}.${(cents % 100).toString().padStart(2, '0')} account credit"
    },
    Regex("""^Admin created (\d+) visit\(s\) \(([^)]*)\) for \S+$""") to { g ->
        val n = g[1].toInt()
        val p = PATTERN_WORDS[g[2].trim()] ?: lowerKeyWords(g[2])
        "Created $n ${if (n == 1) "visit" else "visits"}${if (p.isEmpty()) "" else " ($p)"}"
    },
    Regex("""^Assigned orphan KinTale \S+ to kinfolk (.*) \([^)]*\)$""") to { g ->
        val name = g[1].trim()
        if (name.isEmpty()) "Assigned a KinTale from Needs triage" else "Assigned a KinTale from Needs triage to $name"
    },
    Regex("""^Marked orphan KinTale \S+ as duplicate of \S+$""") to { _ -> "Marked a KinTale in Needs triage as a duplicate" },
    Regex("""^Archived orphan KinTale \S+ as bad data: (.*)$""") to
        { g -> "Archived a KinTale from Needs triage as bad data: ${g[1]}" },
    Regex("""^Invoice PDF generated for \S+$""") to { _ -> "Made the PDF for an invoice" },
    Regex("""^Kinfolk downloaded invoice PDF for \S+$""") to { _ -> "Household downloaded the PDF for an invoice" },
    Regex("""^Vet clinic (update|archive) refused: '[^']*' not found$""") to
        { g -> "Vet clinic ${g[1]} refused: the clinic was not found" },
    Regex("""^Edited session \S+: (.*)$""") to { g -> editedFields(g[1]) },
    Regex("""^Synced visit \S+ to Google Calendar \((\w+)\)$""") to { g -> "Synced a visit to Google Calendar (${g[1]})" },
    Regex("""^AI tale titles applied from batch \S+ \((\d+) applied, (\d+) skipped, (\d+) errored\)$""") to
        { g -> "Applied AI KinTale titles (${g[1]} applied, ${g[2]} skipped, ${g[3]} errored)" },
    Regex("""^Invite \S+ was sent, but the Auntie notice was not: (.*)$""") to
        { g -> "An invite was sent, but the Auntie notice was not: ${g[1]}" },
    Regex("""^Payment notification for invoice \S+ was not delivered after (\d+) retries$""") to
        { g -> "A payment notification was not delivered after ${g[1]} retries" },
    // #1839: a look at a household stored as its bare key and ids. Same words as
    // the web and Android.
    Regex("""^OPERATOR_CROSSTENANT_ACCESS(?: uid=\S+)?(?: target=\S+)?$""") to { _ -> ActivityWords.HOUSEHOLD_OPENED },
)

/** A stored description as the operator reads it. Text with no id or path passes through. */
fun activityDescriptionWords(description: String): String {
    val text = description.trim()
    STORED_SHAPES.firstOrNull { (shape, _) -> shape.matches(text) }?.let { return it.second }
    for ((shape, words) in ID_SHAPES) {
        val m = shape.matchEntire(text) ?: continue
        return words(m.groupValues)
    }
    return DRAFT_PATH.replace(text, "a draft")
}
