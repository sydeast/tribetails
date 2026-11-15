package com.kinfolk.portal.util

import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.KinTaleChecklistItem
import kotlin.time.Clock
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2056: what a KinTale is about.
 *
 * The household read a title, a story and "FED" with four Kin on the visit, and
 * could not tell the KinCare, the day or whose bowl. `getMyKinTales` sends the
 * KinCare's name, the visit's business day and the Kin's names; these turn them
 * into the two lines and the chip text the card prints. Every input is
 * optional, and a missing one is left out of the line, never printed as a
 * placeholder. Mirrors `mytribe/web/src/api/kinTalesApi.ts`, so the two portals
 * read the same.
 */

private val ABOUT_WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val ABOUT_MONTHS =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Biscuit", "Biscuit and Mochi", "Biscuit, Mochi and Pip". Empty for no names. */
fun kinNameList(names: List<String>): String {
    val clean = names.map { it.trim() }.filter { it.isNotEmpty() }
    return when (clean.size) {
        0 -> ""
        1 -> clean[0]
        else -> clean.dropLast(1).joinToString(", ") + " and " + clean.last()
    }
}

/**
 * The visit's day off its `YYYY-MM-DD` key: "Tue, Nov 10", with the year when
 * it is not this one ("Mon, Nov 10, 2025"). Null when the key is missing or
 * unreadable. The key is already the business's day, so it is read as a plain
 * calendar date and never through an instant, which would land on the day
 * before west of UTC.
 */
fun kinTaleVisitDayLabel(
    visitDate: String?,
    nowMillis: Long = Clock.System.now().toEpochMilliseconds(),
    timeZone: TimeZone = TimeZone.currentSystemDefault(),
): String? {
    val key = visitDate?.trim().orEmpty()
    if (key.isEmpty()) return null
    val day = runCatching { LocalDate.parse(key) }.getOrNull() ?: return null
    val thisYear = kotlin.time.Instant.fromEpochMilliseconds(nowMillis).toLocalDateTime(timeZone).year
    val base = "${ABOUT_WEEKDAYS[day.dayOfWeek.ordinal]}, ${ABOUT_MONTHS[day.month.ordinal]} ${day.day}"
    return if (day.year == thisYear) base else "$base, ${day.year}"
}

/** "30 Minute Quick Check · Biscuit, Mochi and Pip": the KinCare and the Kin, whichever are known. Empty for neither. */
fun kinTaleAboutLine(tale: KinTale): String =
    listOf(tale.serviceLabel?.trim().orEmpty(), kinNameList(tale.kinNames))
        .filter { it.isNotEmpty() }
        .joinToString(" · ")

/** A done care task as its chip reads: "Fed for Biscuit" when it was done for named Kin, else just "Fed". */
fun careTaskLabel(item: KinTaleChecklistItem): String {
    val forKin = kinNameList(item.kinNames)
    return if (forKin.isEmpty()) item.text else "${item.text} for $forKin"
}
