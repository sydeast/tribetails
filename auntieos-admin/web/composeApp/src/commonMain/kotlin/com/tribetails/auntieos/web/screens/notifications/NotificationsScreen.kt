package com.tribetails.auntieos.web.screens.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowUpRight
import com.composables.icons.lucide.Archive
import com.composables.icons.lucide.Banknote
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Receipt
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.MessageCircle
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard
import kotlinx.coroutines.launch

/**
 * Admin notification inbox ("The Den · Notifications").
 *
 * Shows catalog-dispatched notifications for the signed-in operator. The
 * Firestore rule (firestore.rules:403) is recipient-scoped, so reads are only
 * permitted when the underlying query is filtered to recipientUid == the signed
 * in uid. That filter lives in the platform stream (FirestoreInterop), NOT in
 * this screen. If it is missing the stream surfaces a PERMISSION_DENIED, which
 * this screen renders loudly via an [AuntieBanner] rather than swallowing.
 *
 * Stage 2 Step 4 (no flag): per-notification quick actions are wired to real
 * deployed callables and a real read/unread + archive model:
 *   - read/unread toggle  -> markNotificationRead / markNotificationUnread
 *     (the row's readAt drives the state),
 *   - open linked item    -> navigate by targetType/targetId via [onOpenTarget],
 *   - dismiss/archive      -> archiveNotification (single) + bulkArchiveNotifications
 *     (multi-select), with archived rows filtered out of the default list,
 *   - approve / deny       -> batchUpdateBookings([targetId], APPROVE|REJECT),
 *     shown ONLY when targetType == "booking".
 * Every action is fail-loud: a WriteResult.Err surfaces the server message in an
 * error banner and the optimistic stream re-renders truth on the next snapshot.
 *
 * [onOpenTarget] routes the "open linked item" action to the booking / invoice /
 * kintale / kinfolk screen; the App owns the actual router wiring.
 */
@Composable
fun NotificationsScreen(
    onOpenTarget: (targetType: String, targetId: String) -> Unit = { _, _ -> },
    onCreateQuote: (kinfolkId: String) -> Unit = {},
) {
    val client = remember { FirestoreClient() }
    val scope = rememberReportingScope()

    // P0-FLICKER: hoist the Flow via remember so it survives recomposition.
    val state by remember { client.notificationsStream() }.collectAsState(initial = FirestoreResult.Loading)

    // Active category filter. null = "All". Selection is presentation-only; it
    // narrows the already-loaded list and never touches the data source.
    var activeFilter by remember { mutableStateOf<String?>(null) }

    // Fail-loud action feedback + multi-select archive state.
    var actionError by remember { mutableStateOf<String?>(null) }
    var actionNotice by remember { mutableStateOf<String?>(null) }
    val selectedIds = remember { mutableStateListOf<String>() }

    // ---- single-row action handlers (all fail-loud) -------------------------
    val onToggleRead: (NotificationEntry) -> Unit = { entry ->
        scope.launch {
            val r = if (entry.isRead) client.markNotificationUnread(entry._id)
            else client.markNotificationRead(entry._id)
            when (r) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> {
                    actionError = null
                    actionNotice = if (entry.isRead) "Marked unread." else "Marked read."
                }
            }
        }
    }
    val onArchive: (NotificationEntry) -> Unit = { entry ->
        scope.launch {
            when (val r = client.archiveNotification(entry._id)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> {
                    actionError = null
                    selectedIds.remove(entry._id)
                    actionNotice = if (r.value > 0) "Archived." else "Nothing to archive."
                }
            }
        }
    }
    val onBookingAction: (NotificationEntry, String) -> Unit = { entry, action ->
        scope.launch {
            when (val r = client.batchUpdateBookings(listOf(entry.targetId), action)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> {
                    actionError = null
                    actionNotice = if (action == "APPROVE") "Booking approved." else "Booking denied."
                }
            }
        }
    }
    val onBulkArchive: () -> Unit = {
        val ids = selectedIds.toList()
        if (ids.isNotEmpty()) scope.launch {
            when (val r = client.bulkArchiveNotifications(ids)) {
                is WriteResult.Err -> actionError = r.message
                is WriteResult.Ok -> {
                    actionError = null
                    selectedIds.clear()
                    actionNotice = "Archived ${r.value} notification${if (r.value == 1) "" else "s"}."
                }
            }
        }
    }

    ScreenScaffold {
        when (val s = state) {
            FirestoreResult.Loading -> {
                Heading(unreadCount = 0)
                Spacer(Modifier.height(20.dp))
                DenPanel(title = "Activity", subtitle = "Catalog-dispatched events for your account.") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        repeat(4) { ShimmerCard(height = 84.dp) }
                    }
                }
            }

            is FirestoreResult.Error -> {
                Heading(unreadCount = 0)
                Spacer(Modifier.height(20.dp))
                // FAIL LOUD: surface the real Firestore error verbatim. The most
                // common cause is a missing recipientUid where-filter on the
                // platform stream (the /notifications rule is recipient-scoped),
                // which is fixed in FirestoreInterop, not on this screen.
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load notifications",
                    icon = Lucide.TriangleAlert,
                ) {
                    Text(
                        s.message,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }
            }

            is FirestoreResult.Data -> {
                // Archived notifications are filtered out of the active inbox.
                val all = activeNotifications(s.value).sortedByDescending { it.createdAt }
                val unreadCount = all.count { !it.isRead }
                val dispatchedCount = all.count { it.status.equals("dispatched", ignoreCase = true) }

                Heading(unreadCount = unreadCount)
                Spacer(Modifier.height(20.dp))

                // Drop any selected id that has left the active list (e.g. archived
                // elsewhere) so the bulk bar count never lies.
                val activeIds = all.map { it._id }.toSet()
                selectedIds.retainAll { it in activeIds }

                // ── stat summary row (real counts) ───────────────────────────
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    StatCard(
                        label = "All notifications",
                        value = all.size.toString(),
                        trend = "in your inbox",
                        tone = AuntieStatusTone.Purple,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Unread",
                        value = unreadCount.toString(),
                        trend = "not yet read",
                        tone = AuntieStatusTone.Warning,
                        feature = unreadCount > 0,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Dispatched",
                        value = dispatchedCount.toString(),
                        trend = "delivered",
                        tone = AuntieStatusTone.Success,
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(20.dp))

                actionError?.let { msg ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Notification action failed",
                        icon = Lucide.TriangleAlert,
                        onDismiss = { actionError = null },
                        body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) },
                    )
                    Spacer(Modifier.height(16.dp))
                }
                actionNotice?.let { msg ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Success,
                        title = "Done",
                        icon = Lucide.Check,
                        onDismiss = { actionNotice = null },
                        body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim) },
                    )
                    Spacer(Modifier.height(16.dp))
                }

                // Multi-select bulk-archive bar, shown only with a selection.
                if (selectedIds.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(AuntieTheme.colors.surface2)
                            .border(
                                AuntieTheme.dims.borderHairline,
                                SolidColor(AuntieTheme.colors.border),
                                RoundedCornerShape(14.dp),
                            )
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = "${selectedIds.size} selected",
                            style = AuntieTheme.typography.titleSmall,
                            color = AuntieTheme.colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        GhostButton(label = "Clear", onClick = { selectedIds.clear() })
                        GhostButton(label = "Archive selected", onClick = onBulkArchive)
                    }
                    Spacer(Modifier.height(16.dp))
                }

                DenPanel(
                    title = "Activity",
                    subtitle = "Catalog-dispatched events for your account, newest first.",
                ) {
                    if (all.isEmpty()) {
                        EmptyHint("No notifications yet. Catalog-dispatched events appear here when MyTribe functions emit them.")
                    } else {
                        // Filter chips reflect categories actually present in the
                        // feed, never an invented taxonomy. "All" + each category.
                        val categories = all
                            .map { it.category.ifBlank { "uncategorized" } }
                            .distinct()
                            .sorted()

                        FilterRow(
                            categories = categories,
                            active = activeFilter,
                            onSelect = { activeFilter = it },
                        )
                        Spacer(Modifier.height(16.dp))

                        val visible = notificationsForFilter(all, activeFilter)

                        if (visible.isEmpty()) {
                            EmptyHint("Nothing in this filter. No notifications match the selected category.")
                        } else {
                            Feed(
                                entries = visible,
                                selectedIds = selectedIds,
                                onToggleSelect = { id, checked ->
                                    if (checked) { if (id !in selectedIds) selectedIds.add(id) }
                                    else selectedIds.remove(id)
                                },
                                onToggleRead = onToggleRead,
                                onOpenTarget = onOpenTarget,
                                onCreateQuote = onCreateQuote,
                                onArchive = onArchive,
                                onBookingAction = onBookingAction,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Editorial heading via [DenScreenHeading], with a coral unread badge in the
 * trailing slot when there are unread notifications.
 */
@Composable
private fun Heading(unreadCount: Int) {
    val c = AuntieTheme.colors
    val typo = AuntieTheme.typography

    DenScreenHeading(
        kicker = "The Den · Notifications",
        title = "Notifications",
        subtitle = "Business-side notifications dispatched to your account.",
        trailing = {
            if (unreadCount > 0) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(c.coral)
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "$unreadCount unread",
                        style = typo.labelMedium.copy(fontWeight = FontWeight.Bold),
                        color = c.background,
                    )
                }
            }
        },
    )
}

/** Category filter chips. "All" plus every category present in the feed. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterRow(
    categories: List<String>,
    active: String?,
    onSelect: (String?) -> Unit,
) {
    val dims = AuntieTheme.dims
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        AuntieChip(
            label = "All",
            selected = active == null,
            onClick = { onSelect(null) },
            tone = AuntieChipTone.Accent,
        )
        // "Unread" filter using the real readAt-driven state (spec 21 item 2).
        AuntieChip(
            label = "Unread",
            selected = active == NOTIF_UNREAD_FILTER,
            onClick = { onSelect(NOTIF_UNREAD_FILTER) },
            tone = AuntieChipTone.Accent,
        )
        categories.forEach { category ->
            AuntieChip(
                label = category,
                selected = active == category,
                onClick = { onSelect(category) },
                tone = AuntieChipTone.Accent,
            )
        }
    }
}

/**
 * Day-separated feed. The list arrives newest-first; we split on the most recent
 * notification's own date so the freshest batch sits under "Recent" and the rest
 * under "Earlier". This leans only on the createdAt strings themselves (no clock
 * is fabricated). When createdAt is unusable everything falls under one group.
 */
@Composable
private fun Feed(
    entries: List<NotificationEntry>,
    selectedIds: List<String>,
    onToggleSelect: (String, Boolean) -> Unit,
    onToggleRead: (NotificationEntry) -> Unit,
    onOpenTarget: (String, String) -> Unit,
    onCreateQuote: (String) -> Unit,
    onArchive: (NotificationEntry) -> Unit,
    onBookingAction: (NotificationEntry, String) -> Unit,
) {
    val newestDate = entries.firstOrNull()?.createdAt?.let { datePrefix(it) }
    val (recentItems, earlierItems) = entries.partition {
        newestDate != null && datePrefix(it.createdAt) == newestDate
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (recentItems.isNotEmpty()) {
            DaySeparator("Recent")
            recentItems.forEach { row(it, selectedIds, onToggleSelect, onToggleRead, onOpenTarget, onCreateQuote, onArchive, onBookingAction) }
        }
        if (earlierItems.isNotEmpty()) {
            if (recentItems.isNotEmpty()) Spacer(Modifier.height(6.dp))
            DaySeparator("Earlier")
            earlierItems.forEach { row(it, selectedIds, onToggleSelect, onToggleRead, onOpenTarget, onCreateQuote, onArchive, onBookingAction) }
        }
    }
}

@Composable
private fun row(
    entry: NotificationEntry,
    selectedIds: List<String>,
    onToggleSelect: (String, Boolean) -> Unit,
    onToggleRead: (NotificationEntry) -> Unit,
    onOpenTarget: (String, String) -> Unit,
    onCreateQuote: (String) -> Unit,
    onArchive: (NotificationEntry) -> Unit,
    onBookingAction: (NotificationEntry, String) -> Unit,
) {
    NotificationRow(
        entry = entry,
        selected = entry._id in selectedIds,
        onToggleSelect = { checked -> onToggleSelect(entry._id, checked) },
        onToggleRead = { onToggleRead(entry) },
        onOpenTarget = { onOpenTarget(entry.targetType, entry.targetId) },
        onCreateQuote = { onCreateQuote(entry.targetId) },
        onArchive = { onArchive(entry) },
        onApprove = { onBookingAction(entry, "APPROVE") },
        onDeny = { onBookingAction(entry, "REJECT") },
    )
}

@Composable
private fun DaySeparator(label: String) {
    val c = AuntieTheme.colors
    Text(
        text = label.uppercase(),
        style = AuntieTheme.typography.mono.copy(
            fontSize = 10.sp,
            letterSpacing = 1.4.sp,
        ),
        color = c.textDim.copy(alpha = 0.7f),
        modifier = Modifier.padding(start = 2.dp, top = 6.dp, bottom = 2.dp),
    )
}

/**
 * A single notification row. Leads with a multi-select checkbox + an
 * [AuntieIconTile] keyed off the category, then the catalog key (mono), category +
 * dispatch mode, channels, and an [AuntieStatusPill]. The right rail carries the
 * timestamp, an unread dot, and the real quick-action buttons returned by
 * [applicableActions]: read/unread toggle, open-linked, approve/deny (booking
 * only), and archive.
 */
@Composable
private fun NotificationRow(
    entry: NotificationEntry,
    selected: Boolean,
    onToggleSelect: (Boolean) -> Unit,
    onToggleRead: () -> Unit,
    onOpenTarget: () -> Unit,
    onCreateQuote: () -> Unit,
    onArchive: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography
    val unread = !entry.isRead
    val actions = applicableActions(entry)

    val border = if (unread) c.accent.copy(alpha = 0.4f) else c.border

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(c.surface2)
            .border(dims.borderHairline, SolidColor(border), RoundedCornerShape(16.dp))
            .padding(15.dp),
        horizontalArrangement = Arrangement.spacedBy(13.dp),
        verticalAlignment = Alignment.Top,
    ) {
        AuntieCheckbox(checked = selected, onCheckedChange = onToggleSelect)

        AuntieIconTile(
            icon = iconFor(entry),
            tone = toneFor(entry),
            size = 42.dp,
        )

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = entry.key.ifBlank { "(no key)" },
                style = typo.titleMedium,
                color = c.textPrimary,
            )
            Text(
                text = "${entry.category.ifBlank { "uncategorized" }} · ${entry.mode.ifBlank { "trigger" }}",
                style = typo.bodySmall,
                color = c.textDim,
            )
            if (entry.channels.isNotEmpty()) {
                Text(
                    text = "channels: ${entry.channels.joinToString(", ")}",
                    style = typo.mono.copy(fontSize = 10.sp, letterSpacing = 0.4.sp),
                    color = c.textFaint,
                )
            }
            Spacer(Modifier.height(2.dp))
            AuntieStatusPill(
                label = entry.status.ifBlank { "unknown" },
                tone = statusTone(entry.status),
                showDot = true,
            )

            // Real, fail-loud quick actions (Stage 2 Step 4). Each maps to a
            // deployed callable; the parent surfaces any error loudly.
            Spacer(Modifier.height(6.dp))
            QuickActionBar(
                actions = actions,
                onToggleRead = onToggleRead,
                onOpenTarget = onOpenTarget,
                onCreateQuote = onCreateQuote,
                onArchive = onArchive,
                onApprove = onApprove,
                onDeny = onDeny,
            )
        }

        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = relativeTime(entry.createdAt),
                style = typo.mono.copy(fontSize = 10.5.sp),
                color = c.textDim,
            )
            if (unread) {
                Box(
                    modifier = Modifier
                        .width(9.dp)
                        .height(9.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(c.accent),
                )
            }
        }
    }
}

/** Row of icon-button quick actions derived from [applicableActions]. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuickActionBar(
    actions: List<NotificationAction>,
    onToggleRead: () -> Unit,
    onOpenTarget: () -> Unit,
    onCreateQuote: () -> Unit,
    onArchive: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        actions.forEach { action ->
            when (action) {
                NotificationAction.MarkRead -> AuntieIconButton(
                    icon = Lucide.Check,
                    contentDescription = "Mark read",
                    onClick = onToggleRead,
                    size = 32.dp,
                )
                NotificationAction.MarkUnread -> AuntieIconButton(
                    icon = Lucide.Mail,
                    contentDescription = "Mark unread",
                    onClick = onToggleRead,
                    size = 32.dp,
                )
                NotificationAction.OpenTarget -> AuntieIconButton(
                    icon = Lucide.ArrowUpRight,
                    contentDescription = "Open linked item",
                    onClick = onOpenTarget,
                    size = 32.dp,
                )
                NotificationAction.ApproveBooking -> AuntieIconButton(
                    icon = Lucide.Check,
                    contentDescription = "Approve booking",
                    onClick = onApprove,
                    size = 32.dp,
                )
                NotificationAction.DenyBooking -> AuntieIconButton(
                    icon = Lucide.X,
                    contentDescription = "Deny booking",
                    onClick = onDeny,
                    size = 32.dp,
                    destructive = true,
                )
                NotificationAction.CreateQuote -> AuntieIconButton(
                    icon = Lucide.Receipt,
                    contentDescription = "Create quote",
                    onClick = onCreateQuote,
                    size = 32.dp,
                )
                NotificationAction.Archive -> AuntieIconButton(
                    icon = Lucide.Archive,
                    contentDescription = "Archive",
                    onClick = onArchive,
                    size = 32.dp,
                )
            }
        }
    }
}

// ---- presentation-only derivations (no backend data invented) -----------------

/** Sentinel filter value for the "Unread" chip (never a real category). */
internal const val NOTIF_UNREAD_FILTER = " unread"

/**
 * Visible notifications for the active filter: null = All, [NOTIF_UNREAD_FILTER] =
 * unread (driven by the real readAt field), else a category match (spec 21 item 2).
 * Pure; unit-tested.
 */
internal fun notificationsForFilter(all: List<NotificationEntry>, filter: String?): List<NotificationEntry> =
    when (filter) {
        null -> all
        NOTIF_UNREAD_FILTER -> all.filter { !it.isRead }
        else -> all.filter { it.category.ifBlank { "uncategorized" } == filter }
    }

/** Map status text to a status-pill tone. */
private fun statusTone(status: String): AuntieStatusTone = when (status.lowercase()) {
    "dispatched" -> AuntieStatusTone.Success
    "pending" -> AuntieStatusTone.Warning
    else -> AuntieStatusTone.Neutral
}

/**
 * Map a notification to an icon-tile tone. Keyed off the category / key family so
 * the feed reads as one coherent brand palette, mirroring the mockup's colored
 * tiles (bookings=orange, payments=teal, kintales=purple, system=coral).
 */
private fun toneFor(entry: NotificationEntry): AuntieStatusTone {
    val family = "${entry.category} ${entry.key}".lowercase()
    return when {
        family.contains("overdue") || family.contains("breach") || family.contains("alert") ->
            AuntieStatusTone.Error
        family.contains("booking") || family.contains("kincare") || family.contains("visit") ->
            AuntieStatusTone.Orange
        family.contains("payment") || family.contains("invoice") || family.contains("payout") ->
            AuntieStatusTone.Teal
        family.contains("kintale") || family.contains("comment") || family.contains("tale") ->
            AuntieStatusTone.Purple
        family.contains("kinfolk") || family.contains("welcome") || family.contains("onboard") ->
            AuntieStatusTone.Purple
        family.contains("security") || family.contains("device") || family.contains("auth") ->
            AuntieStatusTone.Error
        else -> AuntieStatusTone.Neutral
    }
}

/** Map a notification to a leading glyph, mirroring the mockup's tile icons. */
private fun iconFor(entry: NotificationEntry): ImageVector {
    val family = "${entry.category} ${entry.key}".lowercase()
    return when {
        family.contains("overdue") || family.contains("alert") -> Lucide.TriangleAlert
        family.contains("booking") || family.contains("kincare") || family.contains("visit") ->
            Lucide.CalendarPlus
        family.contains("payment") || family.contains("payout") -> Lucide.Banknote
        family.contains("invoice") -> Lucide.Banknote
        family.contains("kintale") || family.contains("comment") || family.contains("tale") ->
            Lucide.MessageCircle
        family.contains("kinfolk") || family.contains("welcome") || family.contains("onboard") ->
            Lucide.PawPrint
        family.contains("security") || family.contains("device") || family.contains("auth") ->
            Lucide.ShieldCheck
        family.contains("system") -> Lucide.Sparkles
        else -> Lucide.Bell
    }
}

/**
 * Pull the YYYY-MM-DD date portion out of an ISO-8601 createdAt string. Returns
 * null when the string is blank or shorter than a date, so callers can decide
 * how to group rather than guessing at a malformed value.
 */
private fun datePrefix(createdAt: String): String? =
    createdAt.takeIf { it.length >= 10 }?.substring(0, 10)

/**
 * Render a compact timestamp. createdAt is an ISO-8601 string; we surface the
 * date portion (and time when present) without fabricating a "2m / 18m / 1h"
 * delta the screen cannot compute without a clock.
 */
private fun relativeTime(createdAt: String): String {
    if (createdAt.isBlank()) return "(no time)"
    // ISO-8601 like 2026-05-27T14:02:11Z -> "05-27 14:02"
    val t = createdAt.indexOf('T')
    if (t <= 0) return createdAt.take(16)
    val datePart = createdAt.substring(0, t)
    val timePart = createdAt.substring(t + 1).take(5)
    val shortDate = if (datePart.length >= 10) datePart.substring(5) else datePart
    return "$shortDate $timePart"
}
