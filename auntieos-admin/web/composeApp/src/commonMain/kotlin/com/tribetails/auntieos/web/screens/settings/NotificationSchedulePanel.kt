package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.AuntieSettingRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * WHEN THE DAILY NOTIFICATION JOBS RUN, AND WHETHER THEY REACH ANYBODY.
 *
 * The desktop console's copy of the panel the React admin and admin Android
 * carry. Parity is mandatory here: a setting on one admin client and not another
 * is a defect, and this one decides whether the product sends anything at all.
 *
 * `householdNotificationsLive` shipped in PR #943 as the pre-launch send gate
 * with no control on any client, so opening the product meant editing a
 * Firestore document by hand. The two hours are new, and they answer the
 * operator asking that the 09:30 overdue job not be hardcoded: a Cloud Scheduler
 * expression is fixed when the function deploys and cannot be read from
 * Firestore at runtime, so the jobs tick hourly and act on the hour stored here.
 * `mytribe/functions/src/lib/notificationSchedule.ts` carries the reasoning.
 *
 * NOT SCHEDULED IS THE SHIPPED STATE AND IS A REAL CHOICE, by operator ruling
 * 2026-09-22: no job runs until it is switched on here and the cadence is
 * decided then. It is the first entry in both pickers, it is what an
 * unconfigured document reads as, and picking it again stops the job.
 *
 * THE SAVE HANDS `loaded.copy(...)`, never a freshly constructed
 * `BusinessSettings()`, the rule `BusinessRulesPanels.kt` states at length: the
 * jvm write diffs against the last read, so a rebuilt model would name every
 * field as changed and write the Kotlin defaults over the operator's document.
 */

/** "9:00 AM" for 9. Mirrors `hourLabel` in the React `NotificationScheduleSection`. */
internal fun notificationHourLabel(hour: Int): String {
    val twelve = if (hour % 12 == 0) 12 else hour % 12
    val meridiem = if (hour < 12) "AM" else "PM"
    return "$twelve:00 $meridiem"
}

/**
 * The picker's entries: "not scheduled" first, then the 24 hours.
 *
 * Null is a real option rather than an empty state, so it has to be IN the list;
 * an operator who scheduled a job must be able to unschedule it from the same
 * control.
 */
internal val NOTIFICATION_HOUR_OPTIONS: List<Int?> = listOf<Int?>(null) + (0..23).toList()

/**
 * A stored hour this panel can show, or null.
 *
 * `firestore.rules` stops every client writing an out-of-range hour but cannot
 * stop the Firestore console, and the read codec carries no `coerceInputValues`.
 * The server reads such a value as no cadence, so this does too, rather than
 * putting a value in the picker that is not one of its options.
 */
internal fun usableNotificationHour(stored: Int?): Int? = stored?.takeIf { it in 0..23 }

/**
 * The one state worth naming on screen: the switch and the cadence disagreeing,
 * either way round.
 *
 * A NOTE AND NOT A BLOCKED SAVE. Both states are legal and reasonable to pass
 * through while opening the product, so Save stays enabled.
 */
internal fun notificationScheduleNote(live: Boolean, hour: Int?): String? = when {
    live && hour == null ->
        "Household notices are on, but no send time is set, so none will go out yet. Pick a time below."
    !live && hour != null ->
        "A send time is set, but household notices are off, so nothing reaches a household yet."
    else -> null
}

@Composable
internal fun NotificationSchedulePanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: CoroutineScope,
) {
    val c = AuntieTheme.colors
    val s = settingsData

    var live by remember(s) { mutableStateOf(s?.householdNotificationsLive == true) }
    var householdHour by remember(s) { mutableStateOf(usableNotificationHour(s?.householdNotificationHour)) }
    var digestHour by remember(s) { mutableStateOf(usableNotificationHour(s?.scheduleDigestHour)) }

    val note = notificationScheduleNote(live, householdHour)
    val dirty = s != null && (
        live != s.householdNotificationsLive ||
            householdHour != usableNotificationHour(s.householdNotificationHour) ||
            digestHour != usableNotificationHour(s.scheduleDigestHour)
        )

    DenPanel(
        title = "Notification schedule",
        subtitle = "Whether automatic notices reach households at all, and what time of day the daily jobs run.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "Times are in ${s?.timeZone.orEmpty().ifBlank { "the business time zone" }}",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            if (note != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Worth knowing") {
                    Text(note, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieSettingRow(
                title = "Send notices to households",
                description = "Off, every notice bound for a household is held back and nothing is sent. " +
                    "Your own alerts and the daily digest still reach you.",
                leadingIcon = Lucide.Bell,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = {
                    AuntieToggle(checked = live, onCheckedChange = { live = it }, enabled = settingsLoaded)
                },
            )

            AuntieSelectField(
                label = "Invoice reminders and overdue notices",
                options = NOTIFICATION_HOUR_OPTIONS,
                selected = householdHour,
                onSelect = { householdHour = it },
                optionLabel = { it?.let(::notificationHourLabel) ?: "Not scheduled" },
                enabled = settingsLoaded,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Both run once a day at this time. Not scheduled means neither runs.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            AuntieSelectField(
                label = "Your daily schedule digest",
                options = NOTIFICATION_HOUR_OPTIONS,
                selected = digestHour,
                onSelect = { digestHour = it },
                optionLabel = { it?.let(::notificationHourLabel) ?: "Not scheduled" },
                enabled = settingsLoaded,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "The next day's visits, emailed to you. Households never see it.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            // Named because the panel would otherwise read as covering every
            // notification. Visit reminders go out relative to the visit, so
            // there is no hour to set for them.
            AuntieSettingRow(
                title = "Visit reminders are not on a clock",
                description = "They go out 24 to 48 hours before each visit. Turn them on or off under Booking.",
                leadingIcon = Lucide.Clock,
                iconTone = AuntieStatusTone.Neutral,
                showDivider = false,
                trailing = {},
            )

            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty && settingsLoaded,
                onCancel = {
                    live = s?.householdNotificationsLive == true
                    householdHour = usableNotificationHour(s?.householdNotificationHour)
                    digestHour = usableNotificationHour(s?.scheduleDigestHour)
                },
                onSave = {
                    // The LOADED document with this panel's three fields overlaid.
                    // `?: BusinessSettings()` would be the rebuild trap: the write
                    // diffs against the last read, so a default-constructed model
                    // would name every field as changed.
                    val loaded = s ?: return@AuntieSaveBar
                    scope.launch {
                        vm.saveSettings(
                            loaded.copy(
                                householdNotificationsLive = live,
                                householdNotificationHour = householdHour,
                                scheduleDigestHour = digestHour,
                            )
                        )
                    }
                },
                dirtyLabel = "Unsaved notification schedule",
                savedLabel = "Notification schedule saved",
            )
        }
    }
}
