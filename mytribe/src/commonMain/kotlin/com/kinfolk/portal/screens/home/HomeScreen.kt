package com.kinfolk.portal.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinStaggerReveal
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.avatarInitial
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingsResult
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.PortalHomeSection
import com.kinfolk.portal.portal.VisitProgress
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime

/**
 * Home. Wide (>= 880dp, same breakpoint as the shell chrome): two columns
 * 1.6fr / 1fr — main = Up Next + Recent KinTales, aside = Tribe roster +
 * Quick Start. Narrow: one column in the same order. The Live Visit hero
 * always spans full width above the columns.
 */
@Composable
fun HomeScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    sections: List<PortalHomeSection> = emptyList(),
    chatEnabled: Boolean = true,
    onMessageAuntie: () -> Unit = {},
    onOpenSchedule: () -> Unit = {},
    onOpenKinTales: () -> Unit = {},
    onOpenKin: () -> Unit = {},
    onOpenKinDetail: (String) -> Unit = {},
    onAddKin: () -> Unit = {},
    onBookVisit: () -> Unit = {},
    onOpenInvoices: () -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    var data by remember { mutableStateOf<BookingsResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var roster by remember { mutableStateOf<List<Kin>?>(null) }
    var rosterFailed by remember { mutableStateOf(false) }
    var tales by remember { mutableStateOf<List<KinTale>?>(null) }
    var talesFailed by remember { mutableStateOf(false) }
    // Bumped by the widget's Retry action to re-run the tales fetch.
    var talesReloadKey by remember { mutableStateOf(0) }

    // Resolve the section layout from the operator config. Empty/absent config →
    // the canonical hardcoded order, every section enabled (today's behavior).
    val layout = remember(sections) { resolveHomeLayout(sections) }
    fun cfg(id: String): HomeSectionResolved? = layout.firstOrNull { it.id == id }
    // Per-section .take limits (0 = unlimited). The tales fetch uses the same
    // limit so we don't over-fetch when the operator capped the section.
    val talesLimit = cfg("tales")?.limit?.takeIf { it > 0 } ?: 3

    LaunchedEffect(kinfolkId) {
        try {
            data = portalApi.getMyBookings(kinfolkId)
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load home"
        }
    }
    // Roster + tales load independently and fail soft: a broken aside never
    // takes down the schedule column.
    LaunchedEffect(kinfolkId) {
        try {
            roster = portalApi.getMyKin(kinfolkId).kin
            rosterFailed = false
        } catch (t: Throwable) {
            rosterFailed = true
        }
    }
    LaunchedEffect(kinfolkId, talesLimit, talesReloadKey) {
        try {
            tales = portalApi.getMyKinTales(kinfolkId, limit = talesLimit).tales
            talesFailed = false
        } catch (t: Throwable) {
            talesFailed = true
        }
    }

    // Reusable section renderers, keyed by id so the layout can place them in any
    // operator-chosen order. limit 0 = unlimited; the canonical caps (5/3/4)
    // apply only when the operator hasn't set one.
    val liveVisitSection: @Composable () -> Unit = {
        Text("Live Visit", style = type.heritageSection, modifier = Modifier.padding(horizontal = KinfolkSpacing.l))
        when {
            error != null -> EmptyState(title = "Couldn't load Home", message = error ?: "")
            data == null -> Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l), contentAlignment = Alignment.Center) {
                KinSpinner()
            }
            data?.liveVisit == null -> EmptyState(
                title = "No active visit",
                message = "When an Auntie checks in for a visit, you'll see live status here.",
            )
            else -> LiveVisitCard(data!!.liveVisit!!)
        }
    }
    val upNextSection: @Composable () -> Unit = {
        UpNextSection(
            data = data,
            limit = cfg("upNext")?.limit?.takeIf { it > 0 } ?: 5,
            onOpenSchedule = onOpenSchedule,
        )
    }
    val talesSection: @Composable () -> Unit = {
        TalesSection(
            tales = tales,
            failed = talesFailed,
            limit = talesLimit,
            onOpenKinTales = onOpenKinTales,
            onRetry = {
                // Show the spinner while the refetch runs, then bump the key.
                tales = null
                talesFailed = false
                talesReloadKey += 1
            },
        )
    }
    val rosterSection: @Composable () -> Unit = {
        RosterSection(
            roster = roster,
            failed = rosterFailed,
            limit = cfg("roster")?.limit?.takeIf { it > 0 } ?: 4,
            onOpenKin = onOpenKin,
            onOpenKinDetail = onOpenKinDetail,
            onAddKin = onAddKin,
        )
    }
    val quickStartSection: @Composable () -> Unit = {
        QuickStartSection(
            showMessageAuntie = chatEnabled,
            onBookVisit = onBookVisit,
            onMessageAuntie = onMessageAuntie,
            onOpenInvoices = onOpenInvoices,
        )
    }

    fun renderById(id: String): (@Composable () -> Unit)? = when (id) {
        "liveVisit" -> liveVisitSection
        "upNext" -> upNextSection
        "tales" -> talesSection
        "roster" -> rosterSection
        "quickStart" -> quickStartSection
        else -> null
    }

    // The canonical layout (empty config) keeps the two-column wide split:
    // main = liveVisit + upNext + tales, aside = roster + quickStart. When the
    // operator supplies an explicit order, we honor that order in a single
    // column (a custom order can't be meaningfully forced into two fixed
    // columns), still skipping disabled sections and applying limits.
    val custom = sections.isNotEmpty()

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            ScreenHeader(
                title = "Your tribe is in good hands.",
                kicker = "Welcome home",
            )

            if (custom) {
                // Operator order: liveVisit spans full width, everything else
                // stacks in the configured order within the padded column.
                layout.forEach { sec ->
                    val render = renderById(sec.id) ?: return@forEach
                    if (sec.id == "liveVisit") {
                        render()
                    } else {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                        ) { render() }
                    }
                }
            } else {
                liveVisitSection()
                val mainColumn: @Composable () -> Unit = {
                    upNextSection()
                    talesSection()
                }
                val asideColumn: @Composable () -> Unit = {
                    rosterSection()
                    quickStartSection()
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
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

/** A resolved home section: id + per-section limit (0 = unlimited). */
private data class HomeSectionResolved(val id: String, val limit: Int)

/** Canonical section order used when the operator supplies no config. */
private val CANONICAL_HOME_ORDER = listOf("liveVisit", "upNext", "tales", "roster", "quickStart")

/**
 * Resolves the home layout from the operator [sections] config. Empty config →
 * the canonical order with all sections enabled. Otherwise: the configured
 * order, dropping `enabled == false` and any unknown ids, carrying each
 * section's limit through.
 */
private fun resolveHomeLayout(sections: List<PortalHomeSection>): List<HomeSectionResolved> {
    if (sections.isEmpty()) return CANONICAL_HOME_ORDER.map { HomeSectionResolved(it, 0) }
    return sections
        .filter { it.enabled && it.id in CANONICAL_HOME_ORDER }
        .map { HomeSectionResolved(it.id, it.limit) }
}

// ---- Sections ----

@Composable
private fun SectLabel(text: String, linkText: String? = null, onLink: () -> Unit = {}) {
    val type = LocalKinfolkTypography.current
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), style = type.sansMeta)
        Spacer(Modifier.weight(1f))
        if (linkText != null) {
            Text(
                text = linkText,
                style = type.sansMeta.copy(color = KinfolkBrand.KinTeal),
                modifier = Modifier
                    .clip(KinfolkShapes.pill)
                    .clickable { onLink() }
                    .padding(horizontal = KinfolkSpacing.xs, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun SectionNote(title: String, message: String) {
    val type = LocalKinfolkTypography.current
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.s)) {
        Text(title, style = type.heritageSection)
        Spacer(Modifier.height(KinfolkSpacing.xs))
        Text(message, style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
    }
}

@Composable
private fun UpNextSection(data: BookingsResult?, limit: Int = 5, onOpenSchedule: () -> Unit) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Up next", linkText = "Full schedule", onLink = onOpenSchedule)
            when {
                data == null -> Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m), contentAlignment = Alignment.Center) {
                    KinSpinner()
                }
                data.upcoming.isEmpty() -> SectionNote(
                    title = "Nothing scheduled",
                    message = "Once your Auntie books visits, your upcoming care will appear here.",
                )
                else -> KinStaggerReveal(
                    items = data.upcoming.take(limit),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) { b -> UpcomingRow(b) }
            }
        }
    }
}

@Composable
private fun UpcomingRow(b: Booking) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.xs),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(b.title ?: b.serviceType ?: "Booking", style = type.heritageTitle)
            Text(relativeTime(b.startTimeMs), style = type.sansLabel)
            val withText = (listOf(b.auntieDisplayName).filterNotNull() + b.kinNames).joinToString(" • ").ifBlank { null }
            if (withText != null) Text(withText, style = type.sansMeta)
        }
        StatusPill(b)
    }
}

@Composable
private fun TalesSection(
    tales: List<KinTale>?,
    failed: Boolean,
    limit: Int = 3,
    onOpenKinTales: () -> Unit,
    onRetry: () -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Recent KinTales", linkText = "All tales", onLink = onOpenKinTales)
            when {
                failed -> Column {
                    SectionNote(
                        title = "KinTales unavailable",
                        message = "We couldn't load recent tales right now.",
                    )
                    Text(
                        text = "Retry",
                        style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
                        modifier = Modifier
                            .clip(KinfolkShapes.pill)
                            .clickable { onRetry() }
                            .padding(horizontal = KinfolkSpacing.xs, vertical = 2.dp),
                    )
                }
                tales == null -> Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m), contentAlignment = Alignment.Center) {
                    KinSpinner()
                }
                tales.isEmpty() -> SectionNote(
                    title = "No tales yet",
                    message = "After each visit, your Auntie's KinTale lands here.",
                )
                else -> KinStaggerReveal(
                    items = tales.take(limit),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) { tale -> TaleRow(tale) }
            }
        }
    }
}

@Composable
private fun TaleRow(tale: KinTale) {
    val type = LocalKinfolkTypography.current
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.xs)) {
        Text(
            text = tale.body.ifBlank { "A new tale from your Auntie" },
            style = type.sansBody,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(KinfolkSpacing.xs))
        val meta = buildString {
            append("FROM ")
            append((tale.authorDisplayName ?: "YOUR AUNTIE").uppercase())
            tale.sentAtMs?.let {
                append(" · ")
                append(relativeTime(it).uppercase())
            }
        }
        Text(meta, style = type.sansMeta)
    }
}

@Composable
private fun RosterSection(
    roster: List<Kin>?,
    failed: Boolean,
    limit: Int = 4,
    onOpenKin: () -> Unit,
    onOpenKinDetail: (String) -> Unit,
    onAddKin: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Your tribe", linkText = "The Kin", onLink = onOpenKin)
            when {
                failed -> SectionNote(
                    title = "Tribe unavailable",
                    message = "We couldn't load your Kin right now. Try The Kin from the account menu.",
                )
                roster == null -> Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m), contentAlignment = Alignment.Center) {
                    KinSpinner()
                }
                else -> {
                    roster.take(limit).forEachIndexed { index, kin -> KinRosterRow(kin, index, onOpenKinDetail) }
                }
            }
            // Add Kin is always available, even while the roster loads or fails.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(KinfolkShapes.cardSmall)
                    .clickable { onAddKin() }
                    .padding(KinfolkSpacing.s),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(50.dp)
                        .clip(CircleShape)
                        .background(KinfolkBrand.GlassSurfaceDim)
                        .border(2.dp, KinfolkBrand.NavyHairline, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("+", style = type.heritageTitle.copy(color = KinfolkBrand.NavyMuted))
                }
                Column {
                    Text("Add Kin", style = type.sansBody)
                    Text("NEW PROFILE", style = type.sansMeta)
                }
            }
        }
    }
}

/** Roster ring colors cycle orange → teal → pink → purple like the design. */
private val RosterRingColors = listOf(
    KinfolkBrand.KinfolkOrange,
    KinfolkBrand.KinTeal,
    KinfolkBrand.PackPink,
    KinfolkBrand.FamilyPurple,
)

@Composable
private fun KinRosterRow(kin: Kin, index: Int, onOpenKinDetail: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    val ring = RosterRingColors[index % RosterRingColors.size]
    val name = kin.name?.takeIf { it.isNotBlank() } ?: "Kin"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.cardSmall)
            .clickable { onOpenKinDetail(kin.id) }
            .padding(KinfolkSpacing.s),
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(50.dp).clip(CircleShape).border(2.dp, ring, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            val photo = kin.photoUrl
            if (!photo.isNullOrBlank()) {
                KinfolkAvatar(url = photo, contentDescription = name, size = 46.dp)
            } else {
                Text(avatarInitial(name), style = type.heritageTitle.copy(color = ring))
            }
        }
        Column {
            Text(name, style = type.sansBody)
            val meta = listOfNotNull(
                (kin.breed ?: kin.species)?.takeIf { it.isNotBlank() }?.uppercase(),
                kin.ageYears?.let { yrs ->
                    val rounded = if (yrs % 1.0 == 0.0) yrs.toInt().toString() else yrs.toString()
                    "$rounded YRS"
                },
            ).joinToString(", ")
            if (meta.isNotBlank()) Text(meta, style = type.sansMeta)
        }
    }
}

@Composable
private fun QuickStartSection(
    showMessageAuntie: Boolean,
    onBookVisit: () -> Unit,
    onMessageAuntie: () -> Unit,
    onOpenInvoices: () -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Quick start")
            KinButton("Book a visit", onClick = onBookVisit, modifier = Modifier.fillMaxWidth())
            if (showMessageAuntie) {
                KinGhostButton("Message your Auntie", onClick = onMessageAuntie, modifier = Modifier.fillMaxWidth())
            }
            KinGhostButton("View invoices", onClick = onOpenInvoices, modifier = Modifier.fillMaxWidth())
        }
    }
}

// ---- Live Visit hero (unchanged) ----

@Composable
private fun LiveVisitCard(b: Booking) {
    val type = LocalKinfolkTypography.current
    // Signature full-bleed Tribe-gradient hero (orange to pink to teal) with white
    // text, the brightest moment on Home when an Auntie is actively with the Kin.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KinfolkSpacing.l)
            .clip(KinfolkShapes.card)
            .background(KinfolkGradients.tribe)
            .padding(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(b.auntieDisplayName ?: "Auntie", style = type.heritageTitle.copy(color = Color.White))
                    Text(b.serviceType ?: "Visit", style = type.sansLabel.copy(color = Color.White.copy(alpha = 0.88f)))
                }
                LivePill(onGradient = true)
            }
            val withText = b.kinNames.joinToString(", ").ifBlank { null }
            if (withText != null) {
                Text("With $withText", style = type.sansBody.copy(color = Color.White))
            }
            if (!b.notes.isNullOrBlank()) {
                Text(b.notes, style = type.sansBody.copy(color = Color.White.copy(alpha = 0.85f)))
            }
            Spacer(Modifier.height(KinfolkSpacing.s))
            VisitProgressTimeline(b.visitProgress ?: VisitProgress.Active, onGradient = true)
        }
    }
}

@Composable
private fun LivePill(onGradient: Boolean = false) {
    val type = LocalKinfolkTypography.current
    val accent = if (onGradient) Color.White else KinfolkBrand.SnuggleCoral
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Surface(
            modifier = Modifier.size(8.dp),
            color = accent,
            shape = CircleShape,
        ) {}
        Text("LIVE", style = type.sansMeta.copy(color = accent))
    }
}

@Composable
private fun VisitProgressTimeline(progress: VisitProgress, onGradient: Boolean = false) {
    val type = LocalKinfolkTypography.current
    val steps = listOf(
        "CONFIRMED" to (progress.ordinal >= VisitProgress.Confirmed.ordinal),
        "EN ROUTE" to (progress.ordinal >= VisitProgress.EnRoute.ordinal),
        "ACTIVE" to (progress.ordinal >= VisitProgress.Active.ordinal),
        "ENDED" to (progress.ordinal >= VisitProgress.Ended.ordinal),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        steps.forEach { (label, active) ->
            val dotColor = when {
                onGradient && active -> Color.White
                onGradient -> Color.White.copy(alpha = 0.35f)
                active -> KinfolkBrand.PackPink
                else -> KinfolkBrand.NavyHairline
            }
            val labelColor = when {
                onGradient && active -> Color.White
                onGradient -> Color.White.copy(alpha = 0.70f)
                active -> KinfolkBrand.Navy
                else -> KinfolkBrand.NavyMuted
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(
                    modifier = Modifier.size(if (active) 14.dp else 10.dp),
                    color = dotColor,
                    shape = CircleShape,
                ) {}
                Spacer(Modifier.height(4.dp))
                Text(
                    label,
                    style = type.sansMeta.copy(color = labelColor),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun StatusPill(b: Booking) {
    val type = LocalKinfolkTypography.current
    val (label, color) = when (b.status) {
        com.kinfolk.portal.portal.BookingStatus.Requested -> "REQUESTED" to KinfolkBrand.KinfolkOrange
        com.kinfolk.portal.portal.BookingStatus.Confirmed -> "CONFIRMED" to KinfolkBrand.KinTeal
        com.kinfolk.portal.portal.BookingStatus.EnRoute -> "EN ROUTE" to KinfolkBrand.PackPink
        com.kinfolk.portal.portal.BookingStatus.Active -> "ACTIVE" to KinfolkBrand.SnuggleCoral
        com.kinfolk.portal.portal.BookingStatus.Completed -> "COMPLETED" to KinfolkBrand.KinTeal
        com.kinfolk.portal.portal.BookingStatus.Cancelled -> "CANCELLED" to KinfolkBrand.NavyMuted
    }
    GlassCard(
        modifier = Modifier,
        shape = KinfolkShapes.pill,
        contentPadding = PaddingValues(horizontal = KinfolkSpacing.m, vertical = 4.dp),
    ) {
        Text(label, style = type.sansMeta.copy(color = color))
    }
}
