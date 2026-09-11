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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

/**
 * ISSUE #582: the exact patch Undo Arrival writes.
 *
 * Pulled out of the composable so the field set is testable without a Compose
 * runtime, the way the desktop console's `kinCarePatch` already is.
 *
 * The three arrival-location fields are cleared alongside `arrivedAt` because
 * the evidence belongs to the arrival being undone. Left behind, the next
 * arrival — quite possibly at a different door, quite possibly offline and so
 * with no measurement of its own — inherits it, and wrong evidence can refuse a
 * COMPLETE that should pass as easily as pass one that should be refused.
 *
 * ISSUE #608: `departedAt` is cleared for the same reason, one field further
 * on. Undo is offered from DEPARTED as well as ARRIVED, so leaving it produced
 * a session whose status said it had not started and whose document still
 * carried the moment it ended. `missingVisitSteps`
 * (`functions/src/lib/arrivalVerification.ts`) reads `arrivedAt` and
 * `departedAt` together to gate a COMPLETE, so the stale half let a later
 * re-arrival complete against a departure the operator had explicitly undone —
 * and invoicing, KinTale timing and the household's record of when their Auntie
 * left all inherited that wrong time. The web path
 * (`admin/setVisitLifecycle.ts`) has cleared both since PR #606 and carried a
 * comment saying Android should follow. This is Android following.
 *
 * NOT cleared, deliberately: `onMyWayAt`, which is what chooses the undo target
 * (`ON_MY_WAY` when set, `SCHEDULED` when not) and so is the leg being rewound
 * TO; `completedAt`, unreachable because undo is only offered from ARRIVED and
 * DEPARTED; and `etaMinutesAway`, left alone to match the web path.
 *
 * Cleared to `""` rather than removed, matching `arrivedAt`: the server reads a
 * non-numeric value on those fields as "no evidence" (`readArrivalEvidence`),
 * which is exactly the state an undone arrival should be in, and every reader
 * that does `.take(10)` or `.trim()` on a timestamp keeps working.
 */
internal fun undoArrivalPatch(undoTo: String): Map<String, Any> = mapOf(
    "status" to undoTo,
    "arrivedAt" to "",
    "departedAt" to "",
    "arrivalDistanceMeters" to "",
    "arrivalAccuracyMeters" to "",
    "arrivalLocationCheckedAt" to "",
)

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
// Auntie Time, the day-of run screen, drawn to
// `ui-ideas/auntieos-auntie-time-2026-05-27.html` (the operator's ruling in
// #703: the mock is the spec, and #755 is the fidelity pass against it). Mono
// kicker + serif heading, then four phase groups, each a mono label with a
// count chip over a stack of glass action cards (AuntieIconTile or the kin
// photos, the household in the serif, one "service · kin · when" line, the
// AuntieStatusPill, GPS line, address chip, note, invoice chip, lifecycle row).
//
// GONE SINCE #755, because the mock has none of them and the web board dropped
// them in #703: the three-card StatRow, the soonest/latest sort chips, and the
// whole-board EmptyState that replaced the four groups when the window was
// empty. The groups render whatever the data says, count chips and all, and a
// single line under them says the window is empty on purpose. Drives entirely
// off the existing AdminDataViewModel UiState; preserves the visit-lifecycle
// actions, the office-note flow, the GPS foreground-service bits, and the
// fail-loud banners.
// ─────────────────────────────────────────────────────────────────────────────

private enum class Phase(val label: String) {
    Active("Active"),
    // issue #702: a SCHEDULED visit whose slot already passed gets its own
    // phase, between Active and Upcoming, rather than being dropped outright.
    Overdue("Overdue"),
    Upcoming("Upcoming"),
    CompletedToday("Recent"),
}

/**
 * What an EMPTY phase group says, per phase, word for word the web board's
 * `PHASE_EMPTY`. The count chip beside the heading already reads 0; each line
 * answers what the chip cannot, which is what the group covers.
 */
private fun phaseEmptyLine(phase: Phase): String = when (phase) {
    Phase.Active -> "No visit is in flight."
    Phase.Overdue -> "No scheduled visit has slipped past its slot."
    Phase.Upcoming -> "Nothing booked in the next $UPCOMING_WINDOW_DAYS days."
    Phase.CompletedToday -> "Nothing wrapped today or yesterday."
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

    // A run sheet reads forwards: ascending by start within each phase. The
    // soonest/latest sort control #17 added is gone since #755 (the mock has
    // no sort, and the web board dropped its Sort select in #703).
    val grouped = visible
        .groupBy { phaseFor(it, today) }
        .mapValues { (_, rows) -> sortSessions(rows) }

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
                    // The mock's own heading, paw and all, and with no italic accent
                    // tail: the Directory mock marks its last word up, this one does
                    // not. Same title string as the web board. The subtitle is the
                    // info button's tooltip (the #758 ruling), never a line of copy.
                    // This screen OWNS the "today's route / active visits / upcoming care
                    // windows" framing (spec 13 item 1 / spec 14): the route map (§A.10)
                    // renders below on the in-flight card; the phases cover the rest.
                    DenScreenHeading(
                        kicker = "The Den · Auntie Time",
                        title = "🐾 Auntie Time",
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

                        else -> {
                            // ISSUE #703: every phase renders, empty ones
                            // included. The guard here used to be
                            // `if (items.isNotEmpty())`, which is the same thing
                            // web's `groupSessionsByPhase` was doing when it
                            // dropped empty groups: a phase with nothing in it
                            // had nothing to say, so the board said nothing at
                            // all and read as broken. The mock draws all four
                            // with their count chips whatever the data says, and
                            // a chip that reads 0 is an answer. #755 extends the
                            // same rule to the whole board: an empty window no
                            // longer swaps the four groups for one empty state.
                            Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                                Phase.entries.forEach { phase ->
                                    val items = grouped[phase].orEmpty()
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

                            // Under a board that is genuinely holding nothing. The
                            // four groups above have already said each phase is
                            // empty; this says that is not a fault. DRAFT and
                            // PENDING bookings are the Bookings screen's queue by
                            // design, so an empty window here is where a new
                            // booking sits until it is approved.
                            if (visible.isEmpty()) {
                                Spacer(Modifier.height(16.dp))
                                Text(
                                    text = "Nothing on the books in this window. New bookings land " +
                                        "here once you approve them on the Bookings screen.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
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

// ── Phase group ─────────────────────────────────────────────────────────────────

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
    // The mock's `.phlab`: a mono uppercase label with the count in a small
    // capsule beside it, over a bare stack of cards. Not a DenPanel: the mock
    // draws no panel around a phase (the cards are the glass), and the web board
    // dropped its panel wrapper in #703 for the same reason.
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(11.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text(
                text = phase.label.uppercase(),
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.3.sp),
                color = c.textPrimary,
                // A heading, so TalkBack can hop phase to phase the way the web
                // board's `h3` lets a screen reader.
                modifier = Modifier.semantics { heading() },
            )
            AuntieStatusPill(
                label = count.toString(),
                tone = AuntieStatusTone.Neutral,
                mono = true,
            )
        }
        if (sessions.isEmpty()) {
            // An empty phase keeps its heading, because the count chip beside it
            // is the answer. This line only says the group is empty ON PURPOSE.
            Text(
                text = phaseEmptyLine(phase),
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                sessions.forEach { session ->
                    val kinfolk = kinfolkById(session.kinfolkId)
                    KinCareCard(
                        session = session,
                        todayIso = todayIso,
                        address = kinfolk?.serviceAddress.orEmpty(),
                        phone = kinfolk?.phoneNumber.orEmpty(),
                        email = kinfolk?.email.orEmpty(),
                        kinAvatars = com.tribetails.auntieos.domain.kinAvatarsForSession(session, kinById),
                        kinNames = kinNamesForSession(session, kinById),
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
}

/**
 * The kin this visit covers, by name, for the card's identity line. The same
 * id resolution `kinAvatarsForSession` uses (the `kinIds` list, else the older
 * single `kinId`), so the names and the photo circles always describe the same
 * animals. A kin the directory has not loaded yet drops out rather than
 * rendering as a blank between two separators.
 */
private fun kinNamesForSession(
    session: KinCareSession,
    kinById: Map<String, com.tribetails.auntieos.data.model.Kin>,
): List<String> {
    val ids = if (session.kinIds.isNotEmpty()) session.kinIds
              else listOfNotNull(session.kinId.ifBlank { null })
    return ids.mapNotNull { kinById[it]?.name?.trim()?.ifBlank { null } }
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
    /** The kin by name, in the same order as [kinAvatars]. */
    kinNames: List<String>,
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
            // ---- Header: kin photos (or the status tile) + identity + status pill ----
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
                // The mock leads the row with the kin's photo circles and falls
                // back to the toned status tile only when no kin resolves (never a
                // placeholder face). The two stand in the same slot; #755 moved
                // the stack here from after the identity column, where it used to
                // sit beside a tile that was always drawn.
                if (kinAvatars.isNotEmpty()) {
                    AuntieAvatarStack(
                        avatars = kinAvatars.map { AvatarSpec(imageUrl = it.imageUrl.ifBlank { null }, initials = it.initials) },
                        max = 3,
                        avatarSize = 34.dp,
                        overlap = 10.dp,
                    )
                } else {
                    AuntieIconTile(
                        icon = statusGlyph(session.status),
                        size = 42.dp,
                        tone = tone,
                    )
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    // Mock `.id b`: the household in the serif.
                    Text(
                        text = session.kinfolkName.ifBlank { "Unnamed Kinfolk" },
                        style = AuntieTheme.typography.titleLarge,
                        color = c.textPrimary,
                    )
                    // Mock `.svc`: ONE dim line, "service · kin · when", with the
                    // Business-Settings time block (§A.8) as its last part. It used
                    // to be a service pill, a clock, and a separate block pill; the
                    // mock writes all of it as one sentence.
                    Text(
                        text = auntieTimeIdentityLine(
                            service = session.serviceType,
                            kinNames = kinNames,
                            window = sessionWindow(session, todayIso),
                            timeBlockLabel = timeBlockLabel,
                        ),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                // The mock's card-row `.pill` is 9.5px: the kit's compact size
                // (#780), where the default capsule sat larger on the card.
                AuntieStatusPill(
                    label = statusLabel(session.status),
                    tone = tone,
                    mono = true,
                    compact = true,
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
                        // #582: the arrival-location evidence belongs to the
                        // arrival being undone. Left behind, the next arrival —
                        // quite possibly at a different door, quite possibly
                        // offline and so with no measurement of its own —
                        // inherits it, and wrong evidence can refuse a COMPLETE
                        // that should pass as easily as pass one that should be
                        // refused. Cleared to "" the way `arrivedAt` already is:
                        // the server reads a non-numeric value on those fields
                        // as no evidence.
                        onPatch(undoArrivalPatch(undoTo), "Arrival undone.")
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

// ── Status mapping ────────────────────────────────────────────────────────────────

/**
 * Maps a session status to the Den status tone, the mock's own pill palette
 * state by state and the twin of web's `SESSION_STATE_TONE`. Completed is
 * teal, not success green: the mock paints a wrap in the same hue as an
 * arrival, one shade quieter, and the label is what tells them apart.
 */
private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "ON_MY_WAY" -> AuntieStatusTone.Orange
    "ARRIVED" -> AuntieStatusTone.Teal
    "DEPARTED" -> AuntieStatusTone.Purple
    "COMPLETED" -> AuntieStatusTone.Teal
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

/**
 * [today] as "YYYY-MM-DD", needed since #702 to tell Overdue from Upcoming.
 * A positive match against COMPLETED/CANCELLED for Recent, same as
 * [isVisibleOnAuntieTime]'s own WRAPPED_STATUSES; a status code no writer
 * produces today is therefore never swept into Recent by elimination, it is
 * placed by its date like SCHEDULED (matching web's `sessionPhase`).
 */
private fun phaseFor(s: KinCareSession, today: String): Phase = when {
    s.status.uppercase() in setOf("ON_MY_WAY", "ARRIVED", "DEPARTED") -> Phase.Active
    s.status.uppercase() in setOf("COMPLETED", "CANCELLED") -> Phase.CompletedToday
    isOverdueScheduled(s, today) -> Phase.Overdue
    else -> Phase.Upcoming
}

/**
 * The window, order and date-label rules live in `AuntieTimeWindow.kt` (Recent
 * is today or yesterday per the mock, the year shows outside the current one,
 * each phase reads forwards by start time, and the identity line is built
 * there too). They are pure functions with their own unit tests; this file
 * stays the Composable.
 */

