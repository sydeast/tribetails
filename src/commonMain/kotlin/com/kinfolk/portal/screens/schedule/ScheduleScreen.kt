package com.kinfolk.portal.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinCalendarBadge
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinTintPill
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingStatus
import com.kinfolk.portal.portal.BookingsResult
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.calendarBadge
import com.kinfolk.portal.util.relativeTime
import kotlinx.coroutines.launch
import kotlin.time.Clock

/**
 * Schedule list, styled per ui-ideas/mytribe-schedule-2026-05-31.html: page
 * head ("Your schedule" + Request a Booking CTA), grouped glass section cards
 * (Upcoming bookings / Past Visits / Visit Replays) with calendar-tile rows
 * and tinted status chips, and the "Good to know" aside. Wide (>= 880dp,
 * shell breakpoint): two columns 1.6fr/1fr like Home; narrow: one column.
 *
 * Detail drill-downs stay lifted into nav: tapping a visit emits
 * [onOpenKinCare] (visitId, batchId), an envelope emits [onOpenEnvelope]
 * (batchId), and "Request a Booking" emits [onOpenWizard]. The list
 * re-fetches via [reloadSignal] (the host bumps it from the back-stack dirty
 * flag), mirroring the old "reload on back" semantics.
 */
@Composable
fun ScheduleScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    firestoreClient: com.kinfolk.portal.firebase.FirestoreClient,
    onOpenKinCare: (visitId: String, batchId: String?) -> Unit = { _, _ -> },
    onOpenEnvelope: (batchId: String) -> Unit = {},
    onOpenWizard: () -> Unit = {},
    onOpenMessageAuntie: () -> Unit = {},
    onOpenRecurring: () -> Unit = {},
    reloadSignal: Int = 0,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<BookingsResult?>(null) }
    var visits by remember { mutableStateOf<com.kinfolk.portal.portal.VisitsResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var showRequest by remember { mutableStateOf(false) }

    suspend fun reload() {
        try {
            data = portalApi.getMyBookings(kinfolkId)
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load schedule"
        }
        // GPS-aware visit list lives on AuntieOS-side `kin_care_sessions` and is
        // best-effort — failures don't block the upcoming/recent bookings render.
        try {
            visits = portalApi.getMyVisits(kinfolkId, limit = 10)
        } catch (_: Throwable) { /* leave null; replay simply hides */ }
    }

    // Re-fetch on first load and whenever a mutating detail returns (the host
    // bumps reloadSignal off the back-stack dirty flag), reproducing the old
    // reload-on-back behavior after a saved note or new booking.
    LaunchedEffect(kinfolkId, reloadSignal) { reload() }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            // Page head: serif greeting + the primary booking CTA (mockup pagehead).
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("SCHEDULE", style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange))
                    Spacer(Modifier.height(KinfolkSpacing.xs))
                    Text(
                        buildAnnotatedString {
                            append("Your ")
                            withStyle(SpanStyle(color = KinfolkBrand.PackPink)) { append("schedule") }
                        },
                        style = type.heritageDisplay.copy(fontWeight = FontWeight.Normal),
                    )
                }
                KinButton(label = "Request a Booking", onClick = onOpenWizard)
            }

            val mainColumn: @Composable () -> Unit = {
                UpcomingCard(
                    data = data,
                    error = error,
                    envelopeOn = true,
                    onOpenKinCare = onOpenKinCare,
                    onOpenEnvelope = onOpenEnvelope,
                )

                // Active visit (status ARRIVED on AuntieOS) — live polyline grows as
                // new GPS pings land. Hides when no active visit.
                val activeVisit = visits?.visits.orEmpty().firstOrNull {
                    it.status.equals("ARRIVED", ignoreCase = true)
                }
                if (activeVisit != null) {
                    Text("Auntie's On Her Way / At Your Place", style = type.heritageSection)
                    LiveVisitCard(visit = activeVisit, firestoreClient = firestoreClient)
                }

                PastVisitsCard(data = data, onOpenKinCare = onOpenKinCare)

                // Visit replays — surfaced separately because they come from
                // AuntieOS-side `kin_care_sessions` (GPS source of truth), not the
                // family-scoped bookings collection. Only renders with a route.
                val replayCandidates = visits?.visits.orEmpty().filter { it.gpsRoute.isNotEmpty() }
                if (replayCandidates.isNotEmpty()) {
                    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
                        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                            SectLabel("VISIT REPLAYS")
                            replayCandidates.forEach { v ->
                                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                    Text(v.serviceType ?: "Kin Care Visit", style = type.heritageTitle)
                                    Text((v.departedAtIso ?: v.startTimeIso).orEmpty(), style = type.sansLabel)
                                    com.kinfolk.portal.components.RouteMap(
                                        route           = v.gpsRoute,
                                        distanceMeters  = v.gpsDistanceMeters,
                                        durationSeconds = v.gpsDurationSeconds,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // "Good to know" aside. Both actions are REAL (16.4 Message Auntie,
            // 16.3 recurring visit): each opens its live flow. Recurring visits are
            // not a contract; the Auntie confirms each visit.
            val asideColumn: @Composable () -> Unit = {
                GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.l)) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        Text("Good to know", style = type.heritageSection)
                        KinGhostButton(
                            label = "Message Auntie",
                            onClick = onOpenMessageAuntie,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        KinGhostButton(
                            label = "Set up a recurring visit",
                            onClick = onOpenRecurring,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Recurring visits aren't a contract. Your Auntie confirms each week before it locks in.",
                            style = type.sansMeta,
                        )
                    }
                }
            }

            if (wide) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(modifier = Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        mainColumn()
                    }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        asideColumn()
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                ) {
                    mainColumn()
                    asideColumn()
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }

    if (showRequest) {
        RequestBookingDialog(
            onDismiss = { showRequest = false },
            onSubmit = { service, notes ->
                showRequest = false
                scope.launch {
                    try {
                        portalApi.requestBooking(
                            kinfolkId = kinfolkId,
                            serviceType = service,
                            startTimeMs = Clock.System.now().toEpochMilliseconds() + 24 * 60 * 60 * 1000L,
                            notes = notes.takeIf { it.isNotBlank() },
                        )
                        reload()
                    } catch (t: Throwable) {
                        error = t.message ?: "Could not submit request"
                    }
                }
            },
        )
    }
}

// ---- Section cards ----

@Composable
private fun UpcomingCard(
    data: BookingsResult?,
    error: String?,
    envelopeOn: Boolean,
    onOpenKinCare: (visitId: String, batchId: String?) -> Unit,
    onOpenEnvelope: (batchId: String) -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("UPCOMING BOOKINGS")
            when {
                error != null -> CardEmpty(title = "Couldn't load schedule", message = error)
                data == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }
                data.upcoming.isEmpty() -> CardEmpty(
                    title = "No upcoming bookings",
                    message = "Request your first booking below or wait for your Auntie to confirm one.",
                )
                envelopeOn -> {
                    // Group upcoming KinCares by their parent envelope. A batch with
                    // a single visit drills straight into KinCareDetail; multi-visit
                    // batches open the BookingEnvelopeScreen. KinCares with no
                    // batchId (legacy/back-compat) fall back to one row each.
                    val groups = data.upcoming.groupBy { it.batchId }
                    var index = 0
                    groups.forEach { (batchId, kinCares) ->
                        if (batchId == null || kinCares.size == 1) {
                            kinCares.forEach { b ->
                                if (index > 0) RowDivider()
                                VisitRow(b, index++, onClick = { onOpenKinCare(b.id, b.batchId) })
                            }
                        } else {
                            if (index > 0) RowDivider()
                            EnvelopeRow(kinCares, index++, onClick = { onOpenEnvelope(batchId) })
                        }
                    }
                }
                else -> data.upcoming.forEachIndexed { i, b ->
                    if (i > 0) RowDivider()
                    VisitRow(b, i, onClick = { onOpenKinCare(b.id, b.batchId) })
                }
            }
        }
    }
}

@Composable
private fun PastVisitsCard(
    data: BookingsResult?,
    onOpenKinCare: (visitId: String, batchId: String?) -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("PAST VISITS")
            when {
                data == null -> Spacer(Modifier.height(KinfolkSpacing.s))
                data.recent.isEmpty() -> CardEmpty(
                    title = "No past visits",
                    message = "Completed visits will live here.",
                )
                else -> data.recent.forEachIndexed { i, b ->
                    if (i > 0) RowDivider()
                    VisitRow(b, i, onClick = { onOpenKinCare(b.id, b.batchId) })
                }
            }
        }
    }
}

// ---- Rows ----

/** Calendar-tile accents cycle orange → purple → teal like the mockup. */
private val VisitAccents = listOf(
    KinfolkBrand.KinfolkOrange,
    KinfolkBrand.FamilyPurple,
    KinfolkBrand.KinTeal,
)

@Composable
private fun VisitRow(b: Booking, index: Int, onClick: (() -> Unit)? = null) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .let { if (onClick != null) it.clickable { onClick() } else it }
            .padding(horizontal = KinfolkSpacing.xs, vertical = KinfolkSpacing.s),
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KinCalendarBadge(calendarBadge(b.startTimeMs), accent = VisitAccents[index % VisitAccents.size])
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val title = b.title ?: b.serviceType ?: "Booking"
            if (b.serviceType != null && b.title != null) {
                Text("SERVICE TYPE · ${b.serviceType.uppercase()}", style = type.sansMeta.copy(fontSize = 10.sp))
            }
            Text(title, style = type.sansBody.copy(fontWeight = FontWeight.SemiBold))
            Text(relativeTime(b.startTimeMs), style = type.sansLabel)
            val parts = listOfNotNull(
                b.auntieDisplayName,
                b.kinNames.takeIf { it.isNotEmpty() }?.joinToString(", "),
                b.notes,
            )
            if (parts.isNotEmpty()) {
                Text(parts.joinToString(" • "), style = type.sansMeta)
            }
            if (b.cancelRequested) {
                Text(
                    "Cancellation requested",
                    style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                )
            }
        }
        StatusChip(b.status)
    }
}

@Composable
private fun EnvelopeRow(kinCares: List<Booking>, index: Int, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    val head = kinCares.firstOrNull()
    val count = kinCares.size
    val nextStart = kinCares.mapNotNull { it.startTimeMs }.minOrNull()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.xs, vertical = KinfolkSpacing.s),
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KinCalendarBadge(calendarBadge(nextStart), accent = VisitAccents[index % VisitAccents.size])
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(head?.serviceType ?: head?.title ?: "Booking", style = type.sansBody.copy(fontWeight = FontWeight.SemiBold))
            Text("$count visits", style = type.sansLabel.copy(color = KinfolkBrand.KinTeal))
            Text("Next ${relativeTime(nextStart)}", style = type.sansMeta)
        }
        KinTintPill("ENVELOPE", KinfolkBrand.KinTeal)
    }
}

@Composable
private fun StatusChip(status: BookingStatus) {
    val (label, color) = when (status) {
        BookingStatus.Requested -> "REQUESTED" to KinfolkBrand.KinfolkOrange
        BookingStatus.Confirmed -> "CONFIRMED" to KinfolkBrand.KinfolkOrange
        BookingStatus.EnRoute -> "EN ROUTE" to KinfolkBrand.PackPink
        BookingStatus.Active -> "ACTIVE" to KinfolkBrand.SnuggleCoral
        BookingStatus.Completed -> "COMPLETED" to KinfolkBrand.FamilyPurple
        BookingStatus.Cancelled -> "CANCELLED" to KinfolkBrand.NavyMuted
    }
    KinTintPill(label, color)
}

// ---- Shared bits ----

@Composable
private fun SectLabel(text: String) {
    val type = LocalKinfolkTypography.current
    Text(text, style = type.sansMeta, modifier = Modifier.padding(bottom = KinfolkSpacing.xs))
}

@Composable
private fun RowDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KinfolkSpacing.xs)
            .height(1.dp)
            .background(KinfolkBrand.NavyHairline),
    )
}

/** In-card empty state, mockup `.empty`: centered serif title + muted note. */
@Composable
private fun CardEmpty(title: String, message: String) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Text(title, style = type.heritageSection)
        Text(
            message,
            style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
            modifier = Modifier.padding(horizontal = KinfolkSpacing.m),
        )
    }
}

@Composable
private fun RequestBookingDialog(
    onDismiss: () -> Unit,
    onSubmit: (serviceType: String, notes: String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var service by remember { mutableStateOf("Drop-in Visit") }
    var notes by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Request a Booking", style = type.heritageTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text(
                    "Tell your Auntie what you need. She'll review and confirm a time.",
                    style = type.sansBody,
                )
                KinField(
                    value = service,
                    onValueChange = { service = it },
                    label = "Service Type",
                )
                KinField(
                    value = notes,
                    onValueChange = { notes = it },
                    label = "Notes (optional)",
                    singleLine = false,
                )
            }
        },
        confirmButton = {
            KinButton(
                label = "Send Request",
                onClick = { onSubmit(service.trim(), notes.trim()) },
                enabled = service.isNotBlank(),
            )
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

/**
 * Live tracking card for the active visit. Subscribes to the
 * `kin_care_sessions/{visit.id}/breadcrumbs` subcollection via gitlive Firestore
 * so the polyline grows as Auntie sends new GPS pings.
 */
@Composable
private fun LiveVisitCard(
    visit: com.kinfolk.portal.portal.Visit,
    firestoreClient: com.kinfolk.portal.firebase.FirestoreClient,
) {
    val type = LocalKinfolkTypography.current
    val live by remember(visit.id) { firestoreClient.breadcrumbsStream(visit.id) }
        .collectAsState(initial = emptyList())

    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text(visit.serviceType ?: "Visit in progress", style = type.heritageTitle)
            Text(
                if (live.isEmpty()) "Waiting for first GPS ping…" else "${live.size} pings · live",
                style = type.sansLabel,
            )
            if (live.isNotEmpty()) {
                com.kinfolk.portal.components.RouteMap(route = live)
            }
        }
    }
}
