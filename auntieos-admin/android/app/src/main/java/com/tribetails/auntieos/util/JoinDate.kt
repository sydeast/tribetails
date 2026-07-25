package com.tribetails.auntieos.util

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The household `joinDate` field: one calendar day, stored as `YYYY-MM-DD`.
 *
 * A direct port of the web `src/lib/joinDate.ts`, kept in step with it the same
 * way FieldValidators.kt is kept in step with the web validators: the two surfaces
 * write the same collection, so they have to agree on what the field holds.
 *
 * It was a free text box on both surfaces, so the collection already holds
 * whatever was typed or written into it: full ISO instants
 * (`2026-07-24T12:34:56.789Z`, what `seedDemoKinfolk.ts` writes), and whatever a
 * person typed into the old `AuntieField`. There is no migration.
 *
 *  - DISPLAY ([formatJoinDate]) never fails and never guesses. A readable value
 *    is formatted for the operator's locale; anything else prints as stored.
 *  - EDIT ([joinDateForEdit]) hands the date picker a value it can actually open,
 *    and returns a note naming the stored string whenever that value is not what
 *    was stored, so nothing is dropped silently.
 *
 * Deliberately NOT parsed: `07/24/2026` and friends. Month-first and day-first
 * are indistinguishable for the first twelve days of any month, so reading them
 * means being wrong about some households without knowing which.
 */

/** What the editor should open with, and what the operator needs told about it. */
data class JoinDateForEdit(val value: String, val note: String?)

private val ISO_DAY_REGEX = Regex("^\\d{4}-\\d{2}-\\d{2}$")

/** True for a `YYYY-MM-DD` string that names a day that actually exists. */
fun isIsoDate(raw: String): Boolean = ISO_DAY_REGEX.matches(raw) && parseIsoDay(raw) != null

/** `YYYY-MM-DD` to a date, or null when the day is not real (`2026-02-30`). */
private fun parseIsoDay(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()

/** The ISO day at the head of a stored value, or null when there isn't one. */
private fun isoDayPrefix(raw: String): String? {
    val trimmed = raw.trim()
    val head = trimmed.take(10)
    if (!isIsoDate(head)) return null
    if (trimmed.length == 10) return head
    val next = trimmed[10]
    return if (next == 'T' || next == ' ') head else null
}

/** Open a stored join date in the editor: coerce what is readable, disclose the rest. */
fun joinDateForEdit(raw: String): JoinDateForEdit {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return JoinDateForEdit("", null)
    if (isIsoDate(trimmed)) return JoinDateForEdit(trimmed, null)

    val day = isoDayPrefix(trimmed)
    if (day != null) {
        return JoinDateForEdit(day, "Stored as “$trimmed”. Saving keeps the day and drops the time.")
    }
    return JoinDateForEdit(
        "",
        "Stored as “$trimmed”, which this picker cannot read. " +
            "Pick the join date to replace it, or save as it stands to clear it.",
    )
}

/** A stored join date as the operator should read it. Unreadable values pass through. */
fun formatJoinDate(raw: String): String {
    val day = isoDayPrefix(raw) ?: return raw
    val parsed = parseIsoDay(day) ?: return raw
    return runCatching {
        parsed.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(Locale.getDefault()))
    }.getOrDefault(raw)
}
