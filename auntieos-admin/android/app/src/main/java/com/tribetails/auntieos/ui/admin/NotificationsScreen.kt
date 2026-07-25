package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Banknote
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageCircle
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Admin notification inbox ("The Den · Notifications"). Android port of the
 * AuntieOS web NotificationsScreen Den redesign (mockup
 * auntieos-notifications-2026-05-27.html).
 *
 * Editorial [DenScreenHeading] with a coral unread badge, a brand-toned [StatCard]
 * summary row built from real counts, a category filter chip row derived from the
 * data, and a day-separated feed of notification rows inside a [DenPanel]. Each row
 * leads with an [AuntieIconTile] whose glyph + tone are derived from the
 * notification category, shows the catalog key, category + dispatch mode, channels,
 * an [AuntieStatusPill], a timestamp, and a teal dot for unread notifications.
 *
 * Stage 2 Step 4 (BUILT FOR REAL, no flag): per-notification quick actions wired to
 * live deployed callables.
 *   1. read/unread toggle  -> markNotificationRead / markNotificationUnread
 *   2. open linked item    -> [onOpenTarget] by targetType / targetId
 *   3. dismiss / archive   -> archiveNotification (+ bulkArchiveNotifications for
 *                             the multi-select working set)
 *   4. quick approve/deny  -> batchUpdateBookings([targetId], APPROVE|REJECT),
 *                             only when targetType == 'booking'
 * Every control fires a real call and confirms (or fails) loudly via the toast.
 * No control is a dead button; archived notifications are filtered server-side.
 *
 * Data source and ViewModel contract preserved: this screen reads the notifications
 * / isLoading / error flows and calls loadNotifications().
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NotificationsScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit,
    onOpenTarget: (targetType: String, targetId: String) -> Unit = { _, _ -> },
    onCreateQuote: (kinfolkId: String) -> Unit = {},
) {
    val entries by viewModel.notifications.collectAsState()
    // Issue #20: notification docs carry a household ID and almost never a
    // household NAME, so the directory is loaded alongside the feed and the row
    // resolves against it. Same call the triage and picker surfaces already use;
    // no new repository work.
    val directory by viewModel.kinfolkDirectory.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    val bulkReadMessage by viewModel.bulkReadMessage.collectAsState()
    val bulkReadInFlight by viewModel.bulkReadInFlight.collectAsState()

    // Active category filter. null = "All". Selection is presentation-only; it
    // narrows the already-loaded list and never touches the data source.
    var activeFilter by remember { mutableStateOf<String?>(null) }

    // Step 4: multi-select working set. `selecting` opens checkboxes on every row;
    // `selectedIds` is the set fed to bulkMarkNotificationsRead / bulkArchiveNotifications.
    var selecting by remember { mutableStateOf(false) }
    var selectedIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    LaunchedEffect(Unit) {
        viewModel.loadNotifications()
        viewModel.loadKinfolkDirectory()
    }
    // Household id -> display name. Only REAL names go in: Kinfolk.displayName
    // answers "Unnamed Kinfolk" for a doc with neither name, and printing that
    // on a notification row would be a placeholder where honesty says nothing.
    val householdNames = remember(directory) {
        directory
            .filter { it.firstName.isNotBlank() || it.lastName.isNotBlank() }
            .associate { it.id to it.displayName }
    }

    AuntieScreenScaffold(
        title = "Notifications",
        onBack = onBack,
        imePaddingEnabled = true,
    ) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh = { viewModel.loadNotifications() },
            modifier = Modifier.weight(1f),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 16.dp),
            ) {
                val all = entries.sortedByDescending { it.createdAt }
                // Read state: a notification is unread until it carries a readAt
                // marker (written by markNotificationRead / bulkMarkNotificationsRead).
                // This is the real per-recipient signal; dispatch status is separate.
                val unreadCount = all.count { isNotificationUnread(it) }
                val dispatchedCount = all.count { it.status.equals("dispatched", ignoreCase = true) }
                val allIds = all.map { it.id }.toSet()
                val unreadSelected = selectedIds.filter { id -> all.any { it.id == id && isNotificationUnread(it) } }

                Heading(unreadCount = unreadCount)
                Spacer(Modifier.height(20.dp))

                // ── Multi-select control bar (Step 4) ────────────────────────────
                // Select mode reveals checkboxes on every row; "Mark read" calls
                // bulkMarkNotificationsRead with the unread subset of the working set,
                // "Dismiss" calls bulkArchiveNotifications with the whole set. Fail-loud:
                // the server-reported counts are surfaced via the toast below.
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    GhostButton(
                        label = if (selecting) "Done" else "Select",
                        enabled = all.isNotEmpty() || selecting,
                        onClick = {
                            selecting = !selecting
                            if (!selecting) selectedIds = emptySet()
                        },
                    )
                    if (selecting) {
                        GhostButton(
                            label = if (selectedIds == allIds && allIds.isNotEmpty()) "Clear all" else "Select all",
                            enabled = allIds.isNotEmpty(),
                            onClick = {
                                selectedIds = if (selectedIds == allIds) emptySet() else allIds
                            },
                        )
                        Spacer(Modifier.weight(1f))
                        GhostButton(
                            label = if (bulkReadInFlight) "Working…"
                                else "Mark read (${unreadSelected.size})",
                            enabled = unreadSelected.isNotEmpty() && !bulkReadInFlight,
                            onClick = {
                                viewModel.markNotificationsRead(unreadSelected)
                                selectedIds = emptySet()
                                selecting = false
                            },
                        )
                        PrimaryButton(
                            label = if (bulkReadInFlight) "Working…"
                                else "Dismiss (${selectedIds.size})",
                            enabled = selectedIds.isNotEmpty() && !bulkReadInFlight,
                            onClick = {
                                viewModel.archiveNotifications(selectedIds.toList())
                                selectedIds = emptySet()
                                selecting = false
                            },
                        )
                    }
                }
                Spacer(Modifier.height(16.dp))

                // FAIL LOUD: surface the real ViewModel error verbatim. The most
                // common cause is a missing recipientUid where-filter on the
                // platform stream (the /notifications rule is recipient-scoped),
                // which is fixed in the repository, not on this screen.
                if (error != null) {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't load notifications",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(
                            error!!,
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                    Spacer(Modifier.height(20.dp))
                }

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

                DenPanel(
                    title = "Activity",
                    subtitle = "Catalog-dispatched events for your account, newest first.",
                ) {
                    when {
                        all.isEmpty() && isLoading -> {
                            EmptyHint("Loading notifications...")
                        }
                        all.isEmpty() -> {
                            EmptyHint("No notifications yet. Catalog-dispatched events appear here when MyTribe functions emit them.")
                        }
                        else -> {
                            // Filter chips reflect categories actually present in
                            // the feed, never an invented taxonomy. "All" + each.
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
                                    householdNames = householdNames,
                                    selecting = selecting,
                                    selectedIds = selectedIds,
                                    onToggleSelect = { id ->
                                        selectedIds = if (id in selectedIds) selectedIds - id else selectedIds + id
                                    },
                                    onToggleRead = { entry ->
                                        viewModel.toggleNotificationRead(entry.id, isNotificationUnread(entry))
                                    },
                                    onOpen = { entry -> onOpenTarget(entry.targetType, entry.targetId) },
                                    onCreateQuote = { entry -> onCreateQuote(notificationKinfolkId(entry)) },
                                    onDismiss = { entry -> viewModel.archiveNotification(entry.id) },
                                    onApprove = { entry -> viewModel.quickBookingAction(entry.targetId, "APPROVE") },
                                    onDeny = { entry -> viewModel.quickBookingAction(entry.targetId, "REJECT") },
                                )
                            }
                        }
                    }
                }
            }
        }

        // Fail-loud quick-action result (e.g. "Marked read.", "Dismissed 3 of 5.").
        StatusToast(
            visible = bulkReadMessage != null,
            message = bulkReadMessage ?: "",
            kind = ToastKind.Info,
            onDismiss = { viewModel.clearBulkReadMessage() },
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        )
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
                        text = "$unreadCount new",
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
        )
        // "Unread" filter keyed off the real readAt-based read state.
        AuntieChip(
            label = "Unread",
            selected = active == NOTIF_UNREAD_FILTER,
            onClick = { onSelect(NOTIF_UNREAD_FILTER) },
        )
        categories.forEach { category ->
            AuntieChip(
                label = category,
                selected = active == category,
                onClick = { onSelect(category) },
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
    householdNames: Map<String, String>,
    selecting: Boolean,
    selectedIds: Set<String>,
    onToggleSelect: (String) -> Unit,
    onToggleRead: (NotificationEntry) -> Unit,
    onOpen: (NotificationEntry) -> Unit,
    onCreateQuote: (NotificationEntry) -> Unit,
    onDismiss: (NotificationEntry) -> Unit,
    onApprove: (NotificationEntry) -> Unit,
    onDeny: (NotificationEntry) -> Unit,
) {
    val newestDate = entries.firstOrNull()?.createdAt?.let { datePrefix(it) }
    val (recentItems, earlierItems) = entries.partition {
        newestDate != null && datePrefix(it.createdAt) == newestDate
    }

    @Composable
    fun row(entry: NotificationEntry) = NotificationRow(
        entry = entry,
        householdName = notificationKinfolkName(entry, householdNames),
        selecting = selecting,
        selected = entry.id in selectedIds,
        onToggleSelect = { onToggleSelect(entry.id) },
        onToggleRead = { onToggleRead(entry) },
        onOpen = { onOpen(entry) },
        onCreateQuote = { onCreateQuote(entry) },
        onDismiss = { onDismiss(entry) },
        onApprove = { onApprove(entry) },
        onDeny = { onDeny(entry) },
    )

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (recentItems.isNotEmpty()) {
            DaySeparator("Recent")
            recentItems.forEach { row(it) }
        }
        if (earlierItems.isNotEmpty()) {
            if (recentItems.isNotEmpty()) Spacer(Modifier.height(6.dp))
            DaySeparator("Earlier")
            earlierItems.forEach { row(it) }
        }
    }
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
 * A single notification row. Leads with an [AuntieIconTile] keyed off the
 * category, then the catalog key, category + dispatch mode, channels, an
 * [AuntieStatusPill], and the Step 4 quick-action row. The right rail carries the
 * timestamp and a teal unread dot for unread notifications.
 *
 * Quick actions (Step 4) are all live: a read/unread toggle, an Open button when the
 * notification points at an openable item, a Dismiss button, and quick Approve/Deny
 * when the notification targets a booking. Which buttons appear is decided by the
 * pure [applicableNotificationActions] helper from the entry's targetType.
 */
@Composable
private fun NotificationRow(
    entry: NotificationEntry,
    householdName: String,
    selecting: Boolean,
    selected: Boolean,
    onToggleSelect: () -> Unit,
    onToggleRead: () -> Unit,
    onOpen: () -> Unit,
    onCreateQuote: () -> Unit,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography
    val unread = isNotificationUnread(entry)
    val actions = applicableNotificationActions(entry)

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
        if (selecting) {
            AuntieCheckbox(
                checked = selected,
                onCheckedChange = { onToggleSelect() },
            )
        }
        AuntieIconTile(
            icon = iconFor(entry),
            tone = toneFor(entry),
            size = 42.dp,
        )

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            // Context first (issue #20): who this is about, and what it points
            // at. Either half may be absent; neither is faked.
            val targetLabel = notificationTargetLabel(entry)
            if (householdName.isNotBlank() || targetLabel.isNotBlank()) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (householdName.isNotBlank()) {
                        Text(
                            text = householdName,
                            style = typo.labelMedium.copy(fontWeight = FontWeight.Bold),
                            color = c.accent,
                        )
                    }
                    if (targetLabel.isNotBlank()) {
                        AuntieStatusPill(label = targetLabel, tone = AuntieStatusTone.Neutral)
                    }
                }
            }
            Text(
                text = notificationHeadline(entry),
                style = typo.titleMedium,
                color = c.textPrimary,
            )
            if (entry.description.isNotBlank()) {
                Text(
                    text = entry.description,
                    style = typo.bodySmall,
                    color = c.textPrimary,
                )
            }
            Text(
                text = buildString {
                    if (entry.actorName.isNotBlank()) append("${entry.actorName} · ")
                    append(entry.category.ifBlank { "uncategorized" })
                    append(" · ")
                    append(entry.mode.ifBlank { "trigger" })
                },
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

            // Step 4 quick actions: live controls, hidden in multi-select mode so
            // the row stays a clean selection target.
            if (!selecting) {
                Spacer(Modifier.height(8.dp))
                QuickActions(
                    unread = unread,
                    actions = actions,
                    onToggleRead = onToggleRead,
                    onOpen = onOpen,
                    onCreateQuote = onCreateQuote,
                    onDismiss = onDismiss,
                    onApprove = onApprove,
                    onDeny = onDeny,
                )
            }
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

/**
 * Per-row quick-action button cluster. Every button fires a live callable. The
 * read/unread toggle is always present; Open / Approve / Deny appear per the pure
 * [applicableNotificationActions] decision so a notification with no openable target
 * never shows a dead Open button.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuickActions(
    unread: Boolean,
    actions: NotificationActions,
    onToggleRead: () -> Unit,
    onOpen: () -> Unit,
    onCreateQuote: () -> Unit,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    val dims = AuntieTheme.dims
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        if (actions.canApproveDeny) {
            PrimaryButton(label = "Approve", onClick = onApprove)
            GhostButton(label = "Deny", onClick = onDeny)
        }
        if (actions.canOpen) {
            GhostButton(label = "Open", onClick = onOpen)
        }
        if (actions.canCreateQuote) {
            GhostButton(label = "Create quote", onClick = onCreateQuote)
        }
        GhostButton(
            label = if (unread) "Mark read" else "Mark unread",
            onClick = onToggleRead,
        )
        GhostButton(label = "Dismiss", onClick = onDismiss)
    }
}

// ---- presentation-only derivations (no backend data invented) -----------------

/** Sentinel filter value for the "Unread" chip (never a real category). */
internal const val NOTIF_UNREAD_FILTER = " unread"

/**
 * Visible notifications for the active filter: null = All, [NOTIF_UNREAD_FILTER] =
 * real (readAt-based) unread, else a category match (spec 21 item 2). Pure; unit-tested.
 */
internal fun notificationsForFilter(all: List<NotificationEntry>, filter: String?): List<NotificationEntry> =
    when (filter) {
        null -> all
        NOTIF_UNREAD_FILTER -> all.filter { isNotificationUnread(it) }
        else -> all.filter { it.category.ifBlank { "uncategorized" } == filter }
    }

/**
 * Which quick actions apply to a notification, decided purely from its targetType /
 * targetId. Mirrors the deployed callable contract:
 *   - Open is available whenever the notification points at a known, openable domain
 *     ('booking' | 'invoice' | 'kintale' | 'kinfolk') with a non-blank targetId.
 *   - Approve/Deny is available ONLY for booking notifications (batchUpdateBookings).
 * read/unread toggle + Dismiss always apply, so they are not modeled here.
 * Pure; unit-tested.
 */
internal data class NotificationActions(val canOpen: Boolean, val canApproveDeny: Boolean, val canCreateQuote: Boolean)

internal val OPENABLE_TARGET_TYPES = setOf("booking", "invoice", "kintale", "kinfolk")

internal fun applicableNotificationActions(targetType: String, targetId: String): NotificationActions {
    val type = targetType.trim().lowercase()
    val hasTarget = targetId.isNotBlank() && type in OPENABLE_TARGET_TYPES
    return NotificationActions(
        canOpen = hasTarget,
        canApproveDeny = hasTarget && type == "booking",
        // A kinfolk-targeted notification can spawn a quote for that household.
        canCreateQuote = type == "kinfolk" && targetId.isNotBlank(),
    )
}

// ---- row CONTEXT: which household, and what the row is about (issue #20) -------
//
// The notifications feed used to print a catalog key and a timestamp, which is
// what made it read like a second Activity Log. The household is the missing
// piece, and it is NOT a column on the notification doc: `dispatcher.ts` writes
// a free-form `data` bag plus a targetType/targetId pair, and the name-filling
// enrichment (`enrichTemplateData.ts`) runs on the CHANNEL doc, never back onto
// the notification. So the id is derived and the name is resolved against the
// kinfolk directory the screen already loads. Nothing is invented: an
// unresolvable household renders no name rather than a placeholder.
//
// These mirror the web build's `lib/notificationContext.ts` decision for
// decision, so the two clients cannot disagree about whose notification this is.

/** A `data` value read as a trimmed String; anything non-String reads as blank. */
private fun dataString(entry: NotificationEntry, key: String): String =
    (entry.data[key] as? String)?.trim().orEmpty()

/**
 * The household this notification concerns, or "" when none can be identified.
 * Precedence matches `dispatcher.resolveTargetRef`: the explicit `data` ids
 * first, then a kinfolk-typed target. Pure; unit-tested.
 */
internal fun notificationKinfolkId(entry: NotificationEntry): String {
    val fromData = dataString(entry, "kinfolkId").ifBlank { dataString(entry, "familyId") }
    if (fromData.isNotBlank()) return fromData
    if (entry.targetType.trim().lowercase() == "kinfolk") return entry.targetId.trim()
    return ""
}

/**
 * The household's display name: a name the emitter already put on the doc, else
 * the id resolved through [namesById]. "" when neither is available, so the row
 * shows nothing rather than "Unknown household". Pure; unit-tested.
 */
internal fun notificationKinfolkName(entry: NotificationEntry, namesById: Map<String, String>): String {
    val fromData = dataString(entry, "kinfolkName")
    if (fromData.isNotBlank()) return fromData
    val id = notificationKinfolkId(entry)
    return if (id.isBlank()) "" else namesById[id].orEmpty()
}

/** Operator-language name for the linked entity, or "" when there is no target. */
internal fun notificationTargetLabel(entry: NotificationEntry): String {
    if (entry.targetId.isBlank()) return ""
    return when (entry.targetType.trim().lowercase()) {
        "invoice" -> "Invoice"
        "kintale" -> "KinTale"
        "kinfolk" -> "Household"
        "booking" -> "Booking"
        else -> ""
    }
}

/** The row's headline: the catalog title, falling back to the raw key (AO-28). */
internal fun notificationHeadline(entry: NotificationEntry): String =
    entry.title.ifBlank { entry.key }.ifBlank { "(no key)" }

/**
 * Entry-aware overload of [applicableNotificationActions]. Open and Approve/Deny
 * are unchanged; Create quote WIDENS from the string version's kinfolk-target
 * rule to the derived household, so an invoice or booking notification that
 * names its household can also spawn a quote for it. The button still
 * disappears entirely when no household is identifiable, which is the property
 * the narrow rule was really protecting. Matches the web build. Pure; unit-tested.
 */
internal fun applicableNotificationActions(entry: NotificationEntry): NotificationActions =
    applicableNotificationActions(entry.targetType, entry.targetId)
        .copy(canCreateQuote = notificationKinfolkId(entry).isNotBlank())

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
