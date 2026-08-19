package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.AdminNotificationPrefs
import com.tribetails.auntieos.data.model.NOTIF_CHANNELS
import com.tribetails.auntieos.data.model.NotificationCatalogEntry
import com.tribetails.auntieos.data.model.NotificationMatrix
import com.tribetails.auntieos.data.model.STREAM_BUSINESS
import com.tribetails.auntieos.data.model.STREAM_STAFF
import com.tribetails.auntieos.data.model.adminReceives
import com.tribetails.auntieos.data.model.applyBulkToggle
import com.tribetails.auntieos.data.model.channelForcedForUser
import com.tribetails.auntieos.data.model.channelForcedReason
import com.tribetails.auntieos.data.model.channelOfferedToUser
import com.tribetails.auntieos.data.model.notifChannelLabel
import com.tribetails.auntieos.data.model.sectionedNotifEntries
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * The operator's OWN notification receive-prefs (Android mirror of the web screen).
 *
 * This is the user-side counterpart to the Business Settings matrix (the gate). The gate
 * decides which channels are AVAILABLE per stream; here the operator chooses, within
 * those, what actually reaches them. Two stacked sections mirror the operator's two
 * hats: "As the owner" (business stream: bookings, invoices, payments, security,
 * ratings) and "As the Auntie" (staff stream: visit notes, KinTale comments, pet
 * updates, schedule digest). Kinfolk copies never show here; a business+kinfolk key
 * appears exactly once, in the owner section. Each entry shows only the channels the
 * stream's gate enabled; a locked or catalog-required channel is forced on and rendered
 * read-only with its reason (the operator's lockReason when written, else the built-in
 * fallback). Backed by getMyAdminNotificationPrefs / saveMyAdminNotificationPrefs
 * (staff/{uid}.notificationPrefs). Fail-loud on load/save errors.
 */

/** One receive section on the prefs screen: a stream plus its heading copy. */
private data class ReceiveSection(val stream: String, val title: String, val subtitle: String)

private val RECEIVE_SECTIONS = listOf(
    ReceiveSection(
        stream = STREAM_BUSINESS,
        title = "As the owner",
        subtitle = "Bookings, invoices, payments, security, and ratings. The business end of things.",
    ),
    ReceiveSection(
        stream = STREAM_STAFF,
        title = "As the Auntie",
        subtitle = "Visit notes, KinTale comments, pet updates, and the schedule digest. The hands-on side.",
    ),
)

@Composable
fun AdminNotificationPrefsScreen(onBack: () -> Unit) {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }
    val scope = rememberCoroutineScope()

    var matrix by remember { mutableStateOf<NotificationMatrix?>(null) }
    var prefs by remember { mutableStateOf<AdminNotificationPrefs?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true
        loadError = null
        // The gate (which channels the business enabled) and the admin's own prefs.
        repo.getBusinessNotificationOverrides()
            .onSuccess { matrix = it }
            .onFailure { loadError = it.message ?: "Couldn't load the notification gate" }
        repo.getMyAdminNotificationPrefs()
            .onSuccess { prefs = it }
            .onFailure {
                val msg = it.message ?: "Couldn't load your preferences"
                loadError = if (loadError == null) msg else "$loadError  $msg"
            }
        loading = false
    }

    // Optimistic write of a single channel toggle; reverts to the prior prefs on failure.
    fun persist(key: String, channel: String, value: Boolean) {
        val prev = prefs ?: return
        val next = prev.withByKeyChannel(key, channel, value)
        prefs = next
        scope.launch {
            repo.saveMyAdminNotificationPrefs(next)
                .onSuccess { saveError = null }
                .onFailure { saveError = it.message ?: "Save failed"; prefs = prev }
        }
    }

    // Page-level select-all (#390 Android parity): builds the WHOLE next-prefs object
    // with applyBulkToggle, once per hat (business + staff — "editable" is gate-scoped
    // per stream, same reason the web fix chains it per stream), then commits with ONE
    // optimistic saveMyAdminNotificationPrefs call. Deliberately NOT built as N calls to
    // `persist`: this screen saves each row's toggle optimistically per click, so a naive
    // bulk built that way would fire one callable round trip per channel (~24 for a full
    // page). This is the one control that actually covers every editable channel on the
    // page; the read-only web parity note in #390 is what this closes.
    fun persistBulk(on: Boolean) {
        val m = matrix ?: return
        val prev = prefs ?: return
        var next = prev
        RECEIVE_SECTIONS.forEach { section ->
            val rows = m.catalog.filter { it.adminReceives(m, section.stream) }
            next = next.applyBulkToggle(m, rows, section.stream, on)
        }
        prefs = next
        scope.launch {
            repo.saveMyAdminNotificationPrefs(next)
                .onSuccess { saveError = null }
                .onFailure { saveError = it.message ?: "Save failed"; prefs = prev }
        }
    }

    AuntieScreenScaffold(title = "Your notifications", onBack = onBack, imePaddingEnabled = true) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
        ) {
            DenScreenHeading(
                kicker = "The Den · Account",
                title = "What you",
                accentTail = "receive.",
                subtitle = "Two hats, two stacks: what reaches you as the owner and what reaches you " +
                    "as the Auntie, within the channels your business enabled. Locked channels are " +
                    "required and can't be turned off.",
            )
            Spacer(Modifier.height(20.dp))

            loadError?.let {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load your notifications", icon = Lucide.TriangleAlert) {
                    Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(16.dp))
            }
            saveError?.let {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed", icon = Lucide.TriangleAlert) {
                    Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(16.dp))
            }

            val m = matrix
            val p = prefs
            when {
                loading -> EmptyHint("Loading your notifications…")
                m == null || p == null -> if (loadError == null) EmptyHint("Couldn't load your notifications.", error = true)
                else -> {
                    val anyRow = RECEIVE_SECTIONS.any { s -> m.catalog.any { it.adminReceives(m, s.stream) } }
                    if (!anyRow) {
                        EmptyHint(
                            "Your business hasn't enabled any notifications for you yet. Turn channels On in " +
                                "Admin Settings, under Per-notification settings.",
                        )
                    } else {
                        // The page-level pair (#390): the only control that means every
                        // editable channel on the page, across both hats. Its own bordered
                        // bar and solid PrimaryButton keep it visually distinct from any
                        // future per-section control (this screen has none today).
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(c.surface2)
                                .border(BorderStroke(1.dp, SolidColor(c.border)), RoundedCornerShape(12.dp))
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(
                                "Every notification below",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                                modifier = Modifier.weight(1f),
                            )
                            PrimaryButton(label = "All on", onClick = { persistBulk(true) })
                            GhostButton(label = "All off", onClick = { persistBulk(false) })
                        }
                        Spacer(Modifier.height(16.dp))

                        RECEIVE_SECTIONS.forEach { section ->
                            val rows = m.catalog.filter { it.adminReceives(m, section.stream) }
                            if (rows.isNotEmpty()) {
                                DenPanel(title = section.title, subtitle = section.subtitle) {
                                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        // Rows grouped under the shared workflow sections;
                                        // unmatched categories land in a trailing "Other".
                                        sectionedNotifEntries(rows, section.stream).forEachIndexed { index, (sectionTitle, sectionRows) ->
                                            NotifSubsectionHeading(title = sectionTitle, isFirst = index == 0)
                                            sectionRows.forEach { entry ->
                                                AdminReceiveRow(
                                                    entry = entry,
                                                    matrix = m,
                                                    prefs = p,
                                                    stream = section.stream,
                                                    onToggle = { ch, v -> persist(entry.key, ch, v) },
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
    }
}

/**
 * One sub-section's boundary + label, inside a hat's [DenPanel] (#391: the web
 * screen's `.mynotif__section` counterpart). Every sub-section but the first
 * gets a rule at [AuntieTheme.dims.borderEmphasis] in the full
 * [AuntieTheme.colors.border]: heavier and darker than the
 * `dims.borderHairline` / `colors.borderSoft` line each [AdminReceiveRow]
 * below it draws, the same "outranks a row hairline" idiom
 * `InvoicesScreen`'s row dividers sit one step under. The title itself is
 * now uppercased, matching the web heading, where before it read as plain
 * body text with nothing marking it as a boundary. The first sub-section in
 * a hat has nothing above it to divide from, so it carries neither the rule
 * nor the extra top space that makes room for one.
 *
 * Pulled out of the loop in [AdminNotificationPrefsScreen] so it is directly
 * testable: that composable reads `AuntieOSApp.instance.repository` itself
 * (no injectable dependency to mock), while this one takes plain values.
 */
@Composable
internal fun NotifSubsectionHeading(title: String, isFirst: Boolean, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    Column(modifier) {
        if (!isFirst) {
            Spacer(Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(AuntieTheme.dims.borderEmphasis)
                    .background(c.border)
                    .testTag("mynotif-section-divider"),
            )
        }
        Text(
            title.uppercase(),
            style = AuntieTheme.typography.labelMedium,
            color = c.textPrimary,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = if (isFirst) 0.dp else 10.dp, bottom = 2.dp),
        )
    }
}

/** One notification's receive controls: a labelled toggle per channel the STREAM's gate
 *  enabled. Forced channels render read-only (on) with their reason. */
@Composable
private fun AdminReceiveRow(
    entry: NotificationCatalogEntry,
    matrix: NotificationMatrix,
    prefs: AdminNotificationPrefs,
    stream: String,
    onToggle: (String, Boolean) -> Unit,
) {
    val c = AuntieTheme.colors
    val offered = NOTIF_CHANNELS.filter { matrix.channelOfferedToUser(entry, it, stream) }
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                entry.displayTitle(),
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            // Always-on for THIS stream (per-stream scope, not the flat catalog flag).
            if (entry.alwaysEnabledFor(stream)) {
                AuntieStatusPill(label = "Required", tone = AuntieStatusTone.Neutral, leadingIcon = Lucide.Lock)
            }
        }
        Spacer(Modifier.height(6.dp))
        offered.forEach { ch ->
            val forced = matrix.channelForcedForUser(entry, ch, stream)
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(notifChannelLabel(ch), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    if (forced) {
                        Text(matrix.channelForcedReason(entry, ch, stream), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                    }
                }
                if (forced) {
                    AuntieStatusPill(label = "Required", tone = AuntieStatusTone.Neutral, leadingIcon = Lucide.Lock)
                    Spacer(Modifier.width(8.dp))
                    // Read-only: forced on by the business, the operator can't turn it off.
                    AuntieToggle(checked = true, enabled = false, onCheckedChange = {})
                } else {
                    AuntieToggle(
                        checked = prefs.effectiveReceive(entry, ch),
                        onCheckedChange = { onToggle(ch, it) },
                    )
                }
            }
        }
    }
}
