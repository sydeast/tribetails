package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.admin.AuditLog
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.BookingTransitionAction
import com.tribetails.auntieos.location.LocationTrackingService
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate

internal fun nowIso(): String = Instant.now().toString().substringBefore('.') + "Z"

private fun startGpsTracking(context: Context, sessionId: String, kinfolkId: String) {
    runCatching {
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START_TRACKING
            putExtra(LocationTrackingService.EXTRA_SESSION_ID, sessionId)
            putExtra(LocationTrackingService.EXTRA_KINFOLK_ID, kinfolkId)
        }
        context.startForegroundService(intent)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auntie Time, the day-of run screen, ported to the Den layout from the web
// counterpart (web/.../screens/sessions/KinCareSessionsScreen.kt). Mono kicker +
// serif heading, a StatCard row computed from the live list, then a DenPanel per
// phase (Active / Upcoming / Recent) of KinCare cards built from AuntieIconTile +
// ServicePill + AuntieStatusPill + statusLabel/formatTime. Drives entirely off the
// existing AdminDataViewModel UiState; preserves the visit-lifecycle actions, the
// office-note flow, the GPS foreground-service bits, and the fail-loud banners.
// ─────────────────────────────────────────────────────────────────────────────

private enum class Phase(val label: String, val tone: AuntieStatusTone) {
    Active("Active", AuntieStatusTone.Teal),
    Upcoming("Upcoming", AuntieStatusTone.Orange),
    CompletedToday("Recent", AuntieStatusTone.Muted),
}

@Composable
fun KinCareSessionsScreen(
    viewModel: AdminDataViewModel = viewModel(),
    // Nullable so the main-nav-tab entry shows no breadcrumb, while the entry
    // reached from Admin Data passes a real back and the scaffold renders it (I11).
    onBack: (() -> Unit)? = null,
    onOpenDetail: (kinCareId: String) -> Unit = {},
    onWriteKinTale: (sessionId: String) -> Unit = {},
    onLiveTrack: (sessionId: String, kinfolkId: String, kinfolkName: String) -> Unit = { _, _, _ -> },
    // §A.10: injectable so the route map is hermetic in tests; defaults to the live
    // breadcrumb subcollection read.
    breadcrumbsFor: (String) -> kotlinx.coroutines.flow.Flow<Result<List<com.tribetails.auntieos.data.model.LocationPoint>>> =
        { AuntieOSApp.instance.kinCareRepository.observeBreadcrumbs(it) },
) {
    val sessions by viewModel.kinCareSessions.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val loadError by viewModel.error.collectAsState()
    val scope = rememberCoroutineScope()
    // §A.8: time-block label (e.g. "Evening block"), always on, resolved from Business-Settings blocks.
    val timeBlocks by viewModel.timeBlocks.collectAsState()
    val timeBlockLabelFor: (com.tribetails.auntieos.data.model.KinCareSession) -> String? = { s ->
        com.tribetails.auntieos.domain.resolveTimeBlock(s.startTime, timeBlocks)?.label
    }

    var kinfolkById by remember { mutableStateOf<Map<String, Kinfolk>>(emptyMap()) }
    // Stage 2 Step 2: all kin keyed by id, for the stacked multi-pet avatars per stop.
    var kinById by remember { mutableStateOf<Map<String, com.tribetails.auntieos.data.model.Kin>>(emptyMap()) }

    var toastMessage by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }

    LaunchedEffect(Unit) {
        viewModel.loadKinCareSessions()
        AuntieOSApp.instance.repository.getKinfolk().onSuccess { list ->
            kinfolkById = list.associateBy { it.id }
        }
        AuntieOSApp.instance.repository.getAllKin().onSuccess { list ->
            kinById = list.associateBy { it.id }
        }
    }

    // Day-of operational window. The rules, and why each boundary sits where it
    // does, live in `AuntieTimeWindow.kt` alongside their tests; this screen
    // just applies them. Web's `lib/sessionFormat.ts` is the twin.
    //
    // AO-18: the operator's "today" must be the LOCAL calendar date, not UTC.
    // nowIso() is UTC (correct for the stored *At timestamps below), but using
    // its date here shifted the whole Auntie Time day-window to tomorrow every
    // evening after ~19:00 CDT (UTC has already rolled over). LocalDate.now()
    // matches how android's Home/Invoices/Activity screens already compute today.
    val today = LocalDate.now().toString()
    val visible = sessions.filter { isVisibleOnAuntieTime(it, today) }

    // Operator issue #17: soonest or latest first, applied WITHIN each phase so
    // "latest first" can never float Recent above Active.
    var sort by remember { mutableStateOf(AuntieTimeSort.Soonest) }

    val grouped = visible
        .groupBy { phaseFor(it) }
        .mapValues { (_, rows) -> sortSessions(rows, sort) }

    val activeCount = grouped[Phase.Active].orEmpty().size
    val upcomingToday = grouped[Phase.Upcoming].orEmpty().count { it.startTime.take(10) == today }
    val recentDone = grouped[Phase.CompletedToday].orEmpty()
        .count { it.status.uppercase() == "COMPLETED" && it.completedAt.orEmpty().take(10) == today }

    val patchFn: (String, Map<String, Any>, String) -> Unit = { id, patch, msg ->
        viewModel.patchKinCareSession(id, patch) { err ->
            scope.launch {
                toastMessage = err?.let { "Couldn't update: ${it.message}" } ?: msg
                toastKind = if (err != null) ToastKind.Error else ToastKind.Success
                toastVisible = true
            }
        }
    }

    /**
     * A3: the OPERATOR status transitions (here, "Complete") go through the
     * `transitionBookingStatus` callable rather than [patchFn]. Same toast
     * treatment, deliberately different verb: the server owns the state machine
     * and can REFUSE, and its sentence is what the operator reads.
     */
    val transitionFn: (String, BookingTransitionAction, String, String) -> Unit =
        { id, action, completedAt, msg ->
            viewModel.transitionBookingStatus(id, action, completedAt = completedAt) { err ->
                scope.launch {
                    toastMessage = err?.let { "Couldn't update: ${it.message}" } ?: msg
                    toastKind = if (err != null) ToastKind.Error else ToastKind.Success
                    toastVisible = true
                }
            }
        }

    AuntieScreenScaffold(title = "Auntie Time", onBack = onBack) {
        Box(modifier = Modifier.fillMaxSize()) {
            AuntiePullRefresh(
                isRefreshing = isLoading,
                onRefresh = { viewModel.loadKinCareSessions() },
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    // Den editorial header: mono kicker + Fraunces title + sub, mirrors
                    // the Auntie Time mockup head.
                    // This screen OWNS the "today's route / active visits / upcoming care
                    // windows" framing (spec 13 item 1 / spec 14): the route map (§A.10)
                    // renders below on the in-flight card; Active/Upcoming/Recent phases
                    // cover the rest. The mislabeled Schedule subtitle was removed; that
                    // content lives here. TODO(auntie copy): subtitle reword is author-owned.
                    DenScreenHeading(
                        kicker = "The Den · Auntie Time",
                        title = "Auntie",
                        accentTail = "Time.",
                        subtitle = "Day-of view. Clock in, clock out, every Kin Care in flight.",
                    )
                    Spacer(Modifier.height(16.dp))

                    when {
                        // FAIL-LOUD: a load failure stays on screen as a persistent banner
                        // rather than an auto-dismissing toast, so a permission denial
                        // can't flash once and leave a blank page that reads as "no work".
                        loadError != null -> {
                            AuntieBanner(
                                tone = AuntieBannerTone.Error,
                                title = "Could not load your Kin Cares",
                                icon = Lucide.TriangleAlert,
                            ) {
                                Text(
                                    text = loadError.orEmpty(),
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }
                        }

                        isLoading && sessions.isEmpty() -> {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                repeat(4) { ShimmerCard(height = 110, modifier = Modifier.fillMaxWidth()) }
                            }
                        }

                        visible.isEmpty() -> EmptyState()

                        else -> {
                            // Live stat row, computed from the same list (no extra fetch).
                            StatRow(
                                activeCount = activeCount,
                                upcomingToday = upcomingToday,
                                recentDone = recentDone,
                            )
                            Spacer(Modifier.height(16.dp))

                            AuntieChipGroup(
                                options = AuntieTimeSort.entries.toList(),
                                selected = setOf(sort),
                                onSelectionChange = { next -> next.firstOrNull()?.let { sort = it } },
                                label = { it.label },
                                singleSelect = true,
                            )
                            Spacer(Modifier.height(20.dp))

                            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                                Phase.entries.forEach { phase ->
                                    val items = grouped[phase].orEmpty()
                                    if (items.isNotEmpty()) {
                                        PhaseGroup(
                                            phase = phase,
                                            count = items.size,
                                            sessions = items,
                                            todayIso = today,
                                            kinfolkById = { kinfolkById[it] },
                                            kinById = kinById,
                                            breadcrumbsFor = breadcrumbsFor,
                                            timeBlockLabelFor = timeBlockLabelFor,
                                            onOpenDetail = onOpenDetail,
                                            onWriteKinTale = onWriteKinTale,
                                            onLiveTrack = onLiveTrack,
                                            onPatch = patchFn,
                                            onTransition = transitionFn,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            StatusToast(
                visible = toastVisible,
                message = toastMessage,
                kind = toastKind,
                onDismiss = { toastVisible = false },
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
            )
        }
    }
}

// ── Stat row (Den StatCards) ──────────────────────────────────────────────────
// On a phone the three cards stack vertically rather than crowding one row.

@Composable
private fun StatRow(activeCount: Int, upcomingToday: Int, recentDone: Int) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard(
            label = "In flight",
            value = activeCount.toString(),
            trend = "on the way, arrived, departed",
            tone = AuntieStatusTone.Teal,
            feature = true,
            modifier = Modifier.fillMaxWidth(),
        )
        StatCard(
            label = "Up next today",
            value = upcomingToday.toString(),
            trend = "scheduled for today",
            tone = AuntieStatusTone.Orange,
            modifier = Modifier.fillMaxWidth(),
        )
        StatCard(
            label = "Wrapped today",
            value = recentDone.toString(),
            trend = "completed Kin Cares",
            tone = AuntieStatusTone.Success,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ── Phase panel ────────────────────────────────────────────────────────────────

@Composable
private fun PhaseGroup(
    phase: Phase,
    count: Int,
    sessions: List<KinCareSession>,
    /** LOCAL today, so a card can decide whether its date needs a year. */
    todayIso: String,
    kinfolkById: (String) -> Kinfolk?,
    kinById: Map<String, com.tribetails.auntieos.data.model.Kin>,
    breadcrumbsFor: (String) -> kotlinx.coroutines.flow.Flow<Result<List<com.tribetails.auntieos.data.model.LocationPoint>>>,
    timeBlockLabelFor: (KinCareSession) -> String?,
    onOpenDetail: (String) -> Unit,
    onWriteKinTale: (String) -> Unit,
    onLiveTrack: (sessionId: String, kinfolkId: String, kinfolkName: String) -> Unit,
    onPatch: (String, Map<String, Any>, String) -> Unit,
    /** A3: operator status transitions, server-owned and audited. See `transitionFn`. */
    onTransition: (String, BookingTransitionAction, String, String) -> Unit,
) {
    // Each phase is a Den glass panel; the count rides in the trailing slot as a
    // toned status pill.
    DenPanel(
        title = phase.label,
        modifier = Modifier.fillMaxWidth(),
        trailing = {
            AuntieStatusPill(
                label = count.toString(),
                tone = phase.tone,
                mono = true,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            sessions.forEach { session ->
                val kinfolk = kinfolkById(session.kinfolkId)
                KinCareCard(
                    session = session,
                    todayIso = todayIso,
                    address = kinfolk?.serviceAddress.orEmpty(),
                    phone = kinfolk?.phoneNumber.orEmpty(),
                    email = kinfolk?.email.orEmpty(),
                    kinAvatars = com.tribetails.auntieos.domain.kinAvatarsForSession(session, kinById),
                    breadcrumbsFor = breadcrumbsFor,
                    timeBlockLabel = timeBlockLabelFor(session),
                    onOpenDetail = { onOpenDetail(session.id) },
                    onWriteKinTale = { onWriteKinTale(session.id) },
                    onLiveTrack = { onLiveTrack(session.id, session.kinfolkId, session.kinfolkName) },
                    onPatch = { patch, msg -> onPatch(session.id, patch, msg) },
                    onTransition = { action, completedAt, msg ->
                        onTransition(session.id, action, completedAt, msg)
                    },
                )
            }
        }
    }
}

// ── KinCare card ────────────────────────────────────────────────────────────────

@Composable
private fun KinCareCard(
    session: KinCareSession,
    todayIso: String,
    address: String,
    phone: String,
    email: String,
    kinAvatars: List<com.tribetails.auntieos.domain.KinAvatar>,
    breadcrumbsFor: (String) -> kotlinx.coroutines.flow.Flow<Result<List<com.tribetails.auntieos.data.model.LocationPoint>>>,
    timeBlockLabel: String?,
    onOpenDetail: () -> Unit,
    onWriteKinTale: () -> Unit,
    onLiveTrack: () -> Unit,
    onPatch: (patch: Map<String, Any>, msg: String) -> Unit,
    /** A3: `(action, completedAt, successMessage)`, bound to this session. */
    onTransition: (BookingTransitionAction, String, String) -> Unit,
) {
    val c = AuntieTheme.colors
    val tone = statusTone(session.status)
    val isArrived = session.status.equals("ARRIVED", ignoreCase = true)
    val isInFlight = session.status.uppercase() in setOf("ARRIVED", "DEPARTED")
    val context = LocalContext.current

    GlassSurface(cornerRadius = 16.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                // Live ARRIVED cards lift to a soft teal radial wash (mockup .card.live).
                .then(
                    if (isArrived) Modifier.background(
                        Brush.radialGradient(
                            colors = listOf(c.accent.copy(alpha = 0.10f), Color.Transparent),
                        ),
                    ) else Modifier,
                )
                .padding(15.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            // ---- Header: status glyph tile + identity + status pill ----
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onOpenDetail,
                    ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AuntieIconTile(
                    icon = statusGlyph(session.status),
                    size = 42.dp,
                    tone = tone,
                )
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        text = session.kinfolkName.ifBlank { "Unnamed Kinfolk" },
                        style = AuntieTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (session.serviceType.isNotBlank()) {
                            ServicePill(serviceType = session.serviceType)
                        }
                        Text(
                            text = sessionWindow(session, todayIso),
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
                // Stage 2 Step 2: stacked per-kin avatars for this stop (multi-pet).
                // Joined from the session's kinIds; absent when no kin resolve (never
                // a placeholder face). Sits between identity and the status pills.
                if (kinAvatars.isNotEmpty()) {
                    AuntieAvatarStack(
                        avatars = kinAvatars.map { AvatarSpec(imageUrl = it.imageUrl.ifBlank { null }, initials = it.initials) },
                        max = 4,
                        avatarSize = 28.dp,
                    )
                }
                // §A.8: Business-Settings time-block descriptor (e.g. "Evening block").
                timeBlockLabel?.let { block ->
                    AuntieStatusPill(label = "$block block", tone = AuntieStatusTone.Muted, mono = true)
                }
                AuntieStatusPill(
                    label = statusLabel(session.status),
                    tone = tone,
                    mono = true,
                )
            }

            // ---- Live GPS indicator (only while ARRIVED + tracking) ----
            if (isArrived) {
                GpsLiveRow()
            }

            // ---- Today's-route map (§A.10): render the live/replay RouteMap inline for
            // in-flight visits, fed by the session's breadcrumb subcollection. Only shown
            // once at least one crumb exists (no empty canvas / fake route). ----
            if (isInFlight) {
                val crumbsResult by remember(session.id) { breadcrumbsFor(session.id) }
                    .collectAsState(initial = Result.success(emptyList<com.tribetails.auntieos.data.model.LocationPoint>()))
                val crumbs = crumbsResult.getOrDefault(emptyList())
                if (crumbs.isNotEmpty()) {
                    com.tribetails.auntieos.ui.components.RouteMap(
                        points = crumbs.map {
                            com.tribetails.auntieos.data.model.GpsPoint(lat = it.latitude, lng = it.longitude, t = it.timestamp)
                        },
                        live = isArrived,
                    )
                }
            }

            // ---- Quick-contact row: maps / call / text / email via platform intents ----
            if (address.isNotBlank() || phone.isNotBlank() || email.isNotBlank()) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (address.isNotBlank()) {
                        ContactIconButton(icon = Lucide.Navigation, label = "Navigate to address") {
                            val uri = Uri.parse("geo:0,0?q=" + Uri.encode(address))
                            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            runCatching { context.startActivity(intent) }
                        }
                    }
                    if (phone.isNotBlank()) {
                        ContactIconButton(icon = Lucide.Phone, label = "Call") {
                            val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { context.startActivity(intent) }
                        }
                        ContactIconButton(icon = Lucide.MessageCircle, label = "Text") {
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("sms:$phone"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { context.startActivity(intent) }
                        }
                    }
                    if (email.isNotBlank()) {
                        ContactIconButton(icon = Lucide.Mail, label = "Email") {
                            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$email"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { context.startActivity(intent) }
                        }
                    }
                }
            }

            // ---- Address chip (clickable → maps) ----
            if (address.isNotBlank()) {
                AddressChip(address = address, context = context)
            }

            // ---- One-line notes preview (kinfolk-facing first, internal fallback) ----
            val notePreview = session.kinfolkNotes.ifBlank { session.notes }
            if (notePreview.isNotBlank()) {
                Text(
                    text = notePreview.take(120) + if (notePreview.length > 120) "…" else "",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }

            // ---- Invoice attribution chip (reciprocal link session → invoice) ----
            if (session.invoiceId.isNotBlank()) {
                AuntieStatusPill(
                    label = "Invoice linked",
                    tone = AuntieStatusTone.Teal,
                )
            }

            // ---- State-aware action row ----
            ActionRow(
                session = session,
                onPatch = onPatch,
                onTransition = onTransition,
                onLiveTrack = onLiveTrack,
                onWriteKinTale = onWriteKinTale,
                context = context,
            )
        }
    }
}

// ── Action row ──────────────────────────────────────────────────────────────────
// State-aware lifecycle controls. On a phone the buttons stack full-width so they
// never crowd, and they preserve the exact lifecycle patches + GPS start the
// original screen drove.

@Composable
private fun ActionRow(
    session: KinCareSession,
    onPatch: (patch: Map<String, Any>, msg: String) -> Unit,
    /** A3: `(action, completedAt, successMessage)`, bound to this session. */
    onTransition: (BookingTransitionAction, String, String) -> Unit,
    onLiveTrack: () -> Unit,
    onWriteKinTale: () -> Unit,
    context: Context,
) {
    var showOMWDialog by remember { mutableStateOf(false) }
    var showOfficeNoteDialog by remember { mutableStateOf(false) }
    var officeNoteText by remember(session.id) { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when (session.status.uppercase()) {
            "SCHEDULED" -> {
                PrimaryButton(
                    label = "On The Way",
                    onClick = { showOMWDialog = true },
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.Car, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
            }

            "ON_MY_WAY" -> {
                PrimaryButton(
                    label = "Arrived",
                    onClick = {
                        startGpsTracking(context, session.id, session.kinfolkId)
                        onPatch(mapOf("status" to "ARRIVED", "arrivedAt" to nowIso()), "Arrived - session active.")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.MapPin, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
            }

            "ARRIVED", "DEPARTED" -> {
                GhostButton(
                    label = "Live Map",
                    onClick = onLiveTrack,
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.Map, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
                GhostButton(
                    label = "Undo Arrival",
                    onClick = {
                        val undoTo = if (!session.onMyWayAt.isNullOrBlank()) "ON_MY_WAY" else "SCHEDULED"
                        onPatch(mapOf("status" to undoTo, "arrivedAt" to ""), "Arrival undone.")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.Undo2, contentDescription = null, modifier = Modifier.size(14.dp)) },
                )
                GhostButton(
                    label = "Journal",
                    onClick = onWriteKinTale,
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.BookOpen, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
                PrimaryButton(
                    label = "Complete",
                    onClick = {
                        // A3: server-owned + audited, not a direct status patch.
                        onTransition(BookingTransitionAction.COMPLETE, nowIso(), "Session completed.")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.CircleCheckBig, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
                GhostButton(
                    label = "Note to Office",
                    onClick = { showOfficeNoteDialog = true },
                    modifier = Modifier.fillMaxWidth(),
                    leading = { Icon(Lucide.StickyNote, contentDescription = null, modifier = Modifier.size(14.dp)) },
                )
            }
        }
    }

    if (showOMWDialog) {
        AuntieModal(
            onDismissRequest = { showOMWDialog = false },
            title = "On The Way",
            confirmButton = {
                AuntieTextBtn(onClick = {
                    showOMWDialog = false
                    onPatch(
                        mapOf("status" to "ON_MY_WAY", "onMyWayAt" to nowIso()),
                        "On the way - kinfolk notified.",
                    )
                }) { Text("OK") }
            },
            dismissButton = {
                AuntieTextBtn(onClick = { showOMWDialog = false }) { Text("CANCEL") }
            },
        ) {
            Text("You are confirming that you are on your way to this assignment and will arrive soon.")
        }
    }

    if (showOfficeNoteDialog) {
        AuntieModal(
            onDismissRequest = { showOfficeNoteDialog = false },
            title = "Note to Office",
            confirmButton = {
                AuntieTextBtn(
                    onClick = {
                        val typed = officeNoteText.trim()
                        if (typed.isNotBlank()) {
                            // Append timestamped office note to session.notes
                            // (admin-internal field). Auntie-in-field uses this
                            // to flag schedule problems, missing supplies, etc.
                            // for the office to action. Audit logs the action
                            // type so admin reports can filter to field-comms.
                            val merged = appendOfficeNote(session.notes, typed)
                            onPatch(
                                mapOf("notes" to merged, "updatedAt" to nowIso()),
                                "Note sent to office.",
                            )
                            AuditLog.fire(
                                scope = scope,
                                repository = AuntieOSApp.instance.repository,
                                actionType = "SESSION_OFFICE_NOTE_ADDED",
                                description = "Field auntie added office note on session ${session.id}",
                                targetId = session.id,
                                targetCollection = "kin_care_sessions",
                            )
                            officeNoteText = ""
                            showOfficeNoteDialog = false
                        }
                    },
                ) { Text("SEND") }
            },
            dismissButton = {
                AuntieTextBtn(onClick = {
                    showOfficeNoteDialog = false
                    officeNoteText = ""
                }) { Text("CANCEL") }
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = "Send a quick note to the office about this assignment. Visible to admin only.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
                AuntieField(
                    value = officeNoteText,
                    onValueChange = { officeNoteText = it },
                    label = "Note",
                    placeholder = "What does the office need to know?",
                    singleLine = false,
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * Pure helper: appends a timestamped office note to an existing session.notes
 * string. Top-level + internal so JVM tests can lock in the formatting per
 * [[compose-pure-helper-tdd]]. Empty inputs are no-ops (callers gate on
 * isNotBlank already; helper is defensive).
 *
 *  [2026-05-19T14:23:00Z] (office) {body}
 *
 * Existing notes are preserved verbatim - the new line is prepended so the
 * latest note surfaces first in the admin UI's notes preview.
 */
internal fun appendOfficeNote(existing: String, addition: String): String {
    val trimmedAdd = addition.trim()
    if (trimmedAdd.isBlank()) return existing
    val stamped = "[${nowIso()}] (office) $trimmedAdd"
    return if (existing.isBlank()) stamped else "$stamped\n$existing"
}

// ── Quick-contact icon button (Den hairline tile) ───────────────────────────────

@Composable
private fun ContactIconButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = c.primary, modifier = Modifier.size(16.dp))
    }
}

// ── Live GPS row (mockup .gpslive: pulsing teal dot + label) ────────────────────

@Composable
private fun GpsLiveRow() {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AuntieStatusPill(
            label = "",
            tone = AuntieStatusTone.Teal,
            dotOnly = true,
            glow = true,
        )
        Text(
            text = "GPS tracking · live route",
            style = AuntieTheme.typography.mono,
            color = c.accent,
        )
    }
}

// ── Address chip → opens platform maps ──────────────────────────────────────────

@Composable
private fun AddressChip(address: String, context: Context) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .clickable {
                val uri = Uri.parse("geo:0,0?q=" + Uri.encode(address))
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                runCatching { context.startActivity(intent) }
            }
            .padding(horizontal = 11.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(Lucide.MapPinned, contentDescription = null, tint = c.textDim, modifier = Modifier.size(12.dp))
        Text(
            text = address,
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            maxLines = 1,
        )
    }
}

// ── Empty state ──────────────────────────────────────────────────────────────────

@Composable
private fun EmptyState() {
    // Migration-aware empty state. Per the audit this is a data-coverage outcome
    // (DRAFT/PENDING bookings and stale-dated migration docs are filtered out by
    // design), not a code bug, so it explains where Kin Cares come from rather than
    // implying something is broken.
    GlassSurface(cornerRadius = 16.dp, modifier = Modifier.fillMaxWidth()) {
        AuntieEmptyState(
            title = "Nothing in flight right now",
            message = "Approved Kin Cares for today and the next two weeks land here, plus anything " +
                "completed or cancelled since yesterday. New bookings show up once you approve them " +
                "on the Bookings screen.",
            icon = Lucide.PawPrint,
        )
    }
}

// ── Status mapping ────────────────────────────────────────────────────────────────

/** Maps a session status to the Den status tone (color signature). */
private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "ON_MY_WAY" -> AuntieStatusTone.Orange
    "ARRIVED" -> AuntieStatusTone.Teal
    "DEPARTED" -> AuntieStatusTone.Purple
    "COMPLETED" -> AuntieStatusTone.Success
    "CANCELLED" -> AuntieStatusTone.Muted
    else /* SCHEDULED */ -> AuntieStatusTone.Neutral
}

/** Leading glyph for the icon tile. */
private fun statusGlyph(status: String): ImageVector = when (status.uppercase()) {
    "ON_MY_WAY" -> Lucide.Footprints
    "ARRIVED", "DEPARTED" -> Lucide.Radio
    "COMPLETED" -> Lucide.CircleCheckBig
    "CANCELLED" -> Lucide.Ban
    else -> Lucide.CalendarClock
}

private fun phaseFor(s: KinCareSession): Phase = when (s.status.uppercase()) {
    "ON_MY_WAY", "ARRIVED", "DEPARTED" -> Phase.Active
    "SCHEDULED" -> Phase.Upcoming
    else -> Phase.CompletedToday
}

/**
 * The window, sort and date-label rules moved to `AuntieTimeWindow.kt` when
 * operator issue #17 changed them (Recent is now seven days, the year shows
 * outside the current one, and the operator can flip the sort). They are pure
 * functions with their own unit tests there; this file stays the Composable.
 */

