package com.tribetails.auntieos.ui.admin.scheduling

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * How much of a day the operator is blocking out (#574).
 *
 * TWO MODES, NOT THREE. There used to be a `SPECIFIC_TIME` alongside these,
 * and it resolved to `startTime to startTime` — a ZERO-LENGTH window. Nothing
 * can be blocked out for no time at all, `createBlockedTimeSlot` refuses
 * `startTime >= endTime` outright, and the mocks describe "specific time" only
 * as a property of a BOOKING (a requested arrival inside a time block,
 * `auntieos-create-booking-2026-05-27.html`), never as a way to block a window.
 * Guessing a duration for it would be inventing a rule the product does not
 * have, so the mode is gone rather than repaired into something nobody asked
 * for. A one-hour block is `TIME_BLOCK` with a start and an end, which is what
 * it always was.
 */
enum class BlockMode(val label: String) {
    WHOLE_DAY("Whole day"),
    TIME_BLOCK("Time block"),
}

/** `HH:mm`, 24h, zero-padded — the exact shape `createBlockedTimeSlot` accepts. */
private val HHMM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/**
 * A window the block-time callable will accept, in BOTH shapes it wants.
 *
 * The wall-clock trio is what gets persisted (the stored document has no
 * timezone field anywhere). The epoch-ms twin is what the server checks against
 * the visits already on the books: it cannot turn `date`+`HH:mm` into an
 * instant without inventing a zone, and the phone is the one place the
 * operator's zone is known. See `functions/src/admin/createBlockedTimeSlot.ts`
 * (`BlockTimeArgs.startTimeMs`) and the web twin in `api/scheduleWrite.ts`.
 */
data class BlockWindow(
    val date: String,
    val startTime: String,
    val endTime: String,
    val notes: String,
    val startTimeMs: Long,
    val endTimeMs: Long,
)

/** Either a window worth sending, or the one sentence saying why it is not. */
sealed interface BlockWindowResult {
    data class Ok(val window: BlockWindow) : BlockWindowResult
    data class Problem(val message: String) : BlockWindowResult
}

/**
 * Turn what the operator typed into a window, or refuse it by name.
 *
 * WHAT THIS REPLACES, and why every branch here is a real defect that shipped
 * (#574): the Save Block button read
 * `runCatching { LocalDate.parse(selectedDate) }.getOrNull() ?: LocalDate.now()`,
 * so a typo in the date field silently blocked out TODAY instead — a window the
 * operator never chose, on a day they may well be working. Start and end were
 * never parsed and never compared, so "17:00" to "09:00" was writable, and so
 * was "9am". Nothing was checked at all before the write went out.
 *
 * Pure and zone-injectable so the whole set is unit-testable; the screen passes
 * nothing and gets the device zone.
 */
fun resolveBlockWindow(
    dateText: String,
    startText: String,
    endText: String,
    notes: String,
    mode: BlockMode,
    zone: ZoneId = ZoneId.systemDefault(),
): BlockWindowResult {
    val date = runCatching { LocalDate.parse(dateText.trim()) }.getOrNull()
        ?: return BlockWindowResult.Problem(
            "Enter the date as YYYY-MM-DD, and a day that exists (\"${dateText.trim()}\" is not one).",
        )

    val start: String
    val end: String
    when (mode) {
        BlockMode.WHOLE_DAY -> {
            start = "00:00"
            // 23:59, not 24:00: the callable's clock regex tops out at 23:59 and
            // the stored document is wall clock, so this is the last minute of
            // the day the collection can express.
            end = "23:59"
        }
        BlockMode.TIME_BLOCK -> {
            start = startText.trim()
            end = endText.trim()
            if (!HHMM.matches(start)) {
                return BlockWindowResult.Problem("Start time has to be a 24-hour HH:MM, like 09:00.")
            }
            if (!HHMM.matches(end)) {
                return BlockWindowResult.Problem("End time has to be a 24-hour HH:MM, like 17:00.")
            }
            // Safe as a string compare precisely because the regex above forces
            // two-digit, zero-padded hours — the same check the web dialog and
            // the desktop admin's BlockTimeDialog.kt make, and the same one the
            // server re-makes on `BlockTimeArgs`.
            if (start >= end) {
                return BlockWindowResult.Problem("The end has to come after the start.")
            }
        }
    }

    val startMs = date.atTime(LocalTime.parse(start)).atZone(zone).toInstant().toEpochMilli()
    val endMs = date.atTime(LocalTime.parse(end)).atZone(zone).toInstant().toEpochMilli()

    return BlockWindowResult.Ok(
        BlockWindow(
            date = date.toString(),
            startTime = start,
            endTime = end,
            notes = notes.trim(),
            startTimeMs = startMs,
            endTimeMs = endMs,
        ),
    )
}
