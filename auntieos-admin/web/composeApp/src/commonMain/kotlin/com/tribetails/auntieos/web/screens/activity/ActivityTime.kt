package com.tribetails.auntieos.web.screens.activity
import com.tribetails.auntieos.web.screens.schedule.businessDateTimeOf
import kotlinx.datetime.TimeZone
/** A log timestamp read on the business's calendar: its day key (`yyyy-MM-dd`) and 24-hour clock (`15:34`). */
internal data class ActivityWhen(val dayKey: String, val clock: String)
private val DATE_TIME_PREFIX = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}""")
/**
 * Reads a log timestamp in the BUSINESS zone (#1585), never the machine's and never
 * the UTC wall clock the string happens to carry. A stamp with a zone (`...Z`,
 * `+05:00`) is an instant; one without is already the business's wall clock. Null
 * when the string has no readable date and time, so the caller can say "Undated"
 * rather than invent one.
 *
 * Mirrors `activityWhen` in `auntieos-admin/src/lib/activityDetail.ts`. This console
 * has always drawn the clock in 24-hour form, so that form is kept.
 */
internal fun activityWhen(timestamp: String, zone: TimeZone): ActivityWhen? {
    if (!DATE_TIME_PREFIX.containsMatchIn(timestamp)) return null
    val t = businessDateTimeOf(timestamp, zone) ?: return null
    val clock = "${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}"
    return ActivityWhen(dayKey = t.date.toString(), clock = clock)
}
