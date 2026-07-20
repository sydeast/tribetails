package com.tribetails.auntieos.web.screens.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.AdminNotificationPrefs
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.CloudNotificationOverridesRepository
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.NotifAudience
import com.tribetails.auntieos.web.data.NotificationCatalogEntry
import com.tribetails.auntieos.web.data.NotificationMatrix
import com.tribetails.auntieos.web.data.STREAM_BUSINESS
import com.tribetails.auntieos.web.data.STREAM_STAFF
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.adminChannelForced
import com.tribetails.auntieos.web.data.adminChannelReason
import com.tribetails.auntieos.web.data.adminGateEnabledChannels
import com.tribetails.auntieos.web.data.adminVisibleNotifications
import com.tribetails.auntieos.web.data.displayTitle
import com.tribetails.auntieos.web.data.sectionedNotifications
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieSettingRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

/**
 * The operator's OWN notification settings: what reaches THEM, and how.
 *
 * Distinct from the business gate (Settings -> Notifications). The gate decides which
 * channels each notification even OFFERS; this screen is the admin's choice, within
 * those offered channels, of what they actually receive. Reached from the account area.
 *
 * Data sources (same catalog + gate as the Settings matrix panel):
 *   - [CloudNotificationOverridesRepository.getMatrix] -> catalog + business overrides.
 *   - [FirestoreClient.getMyAdminNotificationPrefs] / saveMyAdminNotificationPrefs ->
 *     the admin's receive prefs at staff/{uid}.notificationPrefs.
 *
 * Two stacked sections, one per stream the operator wears: "As the owner" (business
 * stream: bookings, invoices, payments, security, ratings) and "As the Auntie" (staff
 * stream: visit notes, KinTale comments, pet updates, the schedule digest). A channel
 * the business LOCKED for that stream (or the catalog requires) renders as required-on
 * and read-only with the reason, preferring the operator's own lockReason; the others
 * are toggles the operator controls. Fail-loud: load + save errors surface in a
 * banner, never a silent fallback.
 */
@Composable
fun MyNotificationsScreen(
    authUser: AuthUser,
    onBack: () -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    val client = remember { FirestoreClient() }
    // Reuse the EXACT data source the Settings gate matrix uses for catalog + overrides.
    val gateRepo = remember { CloudNotificationOverridesRepository() }

    var matrix by remember { mutableStateOf<NotificationMatrix?>(null) }
    var prefs by remember { mutableStateOf<AdminNotificationPrefs?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        loading = true
        loadError = null
        when (val g = gateRepo.getMatrix()) {
            is WriteResult.Err -> { loadError = g.message; loading = false; return }
            is WriteResult.Ok -> matrix = g.value
        }
        when (val p = client.getMyAdminNotificationPrefs()) {
            is WriteResult.Err -> { loadError = p.message; loading = false; return }
            is WriteResult.Ok -> prefs = p.value
        }
        loading = false
    }
    LaunchedEffect(authUser.uid) { reload() }

    // Optimistic per-channel save: flip locally, persist, revert to server truth on error.
    fun setChannel(entry: NotificationCatalogEntry, channel: String, on: Boolean) {
        val current = prefs ?: return
        val next = current.withByKeyChannel(entry.key, channel, on)
        prefs = next // optimistic
        scope.launch {
            when (val r = client.saveMyAdminNotificationPrefs(next)) {
                is WriteResult.Ok -> saveError = null
                is WriteResult.Err -> { saveError = r.message; reload() }
            }
        }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker = "The Den · Account",
            title = "What reaches",
            accentTail = "you.",
            subtitle = "Your business decides which channels each notification can use. Here you pick, " +
                "within those, what actually reaches you and how. Anything your business locked on shows " +
                "as required.",
            trailing = {
                AuntieIconButton(
                    icon = Lucide.ChevronLeft,
                    contentDescription = "Back to account",
                    onClick = onBack,
                    size = 38.dp,
                )
            },
        )
        Spacer(Modifier.height(20.dp))

        if (saveError != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't save that change") {
                Text(saveError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            Spacer(Modifier.height(12.dp))
        }

        when {
            loading ->
                Text("Loading your notification settings…", style = AuntieTheme.typography.bodySmall, color = c.textDim)

            loadError != null ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load your notification settings") {
                    Text(loadError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }

            else -> {
                val m = matrix!!
                val p = prefs!!
                // Two stacked sections, one per hat: owner (business stream) and
                // Auntie (staff stream). A key serving business+kinfolk shows once,
                // under the owner section; kinfolk copies are the families' own and
                // never appear here.
                val ownerRows = adminVisibleNotifications(m, STREAM_BUSINESS)
                val auntieRows = adminVisibleNotifications(m, STREAM_STAFF)
                if (ownerRows.isEmpty() && auntieRows.isEmpty()) {
                    DenPanel(title = "Your notifications", subtitle = "Nothing to set just yet.") {
                        Text(
                            "Your business has not enabled any notifications for you yet. Once a channel is " +
                                "turned on in Settings, it will show up here.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                } else {
                    if (ownerRows.isNotEmpty()) {
                        DenPanel(
                            title = "As the owner",
                            subtitle = "The business side: bookings, invoices, payments, security, ratings.",
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                                // Same workflow sections the gate matrix uses.
                                sectionedNotifications(ownerRows, NotifAudience.Business).forEach { (section, rows) ->
                                    NotifSubsectionHeader(section.title)
                                    rows.forEach { entry ->
                                        AdminNotificationBlock(
                                            matrix = m,
                                            prefs = p,
                                            entry = entry,
                                            stream = STREAM_BUSINESS,
                                            onToggle = { channel, on -> setChannel(entry, channel, on) },
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                    }
                    if (auntieRows.isNotEmpty()) {
                        DenPanel(
                            title = "As the Auntie",
                            subtitle = "The care side: visit notes, KinTale comments, pet updates, your schedule digest.",
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                                sectionedNotifications(auntieRows, NotifAudience.Staff).forEach { (section, rows) ->
                                    NotifSubsectionHeader(section.title)
                                    rows.forEach { entry ->
                                        AdminNotificationBlock(
                                            matrix = m,
                                            prefs = p,
                                            entry = entry,
                                            stream = STREAM_STAFF,
                                            onToggle = { channel, on -> setChannel(entry, channel, on) },
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                    }
                }
            }
        }
    }
}

/** Subtle workflow-section header inside a hat panel (matches the gate matrix headers). */
@Composable
private fun NotifSubsectionHeader(title: String) {
    val c = AuntieTheme.colors
    Text(title.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
}

/** One notification: its name + description, then a row per gate-enabled channel of [stream]. */
@Composable
private fun AdminNotificationBlock(
    matrix: NotificationMatrix,
    prefs: AdminNotificationPrefs,
    entry: NotificationCatalogEntry,
    stream: String,
    onToggle: (channel: String, on: Boolean) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Text(entry.displayTitle(), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        Spacer(Modifier.height(6.dp))
        val channels = adminGateEnabledChannels(matrix, entry, stream)
        channels.forEachIndexed { idx, channel ->
            val forced = adminChannelForced(matrix, entry, stream, channel)
            val showDivider = idx < channels.lastIndex
            if (forced) {
                AuntieSettingRow(
                    title = channelLabel(channel),
                    // The operator's own lock reason wins; stock lines otherwise.
                    description = adminChannelReason(matrix, entry, channel),
                    showDivider = showDivider,
                    trailing = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AuntieStatusPill(label = "Required", tone = AuntieStatusTone.Teal)
                            // Locked toggle: forced-on, read-only (clicks swallowed, lock glyph shown).
                            AuntieToggle(checked = true, locked = true, onCheckedChange = {})
                        }
                    },
                )
            } else {
                val on = prefs.userChannelChoice(entry.key, entry.category, channel)
                AuntieSettingRow(
                    title = channelLabel(channel),
                    showDivider = showDivider,
                    trailing = {
                        AuntieToggle(checked = on, onCheckedChange = { onToggle(channel, it) })
                    },
                )
            }
        }
    }
}

private fun channelLabel(channel: String): String = when (channel) {
    "email" -> "Email"
    "sms" -> "Text (SMS)"
    "push" -> "Push"
    else -> channel.replaceFirstChar { it.uppercase() }
}
