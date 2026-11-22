package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.activityDescriptionWords
import com.tribetails.auntieos.web.data.brandWords
import com.tribetails.auntieos.web.data.noticeNotSentWords
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * #1819, #1905: A NOTICE THAT DID NOT GO OUT, AS THE ACTIVITY LOG READS IT.
 *
 * The server writes `NOTIFICATION_NOT_SENT` with status `NOT_SENT` and a
 * sentence that says who the copy was for and why it did not go. Before that
 * it wrote a held notice as `NOTIFICATION_DISPATCHED`, status SUCCESS, with the
 * reason as a stored key in the payload, so the row read "Notification
 * dispatched" for a notice the send switch had held back.
 *
 * Stored rows are evidence and are never rewritten, so the row reads the older
 * shape as what it was: not sent. Same rules as the web
 * (`lib/activityDetail.ts`) and Android; change all three together. Pure;
 * unit-tested in `ActivityNoticeTest`.
 */
internal const val NOTICE_NOT_SENT_ACTION = "NOTIFICATION_NOT_SENT"
internal const val NOTICE_NOT_SENT_TITLE = "Notification not sent"
internal const val NOT_SENT_STATUS = "NOT_SENT"
internal const val NOT_SENT_STATUS_WORDS = "Not sent"

private fun payloadText(entry: ActivityLogEntry, key: String): String =
    (((entry.payload as? JsonObject)?.get(key)) as? JsonPrimitive)?.contentOrNull.orEmpty().trim()

/** The held notice an older server stored as "dispatched": a reason, and nothing dispatched. */
internal fun isLegacyHeldNotice(entry: ActivityLogEntry): Boolean {
    if (entry.actionType.trim().uppercase() != "NOTIFICATION_DISPATCHED") return false
    val ids = (entry.payload as? JsonObject)?.get("dispatchIds") as? JsonArray
    return payloadText(entry, "reason").isNotEmpty() && ids != null && ids.isEmpty()
}

/** Is this entry a notice that did not go out, in either stored form? */
internal fun isNoticeNotSent(entry: ActivityLogEntry): Boolean =
    entry.actionType.trim().uppercase() == NOTICE_NOT_SENT_ACTION || isLegacyHeldNotice(entry)

/** The row's bold line: [activityTitle], except a held notice stored as "dispatched". */
internal fun activityEntryTitle(entry: ActivityLogEntry): String =
    if (isLegacyHeldNotice(entry)) NOTICE_NOT_SENT_TITLE else activityTitle(entry.actionType)

/** The row's sentence: the stored description in words, or the held notice's reason in words. */
internal fun activityEntryDescription(entry: ActivityLogEntry): String =
    if (isLegacyHeldNotice(entry)) noticeNotSentWords(payloadText(entry, "key"), payloadText(entry, "reason"))
    else activityDescriptionWords(entry.description)

/**
 * The status the entry carries for display and tone: `NOT_SENT` for a notice
 * that did not go out and did not fail, whatever an older writer stored.
 */
internal fun activityEffectiveStatus(entry: ActivityLogEntry): String =
    if (isLegacyHeldNotice(entry) && entry.status.trim().equals("SUCCESS", ignoreCase = true)) NOT_SENT_STATUS
    else entry.status

/** The status on the row's pill and in the opened entry, in words (#1818): "Done", "Failed", "Pending", "Not sent". */
internal fun activityStatusWords(entry: ActivityLogEntry): String {
    val status = activityEffectiveStatus(entry)
    val key = status.trim().uppercase()
    if (key == NOT_SENT_STATUS) return NOT_SENT_STATUS_WORDS
    return STATUS_WORDS[key] ?: brandWords(status)
}

private val STATUS_WORDS = mapOf("SUCCESS" to "Done", "FAILURE" to "Failed", "ERROR" to "Failed", "PENDING" to "Pending")
