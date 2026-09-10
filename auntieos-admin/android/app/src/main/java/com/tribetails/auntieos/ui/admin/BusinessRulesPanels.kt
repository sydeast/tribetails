package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieSettingRow
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.ZoneId

/**
 * ISSUE #519: the settings this app decoded, defaulted and round-tripped and
 * gave the operator nowhere to change.
 *
 * The phone had editors for five of the twenty (the GPS master switch,
 * auto-start, accuracy, the ETA default and the draft-retention default, all in
 * `BusinessOperationsPanel`), which was five more than either web surface had.
 * The rest had no control anywhere: the whole booking-configuration block,
 * the time zone, the two option LISTS behind the two dropdowns, and four of the
 * seven GPS fields. This file is the phone's half of closing that.
 *
 * KEPT OUT OF `AdminSettingsScreen.kt` on purpose. That file is 3,300 lines and
 * two other in-flight changes are editing it; a new section here costs it one
 * enum entry and one `when` branch.
 *
 * SAVES GO THROUGH `AdminSettingsViewModel.updateBusinessSettings`, which diffs
 * against the copy Firestore handed over (`BusinessSettingsDiff.kt`) and writes
 * only what changed. Every panel below hands it `settings.copy(...)`, the
 * loaded model with this panel's fields overlaid, never a freshly constructed
 * `BusinessSettings(...)`, which is what would silently reset every field the
 * panel has no control for.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pure rules. Unit-tested; the composables below only render them.
// ─────────────────────────────────────────────────────────────────────────────

/** Wire values for `defaultBookingMode`, matching the `BookingMode` enum names. */
internal val BOOKING_MODE_WIRE: List<Pair<String, String>> = listOf(
    "SPECIFIC_TIME" to "A specific time (11:15 AM)",
    "TIME_BLOCK" to "A time block (Midday)",
)

/** Wire values for `defaultCalendarView`, matching the `CalendarViewMode` enum names. */
internal val CALENDAR_VIEW_WIRE: List<Pair<String, String>> = listOf(
    "DAY" to "Day",
    "WEEK" to "Week",
    "MONTH" to "Month",
    "AGENDA" to "Agenda",
)

/**
 * `options`, plus `current` when the document holds something the vocabulary
 * does not list. A legacy or hand-edited value stays visible and saveable as it
 * is, rather than the picker snapping to a value the operator never chose and
 * their next unrelated save writing it down.
 */
internal fun optionsIncluding(
    options: List<Pair<String, String>>,
    current: String,
): List<Pair<String, String>> =
    if (options.any { it.first == current }) options
    else options + (current to "$current (not a known value)")

internal val HHMM_REGEX = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")

/** How many bookable blocks one business may define. Mirrors the React editor. */
internal const val MAX_TIME_BLOCKS: Int = 12

/** How many entries one option list may hold. A dropdown longer than this is not a dropdown. */
internal const val MAX_OPTION_LIST_LENGTH: Int = 12

/**
 * `raw` as a whole number inside [min]..[max], or null.
 *
 * Blank is null rather than zero: a cleared box is an unfinished edit, and "0
 * minutes of travel buffer" is a real answer somebody might mean.
 */
internal fun parseWholeNumber(raw: String, min: Int, max: Int): Int? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || !trimmed.all { it.isDigit() }) return null
    val value = trimmed.toIntOrNull() ?: return null
    return if (value in min..max) value else null
}

/**
 * A comma-separated option list as sorted unique positive whole numbers, or
 * null when any entry is unusable.
 *
 * These lists are what the "On My Way" sheet and the draft-retention picker
 * OFFER, so an empty list is a dropdown with nothing in it and a duplicate is a
 * row the operator can pick twice with no way to tell which they picked.
 */
internal fun parseOptionList(raw: String): List<Int>? {
    val parts = raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.isEmpty() || parts.size > MAX_OPTION_LIST_LENGTH) return null
    val out = mutableListOf<Int>()
    for (part in parts) {
        if (!part.all { it.isDigit() }) return null
        val n = part.toIntOrNull() ?: return null
        if (n <= 0 || out.contains(n)) return null
        out += n
    }
    return out.sorted()
}

/** An option list back as the operator types it. */
internal fun formatOptionList(values: List<Int>): String = values.joinToString(", ")

/**
 * The default to store beside a freshly edited option list: unchanged when it is
 * already a member, otherwise the nearest surviving option, ties going to the
 * SMALLER so nobody is silently handed a longer wait than they had. Deleting the
 * selected entry is a normal edit and must not block the save.
 */
internal fun clampToOptions(value: Int, options: List<Int>): Int {
    if (options.isEmpty() || options.contains(value)) return value
    return options.minWithOrNull(
        compareBy<Int> { kotlin.math.abs(it - value) }.thenBy { it },
    ) ?: value
}

/** One row of the time-block editor, as the operator is typing it. */
internal data class TimeBlockRow(
    val id: String,
    val label: String,
    val startTime: String,
    val endTime: String,
    val active: Boolean,
)

internal fun TimeBlockDefinition.toRow(): TimeBlockRow =
    TimeBlockRow(id = id, label = label, startTime = startTime, endTime = endTime, active = isActive)

/**
 * A url-safe id from a label, used only when a row is ADDED. An existing row
 * never has its id recomputed: `resolveTimeBlock` matches stored sessions by the
 * block's identity, and renaming "Midday" must not orphan visits already
 * labelled with it.
 */
internal fun slugifyBlockId(label: String, taken: List<String>): String {
    val base = label.lowercase()
        .map { if (it.isLetterOrDigit()) it else '-' }
        .joinToString("")
        .trim('-')
        .replace(Regex("-+"), "-")
        .take(40)
        .ifEmpty { "block" }
    if (!taken.contains(base)) return base
    for (n in 2 until 100) {
        val candidate = "$base-$n"
        if (!taken.contains(candidate)) return candidate
    }
    return "$base-${taken.size}"
}

/** The end a NEW block gets: its start plus the default block length, capped at 23:59. */
internal fun defaultBlockEnd(startTime: String, durationHours: Int): String {
    if (!HHMM_REGEX.matches(startTime)) return "23:59"
    val (h, m) = startTime.split(":").map { it.toInt() }
    val end = minOf(h * 60 + m + maxOf(1, durationHours) * 60, 23 * 60 + 59)
    return "%02d:%02d".format(end / 60, end % 60)
}

/**
 * THE AVAILABILITY MODEL, not one more setting.
 *
 * `business_settings.timeBlocks` is the set of named windows a kinfolk books
 * INTO. Operator, 2026-08-24: "kinfolk book within time blocks, not at a
 * specific set time. I need to be able to create these time blocks and those are
 * what the kinfolk should be able to select from when booking."
 *
 * NOT `booking_time_slots`. That collection is block-OUT time, written by
 * `createBlockedTimeSlot` and the Google busy importer, and it says when NOT to
 * book. These say when a booking may land. The two are never merged.
 *
 * TWO ACTIVE BLOCKS MAY NOT OVERLAP. `resolveTimeBlock`
 * (`domain/TimeBlockResolver.kt:15`) resolves a stored visit back to its block
 * with `firstOrNull` over the ACTIVE rows, so under an overlap the name a visit
 * is displayed with is decided by array order rather than by the block the
 * kinfolk chose. INACTIVE rows are exempt: the resolver skips them and nothing
 * can be booked into them, so a parked seasonal block that overlaps a live one
 * is not a conflict until it is switched on.
 *
 * ROWS ARE STORED SORTED BY START TIME, because `firstOrNull` makes the stored
 * order load-bearing and "the order they were typed in" would make the
 * resolver's answer depend on edit history.
 *
 * `startTime < endTime` is required rather than wrapped past midnight: the
 * resolver compares the pair as a plain same-day range, so a "22:00-02:00" block
 * would match nothing at all and the operator would never be told why.
 */
internal fun timeBlockError(rows: List<TimeBlockRow>): String? {
    if (rows.size > MAX_TIME_BLOCKS) return "That is more than $MAX_TIME_BLOCKS blocks. Remove some first."
    val ids = mutableSetOf<String>()
    val labels = mutableSetOf<String>()
    for (row in rows) {
        val label = row.label.trim()
        if (label.isEmpty()) return "Every block needs a name."
        if (!labels.add(label.lowercase())) return "Two blocks are both called \"$label\"."
        if (!HHMM_REGEX.matches(row.startTime)) return "\"$label\" needs a start time as HH:mm."
        if (!HHMM_REGEX.matches(row.endTime)) return "\"$label\" needs an end time as HH:mm."
        if (row.startTime >= row.endTime) {
            return "\"$label\" has to end after it starts. A block cannot run past midnight."
        }
        if (row.id.isBlank()) return "\"$label\" lost its id. Remove the row and add it again."
        if (!ids.add(row.id)) return "Two blocks share the id \"${row.id}\"."
    }
    firstActiveOverlap(rows.sortedWith(::compareBlocksByStart))?.let { (first, second) ->
        return "\"$first\" and \"$second\" overlap. Two blocks a kinfolk can book at the same " +
            "moment cannot both be on, because a visit in the overlap would be labelled with " +
            "whichever came first."
    }
    return null
}

/** Start time first, then end, then label: an order that is a fact about the clock, not about edit history. */
internal fun compareBlocksByStart(a: TimeBlockRow, b: TimeBlockRow): Int {
    val byStart = a.startTime.compareTo(b.startTime)
    if (byStart != 0) return byStart
    val byEnd = a.endTime.compareTo(b.endTime)
    if (byEnd != 0) return byEnd
    return a.label.compareTo(b.label)
}
/**
 * The first pair of ACTIVE rows whose windows intersect, or null.
 *
 * Touching ends do NOT overlap: the resolver's range is `start until end`, half
 * open, so a visit at exactly 15:00 belongs to the block starting at 15:00 and
 * not to the one ending there. [rows] must already be start-ordered, which is
 * what lets one pass over adjacent pairs find every intersection.
 */
internal fun firstActiveOverlap(rows: List<TimeBlockRow>): Pair<String, String>? {
    val active = rows.filter { it.active }
    for (i in 1 until active.size) {
        val prev = active[i - 1]
        val next = active[i]
        if (next.startTime < prev.endTime) {
            return (prev.label.ifBlank { prev.id }) to (next.label.ifBlank { next.id })
        }
    }
    return null
}

/** Stored start-ordered, because `resolveTimeBlock`'s `firstOrNull` makes the stored order load-bearing. */
internal fun List<TimeBlockRow>.toDefinitions(): List<TimeBlockDefinition> = sortedWith(::compareBlocksByStart).map {
    TimeBlockDefinition(
        id = it.id,
        label = it.label.trim(),
        startTime = it.startTime,
        endTime = it.endTime,
        isActive = it.active,
    )
}

/** The zone ids offered, always carrying the stored one even when this device does not know it. */
internal fun timeZoneOptions(current: String): List<String> {
    val all = sortedSetOf<String>()
    all += runCatching { ZoneId.getAvailableZoneIds() }.getOrDefault(emptySet())
    all += "America/New_York"
    val trimmed = current.trim()
    if (trimmed.isNotEmpty()) all += trimmed
    return all.toList()
}

/** Can this device actually resolve the zone? A no means the phone line answers as open around the clock. */
internal fun isUsableTimeZone(zone: String): Boolean =
    zone.isNotBlank() && runCatching { ZoneId.of(zone.trim()) }.isSuccess

/**
 * What is wrong with the whole booking-rules draft, or null.
 *
 * The mode and the two allow-flags are checked TOGETHER because they are one
 * decision: defaulting to a mode you have turned off leaves the document in a
 * state no screen can act on.
 */
internal fun bookingRulesError(
    defaultBookingMode: String,
    allowSpecificTimeBooking: Boolean,
    allowTimeBlockBooking: Boolean,
    blockDurationHours: String,
    travelBufferMinutes: String,
    blocks: List<TimeBlockRow>,
    timeZone: String,
): String? {
    if (!allowSpecificTimeBooking && !allowTimeBlockBooking) {
        return "Leave at least one booking mode on, or nothing can be booked at all."
    }
    if (defaultBookingMode == "TIME_BLOCK" && !allowTimeBlockBooking) {
        return "Time blocks are turned off, so they cannot be the default. Pick the other mode."
    }
    if (defaultBookingMode == "SPECIFIC_TIME" && !allowSpecificTimeBooking) {
        return "Specific times are turned off, so they cannot be the default. Pick the other mode."
    }
    if (!isUsableTimeZone(timeZone)) {
        return "This phone cannot read a time in \"$timeZone\". Pick a zone from the list."
    }
    if (parseWholeNumber(blockDurationHours, 1, 24) == null) return "Default block length: enter 1 to 24 hours."
    if (parseWholeNumber(travelBufferMinutes, 0, 480) == null) return "Travel buffer: enter 0 to 480 minutes."
    timeBlockError(blocks)?.let { return it }
    if (allowTimeBlockBooking && blocks.none { it.active }) {
        return "Time-block booking is on but no block is active, so there is nothing to book into."
    }
    return null
}

/** What is wrong with the visit-records draft, or null. */
internal fun visitRecordsError(
    saveRoutesForDays: String,
    etaOptions: String,
    draftOptions: String,
    arrivalRadiusMeters: String = "150",
): String? {
    if (parseWholeNumber(saveRoutesForDays, 1, 3650) == null) return "Keep routes for: enter 1 to 3650 days."
    if (parseOptionList(etaOptions) == null) return "On-my-way choices: whole numbers over zero, no repeats."
    if (parseOptionList(draftOptions) == null) return "Draft-retention choices: whole numbers over zero, no repeats."
    // ISSUE #582. The same 10..5000 the rules guard
    // (`bsInt('arrivalRadiusMeters', 10, 5000)`) and the server's
    // ARRIVAL_RADIUS_MIN/MAX_METERS enforce, so the operator reads what is wrong
    // here rather than watching the save bounce off firestore.rules. Validated
    // even while the switch is off: the value is saved either way, and a bad one
    // left behind becomes an unfixable problem the first time somebody turns
    // verification on.
    if (parseWholeNumber(arrivalRadiusMeters, 10, 5000) == null) {
        return "Arrival must be within: enter 10 to 5000 metres."
    }
    return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The booking-configuration block, plus the business time zone.
 *
 * TIME ZONE LIVES HERE ON THE PHONE, and under Business profile on the two web
 * surfaces, because this screen has no business-profile section to put it in
 * (the business name and address are edited under Service management). Its
 * consumers are all timing: whether the phone line answers as open, when a quote
 * expires, and the dates printed in every visit message.
 */
@Composable
internal fun BookingRulesPanel(
    settings: BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Re-seeded whenever a fresh document arrives, the convention every other
    // panel on this screen uses (`remember(settings.field)`).
    var timeZone by remember(settings) { mutableStateOf(settings.timeZone) }
    var mode by remember(settings) { mutableStateOf(settings.defaultBookingMode) }
    var view by remember(settings) { mutableStateOf(settings.defaultCalendarView) }
    var allowSpecific by remember(settings) { mutableStateOf(settings.allowSpecificTimeBooking) }
    var allowBlock by remember(settings) { mutableStateOf(settings.allowTimeBlockBooking) }
    var reminder by remember(settings) { mutableStateOf(settings.enableAutoReminder24h) }
    var blockHours by remember(settings) { mutableStateOf(settings.defaultTimeBlockDurationHours.toString()) }
    var travelBuffer by remember(settings) { mutableStateOf(settings.travelBufferMinutes.toString()) }
    // Sorted on the way in, matching how they are stored. Rows are NOT re-sorted
    // while the operator types: moving a row out from under a cursor because a
    // start time is momentarily "0" is worse than a list briefly out of order.
    var blocks by remember(settings) {
        mutableStateOf(settings.timeBlocks.map { it.toRow() }.sortedWith(::compareBlocksByStart))
    }

    val problem = bookingRulesError(mode, allowSpecific, allowBlock, blockHours, travelBuffer, blocks, timeZone)

    DenPanel(
        title = "Booking rules",
        subtitle = "The clock the business runs on, how visits may be booked, and the blocks they land in.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            if (problem != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Not ready to save") {
                    Text(problem, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieFieldLabel(text = "Time zone")
            AuntieDropdownField(
                value = timeZone,
                options = timeZoneOptions(settings.timeZone),
                onSelect = { timeZone = it },
                displayText = { it },
                label = "Business time zone",
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Your phone line's open and closed hours, quote expiry, and the visit dates in every message are read in this zone.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            // ISSUE #708 (web mark 38, ported here for the same defect): this
            // panel used to read as one flat column with no break between the
            // mode toggles, the defaults below them, and the time blocks. It is
            // now three named groups, matching the split BookingRulesSection.tsx
            // uses on the web admin.
            AuntieFieldLabel(text = "Booking modes")
            AuntieSettingRow(
                title = "Offer specific times",
                description = "Kinfolk pick an exact start time.",
                leadingIcon = Lucide.Clock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = true,
                trailing = { AuntieToggle(checked = allowSpecific, onCheckedChange = { allowSpecific = it }) },
            )
            AuntieSettingRow(
                title = "Offer time blocks",
                description = "Kinfolk pick a named window instead of a clock time.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = { AuntieToggle(checked = allowBlock, onCheckedChange = { allowBlock = it }) },
            )

            AuntieFieldLabel(text = "Defaults")
            AuntieSettingRow(
                title = "Remind kinfolk 24 hours before a visit",
                description = "The reminder goes out the day before. Turning this off stops it for everyone.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = { AuntieToggle(checked = reminder, onCheckedChange = { reminder = it }) },
            )

            AuntieDropdownField(
                value = mode,
                options = optionsIncluding(BOOKING_MODE_WIRE, mode).map { it.first },
                onSelect = { mode = it },
                displayText = { wire -> optionsIncluding(BOOKING_MODE_WIRE, mode).first { it.first == wire }.second },
                label = "New bookings start as",
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieDropdownField(
                value = view,
                options = optionsIncluding(CALENDAR_VIEW_WIRE, view).map { it.first },
                onSelect = { view = it },
                displayText = { wire -> optionsIncluding(CALENDAR_VIEW_WIRE, view).first { it.first == wire }.second },
                label = "Calendar opens on",
                modifier = Modifier.fillMaxWidth(),
            )

            Row(horizontalArrangement = Arrangement.spacedBy(dims.space3), modifier = Modifier.fillMaxWidth()) {
                AuntieField(
                    value = blockHours,
                    onValueChange = { blockHours = it },
                    label = "Default block length (hours)",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    isError = parseWholeNumber(blockHours, 1, 24) == null,
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = travelBuffer,
                    onValueChange = { travelBuffer = it },
                    label = "Travel buffer (minutes)",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    isError = parseWholeNumber(travelBuffer, 0, 480) == null,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                "The buffer is room kept between two visits in one block, so a full block still leaves you time to drive.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            Spacer(Modifier.height(dims.space2))
            AuntieFieldLabel(text = "Time blocks")
            Text(
                "The windows kinfolk book into. They pick one of these by name rather than typing a clock time, so this list is what is on offer. Turn a block off to stop offering it without losing its hours. Two blocks that are both on cannot overlap.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            if (blocks.isEmpty()) {
                Text(
                    "No blocks yet. Add one below.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
            blocks.forEachIndexed { index, row ->
                Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                    AuntieField(
                        value = row.label,
                        onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(label = v) } },
                        label = "Name",
                        placeholder = "Midday",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        AuntieField(
                            value = row.startTime,
                            onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(startTime = v) } },
                            label = "Starts",
                            placeholder = "11:00",
                            isError = !HHMM_REGEX.matches(row.startTime),
                            modifier = Modifier.weight(1f),
                        )
                        AuntieField(
                            value = row.endTime,
                            onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(endTime = v) } },
                            label = "Ends",
                            placeholder = "15:00",
                            isError = !HHMM_REGEX.matches(row.endTime),
                            modifier = Modifier.weight(1f),
                        )
                        AuntieToggle(
                            checked = row.active,
                            onCheckedChange = { v -> blocks = blocks.replaceAt(index) { it.copy(active = v) } },
                        )
                        Spacer(Modifier.width(dims.space1))
                        GhostButton(
                            label = "Remove",
                            onClick = { blocks = blocks.filterIndexed { i, _ -> i != index } },
                        )
                    }
                }
            }
            GhostButton(
                label = "Add a block",
                onClick = {
                    val hours = parseWholeNumber(blockHours, 1, 24) ?: 4
                    val taken = blocks.map { it.id }
                    blocks = blocks + TimeBlockRow(
                        id = slugifyBlockId("block ${taken.size + 1}", taken),
                        label = "",
                        startTime = "09:00",
                        endTime = defaultBlockEnd("09:00", hours),
                        active = true,
                    )
                },
            )

            Spacer(Modifier.height(dims.space2))
            PrimaryButton(
                label = "Save booking rules",
                onClick = {
                    onSettingsChange(
                        settings.copy(
                            timeZone = timeZone.trim(),
                            defaultBookingMode = mode,
                            defaultCalendarView = view,
                            allowSpecificTimeBooking = allowSpecific,
                            allowTimeBlockBooking = allowBlock,
                            enableAutoReminder24h = reminder,
                            defaultTimeBlockDurationHours = parseWholeNumber(blockHours, 1, 24) ?: settings.defaultTimeBlockDurationHours,
                            travelBufferMinutes = parseWholeNumber(travelBuffer, 0, 480) ?: settings.travelBufferMinutes,
                            timeBlocks = blocks.toDefinitions(),
                        )
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isLoading && problem == null,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit records (the GPS fields with no control, and the two option lists)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The second half of Business operations: the four GPS/records fields that had
 * no control anywhere, the route-retention period, and the two option LISTS
 * behind the dropdowns in the panel above this one.
 *
 * EVERY FIELD HERE HAS A CONSUMER, per the operator's 2026-08-24 ruling that a
 * control must turn on a working feature. Photo tagging stamps a KinTale photo
 * with where the visit was; arrival verification stops `transitionBookingStatus`
 * completing a visit nobody arrived at; kinfolk location sharing withholds
 * coordinates from the portal callables and the live breadcrumb read; and the
 * two retention periods are applied nightly by `purgeOldVisitRoutes` and
 * `purgeOldDrafts`.
 */
@Composable
internal fun VisitRecordsPanel(
    settings: BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    var photoTagging by remember(settings) { mutableStateOf(settings.enablePhotoLocationTagging) }
    var arrivalCheck by remember(settings) { mutableStateOf(settings.requireArrivalDepartureVerification) }
    var arrivalRadius by remember(settings) { mutableStateOf(settings.arrivalRadiusMeters.toString()) }
    var clientSharing by remember(settings) { mutableStateOf(settings.allowClientLocationSharing) }
    var routeDays by remember(settings) { mutableStateOf(settings.saveRoutesForDays.toString()) }
    var etaOptions by remember(settings) { mutableStateOf(formatOptionList(settings.etaMinuteOptions)) }
    var draftOptions by remember(settings) { mutableStateOf(formatOptionList(settings.draftRetentionOptions)) }

    val problem = visitRecordsError(routeDays, etaOptions, draftOptions, arrivalRadius)

    DenPanel(
        title = "Visit records",
        subtitle = "What a visit leaves behind, and the choices the two pickers above offer.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            if (problem != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Not ready to save") {
                    Text(problem, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieField(
                value = etaOptions,
                onValueChange = { etaOptions = it },
                label = "On My Way choices (minutes)",
                placeholder = "5, 10, 15, 20, 30",
                isError = parseOptionList(etaOptions) == null,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = draftOptions,
                onValueChange = { draftOptions = it },
                label = "Draft retention choices (days)",
                placeholder = "30, 60, 90",
                isError = parseOptionList(draftOptions) == null,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Separate with commas. Deleting the entry a picker is currently set to moves it to the nearest one left.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            AuntieSettingRow(
                title = "Tag visit photos with where they were taken",
                description = "A KinTale photo is stamped with where the visit was when you added it.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = { AuntieToggle(checked = photoTagging, onCheckedChange = { photoTagging = it }) },
            )
            AuntieSettingRow(
                title = "Verify arrival and departure by location",
                description = "A visit cannot be marked complete until it has been arrived at and departed from.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = { AuntieToggle(checked = arrivalCheck, onCheckedChange = { arrivalCheck = it }) },
            )
            AuntieField(
                value = arrivalRadius,
                onValueChange = { arrivalRadius = it },
                label = "Arrival must be within (metres)",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                isError = parseWholeNumber(arrivalRadius, 10, 5000) == null,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Only applies while the switch above is on. Marking Arrived checks where you are " +
                    "against the household's address; further away than this and the visit cannot " +
                    "be marked complete. If your phone cannot get a fix, you are offline, or we " +
                    "cannot place the address on the map, the visit still goes through and is " +
                    "recorded as unverified.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            AuntieSettingRow(
                title = "Let kinfolk see visit locations",
                description = "Off withholds route coordinates from the portal and the live map.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = false,
                trailing = { AuntieToggle(checked = clientSharing, onCheckedChange = { clientSharing = it }) },
            )

            AuntieField(
                value = routeDays,
                onValueChange = { routeDays = it },
                label = "Keep visit routes for (days)",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                isError = parseWholeNumber(routeDays, 1, 3650) == null,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Route pings older than this are deleted nightly. The visit and its summary map stay.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            PrimaryButton(
                label = "Save visit records",
                onClick = {
                    val eta = parseOptionList(etaOptions) ?: settings.etaMinuteOptions
                    val drafts = parseOptionList(draftOptions) ?: settings.draftRetentionOptions
                    onSettingsChange(
                        settings.copy(
                            enablePhotoLocationTagging = photoTagging,
                            requireArrivalDepartureVerification = arrivalCheck,
                            arrivalRadiusMeters =
                                parseWholeNumber(arrivalRadius, 10, 5000) ?: settings.arrivalRadiusMeters,
                            allowClientLocationSharing = clientSharing,
                            saveRoutesForDays = parseWholeNumber(routeDays, 1, 3650) ?: settings.saveRoutesForDays,
                            etaMinuteOptions = eta,
                            defaultEtaMinutes = clampToOptions(settings.defaultEtaMinutes, eta),
                            draftRetentionOptions = drafts,
                            draftRetentionDays = clampToOptions(settings.draftRetentionDays, drafts),
                        )
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isLoading && problem == null,
            )
        }
    }
}

/** Replace one row of a list, leaving the rest untouched. */
private fun List<TimeBlockRow>.replaceAt(index: Int, edit: (TimeBlockRow) -> TimeBlockRow): List<TimeBlockRow> =
    mapIndexed { i, row -> if (i == index) edit(row) else row }
