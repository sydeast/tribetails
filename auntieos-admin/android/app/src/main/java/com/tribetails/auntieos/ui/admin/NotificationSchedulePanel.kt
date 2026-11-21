package com.tribetails.auntieos.ui.admin

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
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.resolveBusinessTimeZone
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieSettingRow
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * WHEN THE DAILY NOTIFICATION JOBS RUN, AND WHETHER THEY REACH ANYBODY.
 *
 * The Android half of the same panel the React admin and the desktop console
 * carry. Parity is mandatory here: a setting on one admin client and not another
 * is a defect, and this one decides whether the product sends anything at all.
 *
 * `householdNotificationsLive` shipped in PR #943 as the pre-launch send gate
 * with no control on any client, so opening the product meant editing a
 * Firestore document by hand. The two hours are new, and they are the answer to
 * the operator asking that the 09:30 overdue job not be hardcoded. A Cloud
 * Scheduler expression is fixed when the function deploys and cannot be read
 * from Firestore at runtime, so the jobs tick hourly and act on the hour stored
 * here. `mytribe/functions/src/lib/notificationSchedule.ts` has the reasoning.
 *
 * NOT SCHEDULED IS THE SHIPPED STATE AND IS A REAL CHOICE, by operator ruling
 * 2026-09-22: no job runs until it is switched on here and the cadence is
 * decided then. It is the first entry in both pickers, it is what an
 * unconfigured document reads as, and picking it again stops the job. The old
 * 09:00 and 07:00 are not offered back as a preselected suggestion, because
 * nobody chose them in the first place.
 *
 * KEPT OUT OF `AdminSettingsScreen.kt` on purpose, the reason `BusinessRulesPanels.kt`
 * gives: that file is over three thousand lines and this costs it one `when`
 * branch instead of a few hundred lines.
 */

/** Every decision this panel makes lives out here, where the JVM suite can reach it. */

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
 * Firestore's mapper will happily hand us a 25 that a hand edit left behind, and
 * `firestore.rules` stops every client from writing one but cannot stop the
 * console. Showing it would put a value in the picker that is not one of its
 * options; the server reads it as no cadence, so this does too. Mirrors
 * `pickHour` on the web and `resolveSendHour` on the server.
 */
internal fun usableNotificationHour(stored: Int?): Int? = stored?.takeIf { it in 0..23 }

/**
 * The one state worth naming on screen: the switch and the send time
 * disagreeing, either way round.
 *
 * #1834: THE SEND TIME GOVERNS TWO JOBS, NOT EVERY NOTICE. This used to read
 * "no send time is set, so none will go out yet" with the switch on, while
 * visit notices were reaching the household. On my way, arrived, departed, the
 * KinTale, booking and invoice notices all go out as they happen; only invoice
 * reminders and overdue notices wait for the hour. And four things do not pass
 * the switch: a broadcast, a single email or text message, an invite and a
 * password reset. Everything else is held, a KinTale or an invoice the operator
 * sends by hand included.
 *
 * A NOTE AND NOT A BLOCKED SAVE. Both states are legal and reasonable to pass
 * through while opening the product, so Save stays enabled. Same sentences as
 * the web (`NotificationScheduleSection.tsx`) and the other Kotlin client.
 */
internal const val SCHEDULE_NOTE_ON_NO_HOUR =
    "Notices to households are on and go out as things happen. " +
        "Invoice reminders and overdue notices have no send time, so only those two wait."
internal const val SCHEDULE_NOTE_OFF_WITH_HOUR =
    "A send time is set, but notices to households are off, so they are held back."

/** What the switch's own line says: what off holds back, and what it does not. */
internal const val HOUSEHOLD_SWITCH_TIP =
    "Off, notices to households are held back, a KinTale or an invoice you send included, and so are broadcasts and marketing blasts. " +
        "A message you write to one household still goes: an email, a text, a push, an inbox reply. " +
        "Invites and password resets still go too. " +
        "Your own alerts and the daily digest still reach you."

internal fun notificationScheduleNote(live: Boolean, hour: Int?): String? = when {
    live && hour == null -> SCHEDULE_NOTE_ON_NO_HOUR
    !live && hour != null -> SCHEDULE_NOTE_OFF_WITH_HOUR
    else -> null
}

/**
 * The panel's value line (#1834): the SAVED state of the switch and of the two
 * jobs' send time, then the clock the times are on. Values, not a sentence
 * (ruling 2026-09-11). It reads the saved document, never the unsaved flip, so
 * it cannot say "on" before Save has.
 */
internal fun notificationScheduleDetail(live: Boolean, hour: Int?, zone: String): String = listOf(
    "Notices to households: ${if (live) "on" else "off"}",
    "Invoice reminders: ${hour?.let(::notificationHourLabel) ?: "not scheduled"}",
    "Times are in $zone",
).joinToString(" · ")

@Composable
internal fun NotificationSchedulePanel(
    settings: BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Re-seeded whenever a fresh document arrives, the convention every other
    // panel on this screen uses.
    var live by remember(settings) { mutableStateOf(settings.householdNotificationsLive) }
    var householdHour by remember(settings) {
        mutableStateOf(usableNotificationHour(settings.householdNotificationHour))
    }
    var digestHour by remember(settings) {
        mutableStateOf(usableNotificationHour(settings.scheduleDigestHour))
    }

    val note = notificationScheduleNote(live, householdHour)

    DenPanel(
        title = "Notification schedule",
        detail = notificationScheduleDetail(
            settings.householdNotificationsLive,
            usableNotificationHour(settings.householdNotificationHour),
            resolveBusinessTimeZone(settings.timeZone),
        ),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            if (note != null) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Worth knowing") {
                    Text(note, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }

            AuntieSettingRow(
                title = "Send notices to households",
                description = HOUSEHOLD_SWITCH_TIP,
                leadingIcon = Lucide.Bell,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = {
                    AuntieToggle(checked = live, onCheckedChange = { live = it }, enabled = !isLoading)
                },
            )

            AuntieDropdownField(
                value = householdHour,
                options = NOTIFICATION_HOUR_OPTIONS,
                onSelect = { householdHour = it },
                displayText = { it?.let(::notificationHourLabel) ?: "Not scheduled" },
                label = "Invoice reminders and overdue notices",
                // The collapsed field shows this, faintly, when nothing is
                // scheduled. `AuntieDropdownField` never calls `displayText` for a
                // null value, so without it the row would read "Select…" and
                // imply the operator had forgotten to answer rather than that
                // they had answered "no".
                placeholder = "Not scheduled",
                enabled = !isLoading,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Both run once a day at this time. Not scheduled means neither runs.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            AuntieDropdownField(
                value = digestHour,
                options = NOTIFICATION_HOUR_OPTIONS,
                onSelect = { digestHour = it },
                displayText = { it?.let(::notificationHourLabel) ?: "Not scheduled" },
                label = "Your daily schedule digest",
                placeholder = "Not scheduled",
                enabled = !isLoading,
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
                description = VISIT_REMINDER_NOTE,
                leadingIcon = Lucide.Clock,
                iconTone = AuntieStatusTone.Neutral,
                showDivider = false,
                trailing = {},
            )

            PrimaryButton(
                label = "Save notification schedule",
                onClick = {
                    // `settings.copy`, never a fresh `BusinessSettings(...)`. The
                    // save diffs against the loaded document, so a rebuilt model
                    // would name every field as changed and write the Kotlin
                    // defaults over the operator's document.
                    onSettingsChange(
                        settings.copy(
                            householdNotificationsLive = live,
                            householdNotificationHour = householdHour,
                            scheduleDigestHour = digestHour,
                        )
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isLoading,
            )
        }
    }
}
