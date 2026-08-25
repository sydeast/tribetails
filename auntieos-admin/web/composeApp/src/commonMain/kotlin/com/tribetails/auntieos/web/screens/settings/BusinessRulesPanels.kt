package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.TimeBlockDefinition
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieSettingRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * ISSUE #519: the desktop console's half of the settings no admin surface could
 * edit.
 *
 * Twenty operator-facing `business_settings` fields were decoded, defaulted and
 * round-tripped by this model and rendered by no section of this screen. The
 * comment that stopped the work reasoned from what the (now-retired) wasm screen
 * happened to render; the fields' own meaning was never the argument.
 *
 * Panels here follow the `BookingBehaviorPanel` shape rather than the hoisted
 * `SectionPanel` parameter list: they take the loaded document and the view
 * model, hold their own draft, and save through `vm.saveSettings`. That keeps
 * `SettingsScreen.kt`'s cost to two enum entries and two `when` branches.
 *
 * EVERY SAVE HANDS `settingsData.copy(...)`, the loaded document with this
 * panel's fields overlaid, never a freshly constructed `BusinessSettings()`.
 * With the jvm write now diffing against the last read
 * (`data/BusinessSettingsDiff.kt`), a rebuilt model would name every field as
 * changed and write the Kotlin defaults over the operator's document.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pure rules. Unit-tested; the composables only render them.
// ─────────────────────────────────────────────────────────────────────────────

/** Wire values for `defaultBookingMode`, matching the Android `BookingMode` enum names. */
internal val BOOKING_MODE_WIRE: List<Pair<String, String>> = listOf(
    "SPECIFIC_TIME" to "A specific time (11:15 AM)",
    "TIME_BLOCK" to "A time block (Midday)",
)

/** Wire values for `defaultCalendarView`, matching the Android `CalendarViewMode` enum names. */
internal val CALENDAR_VIEW_WIRE: List<Pair<String, String>> = listOf(
    "DAY" to "Day",
    "WEEK" to "Week",
    "MONTH" to "Month",
    "AGENDA" to "Agenda",
)

/** Wire values for `trackingAccuracy`, matching the Android `TrackingAccuracy` enum names. */
internal val TRACKING_ACCURACY_WIRE: List<Pair<String, String>> = listOf(
    "HIGH" to "High (most precise, heaviest on battery)",
    "MEDIUM" to "Medium (balanced)",
    "LOW" to "Low (lightest on battery, least precise)",
)

/**
 * `options`, plus `current` when the document holds something the vocabulary
 * does not list, so a legacy or hand-edited value stays visible and saveable as
 * it is instead of the picker snapping to a value nobody chose.
 */
internal fun optionsIncluding(
    options: List<Pair<String, String>>,
    current: String,
): List<Pair<String, String>> =
    if (options.any { it.first == current }) options
    else options + (current to "$current (not a known value)")

internal val HHMM_REGEX = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")

internal const val MAX_TIME_BLOCKS: Int = 12
internal const val MAX_OPTION_LIST_LENGTH: Int = 12

/** `raw` as a whole number inside [min]..[max], or null. Blank is null, never zero. */
internal fun parseWholeNumber(raw: String, min: Int, max: Int): Int? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || !trimmed.all { it.isDigit() }) return null
    val value = trimmed.toIntOrNull() ?: return null
    return if (value in min..max) value else null
}

/** A comma list as sorted unique positive whole numbers, or null when any entry is unusable. */
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

internal fun formatOptionList(values: List<Int>): String = values.joinToString(", ")

/**
 * The default to store beside a freshly edited option list: unchanged when it is
 * a member, otherwise the nearest survivor, ties going SMALLER so nobody is
 * silently handed a longer wait than they had.
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

/**
 * A url-safe id from a label, used only when a row is ADDED. An existing row is
 * never re-slugged: `resolveTimeBlock` matches stored sessions by the block's
 * identity, and renaming "Midday" must not orphan visits labelled with it.
 */
internal fun slugifyBlockId(label: String, taken: List<String>): String {
    val base = label.lowercase()
        .map { if (it.isLetterOrDigit()) it else '-' }
        .joinToString("")
        .replace(Regex("-+"), "-")
        .trim('-')
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
    val hh = (end / 60).toString().padStart(2, '0')
    val mm = (end % 60).toString().padStart(2, '0')
    return "$hh:$mm"
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

/**
 * What is wrong with the whole booking-rules draft, or null.
 *
 * [zoneUsable] is passed in rather than computed, because "can this runtime
 * resolve the zone" is a platform question and this rule is common code.
 */
internal fun bookingRulesError(
    defaultBookingMode: String,
    allowSpecificTimeBooking: Boolean,
    allowTimeBlockBooking: Boolean,
    blockDurationHours: String,
    travelBufferMinutes: String,
    blocks: List<TimeBlockRow>,
    timeZone: String,
    zoneUsable: Boolean,
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
    if (!zoneUsable) return "Nothing here can read a time in \"$timeZone\". Pick a zone from the list."
    if (parseWholeNumber(blockDurationHours, 1, 24) == null) return "Default block length: enter 1 to 24 hours."
    if (parseWholeNumber(travelBufferMinutes, 0, 480) == null) return "Travel buffer: enter 0 to 480 minutes."
    timeBlockError(blocks)?.let { return it }
    if (allowTimeBlockBooking && blocks.none { it.active }) {
        return "Time-block booking is on but no block is active, so there is nothing to book into."
    }
    return null
}

/** What is wrong with the visit-records draft, or null. */
internal fun visitRecordsError(saveRoutesForDays: String, etaOptions: String, draftOptions: String): String? {
    if (parseWholeNumber(saveRoutesForDays, 1, 3650) == null) return "Keep routes for: enter 1 to 3650 days."
    if (parseOptionList(etaOptions) == null) return "On-my-way choices: whole numbers over zero, no repeats."
    if (parseOptionList(draftOptions) == null) return "Draft-retention choices: whole numbers over zero, no repeats."
    return null
}

/**
 * Every zone id this runtime knows, with `current` and the shipped default kept
 * present whatever the tzdata says. Implemented per platform: the desktop asks
 * `java.time`, and a zone id can be retired between tzdata releases, so dropping
 * the stored one would silently retarget the phone line's open/closed answer,
 * quote expiry and every visit date at whatever sorted first.
 */
internal expect fun platformTimeZoneIds(): List<String>

/** Can this runtime resolve the zone? A no means the phone line answers as open around the clock. */
internal expect fun platformTimeZoneUsable(zone: String): Boolean

internal fun timeZoneOptions(current: String): List<String> {
    val all = sortedSetOf<String>()
    all += platformTimeZoneIds()
    all += "America/New_York"
    val trimmed = current.trim()
    if (trimmed.isNotEmpty()) all += trimmed
    return all.toList()
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The booking-configuration block, the business time zone, and the bookable
 * time blocks.
 *
 * TIME ZONE IS HERE ON THE PHONE AND UNDER BUSINESS PROFILE ON THE WEB. This
 * console has a Business profile section, so it follows the issue's own
 * grouping: `TimeZonePanel` below is rendered there, and this panel does not
 * repeat it. One home per setting.
 */
@Composable
internal fun BookingRulesPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val s = settingsData

    var mode by remember(s) { mutableStateOf(s?.defaultBookingMode ?: "SPECIFIC_TIME") }
    var view by remember(s) { mutableStateOf(s?.defaultCalendarView ?: "MONTH") }
    var allowSpecific by remember(s) { mutableStateOf(s?.allowSpecificTimeBooking != false) }
    var allowBlock by remember(s) { mutableStateOf(s?.allowTimeBlockBooking != false) }
    var reminder by remember(s) { mutableStateOf(s?.enableAutoReminder24h != false) }
    var blockHours by remember(s) { mutableStateOf((s?.defaultTimeBlockDurationHours ?: 4).toString()) }
    var travelBuffer by remember(s) { mutableStateOf((s?.travelBufferMinutes ?: 30).toString()) }
    // Sorted on the way in, matching how they are stored. Rows are NOT re-sorted
    // while the operator types: moving a row out from under a cursor because a
    // start time is momentarily "0" is worse than a list briefly out of order.
    var blocks by remember(s) {
        mutableStateOf(s?.timeBlocks.orEmpty().map { it.toRow() }.sortedWith(::compareBlocksByStart))
    }

    val problem = bookingRulesError(
        defaultBookingMode = mode,
        allowSpecificTimeBooking = allowSpecific,
        allowTimeBlockBooking = allowBlock,
        blockDurationHours = blockHours,
        travelBufferMinutes = travelBuffer,
        blocks = blocks,
        timeZone = s?.timeZone.orEmpty(),
        zoneUsable = true, // the zone is edited on its own panel; not this panel's gate
    )

    DenPanel(
        title = "Booking rules",
        subtitle = "How visits may be booked, how long a block runs, and how much room to leave between two visits.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            if (problem != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Not ready to save") {
                    Text(problem, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieSettingRow(
                title = "Offer specific times",
                description = "Kinfolk pick an exact start time.",
                leadingIcon = Lucide.Clock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = allowSpecific,
                        onCheckedChange = { allowSpecific = it },
                        enabled = settingsLoaded,
                    )
                },
            )
            AuntieSettingRow(
                title = "Offer time blocks",
                description = "Kinfolk pick a named window instead of a clock time.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = allowBlock,
                        onCheckedChange = { allowBlock = it },
                        enabled = settingsLoaded,
                    )
                },
            )
            AuntieSettingRow(
                title = "Remind kinfolk 24 hours before a visit",
                description = "The reminder goes out the day before. Turning this off stops it for everyone.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = {
                    AuntieToggle(
                        checked = reminder,
                        onCheckedChange = { reminder = it },
                        enabled = settingsLoaded,
                    )
                },
            )

            AuntieSelectField(
                label = "New bookings start as",
                options = optionsIncluding(BOOKING_MODE_WIRE, mode).map { it.first },
                selected = mode,
                onSelect = { mode = it },
                optionLabel = { wire -> optionsIncluding(BOOKING_MODE_WIRE, mode).first { it.first == wire }.second },
                enabled = settingsLoaded,
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieSelectField(
                label = "Calendar opens on",
                options = optionsIncluding(CALENDAR_VIEW_WIRE, view).map { it.first },
                selected = view,
                onSelect = { view = it },
                optionLabel = { wire -> optionsIncluding(CALENDAR_VIEW_WIRE, view).first { it.first == wire }.second },
                enabled = settingsLoaded,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(horizontalArrangement = Arrangement.spacedBy(dims.space3), modifier = Modifier.fillMaxWidth()) {
                BottomBorderField(
                    value = blockHours,
                    onValueChange = { blockHours = it },
                    label = "Default block length (hours)",
                    placeholder = "4",
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    value = travelBuffer,
                    onValueChange = { travelBuffer = it },
                    label = "Travel buffer (minutes)",
                    placeholder = "30",
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
                Text("No blocks yet. Add one below.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            blocks.forEachIndexed { index, row ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    verticalAlignment = Alignment.Bottom,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    BottomBorderField(
                        value = row.label,
                        onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(label = v) } },
                        label = "Name",
                        placeholder = "Midday",
                        modifier = Modifier.weight(2f),
                    )
                    BottomBorderField(
                        value = row.startTime,
                        onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(startTime = v) } },
                        label = "Starts",
                        placeholder = "11:00",
                        modifier = Modifier.weight(1f),
                    )
                    BottomBorderField(
                        value = row.endTime,
                        onValueChange = { v -> blocks = blocks.replaceAt(index) { it.copy(endTime = v) } },
                        label = "Ends",
                        placeholder = "15:00",
                        modifier = Modifier.weight(1f),
                    )
                    AuntieToggle(
                        checked = row.active,
                        onCheckedChange = { v -> blocks = blocks.replaceAt(index) { it.copy(active = v) } },
                    )
                    GhostButton(
                        label = "Remove",
                        onClick = { blocks = blocks.filterIndexed { i, _ -> i != index } },
                    )
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
                label = if (settingsLoaded) "Save booking rules" else "Loading settings…",
                enabled = settingsLoaded && problem == null,
                onClick = {
                    val loaded = s ?: return@PrimaryButton
                    scope.launch {
                        vm.saveSettings(
                            loaded.copy(
                                defaultBookingMode = mode,
                                defaultCalendarView = view,
                                allowSpecificTimeBooking = allowSpecific,
                                allowTimeBlockBooking = allowBlock,
                                enableAutoReminder24h = reminder,
                                defaultTimeBlockDurationHours = parseWholeNumber(blockHours, 1, 24)
                                    ?: loaded.defaultTimeBlockDurationHours,
                                travelBufferMinutes = parseWholeNumber(travelBuffer, 0, 480)
                                    ?: loaded.travelBufferMinutes,
                                timeBlocks = blocks.toDefinitions(),
                            )
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visits and tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The GPS block and the two visit defaults, with their option lists.
 *
 * EVERY FIELD HERE HAS A CONSUMER, per the operator's 2026-08-24 ruling that a
 * control must turn on a working feature. The master switch, auto-start and
 * accuracy change what the phone's `LocationTrackingService` does; the ETA
 * default and its choices drive the On My Way sheet; photo tagging stamps a
 * KinTale photo with where the visit was; arrival verification stops
 * `transitionBookingStatus` completing a visit nobody arrived at; kinfolk
 * location sharing withholds coordinates from the portal callables and the live
 * breadcrumb read; and the two retention periods are applied nightly by
 * `purgeOldVisitRoutes` and `purgeOldDrafts`.
 */
@Composable
internal fun VisitsTrackingPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val s = settingsData

    var tracking by remember(s) { mutableStateOf(s?.enableGPSTrackingForAllVisits != false) }
    var autoStart by remember(s) { mutableStateOf(s?.autoStartTrackingOnVisitStart != false) }
    var accuracy by remember(s) { mutableStateOf(s?.trackingAccuracy ?: "HIGH") }
    var photoTagging by remember(s) { mutableStateOf(s?.enablePhotoLocationTagging != false) }
    var arrivalCheck by remember(s) { mutableStateOf(s?.requireArrivalDepartureVerification != false) }
    var clientSharing by remember(s) { mutableStateOf(s?.allowClientLocationSharing != false) }
    var routeDays by remember(s) { mutableStateOf((s?.saveRoutesForDays ?: 90).toString()) }
    var etaOptions by remember(s) { mutableStateOf(formatOptionList(s?.etaMinuteOptions.orEmpty())) }
    var draftOptions by remember(s) { mutableStateOf(formatOptionList(s?.draftRetentionOptions.orEmpty())) }

    val problem = visitRecordsError(routeDays, etaOptions, draftOptions)

    DenPanel(
        title = "Visits and tracking",
        subtitle = "GPS while you are out on a visit, the defaults the visit card starts with, and what a visit leaves behind.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            if (problem != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Not ready to save") {
                    Text(problem, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieSettingRow(
                title = "Track visits by GPS",
                description = "The master switch. Off stops the tracking service on the phone outright.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(checked = tracking, onCheckedChange = { tracking = it }, enabled = settingsLoaded)
                },
            )
            AuntieSettingRow(
                title = "Start tracking when a visit starts",
                description = "Arriving at a visit begins tracking by itself.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = autoStart,
                        onCheckedChange = { autoStart = it },
                        enabled = settingsLoaded && tracking,
                    )
                },
            )
            AuntieSelectField(
                label = "Tracking accuracy",
                options = optionsIncluding(TRACKING_ACCURACY_WIRE, accuracy).map { it.first },
                selected = accuracy,
                onSelect = { accuracy = it },
                optionLabel = { wire ->
                    optionsIncluding(TRACKING_ACCURACY_WIRE, accuracy).first { it.first == wire }.second
                },
                enabled = settingsLoaded && tracking,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(dims.space2))
            AuntieFieldLabel(text = "Visit card defaults")
            BottomBorderField(
                value = etaOptions,
                onValueChange = { etaOptions = it },
                label = "On My Way choices (minutes)",
                placeholder = "5, 10, 15, 20, 30",
                modifier = Modifier.fillMaxWidth(),
            )
            BottomBorderField(
                value = draftOptions,
                onValueChange = { draftOptions = it },
                label = "Draft retention choices (days)",
                placeholder = "30, 60, 90",
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Separate with commas. Deleting the entry a picker is currently set to moves it to the nearest one left.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            Spacer(Modifier.height(dims.space2))
            AuntieFieldLabel(text = "Records and sharing")
            AuntieSettingRow(
                title = "Tag visit photos with where they were taken",
                description = "A KinTale photo is stamped with where the visit was when you added it.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(checked = photoTagging, onCheckedChange = { photoTagging = it }, enabled = settingsLoaded)
                },
            )
            AuntieSettingRow(
                title = "Verify arrival and departure by location",
                description = "A visit cannot be marked complete until it has been arrived at and departed from.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(checked = arrivalCheck, onCheckedChange = { arrivalCheck = it }, enabled = settingsLoaded)
                },
            )
            AuntieSettingRow(
                title = "Let kinfolk see visit locations",
                description = "Off withholds route coordinates from the portal and the live map.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = false,
                trailing = {
                    AuntieToggle(checked = clientSharing, onCheckedChange = { clientSharing = it }, enabled = settingsLoaded)
                },
            )
            BottomBorderField(
                value = routeDays,
                onValueChange = { routeDays = it },
                label = "Keep visit routes for (days)",
                placeholder = "90",
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Route pings and unsent drafts older than these windows are deleted nightly. Visits, their summary maps and anything already sent stay.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            Spacer(Modifier.height(dims.space2))
            PrimaryButton(
                label = if (settingsLoaded) "Save visits and tracking" else "Loading settings…",
                enabled = settingsLoaded && problem == null,
                onClick = {
                    val loaded = s ?: return@PrimaryButton
                    val eta = parseOptionList(etaOptions) ?: loaded.etaMinuteOptions
                    val drafts = parseOptionList(draftOptions) ?: loaded.draftRetentionOptions
                    scope.launch {
                        vm.saveSettings(
                            loaded.copy(
                                enableGPSTrackingForAllVisits = tracking,
                                autoStartTrackingOnVisitStart = autoStart,
                                trackingAccuracy = accuracy,
                                enablePhotoLocationTagging = photoTagging,
                                requireArrivalDepartureVerification = arrivalCheck,
                                allowClientLocationSharing = clientSharing,
                                saveRoutesForDays = parseWholeNumber(routeDays, 1, 3650) ?: loaded.saveRoutesForDays,
                                etaMinuteOptions = eta,
                                defaultEtaMinutes = clampToOptions(loaded.defaultEtaMinutes, eta),
                                draftRetentionOptions = drafts,
                                draftRetentionDays = clampToOptions(loaded.draftRetentionDays, drafts),
                            )
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time zone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `business_settings.timeZone`, the highest-consequence field #519 found: five
 * server behaviors read it (the phone line's open/closed answer, quote expiry,
 * the dates in every visit message, notification template time tokens, and the
 * new-booking dialog's mismatch note) and no admin surface could set it.
 *
 * Rendered under Business profile, following the issue's own grouping.
 * BOOKINGS STILL DO NOT CONVERT THROUGH IT: both admin clients write booking
 * times from the operator's device wall clock, and `booking_time_slots` carries
 * no zone to convert from. What changes is that the mismatch the new-booking
 * dialog discloses is now something the operator can go and fix.
 */
@Composable
internal fun TimeZonePanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val s = settingsData

    var zone by remember(s) { mutableStateOf(s?.timeZone ?: "America/New_York") }
    val usable = platformTimeZoneUsable(zone)

    DenPanel(
        title = "Time zone",
        subtitle = "The clock the business runs on. Your phone line's open and closed hours, quote expiry dates, and the visit dates in every message are read in this zone.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieSelectField(
                label = "Business time zone",
                options = timeZoneOptions(s?.timeZone.orEmpty()),
                selected = zone,
                onSelect = { zone = it },
                optionLabel = { it },
                enabled = settingsLoaded,
                modifier = Modifier.fillMaxWidth(),
            )
            if (!usable) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "This zone will not work") {
                    Text(
                        "Nothing here can read a time in \"$zone\". Saved as it is, the phone line answers as open around the clock.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textPrimary,
                    )
                }
            }
            Text(
                "Times typed into the new-booking dialog stay on this computer's clock. The zone above is what the phone line and outgoing messages read.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Spacer(Modifier.height(2.dp))
            PrimaryButton(
                label = if (settingsLoaded) "Save" else "Loading settings…",
                enabled = settingsLoaded && usable,
                onClick = {
                    val loaded = s ?: return@PrimaryButton
                    scope.launch { vm.saveSettings(loaded.copy(timeZone = zone.trim())) }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Replace one row of a list, leaving the rest untouched. */
private fun List<TimeBlockRow>.replaceAt(index: Int, edit: (TimeBlockRow) -> TimeBlockRow): List<TimeBlockRow> =
    mapIndexed { i, row -> if (i == index) edit(row) else row }
