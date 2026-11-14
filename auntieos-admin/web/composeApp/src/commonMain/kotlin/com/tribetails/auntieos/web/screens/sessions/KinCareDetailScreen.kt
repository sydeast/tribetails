package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.HousePlus
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPinned
import com.composables.icons.lucide.NotebookPen
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.ShieldAlert
import com.composables.icons.lucide.Wifi
import com.tribetails.auntieos.web.data.Breadcrumb
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kin411
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.emergencyContactsOf
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.KeyValueStyle
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.NotFoundNotice
import com.tribetails.auntieos.web.ui.components.rememberReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.util.openInMaps
import kotlinx.datetime.TimeZone
import com.tribetails.auntieos.web.util.businessTimeZone

/**
 * Operational detail for one Kin Care. Auntie taps into this from the Auntie
 * Time row body - it's the in-the-field reference card she pulls up while
 * standing at the door or mid-visit. Action buttons live on the *list* row,
 * not here; this screen is read-only context.
 *
 * Den redesign: a warm-editorial hero (kin photos + status pill), a visit
 * lifecycle timeline rail, dual note boxes (kinfolk-facing vs admin-internal),
 * and a details key/value list. All field wiring is unchanged from the prior
 * version; the layout now mirrors `ui-ideas/auntieos-kincare-detail-2026-05-27.html`.
 */
@Composable
fun KinCareDetailScreen(
    kinCareId: String,
    onBack: () -> Unit,
) {
    val client = remember { FirestoreClient() }
    val reload = rememberReloadableRead()
    val sessions by remember(reload.generation) { client.sessionsStream().settlesRetry(reload) }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolks by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val reports  by remember { client.reportsStream() }.collectAsState(initial = FirestoreResult.Loading)
    // #1580: the internal notes' dates read on the business clock, like the booking sheet's.
    val settings by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val businessZone = com.tribetails.auntieos.web.screens.booking.NewBookingMath.businessTimeZone(
        (settings as? FirestoreResult.Data)?.value?.timeZone,
    )

    val session = remember(sessions, kinCareId) {
        (sessions as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinCareId }
    }
    val kinfolk = remember(kinfolks, session) {
        val id = session?.kinfolkId ?: return@remember null
        (kinfolks as? FirestoreResult.Data)?.value?.firstOrNull { it._id == id }
    }
    val sessionReports = remember(reports, kinCareId) {
        ((reports as? FirestoreResult.Data)?.value.orEmpty())
            .filter { it.sessionId == kinCareId }
            .sortedByDescending { it.sentAt.ifBlank { it.createdAt } }
    }

    // Stream the household's kin so we can show real names alongside the per-kin 411.
    val kinForKinfolk by remember(session?.kinfolkId) {
        (session?.kinfolkId?.takeIf { it.isNotBlank() }?.let { client.kinStream(it) }
            ?: kotlinx.coroutines.flow.flowOf(FirestoreResult.Data(emptyList<Kin>())))
    }.collectAsState(initial = FirestoreResult.Loading)
    val kinById: Map<String, Kin> = remember(kinForKinfolk) {
        ((kinForKinfolk as? FirestoreResult.Data)?.value.orEmpty()).associateBy { it._id }
    }

    ScreenScaffold {
        if (session == null) {
            // #867: a failed read shows its error, not a shimmer that never ends.
            (sessions as? FirestoreResult.Error)?.let {
                SectionHeader(title = "KinCare", subtitle = "", icon = Lucide.PawPrint, onBack = onBack)
                LoadErrorBanner("Couldn't load this KinCare", it.message, onRetry = reload::retry, retrying = reload.retrying)
                return@ScreenScaffold
            }
            // #898: the read answered and this id is not in it (deleted, or a
            // stale link), distinct from still-loading, which used to shimmer forever.
            if (sessions is FirestoreResult.Data) {
                SectionHeader(title = "KinCare", subtitle = "", icon = Lucide.PawPrint, onBack = onBack)
                NotFoundNotice("This KinCare couldn't be found. It may have been removed.", onBack = onBack)
                return@ScreenScaffold
            }
            SectionHeader(title = "Loading…", subtitle = "Pulling KinCare detail", icon = Lucide.PawPrint)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(4) { ShimmerCard(height = 72.dp) }
            }
            return@ScreenScaffold
        }

        // ---- Breadcrumb trail: Schedule / <window> / <kinfolk> ----
        SectionHeader(
            title    = session.kinfolkName.ifBlank { "KinCare" },
            subtitle = listOfNotNull(
                session.serviceType.takeIf { it.isNotBlank() }?.let { com.tribetails.auntieos.web.screens.LocalServiceCatalog.current.nameOf(it) },
                sessionWindowFor(session),
            ).joinToString(" · "),
            icon     = Lucide.PawPrint,
            onBack   = onBack,
            breadcrumbs = listOfNotNull(
                "Schedule",
                shortIso(session.startTime).takeIf { it.isNotBlank() },
                session.kinfolkName.takeIf { it.isNotBlank() },
            ),
        )

        GhostButton(label = "Back to Auntie Time", onClick = onBack, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(20.dp))

        // ---- Hero: kin photos + title + window + address + status pill ----
        val ids = (session.kinIds + listOf(session.kinId)).filter { it.isNotBlank() }.distinct()
        HeroPanel(
            session  = session,
            kinfolk  = kinfolk,
            kinById  = kinById,
            kinIds   = ids,
        )
        Spacer(Modifier.height(18.dp))

        // ---- Visit lifecycle timeline ----
        DenPanel {
            PanelHeading("Visit lifecycle", Lucide.Clock)
            Spacer(Modifier.height(6.dp))
            LifecycleRail(session)
        }
        Spacer(Modifier.height(18.dp))

        // ---- Dual note boxes: kinfolk-facing + admin-internal ----
        DenPanel {
            PanelHeadingWithTag(
                title  = "Kinfolk-facing note",
                icon   = Lucide.NotebookPen,
                tag    = listOfNotNull(
                    "visible to",
                    session.kinfolkName.takeIf { it.isNotBlank() },
                ).joinToString(" ").ifBlank { "visible to the kinfolk" },
                tone   = AuntieStatusTone.Purple,
            )
            Spacer(Modifier.height(10.dp))
            if (session.kinfolkNotes.isNotBlank()) {
                AuntieNoteCallout(text = session.kinfolkNotes, dashed = false, italic = false)
            } else {
                AuntieNoteCallout(text = "No kinfolk-facing note for this KinCare.", dashed = true, italic = true)
            }
            Spacer(Modifier.height(10.dp))
            // Cutoff hint mirrors the booking-notes "editable until 3h before visit" rule.
            CutoffHint(session)
        }
        Spacer(Modifier.height(18.dp))

        // #1580: the visit's one internal-notes list, the same one the booking
        // sheet, web and Android show. This box used to show the session's own
        // notes text only ("Admin-internal note"), a second store.
        com.tribetails.auntieos.web.screens.schedule.VisitInternalNotesPanel(client = client, sessionId = session._id, zone = businessZone)
        Spacer(Modifier.height(18.dp))
        // ---- Details key/value list ----
        DenPanel {
            PanelHeading("Details", Lucide.PawPrint)
            Spacer(Modifier.height(6.dp))
            session.serviceType.takeIf { it.isNotBlank() }?.let {
                AuntieKeyValueRow(label = "Service", value = com.tribetails.auntieos.web.screens.LocalServiceCatalog.current.nameOf(it))
            }
            // #1581: a stored 0 falls back to the visit's own window.
            shownVisitLengthMinutes(session.serviceDurationMinutes, session.startTime, session.endTime)?.let {
                AuntieKeyValueRow(label = "Duration", value = "$it min")
            }
            AuntieKeyValueRow(label = "Window", value = sessionWindowFor(session))
            AuntieKeyValueRow(
                label = "Status",
                showDivider = true,
                trailing = {
                    AuntieStatusPill(
                        label = statusLabel(session.status),
                        tone  = statusTone(session.status),
                        showDot = true,
                        mono  = true,
                    )
                },
            )
            session.invoiceId.takeIf { it.isNotBlank() }?.let {
                AuntieKeyValueRow(label = "Invoice", value = it, valueMono = true)
            }
            session.sourceBookingId.takeIf { it.isNotBlank() }?.let {
                AuntieKeyValueRow(label = "Booked from", value = it, valueMono = true)
            }
            AuntieKeyValueRow(
                label = "KinTales sent",
                value = session.sentReportCount.toString(),
                valueStyle = if (session.sentReportCount > 0) KeyValueStyle.AccentSuccess else KeyValueStyle.Muted,
                showDivider = false,
            )
        }
        Spacer(Modifier.height(18.dp))

        // ---- Address + map link (kept from the field-reference card) ----
        if (kinfolk != null && kinfolk.serviceAddress.isNotBlank()) {
            DenPanel {
                PanelHeading("Address", Lucide.MapPinned)
                Spacer(Modifier.height(6.dp))
                AddressBlock(kinfolk.serviceAddress)
            }
            Spacer(Modifier.height(18.dp))
        }

        // ---- Household access (the "I'm at the front door" reference) ----
        if (kinfolk != null) {
            val anyAccessInfo = listOf(
                kinfolk.gateCode, kinfolk.parkingInstructions, kinfolk.entryNotes,
                kinfolk.wifiName, kinfolk.wifiPassword,
            ).any { it.isNotBlank() }
            if (anyAccessInfo) {
                DenPanel {
                    PanelHeading("Household access", Lucide.KeyRound)
                    Spacer(Modifier.height(6.dp))
                    FactRow(Lucide.KeyRound,  label = "Gate / door code", value = kinfolk.gateCode)
                    FactRow(Lucide.HousePlus, label = "Parking",          value = kinfolk.parkingInstructions)
                    FactRow(Lucide.Wifi,      label = "Wi-Fi",            value = wifiSummary(kinfolk))
                    FactRow(Lucide.NotebookPen, label = "Entry notes",    value = kinfolk.entryNotes, multiline = true)
                }
                Spacer(Modifier.height(18.dp))
            }
        }

        // ---- Emergency contact ----
        // #829. One per household since 2026-09-27 (Q2); a household still
        // holding two from the earlier rule shows both.
        val emergencyContacts = kinfolk?.let { emergencyContactsOf(it) }.orEmpty()
        if (emergencyContacts.isNotEmpty()) {
            DenPanel {
                PanelHeading(if (emergencyContacts.size > 1) "Emergency Contacts" else "Emergency Contact", Lucide.ShieldAlert)
                Spacer(Modifier.height(6.dp))
                emergencyContacts.forEach { ec ->
                    FactRow(Lucide.ShieldAlert, label = "Name",         value = ec.name)
                    FactRow(Lucide.ShieldAlert, label = "Phone",        value = ec.phone)
                    FactRow(Lucide.ShieldAlert, label = "Relationship", value = ec.relationship.orEmpty())
                }
            }
            Spacer(Modifier.height(18.dp))
        }

        // ---- GPS route map (live while ARRIVED, replay once DEPARTED/COMPLETED) ----
        val statusUpper = session.status.uppercase()
        val showRoute = statusUpper in setOf("ARRIVED", "DEPARTED", "COMPLETED")
        if (showRoute) {
            val breadcrumbsState by remember(kinCareId) { client.breadcrumbsStream(kinCareId) }.collectAsState(initial = FirestoreResult.Loading)
            val crumbs: List<Breadcrumb> = (breadcrumbsState as? FirestoreResult.Data)?.value.orEmpty()
            DenPanel {
                PanelHeading(if (statusUpper == "ARRIVED") "Live route" else "Route replay", Lucide.MapPinned)
                Spacer(Modifier.height(6.dp))
                RouteMap(
                    breadcrumbs = crumbs,
                    live        = statusUpper == "ARRIVED",
                )
            }
            Spacer(Modifier.height(18.dp))
        }

        // ---- Kin in this household, with 411 snippet ----
        if (ids.isNotEmpty()) {
            DenPanel {
                PanelHeading("Kin in this care", Lucide.PawPrint)
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ids.forEach { kid -> KinDetailCard(kid, kinById[kid]) }
                }
            }
            Spacer(Modifier.height(18.dp))
        }

        // ---- KinTales sent so far for this Kin Care ----
        DenPanel {
            PanelHeading("KinTales sent", Lucide.NotebookPen)
            Spacer(Modifier.height(6.dp))
            if (sessionReports.isEmpty()) {
                EmptyHint("No KinTales sent yet during this KinCare.")
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    sessionReports.forEach { r -> KinTaleSnippet(r) }
                }
            }
        }
    }
}

// ---- Hero ------------------------------------------------------------------

@Composable
private fun HeroPanel(
    session: KinCareSession,
    kinfolk: Kinfolk?,
    kinById: Map<String, Kin>,
    kinIds: List<String>,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Warm radial wash from the top-left, the signature Den hero treatment.
    val washBrush = Brush.linearGradient(
        listOf(
            c.primary.copy(alpha = if (c.isDark) 0.22f else 0.14f),
            c.surfaceGlass,
        ),
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(washBrush)
            .border(dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .padding(20.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space4),
        ) {
            // Kin photos: overlapping circular avatars, one per kin in this care.
            if (kinIds.isNotEmpty()) {
                KinPhotos(kinIds = kinIds, kinById = kinById)
            } else {
                AuntieAvatar(glyph = Lucide.PawPrint, size = 52.dp, gradientSeed = session._id)
            }

            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    text  = heroTitle(session, com.tribetails.auntieos.web.screens.LocalServiceCatalog.current),
                    style = AuntieTheme.typography.headlineLarge,
                    color = c.textPrimary,
                )
                val subParts = listOfNotNull(
                    sessionWindowFor(session).takeIf { it.isNotBlank() },
                    session.kinfolkName.takeIf { it.isNotBlank() },
                    kinfolk?.serviceAddress?.takeIf { it.isNotBlank() },
                )
                if (subParts.isNotEmpty()) {
                    Text(
                        text  = subParts.joinToString(" · "),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            AuntieStatusPill(
                label = statusLabel(session.status),
                tone  = statusTone(session.status),
                showDot = true,
                glow  = session.status.uppercase() == "ARRIVED",
                mono  = true,
            )
        }
    }
}

@Composable
private fun KinPhotos(kinIds: List<String>, kinById: Map<String, Kin>) {
    // Overlapping avatars, drawn left-to-right with a slight negative offset to
    // mirror the mockup's stacked profile photos.
    val shown = kinIds.take(4)
    Row(horizontalArrangement = Arrangement.spacedBy((-16).dp)) {
        shown.forEach { kid ->
            val kin = kinById[kid]
            AuntieAvatar(
                imageUrl = null,
                initials = kin?.name?.take(2),
                glyph    = if (kin?.name.isNullOrBlank()) Lucide.PawPrint else null,
                size     = 52.dp,
                gradientSeed = kid,
            )
        }
    }
}

/** #1744: the household, then the KinCare's name, never the stored `visit_60`. */
internal fun heroTitle(s: KinCareSession, catalog: com.tribetails.auntieos.web.screens.ServiceCatalog): String {
    val name = s.kinfolkName.ifBlank { "KinCare" }
    return if (s.serviceType.isNotBlank()) "$name · ${catalog.nameOf(s.serviceType)}" else name
}

// ---- Lifecycle rail --------------------------------------------------------

@Composable
private fun LifecycleRail(session: KinCareSession) {
    val c = AuntieTheme.colors
    val statusUpper = session.status.uppercase()

    // Ordered lifecycle: SCHEDULED -> ON_MY_WAY -> ARRIVED -> DEPARTED -> COMPLETED.
    data class Step(val name: String, val iso: String, val statusKey: String)
    val steps = listOf(
        Step("Scheduled", session.startTime,   "SCHEDULED"),
        Step("On my way", session.onMyWayAt,   "ON_MY_WAY"),
        Step("Arrived",   session.arrivedAt,   "ARRIVED"),
        Step("Departed",  session.departedAt,  "DEPARTED"),
        Step("Completed", session.completedAt, "COMPLETED"),
    )
    val order = listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "DEPARTED", "COMPLETED")
    val currentIdx = order.indexOf(statusUpper).let { if (it < 0) 0 else it }

    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(0.dp),
        verticalAlignment = Alignment.Top,
    ) {
        steps.forEachIndexed { idx, step ->
            val done = idx < currentIdx || step.iso.isNotBlank() && idx < currentIdx
            val isNow = idx == currentIdx
            val completed = idx < currentIdx
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LifecycleNode(
                    completed = completed,
                    isNow = isNow,
                    connectorBefore = idx > 0,
                    connectorAfter = idx < steps.lastIndex,
                    connectorDoneBefore = idx <= currentIdx,
                    connectorDoneAfter = idx < currentIdx,
                )
                Text(
                    text  = step.name,
                    style = AuntieTheme.typography.titleSmall,
                    color = if (completed || isNow) c.textPrimary else c.textDim,
                )
                Text(
                    text  = if (step.iso.isNotBlank()) shortIsoTimeOnly(step.iso) else "-",
                    style = AuntieTheme.typography.mono,
                    color = c.textFaint,
                )
            }
        }
    }
}

@Composable
private fun LifecycleNode(
    completed: Boolean,
    isNow: Boolean,
    connectorBefore: Boolean,
    connectorAfter: Boolean,
    connectorDoneBefore: Boolean,
    connectorDoneAfter: Boolean,
) {
    val c = AuntieTheme.colors
    val nodeColor = when {
        completed -> c.accent
        isNow     -> c.primary
        else      -> c.surface2
    }
    val nodeBorder = when {
        completed -> c.accent
        isNow     -> c.primary
        else      -> c.border
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(28.dp)
            // Connector line behind the node, split into a left and right half so each
            // segment can independently read as done (teal) or pending (faint).
            .drawBehind {
                val cy = size.height / 2f
                val stroke = 2.dp.toPx()
                val halfW = size.width / 2f
                if (connectorBefore) {
                    drawLine(
                        color = if (connectorDoneBefore) c.accent else c.borderSoft,
                        start = Offset(0f, cy),
                        end   = Offset(halfW, cy),
                        strokeWidth = stroke,
                    )
                }
                if (connectorAfter) {
                    drawLine(
                        color = if (connectorDoneAfter) c.accent else c.borderSoft,
                        start = Offset(halfW, cy),
                        end   = Offset(size.width, cy),
                        strokeWidth = stroke,
                    )
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(if (isNow) 22.dp else 18.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(nodeColor.copy(alpha = if (completed || isNow) 1f else 0.25f).compositeOver(c.surface))
                .border(AuntieTheme.dims.borderEmphasis, nodeBorder, RoundedCornerShape(999.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (isNow) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(c.background),
                )
            }
        }
    }
}

// ---- Note cutoff hint ------------------------------------------------------

@Composable
private fun CutoffHint(session: KinCareSession) {
    val c = AuntieTheme.colors
    // Editable until 3h before the visit start, per the booking-notes rule.
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Lucide.Clock, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(14.dp))
        Text(
            text  = "Editable until 3h before the visit. You can edit on the kinfolk's behalf.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
    }
}

// ---- Kin detail card -------------------------------------------------------

@Composable
private fun KinDetailCard(kinId: String, kin: Kin?) {
    val client = remember(kinId) { FirestoreClient() }
    val info   by remember(kinId) { client.kin411Stream(kinId) }.collectAsState(initial = FirestoreResult.Loading)
    val c = AuntieTheme.colors

    val data = (info as? FirestoreResult.Data)?.value
    val loading = info is FirestoreResult.Loading

    if (loading && kin == null) {
        ShimmerCard(height = 72.dp)
        return
    }

    val title = kin?.name?.takeIf { it.isNotBlank() }
        ?: data?.breed?.takeIf { it.isNotBlank() }?.let { "Kin · $it" }
        ?: "Unnamed Kin"
    val sublineParts = buildList {
        kin?.species?.takeIf { it.isNotBlank() }?.let { add(it) }
        (kin?.breed?.ifBlank { data?.breed.orEmpty() } ?: data?.breed.orEmpty()).takeIf { it.isNotBlank() }?.let { add(it) }
        kin?.age?.takeIf { it.isNotBlank() }?.let { add(it) }
        kin?.sex?.takeIf { it.isNotBlank() }?.let { add(it) }
    }
    val reactive = kin?.reactive == true || data?.reactive == true

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieAvatar(
                initials = kin?.name?.take(2),
                glyph    = if (kin?.name.isNullOrBlank()) Lucide.PawPrint else null,
                size     = 30.dp,
                gradientSeed = kinId,
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(title, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                if (sublineParts.isNotEmpty()) {
                    Text(
                        text = sublineParts.joinToString(" · "),
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                    )
                }
            }
            if (reactive) {
                AuntieStatusPill(label = "Reactive", tone = AuntieStatusTone.Error)
            }
        }

        if (data == null) {
            EmptyHint("411 not on file for this kin yet.")
        } else {
            FactRow(Lucide.NotebookPen, label = "Personality", value = data.personality, multiline = true)
            FactRow(Lucide.NotebookPen, label = "Quirks",      value = data.quirksAndPreferences, multiline = true)
            FactRow(Lucide.NotebookPen, label = "Medical",     value = data.medicalNotes, multiline = true)
            FactRow(Lucide.NotebookPen, label = "Diet",        value = feedingSummary(data), multiline = true)
            FactRow(Lucide.NotebookPen, label = "Vet",         value = vetSummary(data))
            if (data.pottyRoutine.isNotBlank()) {
                FactRow(Lucide.NotebookPen, label = "Potty", value = data.pottyRoutine, multiline = true)
            }
        }
    }
}

private fun feedingSummary(k: Kin411): String {
    val parts = listOf(k.dietaryDetails, k.feedingAmount, k.feedingFrequency).filter { it.isNotBlank() }
    return parts.joinToString(" · ")
}

private fun vetSummary(k: Kin411): String {
    val parts = listOf(k.vetName, k.vetPhone).filter { it.isNotBlank() }
    return parts.joinToString(" · ")
}

@Composable
private fun KinTaleSnippet(report: KinCareReport) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieStatusPill(
                label = report.status.lowercase().replaceFirstChar { it.uppercaseChar() },
                tone = when (report.status.uppercase()) {
                    "SENT"   -> AuntieStatusTone.Success
                    "FAILED" -> AuntieStatusTone.Error
                    else     -> AuntieStatusTone.Muted
                },
                showDot = true,
            )
            val ts = report.sentAt.ifBlank { report.updatedAt.ifBlank { report.createdAt } }
            if (ts.isNotBlank()) {
                Text(ts, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            }
        }
        if (report.bodyCopy.isNotBlank()) {
            Text(
                text  = report.bodyCopy.take(180) + if (report.bodyCopy.length > 180) "…" else "",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

// ---- Den panel shell -------------------------------------------------------

@Composable
private fun DenPanel(content: @Composable () -> Unit) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(18.dp))
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        content()
    }
}

@Composable
private fun PanelHeading(title: String, icon: ImageVector) {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Icon(icon, contentDescription = null, tint = c.primary, modifier = Modifier.size(16.dp))
        Text(title, style = AuntieTheme.typography.headlineSmall, color = c.textPrimary)
    }
}

@Composable
private fun PanelHeadingWithTag(
    title: String,
    icon: ImageVector,
    tag: String,
    tone: AuntieStatusTone,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Icon(icon, contentDescription = null, tint = c.primary, modifier = Modifier.size(16.dp))
        Text(title, style = AuntieTheme.typography.headlineSmall, color = c.textPrimary, modifier = Modifier.weight(1f))
        AuntieStatusPill(label = tag, tone = tone)
    }
}

// ---- Fact rows / blocks ----------------------------------------------------

@Composable
private fun FactRow(icon: ImageVector, label: String, value: String, multiline: Boolean = false) {
    if (value.isBlank()) return
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.padding(vertical = 2.dp),
        verticalAlignment = if (multiline) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = c.textFaint, modifier = Modifier.size(14.dp))
        if (label.isNotBlank()) {
            Text(
                text  = label,
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
                modifier = Modifier.padding(end = 6.dp),
            )
        }
        Text(
            text  = value,
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun AddressBlock(address: String) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(address, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        // #1602: the walk's visit read "18605" with no hint it was incomplete.
        if (addressLooksIncomplete(address)) {
            Text(INCOMPLETE_ADDRESS_HINT, style = AuntieTheme.typography.labelSmall, color = c.warning)
        }
        GhostButton(label = "Open in Maps", onClick = { openInMaps(address) })
    }
}

@Composable
private fun EmptyHint(text: String) {
    Text(
        text  = text,
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.textFaint,
    )
}

private fun wifiSummary(k: Kinfolk): String {
    if (k.wifiName.isBlank() && k.wifiPassword.isBlank()) return ""
    val name = k.wifiName.ifBlank { "(unnamed)" }
    val pass = if (k.wifiPassword.isNotBlank()) " · password on file" else ""
    return "$name$pass"
}

// ---- Status mapping --------------------------------------------------------

private fun statusLabel(status: String): String = when (status.uppercase()) {
    "SCHEDULED" -> "Scheduled"
    "ON_MY_WAY" -> "On my way"
    "ARRIVED"   -> "Arrived"
    "DEPARTED"  -> "Departed"
    "COMPLETED" -> "Completed"
    else        -> status.lowercase().replaceFirstChar { it.uppercaseChar() }.ifBlank { "Scheduled" }
}

private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "SCHEDULED" -> AuntieStatusTone.Muted
    "ON_MY_WAY" -> AuntieStatusTone.Orange
    "ARRIVED"   -> AuntieStatusTone.Teal
    "DEPARTED"  -> AuntieStatusTone.Purple
    "COMPLETED" -> AuntieStatusTone.Success
    else        -> AuntieStatusTone.Neutral
}

// ---- ISO helpers -----------------------------------------------------------

private fun sessionWindowFor(s: KinCareSession): String {
    val start = shortIso(s.startTime)
    val end   = shortIsoTimeOnly(s.endTime)
    return when {
        start.isBlank() && end.isBlank() -> "Time TBD"
        end.isBlank()                    -> start
        else                             -> "$start to $end"
    }
}

/**
 * "Sep 3 · 14:02", or "Sep 3, 2025 · 14:02" when it is not [currentYear] (#1599),
 * on the BUSINESS's clock (#2095): an instant is converted into [zone], a
 * zone-less value is already business time. Printing the stored characters
 * gave the UTC day and hour for an instant.
 */
internal fun shortIso(
    iso: String,
    currentYear: Int = com.tribetails.auntieos.web.screens.invoices.localTodayIso().take(4).toIntOrNull() ?: 0,
    zone: TimeZone = businessTimeZone(),
): String =
    runCatchingCancellable {
        if (iso.length < 16) return@runCatchingCancellable iso
        val at = com.tribetails.auntieos.web.screens.schedule.businessDateTimeOf(iso.trim(), zone)
            ?: return@runCatchingCancellable iso
        val month = MONTHS[at.monthNumber - 1]
        val time  = "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
        if (at.year == currentYear) "$month ${at.dayOfMonth} · $time" else "$month ${at.dayOfMonth}, ${at.year} · $time"
    }.getOrDefault(iso)

private fun shortIsoTimeOnly(iso: String, zone: TimeZone = businessTimeZone()): String =
    if (iso.length >= 16) businessShortTime(iso, zone) else iso

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
