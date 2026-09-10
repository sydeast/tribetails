package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
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
 * notification category, shows the household, the catalog title, the entity
 * summary, a timestamp, and a teal dot for unread notifications.
 *
 * ── OPERATOR RULING R5, 2026-08-03 ─────────────────────────────────────────
 *
 * Two changes, matching the web build decision for decision.
 *
 *   1. WORKFLOW IS OFF THE CARD. The row printed the delivery mode ("bookings ·
 *      trigger"), the transports ("channels: email, sms") and a dispatch-status
 *      pill, and the stat strip carried a "Dispatched" tile. Verbatim: "there
 *      are many Activity Log records and workflow (Channels, trigger, and
 *      dispatched are activity log not notification) in Notifications." All of
 *      it is gone. The state lives on `notificationDispatch/{id}` and the RECORD
 *      of it is written to the hash-chained `activity_log`, so the Activity Log
 *      gained exactly what this screen lost.
 *
 *   2. THE CARD OPENS. Verbatim: "I see the A KinCare visit was assigned and the
 *      CTAs for the workflow but I do not see the KinCare/Booking details. Who
 *      requested, For which kinfolk, what date, what time, wheres the notes."
 *      Those are resolved server-side at dispatch and stamped on the doc as
 *      `detail`; the row summarises kin/date/time inline and expands in place to
 *      the full block. An expansion rather than a detail destination, matching
 *      the web: there is no notification-detail mockup to build from, and the
 *      one mockup directive that does apply, the filename
 *      `...-cardsShouldOpenDisplayingFullerDetails.html`, asks for exactly an
 *      in-place disclosure.
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

    // R5: which cards are OPEN, by id. A set rather than a single id because an
    // operator triaging a morning's bookings compares them, and a single-open
    // accordion makes that impossible. Collapsed by default: triage is a
    // scanning task, and the inline kin/date/time summary is what makes the
    // collapsed state useful enough to leave collapsed.
    var openIds by remember { mutableStateOf<Set<String>>(emptySet()) }

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
                val unreadCount = all.count { isNotificationUnread(it) }
                // R5: WAS a "dispatched" count, i.e. the delivery pipeline's own
                // health on the operator's inbox screen. Now the rows waiting on
                // a decision, from the same `applicableNotificationActions` that
                // decides which rows show Approve/Deny, so the tile and the
                // buttons cannot disagree.
                val actionableCount = all.count { applicableNotificationActions(it).canApproveDeny }
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
                        label = "Needs a decision",
                        value = actionableCount.toString(),
                        trend = "approve or deny",
                        tone = AuntieStatusTone.Warning,
                        feature = actionableCount > 0,
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
                                    openIds = openIds,
                                    onToggleDetail = { id ->
                                        openIds = if (id in openIds) openIds - id else openIds + id
                                    },
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
    openIds: Set<String>,
    onToggleDetail: (String) -> Unit,
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
        detailOpen = entry.id in openIds,
        onToggleDetail = { onToggleDetail(entry.id) },
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
 * category, then the catalog title, the household, the collapsed entity summary,
 * expandable entity detail, and the Step 4 quick-action row. The right rail
 * carries the timestamp and a teal unread dot for unread notifications.
 *
 * Quick actions (Step 4) are all live: a read/unread toggle, an Open button when the
 * notification points at an openable item, a Dismiss button, and quick Approve/Deny
 * when the notification targets a booking. Which buttons appear is decided by the
 * pure [applicableNotificationActions] helper from the entry's targetType.
 *
 * The CTAs were never the broken half of the operator's complaint. They have
 * always acted on the entity via batchUpdateBookings. What was broken is that
 * they sat beside a card that would not say what entity they would act ON, which
 * is what [notificationDetailRows] fixes.
 */
@Composable
private fun NotificationRow(
    entry: NotificationEntry,
    householdName: String,
    selecting: Boolean,
    selected: Boolean,
    detailOpen: Boolean,
    onToggleDetail: () -> Unit,
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
    // Computed here, not inside the Column's content, because issue #705 needs
    // it to decide the Column's OWN modifier (whether the whole body toggles).
    val detailRows = notificationDetailRows(entry)
    val canOpenDetail = detailRows.isNotEmpty()

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

        // ISSUE #705: the whole body is the disclosure control when there is
        // something to disclose, not only the headline. A tap on a descendant
        // that has its own clickable (a quick-action button, the detail toggle
        // if it still had one) is consumed there and never reaches this
        // modifier, which is what keeps the CTAs below from also toggling the
        // card. A row with nothing to disclose gets no click handler at all: a
        // control that opens onto an empty box is worse than no control, the
        // same rule applicableNotificationActions applies to the Open CTA.
        val bodyModifier = if (canOpenDetail) {
            Modifier
                .weight(1f)
                .clickable { onToggleDetail() }
                .semantics { this.role = Role.Button }
        } else {
            Modifier.weight(1f)
        }

        Column(
            modifier = bodyModifier,
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
            if (canOpenDetail) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = notificationHeadline(entry),
                        style = typo.titleMedium,
                        color = c.textPrimary,
                    )
                    // Rotates the same glyph rather than swapping it, so the
                    // affordance reads as one control changing state.
                    Text(
                        text = "▸",
                        style = typo.bodySmall,
                        color = c.textDim,
                        modifier = Modifier.rotate(if (detailOpen) 90f else 0f),
                    )
                }
            } else {
                Text(
                    text = notificationHeadline(entry),
                    style = typo.titleMedium,
                    color = c.textPrimary,
                )
            }
            if (entry.description.isNotBlank()) {
                Text(
                    text = entry.description,
                    style = typo.bodySmall,
                    color = c.textPrimary,
                )
            }

            // Kin · date · time on the COLLAPSED row. The whole complaint was
            // that one KinCare notification looked identical to the next; these
            // are the three values that tell them apart.
            val summary = notificationDetailSummary(entry)
            if (summary.isNotBlank() && !detailOpen) {
                Text(text = summary, style = typo.bodySmall, color = c.textDim)
            }

            if (detailOpen) {
                Spacer(Modifier.height(4.dp))
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(c.surface)
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    detailRows.forEach { (label, value) ->
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                text = label.uppercase(),
                                style = typo.mono.copy(fontSize = 9.5.sp, letterSpacing = 0.8.sp),
                                color = c.textDim,
                            )
                            Text(text = value, style = typo.bodySmall, color = c.textPrimary)
                        }
                    }
                }
            }

            Text(
                text = buildString {
                    entry.actorName?.takeIf { it.isNotBlank() }?.let { append("$it · ") }
                    append(entry.category.ifBlank { "uncategorized" })
                },
                style = typo.bodySmall,
                color = c.textDim,
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
 * Which quick actions apply to a notification. Open is decided purely from
 * targetType/targetId (below); Approve/Deny and Create quote are narrowed
 * further by the entry-aware overload at the bottom of this file, which reads
 * the dispatch `key` as well. read/unread toggle + Dismiss always apply, so
 * they are not modeled here. Pure; unit-tested.
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
 * The one catalog key that means "a booking request is waiting on a decision"
 * (mytribe/functions/src/notifications/catalog.ts: "Kinfolk requested a
 * KinCare visit"). Fired once, at the moment of the ask, by
 * onBookingEnvelopeCreate.ts. Mirrors the web build's
 * `lib/notificationActions.ts`.
 */
private const val PENDING_BOOKING_REQUEST_KEY = "kincare.requested"

/** The household turned a quote down; a new quote is the natural follow-up. */
private const val QUOTE_DENIED_KEY = "quote.denied"

/**
 * Entry-aware overload of [applicableNotificationActions]. Open stays decided
 * purely by targetType/targetId; Approve/Deny and Create quote are narrowed by
 * the dispatch `key` (issue #706, operator: "most of these don't need most of
 * these ctas").
 *
 * Every booking-flavoured row used to offer Approve/Deny, and any row naming a
 * household offered Create quote, regardless of what the event was or what had
 * already happened to it.
 *
 * APPROVE/DENY calls the batch booking callable with APPROVE/REJECT, and that
 * is only the right action for a FRESH request: a reschedule ask resolves
 * through a different callable and a cancellation ask through the #438
 * accept/decline path. A notification carries no live visit status to
 * re-check, so pendency is read off the key itself:
 * [PENDING_BOOKING_REQUEST_KEY] only ever fires once, at the moment of the
 * ask. A request an admin has since decided keeps offering Approve/Deny on its
 * original card until archived or read away; the callable itself fails loud on
 * a stale click rather than pretending the click worked.
 *
 * CREATE QUOTE is offered for a quote or a booking request that has no
 * invoice yet: [QUOTE_DENIED_KEY] (the quote itself was rejected, no bill
 * exists) or [PENDING_BOOKING_REQUEST_KEY] (a fresh ask, nothing billed)
 * PROVIDED the entry does not already reference an invoice. `quote.accepted`
 * is excluded because that quote already became the bill. The button still
 * disappears entirely when no household is identifiable. Matches the web
 * build. Pure; unit-tested.
 */
internal fun applicableNotificationActions(entry: NotificationEntry): NotificationActions {
    val base = applicableNotificationActions(entry.targetType, entry.targetId)
    val key = entry.key.trim()
    val type = entry.targetType.trim().lowercase()
    val targetId = entry.targetId.trim()

    val isPendingBookingRequest =
        key == PENDING_BOOKING_REQUEST_KEY && type == "booking" && targetId.isNotBlank()

    val hasInvoiceReference = type == "invoice" || dataString(entry, "invoiceId").isNotBlank()
    val isQuoteDenial = key == QUOTE_DENIED_KEY
    val isUninvoicedBookingRequest = key == PENDING_BOOKING_REQUEST_KEY && !hasInvoiceReference
    val kinfolkId = notificationKinfolkId(entry)
    val quoteEligible = kinfolkId.isNotBlank() && (isQuoteDenial || isUninvoicedBookingRequest)

    return base.copy(canApproveDeny = isPendingBookingRequest, canCreateQuote = quoteEligible)
}

// ---- row DETAIL: what the notification is actually about (R5) ----------------
//
// Operator ruling R5, 2026-08-03, verbatim: "CTAs on the Notifications have
// nothing to do with the actual notification nor am I able to open card to view
// more details. I see the A KinCare visit was assigned and the CTAs for the
// workflow but I do not see the KinCare/Booking details. Who requested, For
// which kinfolk, what date, what time, wheres the notes."
//
// PURE, AND DELIBERATELY DUMB: nothing here resolves or fetches anything. Every
// value is already on the document, written by
// mytribe/functions/src/notifications/buildNotificationDetail.ts at dispatch
// time. Resolving a booking on the client would need read access to
// the `families/{id}/bookings` subtree, which an admin has and a recipient kinfolk does
// not, so the admin card and the portal card would disagree about the same
// notification. One server-side resolution, two identical renderings.
//
// These mirror the web build's `lib/notificationDetail.ts` decision for decision
// (same fields, same order, same drop-the-blanks rule) so the two clients
// cannot disagree about what a notification says.

/**
 * Field label to value, in the operator's own order: who requested it, for which
 * household, which kin, the service, the date, the time, then the invoice
 * figures, and notes last because it is the only field that wraps.
 *
 * Blank fields are DROPPED, never rendered as a labelled empty. Pure; unit-tested.
 */
internal fun notificationDetailRows(entry: NotificationEntry): List<Pair<String, String>> {
    val d = entry.detail ?: return emptyList()
    return listOf(
        "Requested by" to d.requestedBy,
        "Household" to d.kinfolkName,
        "Kin" to d.kinName,
        "Service" to d.serviceType,
        "Date" to d.bookingDate,
        "Time" to d.bookingTime,
        "Invoice" to d.invoiceNumber,
        "Amount" to d.amount,
        "Due" to d.dueDate,
        "Notes" to d.notes,
    ).mapNotNull { (label, value) ->
        val v = value.trim()
        if (v.isEmpty()) null else label to v
    }
}

/**
 * The one-line summary on a COLLAPSED row: kin, date, time.
 *
 * The household is deliberately absent: the row already prints it as its own
 * accent-coloured context line, and repeating it would push the distinguishing
 * values off the end. "" when there is nothing worth summarising, and the row
 * then shows no summary line rather than an empty one. Pure; unit-tested.
 */
internal fun notificationDetailSummary(entry: NotificationEntry): String {
    val d = entry.detail ?: return ""
    return listOf(d.kinName, d.bookingDate, d.bookingTime)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(" · ")
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
