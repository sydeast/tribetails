package com.kinfolk.portal.screens.messages
import com.kinfolk.portal.portal.ConversationMessage
import com.kinfolk.portal.portal.SenderRole
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
/**
 * Day separators for the Message Auntie thread (#1318). Days are cut in the
 * business timezone (operator ruling 2026-08-11: America/Chicago), not the
 * device's. Mirrors mytribe/web/src/lib/messageDays.ts.
 */
val BUSINESS_TIME_ZONE: TimeZone = TimeZone.of("America/Chicago")
private val WEEKDAYS = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
private val MONTHS = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
private fun businessDate(epochMillis: Long) =
    Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(BUSINESS_TIME_ZONE).date
/** Stable per-day key ("2026-11-01") in the business timezone. */
fun messageDayKey(epochMillis: Long): String = businessDate(epochMillis).toString()
/**
 * Today / Yesterday / weekday (last 6 days) / "October 5", with the year
 * added ("October 5, 2025") when it is not the current year.
 */
fun messageDayLabel(epochMillis: Long, nowMillis: Long = Clock.System.now().toEpochMilliseconds()): String {
    val then = businessDate(epochMillis)
    val today = businessDate(nowMillis)
    val days = today.toEpochDays() - then.toEpochDays()
    return when {
        days == 0L -> "Today"
        days == 1L -> "Yesterday"
        days in 2L..6L -> WEEKDAYS[then.dayOfWeek.ordinal]
        else -> {
            val base = "${MONTHS[then.month.ordinal]} ${then.day}"
            if (then.year == today.year) base else "$base, ${then.year}"
        }
    }
}
/**
 * The separator label to print above [messages][index], or null when it
 * shares a day with the message before it (or has no timestamp).
 */
fun daySeparatorBefore(
    messages: List<ConversationMessage>,
    index: Int,
    nowMillis: Long = Clock.System.now().toEpochMilliseconds(),
): String? {
    val ms = messages[index].createdAtMs ?: return null
    val prev = if (index > 0) messages[index - 1].createdAtMs else null
    if (prev != null && messageDayKey(prev) == messageDayKey(ms)) return null
    return messageDayLabel(ms, nowMillis)
}
/**
 * #1320: Suggest reply only answers something the Auntie said. True when the
 * thread's latest message is hers. Mirrors the server's nothing_to_reply_to.
 */
fun canSuggestReply(messages: List<ConversationMessage>?): Boolean =
    messages?.lastOrNull()?.senderRole == SenderRole.Auntie
/** Reason shown while Suggest reply is parked on a non-empty thread. */
const val NOTHING_NEW_TO_REPLY_TO = "Nothing new to reply to"
