package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import kotlinx.coroutines.flow.Flow
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Ban
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.EllipsisVertical
import com.composables.icons.lucide.Footprints
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPinned
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Radio
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.Undo2
import com.tribetails.auntieos.web.data.AuditLog
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.Breadcrumb
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.GpsPoint
import com.tribetails.auntieos.web.data.GpsSummary
import com.tribetails.auntieos.web.data.GpsTracker
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.resolveTimeBlock
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.createGpsTracker
import com.tribetails.auntieos.web.screens.KinAvatar
import com.tribetails.auntieos.web.screens.kinAvatarsForSession
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.util.nowIso
import com.tribetails.auntieos.web.util.openInMaps
import com.tribetails.auntieos.web.ui.components.AuntieAvatarStack
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AvatarSpec
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.ui.components.color
import kotlinx.coroutines.launch

// ---- Sub-routes inside Auntie Time (drill into operational detail) ----

private sealed interface AuntieTimeRoute {
    data object List                          : AuntieTimeRoute
    data class Detail(val kinCareId: String)  : AuntieTimeRoute
    data class Compose(val kinCareId: String) : AuntieTimeRoute
}

@Composable
fun KinCareSessionsScreen() {
    var route by remember { mutableStateOf<AuntieTimeRoute>(AuntieTimeRoute.List) }
    when (val r = route) {
        AuntieTimeRoute.List      -> AuntieTimeListScreen(
            onOpenDetail   = { route = AuntieTimeRoute.Detail(it) },
            onWriteKinTale = { route = AuntieTimeRoute.Compose(it) },
        )
        is AuntieTimeRoute.Detail -> KinCareDetailScreen(
            kinCareId = r.kinCareId,
            onBack    = { route = AuntieTimeRoute.List },
        )
        is AuntieTimeRoute.Compose -> com.tribetails.auntieos.web.screens.kintales.KinTaleComposeScreen(
            sessionId = r.kinCareId,
            onClose   = { route = AuntieTimeRoute.List },
        )
    }
}

private enum class Phase(val label: String, val tone: AuntieStatusTone) {
    Active        ("Active",   AuntieStatusTone.Teal),
    Upcoming      ("Upcoming", AuntieStatusTone.Orange),
    CompletedToday("Recent",   AuntieStatusTone.Muted),
}

@Composable
private fun AuntieTimeListScreen(
    onOpenDetail: (String) -> Unit,
    onWriteKinTale: (String) -> Unit,
) {
    val client = remember { FirestoreClient() }
    val auth   = remember { AuthClient() }
    val authUser by auth.authStateStream().collectAsState(initial = null)
    val state    by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolks by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    // Multi-pet avatars: a single screen-level kin subscription, joined per session
    // by kinId/kinIds via the pure kinAvatarsForSession helper (no N+1 listeners).
    val allKinState by remember { client.allKinStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinById = remember(allKinState) {
        (allKinState as? FirestoreResult.Data)?.value.orEmpty().associateBy { it._id }
    }
    // §A.8: Business-Settings time blocks drive the "Evening block" descriptor on cards.
    val settingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val timeBlocks = remember(settingsState) { (settingsState as? FirestoreResult.Data)?.value?.timeBlocks.orEmpty() }
    // Resolve a session's start time onto its block label.
    val timeBlockLabelFor: (KinCareSession) -> String? = { s ->
        resolveTimeBlock(s.startTime, timeBlocks)?.label
    }

    var toast        by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind    by remember { mutableStateOf(ToastKind.Info) }

    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    val scope = rememberCoroutineScope()

    // ---- Per-session GPS trackers (one watchPosition per ARRIVED session) ----
    val trackers = remember { mutableStateMapOf<String, GpsTracker>() }
    DisposableEffect(Unit) {
        onDispose { trackers.values.forEach { it.stop() }; trackers.clear() }
    }

    fun startGpsFor(sessionId: String) {
        if (sessionId.isBlank() || trackers.containsKey(sessionId)) return
        val tracker = createGpsTracker(client)
        trackers[sessionId] = tracker
        tracker.start(
            sessionId = sessionId,
            onPing    = { /* live polyline UI subscribes via breadcrumbsStream */ },
            onError   = { msg ->
                showToast("GPS: $msg", ToastKind.Error)
            },
        )
        AuditLog.fire(
            scope            = scope,
            client           = client,
            actorId          = authUser?.uid.orEmpty(),
            actionType       = "GPS_START",
            description      = "Session GPS started",
            targetId         = sessionId,
            targetCollection = "kin_care_sessions",
        )
    }

    fun stopGpsFor(sessionId: String) {
        val tracker = trackers.remove(sessionId) ?: return
        tracker.stop()
        AuditLog.fire(
            scope            = scope,
            client           = client,
            actorId          = authUser?.uid.orEmpty(),
            actionType       = "GPS_STOP",
            description      = "Session GPS stopped",
            targetId         = sessionId,
            targetCollection = "kin_care_sessions",
        )
        // Bake the final route + summary onto the parent session doc so MyTribe +
        // the future Departed-email flow can render replay without re-reading the
        // breadcrumb subcollection. Fail-loud surfaces via toast; absence is OK
        // because GPS is best-effort, not journal-blocking.
        scope.launch {
            when (val r = client.getBreadcrumbs(sessionId)) {
                is WriteResult.Err -> showToast("GPS summary skipped: ${r.message}", ToastKind.Error)
                is WriteResult.Ok  -> {
                    val crumbs = r.value
                    val summary = buildGpsSummary(crumbs)
                    when (val w = client.saveSessionGpsSummary(sessionId, summary)) {
                        is WriteResult.Err -> showToast("Could not save GPS summary: ${w.message}", ToastKind.Error)
                        is WriteResult.Ok  -> Unit
                    }
                }
            }
        }
    }

    /** Lookup helper for resolving the kinfolk record by id (service address + photo). */
    val kinfolkById: (String) -> Kinfolk? = remember(kinfolks) {
        val byId = (kinfolks as? FirestoreResult.Data)?.value?.associateBy { it._id } ?: emptyMap()
        ({ id -> byId[id] })
    }

    ScreenScaffold {
        // Den editorial header: mono kicker + Fraunces title + sub, mirrors the
        // Auntie Time mockup (.head .kick / .head h2 / .head .sub).
        // This screen OWNS the "today's route / active visits / upcoming care windows"
        // framing (spec 13 item 1 / spec 14): the route map (§A.10) renders below on the
        // in-flight card, and Active/Upcoming/Recent phases cover active + upcoming. The
        // mislabeled Schedule subtitle was removed; that content lives here, not nowhere.
        // TODO(auntie copy): any subtitle rewording to surface "route" is author-owned.
        DenScreenHeading(
            kicker     = "The Den · Auntie Time",
            title      = "Auntie",
            accentTail = "Time.",
            subtitle   = "Day-of view. Clock in, clock out, every Kin Care in flight.",
        )
        Spacer(Modifier.height(20.dp))

        // Transient write-feedback toast (clock-in/out, GPS). Stream-load errors do
        // NOT use this path: per the fail-loud policy a load failure shows a
        // persistent banner below, never a dismissible toast that can flash away
        // and leave the screen looking simply empty.
        StatusToast(
            visible   = toastVisible,
            message   = toast,
            kind      = toastKind,
            onDismiss = { toastVisible = false },
        )

        when (val s = state) {
            FirestoreResult.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(4) { ShimmerCard(height = 110.dp) }
                }

            // FAIL-LOUD FIX (audit auntie-time): a kin_care_sessions listen error
            // previously rendered as an auto-dismissing StatusToast, so a permission
            // denial flashed once then left a blank page indistinguishable from
            // "no work today". It now stays on screen as a persistent error banner.
            is FirestoreResult.Error ->
                AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Could not load your Kin Cares",
                    icon  = Lucide.TriangleAlert,
                ) {
                    Text(
                        text  = s.message,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }

            is FirestoreResult.Data -> {
                val today = nowIso().take(10)
                // Only show sessions that are relevant for a day-of operational view:
                //   Active:   always (any date, currently in flight)
                //   Upcoming: today and next 14 days only (hides stale migration noise)
                //   Recent:   completed/cancelled today or yesterday only
                // NOTE (audit): DRAFT/PENDING bookings are intentionally excluded;
                // a booking surfaces here only once it is approved to SCHEDULED.
                val yesterday = dateSubDays(today, 1)
                val cutoff    = dateAddDays(today, 14)
                val visible = s.value.filter { session ->
                    val status = session.status.uppercase()
                    val date   = session.startTime.take(10)
                    when {
                        status in setOf("ON_MY_WAY", "ARRIVED", "DEPARTED") -> true
                        status == "SCHEDULED" -> date in yesterday..cutoff
                        status in setOf("COMPLETED", "CANCELLED")           -> date >= yesterday
                        else -> false
                    }
                }

                if (visible.isEmpty()) {
                    EmptyState()
                } else {
                    val grouped = visible
                        .sortedBy { it.startTime }   // earliest first inside each phase
                        .groupBy { phaseFor(it) }

                    // Real stat row, computed from the same stream (no extra fetch):
                    // in-flight count, today's scheduled run, and today's wraps.
                    val activeCount   = grouped[Phase.Active].orEmpty().size
                    val upcomingToday = grouped[Phase.Upcoming].orEmpty().count { it.startTime.take(10) == today }
                    val recentDone    = grouped[Phase.CompletedToday].orEmpty()
                        .count { it.status.uppercase() == "COMPLETED" && it.completedAt.take(10) == today }

                    StatRow(activeCount = activeCount, upcomingToday = upcomingToday, recentDone = recentDone)
                    Spacer(Modifier.height(20.dp))

                    // §A.8: time-block labels are WIRED. Multi-pet avatars are now WIRED
                    // too (per-session kin join via kinAvatarsForSession). Surface a
                    // loud error only if the kin stream itself failed.
                    (allKinState as? FirestoreResult.Error)?.let { err ->
                        AuntieBanner(
                            tone  = AuntieBannerTone.Error,
                            title = "Couldn't load pet avatars",
                        ) {
                            Text(err.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                        }
                        Spacer(Modifier.height(16.dp))
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Phase.entries.forEach { phase ->
                            val items = grouped[phase].orEmpty()
                            if (items.isNotEmpty()) {
                                PhaseGroup(
                                    phase   = phase,
                                    count   = items.size,
                                    sessions = items,
                                    kinfolkById = kinfolkById,
                                    kinById = kinById,
                                    breadcrumbsFor = { client.breadcrumbsStream(it) },
                                    timeBlockLabelFor = timeBlockLabelFor,
                                    onOpenDetail = onOpenDetail,
                                    onWriteKinTale = onWriteKinTale,
                                    onPatch = { id, patch, successMsg ->
                                        scope.launch {
                                            when (val r = client.patchKinCare(id, patch)) {
                                                is WriteResult.Ok  -> {
                                                    when (patch["status"]?.uppercase()) {
                                                        "ARRIVED" -> startGpsFor(id)
                                                        "DEPARTED",
                                                        "ON_MY_WAY",
                                                        "SCHEDULED",
                                                        "COMPLETED",
                                                        "CANCELLED" -> stopGpsFor(id)
                                                        else -> Unit
                                                    }
                                                    showToast(successMsg, ToastKind.Success)
                                                }
                                                is WriteResult.Err -> showToast("Couldn't update: ${r.message}", ToastKind.Error)
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------- Stat row (Den StatCards, computed from the live stream) ----------

@Composable
private fun StatRow(activeCount: Int, upcomingToday: Int, recentDone: Int) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StatCard(
            label   = "In flight",
            value   = activeCount.toString(),
            trend   = "on the way, arrived, departed",
            tone    = AuntieStatusTone.Teal,
            feature = true,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label   = "Up next today",
            value   = upcomingToday.toString(),
            trend   = "scheduled for today",
            tone    = AuntieStatusTone.Orange,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label   = "Wrapped today",
            value   = recentDone.toString(),
            trend   = "completed Kin Cares",
            tone    = AuntieStatusTone.Success,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun PhaseGroup(
    phase: Phase,
    count: Int,
    sessions: List<KinCareSession>,
    kinfolkById: (String) -> Kinfolk?,
    kinById: Map<String, Kin>,
    breadcrumbsFor: (String) -> Flow<FirestoreResult<List<Breadcrumb>>>,
    timeBlockLabelFor: (KinCareSession) -> String?,
    onOpenDetail: (String) -> Unit,
    onWriteKinTale: (String) -> Unit,
    onPatch: (id: String, patch: Map<String, String>, successMsg: String) -> Unit,
) {
    // Each phase is a Den glass panel; the count rides in the panel trailing slot
    // as a toned status pill (replaces the bespoke mockup .phlab chip).
    DenPanel(
        title    = phase.label,
        modifier = Modifier.fillMaxWidth(),
        trailing = {
            AuntieStatusPill(
                label = count.toString(),
                tone  = phase.tone,
                mono  = true,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            sessions.forEach { session ->
                val kinfolk = kinfolkById(session.kinfolkId)
                KinCareCard(
                    session     = session,
                    address     = kinfolk?.serviceAddress.orEmpty(),
                    photoUrl    = kinfolk?.profilePictureUrl.orEmpty(),
                    kinAvatars  = kinAvatarsForSession(session, kinById),
                    breadcrumbsFor = breadcrumbsFor,
                    timeBlockLabel = timeBlockLabelFor(session),
                    onOpenDetail = { onOpenDetail(session._id) },
                    onWriteKinTale = { onWriteKinTale(session._id) },
                    onPatch     = onPatch,
                )
            }
        }
    }
}

@Composable
private fun KinCareCard(
    session: KinCareSession,
    address: String,
    photoUrl: String,
    kinAvatars: List<KinAvatar>,
    breadcrumbsFor: (String) -> Flow<FirestoreResult<List<Breadcrumb>>>,
    timeBlockLabel: String?,
    onOpenDetail: () -> Unit,
    onWriteKinTale: () -> Unit,
    onPatch: (id: String, patch: Map<String, String>, successMsg: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val tone = statusTone(session.status)
    val accent = tone.color(c)
    val isArrived = session.status.equals("ARRIVED", ignoreCase = true)
    val isInFlight = session.status.uppercase() in setOf("ARRIVED", "DEPARTED")

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
                    ) else Modifier
                )
                .padding(15.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            // ---- Header: leading element + identity + status pill + kebab ----
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
                // Stacked per-kin (pet) avatars when the session's kin resolve, else
                // the kinfolk photo, else a status glyph tile. The pet cluster is the
                // real multi-pet avatar affordance (kinAvatarsForSession join).
                when {
                    kinAvatars.isNotEmpty() -> {
                        AuntieAvatarStack(
                            avatars = kinAvatars.map {
                                AvatarSpec(
                                    imageUrl = it.imageUrl.takeIf { url -> url.isNotBlank() },
                                    initials = it.initials.ifBlank { "Kin" },
                                )
                            },
                            max = 4,
                            avatarSize = 34.dp,
                        )
                    }
                    photoUrl.isNotBlank() -> {
                        AuntieAvatarStack(
                            avatars = listOf(
                                AvatarSpec(
                                    imageUrl = photoUrl,
                                    initials = session.kinfolkName.ifBlank { "Kin" },
                                ),
                            ),
                            max = 4,
                            avatarSize = 34.dp,
                        )
                    }
                    else -> {
                        AuntieIconTile(
                            icon = statusGlyph(session.status),
                            size = 42.dp,
                            tone = tone,
                        )
                    }
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text  = session.kinfolkName.ifBlank { "Unnamed Kinfolk" },
                        style = AuntieTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (session.serviceType.isNotBlank()) {
                            Text(session.serviceType, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            Text("·", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
                        }
                        Text(sessionWindow(session), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
                // §A.8: Business-Settings time-block descriptor (e.g. "Evening block"),
                // resolved from the session start time. Null when the session falls in
                // no block or the flag is off.
                timeBlockLabel?.let { block ->
                    AuntieStatusPill(label = "$block block", tone = AuntieStatusTone.Muted, mono = true)
                }
                AuntieStatusPill(
                    label = statusLabel(session.status),
                    tone  = tone,
                    mono  = true,
                )
                KebabMenu(session = session, onPatch = onPatch)
            }

            // ---- Live GPS indicator (only while ARRIVED + tracking) ----
            if (isArrived) {
                GpsLiveRow()
            }

            // ---- Today's-route map (§A.10): render the live/replay RouteMap inline for
            // in-flight visits, fed by the session's breadcrumb subcollection. Only shown
            // once at least one crumb exists (no empty canvas / fake route). ----
            if (isInFlight) {
                val crumbsState by remember(session._id) { breadcrumbsFor(session._id) }
                    .collectAsState(initial = FirestoreResult.Loading)
                val crumbs = (crumbsState as? FirestoreResult.Data)?.value.orEmpty()
                if (crumbs.isNotEmpty()) {
                    RouteMap(breadcrumbs = crumbs, live = isArrived)
                }
            }

            // ---- Address chip (clickable → maps) ----
            if (address.isNotBlank()) {
                AddressChip(address)
            }

            // ---- One-line notes preview ----
            if (session.notes.isNotBlank()) {
                Text(
                    text  = session.notes.take(120) + if (session.notes.length > 120) "…" else "",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }

            // ---- Invoice attribution chip (reciprocal link session → invoice) ----
            if (session.invoiceId.isNotBlank()) {
                AuntieStatusPill(
                    label = "Invoice linked",
                    tone  = AuntieStatusTone.Teal,
                )
            }

            // ---- State-aware action row ----
            ActionRow(session = session, onPatch = onPatch, onWriteKinTale = onWriteKinTale)
        }
    }
}

@Composable
private fun ActionRow(
    session: KinCareSession,
    onPatch: (id: String, patch: Map<String, String>, successMsg: String) -> Unit,
    onWriteKinTale: () -> Unit,
) {
    val now = nowIso()
    when (session.status.uppercase()) {
        "SCHEDULED" -> Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            PrimaryButton(
                label   = "OMW",
                onClick = { onPatch(session._id, mapOf("status" to "ON_MY_WAY", "onMyWayAt" to now), "On the way.") },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Arrived",
                onClick = { onPatch(session._id, mapOf("status" to "ARRIVED", "arrivedAt" to now), "Arrived. GPS started.") },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Complete",
                onClick = onWriteKinTale,
                modifier = Modifier.weight(1f),
            )
        }

        "ON_MY_WAY" -> Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            PrimaryButton(
                label   = "Arrived",
                onClick = { onPatch(session._id, mapOf("status" to "ARRIVED", "arrivedAt" to now), "Arrived. GPS started.") },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Complete",
                onClick = onWriteKinTale,
                modifier = Modifier.weight(1f),
            )
        }

        "ARRIVED" -> Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            PrimaryButton(
                label   = "Departed",
                onClick = { onPatch(session._id, mapOf("status" to "DEPARTED", "departedAt" to now), "Departed. GPS saved.") },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Undo Arrived",
                onClick = {
                    val undoTo = if (session.onMyWayAt.isNotBlank()) "ON_MY_WAY" else "SCHEDULED"
                    onPatch(session._id, mapOf("status" to undoTo, "arrivedAt" to ""), "Undid arrival.")
                },
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Undo2, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
        }

        "DEPARTED" -> PrimaryButton(
            label   = "Complete KinTale",
            onClick = onWriteKinTale,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(13.dp)) },
        )

        // COMPLETED: offer a read-only jump into the sent KinTale (mockup "View KinTale").
        "COMPLETED" -> GhostButton(
            label   = "View KinTale",
            onClick = onWriteKinTale,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        )

        // CANCELLED: no action buttons.
        else -> Unit
    }
}

@Composable
private fun KebabMenu(
    session: KinCareSession,
    onPatch: (id: String, patch: Map<String, String>, successMsg: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val terminal = session.status.equals("COMPLETED",  ignoreCase = true) ||
                   session.status.equals("CANCELLED",  ignoreCase = true)
    if (terminal) return

    var open by remember { mutableStateOf(false) }

    Box {
        Box(
            modifier = Modifier
                .size(28.dp)
                .clip(RoundedCornerShape(6.dp))
                .clickable { open = true }
                .padding(4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.EllipsisVertical, contentDescription = "More", tint = c.textDim, modifier = Modifier.size(16.dp))
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
        ) {
            DropdownMenuItem(
                text = { Text("Mark Completed") },
                onClick = {
                    open = false
                    onPatch(session._id, mapOf("status" to "COMPLETED", "completedAt" to nowIso()), "Marked Completed.")
                },
                leadingIcon = { Icon(Lucide.CircleCheckBig, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
            DropdownMenuItem(
                text = { Text("Cancel KinCare") },
                onClick = {
                    open = false
                    onPatch(session._id, mapOf("status" to "CANCELLED"), "Cancelled.")
                },
                leadingIcon = { Icon(Lucide.Ban, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
        }
    }
}

// ---------- Live GPS row (mockup .gpslive: pulsing teal dot + label) ----------

@Composable
private fun GpsLiveRow() {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Reuse the Den status LED in glow mode for the pulsing "live" dot.
        AuntieStatusPill(
            label   = "",
            tone    = AuntieStatusTone.Teal,
            dotOnly = true,
            glow    = true,
        )
        Text(
            text  = "GPS tracking · live route",
            style = AuntieTheme.typography.mono,
            color = c.accent,
        )
    }
}

// ---------- Address chip → opens platform maps ----------

@Composable
private fun AddressChip(address: String) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .clickable { openInMaps(address) }
            .padding(horizontal = 11.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(Lucide.MapPinned, contentDescription = null, tint = c.textDim, modifier = Modifier.size(12.dp))
        Text(
            text  = address,
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            maxLines = 1,
        )
    }
}

// ---------- Empty state ----------

@Composable
private fun EmptyState() {
    // Clean empty state. Per the audit this is a data-coverage outcome
    // (DRAFT/PENDING bookings and stale-dated docs are filtered out by design),
    // not a code bug, so it explains where Kin Cares come from rather than
    // implying something is broken.
    GlassSurface(cornerRadius = 16.dp, modifier = Modifier.fillMaxWidth()) {
        AuntieEmptyState(
            title   = "Nothing in flight right now",
            message = "Approved Kin Cares for today and the next two weeks land here, plus anything " +
                      "completed or cancelled since yesterday. New bookings show up once you approve them " +
                      "on the Bookings screen.",
            icon    = Lucide.PawPrint,
        )
    }
}

// ---------- Status mapping ----------

/** Maps a session status to the Den status tone (color signature). */
private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "ON_MY_WAY"          -> AuntieStatusTone.Orange
    "ARRIVED"            -> AuntieStatusTone.Teal
    "DEPARTED"           -> AuntieStatusTone.Purple
    "COMPLETED"          -> AuntieStatusTone.Success
    "CANCELLED"          -> AuntieStatusTone.Muted
    else /* SCHEDULED */ -> AuntieStatusTone.Neutral
}

/** Title-case pill label from the SCREAMING_SNAKE status code. */
private fun statusLabel(status: String): String =
    status.lowercase().replace('_', ' ')

/** Leading glyph for the icon tile (non-photo cards). */
private fun statusGlyph(status: String) = when (status.uppercase()) {
    "ON_MY_WAY"           -> Lucide.Footprints
    "ARRIVED", "DEPARTED" -> Lucide.Radio
    "COMPLETED"           -> Lucide.CircleCheckBig
    "CANCELLED"           -> Lucide.Ban
    else                  -> Lucide.CalendarClock
}

private fun phaseFor(s: KinCareSession): Phase = when (s.status.uppercase()) {
    "ON_MY_WAY", "ARRIVED", "DEPARTED" -> Phase.Active
    "SCHEDULED"                        -> Phase.Upcoming
    else                               -> Phase.CompletedToday
}

private fun sessionWindow(s: KinCareSession): String {
    val start = shortDateTime(s.startTime)
    val end   = shortTime(s.endTime)
    return when {
        start.isBlank() && end.isBlank() -> "Time TBD"
        end.isBlank()                    -> start
        else                             -> "$start to $end"
    }
}

private fun shortDateTime(iso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        "$month $day · $time"
    }.getOrDefault(iso)

private fun shortTime(iso: String): String =
    runCatching { if (iso.length >= 16) iso.substring(11, 16) else iso }
        .getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")

/** Add [days] days to an ISO date string "YYYY-MM-DD". Handles month/year rollover. */
private fun dateAddDays(iso: String, days: Int): String = dateOffset(iso, days)

/** Subtract [days] days from an ISO date string "YYYY-MM-DD". */
private fun dateSubDays(iso: String, days: Int): String = dateOffset(iso, -days)

private fun dateOffset(iso: String, offsetDays: Int): String = runCatching {
    if (iso.length < 10) return@runCatching iso
    var y = iso.substring(0, 4).toInt()
    var m = iso.substring(5, 7).toInt()
    var d = iso.substring(8, 10).toInt() + offsetDays
    // Roll over months
    while (d < 1)  { m--; if (m < 1)  { m = 12; y-- }; d += daysInMonth(y, m) }
    while (d > daysInMonth(y, m)) { d -= daysInMonth(y, m); m++; if (m > 12) { m = 1; y++ } }
    val ys = y.toString().padStart(4, '0')
    val ms = m.toString().padStart(2, '0')
    val ds = d.toString().padStart(2, '0')
    "$ys-$ms-$ds"
}.getOrDefault(iso)

private fun daysInMonth(y: Int, m: Int) = when (m) {
    1,3,5,7,8,10,12 -> 31
    4,6,9,11         -> 30
    2                -> if (y % 400 == 0 || (y % 4 == 0 && y % 100 != 0)) 29 else 28
    else             -> 30
}

/**
 * Builds a [GpsSummary] from raw breadcrumbs. Down-samples to <= 1_000 points
 * so the resulting Firestore doc stays well under the 1MB limit even for
 * multi-hour overnights. Distance + duration use the full series so accuracy
 * is preserved.
 */
internal fun buildGpsSummary(crumbs: List<Breadcrumb>): GpsSummary {
    if (crumbs.isEmpty()) return GpsSummary(computedAt = nowIso())
    val distance = totalDistanceMeters(crumbs)
    val duration = durationMillis(crumbs) / 1000L
    val first = crumbs.first()
    val last = crumbs.last()
    val downsampled = downsample(crumbs, 1_000)
    return GpsSummary(
        distanceMeters = distance,
        durationSeconds = duration,
        startLat = first.lat,
        startLng = first.lng,
        endLat = last.lat,
        endLng = last.lng,
        route = downsampled.map { GpsPoint(lat = it.lat, lng = it.lng, t = parseIsoEpochMs(it.timestamp)) },
        computedAt = nowIso(),
    )
}

private fun downsample(crumbs: List<Breadcrumb>, target: Int): List<Breadcrumb> {
    if (crumbs.size <= target) return crumbs
    val step = crumbs.size.toDouble() / target.toDouble()
    val out = ArrayList<Breadcrumb>(target)
    var i = 0.0
    while (out.size < target && i.toInt() < crumbs.size) {
        out.add(crumbs[i.toInt()])
        i += step
    }
    // Always keep the last point so the polyline ends where Auntie finished.
    if (out.lastOrNull()?.timestamp != crumbs.last().timestamp) out.add(crumbs.last())
    return out
}

/** Slim ISO-8601 → epoch ms. Returns 0 on parse failure (caller treats 0 as "unknown"). */
private fun parseIsoEpochMs(iso: String): Long = runCatching {
    if (iso.length < 19) return@runCatching 0L
    val y  = iso.substring(0, 4).toInt()
    val mo = iso.substring(5, 7).toInt()
    val d  = iso.substring(8, 10).toInt()
    val h  = iso.substring(11, 13).toInt()
    val mi = iso.substring(14, 16).toInt()
    val s  = iso.substring(17, 19).toInt()
    val days = daysFromCivilLocal(y, mo, d)
    days * 86_400_000L + h * 3_600_000L + mi * 60_000L + s * 1_000L
}.getOrDefault(0L)

private fun daysFromCivilLocal(y: Int, m: Int, d: Int): Long {
    val yy = if (m <= 2) y - 1 else y
    val era = if (yy >= 0) yy / 400 else (yy - 399) / 400
    val yoe = (yy - era * 400).toLong()
    val mp = if (m > 2) m - 3 else m + 9
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097L + doe - 719_468L
}
