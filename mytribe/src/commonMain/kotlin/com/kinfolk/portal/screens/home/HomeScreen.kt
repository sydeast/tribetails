package com.kinfolk.portal.screens.home

import com.kinfolk.portal.util.auntieName
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinLoading
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinStaggerReveal
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.BOOKINGS_POLL_MS
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingsResult
import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.push.PushRegistrationCoordinator
import com.kinfolk.portal.screens.notifications.DevicePushCard
import com.kinfolk.portal.portal.PortalHomeSection
import com.kinfolk.portal.portal.VisitProgress
import com.kinfolk.portal.portal.VisitStage
import com.kinfolk.portal.portal.label
import com.kinfolk.portal.portal.liveVisitOrNull
import com.kinfolk.portal.portal.pendingChangeLabel
import com.kinfolk.portal.portal.stage
import com.kinfolk.portal.screens.schedule.KeepBookingsCurrent
import com.kinfolk.portal.screens.schedule.SAVE_NOTICE_MS
import com.kinfolk.portal.screens.schedule.SaveNoticeRow
import com.kinfolk.portal.screens.schedule.ScheduleHandoff
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.bookingWhenLabel
import com.kinfolk.portal.util.formatUsd
import com.kinfolk.portal.util.KIN_TALE_HEADLINE_HOME_CHARS
import com.kinfolk.portal.util.kinTaleByline
import com.kinfolk.portal.util.kinTaleHeadline
import kotlinx.coroutines.delay
import kotlin.coroutines.cancellation.CancellationException

/**
 * Home, the dashboard (#1412, operator ruling on #1295). Wide (>= 880dp, same
 * breakpoint as the shell chrome): two columns 1.6fr / 1fr — main = Up Next +
 * Recent KinTales, aside = Quick Start. Narrow: one column, Quick Start FIRST
 * so it sits above the fold on a phone, then Up Next, then Recent KinTales.
 * The Live Visit hero always spans full width above the columns.
 *
 * The kin roster is not here: it lives on the Tribe screen only
 * (TribeHubScreen.kt), so this screen never calls getMyKin. The hero's kin
 * names come from the booking itself ([Booking.kinNames]).
 */
@Composable
fun HomeScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    sections: List<PortalHomeSection> = emptyList(),
    onOpenSchedule: () -> Unit = {},
    /** #1461: an Up next row opens that booking, the way a Schedule row does. */
    onOpenBooking: (visitId: String, batchId: String?) -> Unit = { _, _ -> },
    onOpenKinTales: () -> Unit = {},
    /** #1329: a Recent KinTales card opens that tale. */
    onOpenKinTale: (String) -> Unit = {},
    onBookVisit: () -> Unit = {},
    /**
     * #1462: opens Invoices from the Balance due line. Null for a member
     * without billing access: Home then neither reads the balance nor draws it.
     */
    onOpenInvoices: (() -> Unit)? = null,
    /** #1345: what the booking wizard leaves when it returns here. Taken once, then [onHandoffTaken] clears it. */
    handoff: ScheduleHandoff? = null,
    onHandoffTaken: () -> Unit = {},
    /** #1788: the device's notifications card (Enable / Blocked / Finish); null draws none. */
    pushCoordinator: PushRegistrationCoordinator? = null,
    /** #2122: how often [KeepBookingsCurrent] re-reads; see there. */
    pollMs: Long = BOOKINGS_POLL_MS,
) {
    val type = LocalKinfolkTypography.current
    // #1345: seeded from the wizard's handoff, so Home shows the new booking
    // and the confirmation at once; its own read still runs behind it.
    var data by remember { mutableStateOf(handoff?.bookings) }
    var notice by remember { mutableStateOf(handoff?.notice) }
    var error by remember { mutableStateOf<String?>(null) }
    var tales by remember { mutableStateOf<List<KinTale>?>(null) }
    var talesFailed by remember { mutableStateOf(false) }
    // Bumped by the widget's Retry action to re-run the tales fetch.
    var talesReloadKey by remember { mutableStateOf(0) }
    // Same idiom for the bookings read, so the 10s "Tap to sync" on each
    // section has a real re-attempt behind it rather than a dead button
    // (operator ruling, 2026-09-12). Bumping the key re-runs the
    // LaunchedEffect below; nulling the data puts the section back into its
    // waiting state so the cue is visible while the retry runs.
    var bookingsReloadKey by remember { mutableStateOf(0) }
    // #1462: what the household owes. Read fresh on every visit to Home (the
    // shell's copy of getMyHome is loaded once per session, so it would still
    // show a bill the household just paid). Null while the read runs.
    var balanceDueCents by remember { mutableStateOf<Long?>(null) }
    var balanceReloadKey by remember { mutableStateOf(0) }

    // Resolve the section layout from the operator config. Empty/absent config →
    // the canonical hardcoded order, every section enabled (today's behavior).
    val layout = remember(sections) { resolveHomeLayout(sections) }
    fun cfg(id: String): HomeSectionResolved? = layout.firstOrNull { it.id == id }
    // Per-section .take limits (0 = unlimited). The tales fetch uses the same
    // limit so we don't over-fetch when the operator capped the section.
    val talesLimit = cfg("tales")?.limit?.takeIf { it > 0 } ?: 3

    LaunchedEffect(kinfolkId, bookingsReloadKey) {
        try {
            data = portalApi.getMyBookings(kinfolkId)
            error = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            error = t.message ?: "Could not load home"
        }
    }
    // #1832: while a visit is under way or about due, Home keeps itself
    // current, so the live card appears, changes and clears without leaving
    // the screen. Quiet on purpose: a dropped re-read leaves Home as it is.
    KeepBookingsCurrent(data, pollMs = pollMs) {
        try {
            data = portalApi.getMyBookings(kinfolkId)
            error = null
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) { /* keep what is on screen; the next turn tries again */ }
    }
    LaunchedEffect(handoff) {
        if (handoff != null) {
            handoff.bookings?.let { data = it }
            notice = handoff.notice
            onHandoffTaken()
        }
    }
    LaunchedEffect(notice) {
        if (notice != null) {
            delay(SAVE_NOTICE_MS)
            notice = null
        }
    }
    LaunchedEffect(kinfolkId, onOpenInvoices != null, balanceReloadKey) {
        if (onOpenInvoices == null) return@LaunchedEffect
        balanceDueCents = try {
            portalApi.getMyHome(kinfolkId).balanceDueCents
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            // Fails soft to no line: Invoices is still one tap away in the
            // avatar menu, and a failed money cue must not read as "owes $0".
            0L
        }
    }
    // Tales load independently and fail soft: a broken tales card never takes
    // down the schedule column.
    LaunchedEffect(kinfolkId, talesLimit, talesReloadKey) {
        try {
            tales = portalApi.getMyKinTales(kinfolkId, limit = talesLimit).tales
            talesFailed = false
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            talesFailed = true
        }
    }

    // Reusable section renderers, keyed by id so the layout can place them in any
    // operator-chosen order. limit 0 = unlimited; the canonical caps (5/3)
    // apply only when the operator hasn't set one.
    val liveVisitSection: @Composable () -> Unit = {
        // #1421: matches web. Nothing is drawn for the common case (no visit
        // under way), so there is no heading and no empty card.
        when {
            error != null -> EmptyState(title = "Couldn't load Home", message = error ?: "")
            data == null -> KinLoading(
                text = "Checking whether a visit is under way\u2026",
                onSync = { data = null; bookingsReloadKey += 1 },
            )
            else -> data?.liveVisitOrNull()?.let { live ->
                // #1832: the card opens the visit it is about.
                LiveVisitCard(live, onOpen = { onOpenBooking(live.id, live.batchId) })
            }
        }
    }
    val upNextSection: @Composable () -> Unit = {
        UpNextSection(
            data = data,
            limit = cfg("upNext")?.limit?.takeIf { it > 0 } ?: 5,
            onOpenSchedule = onOpenSchedule,
            onOpenBooking = onOpenBooking,
            onReloadBookings = { data = null; bookingsReloadKey += 1 },
        )
    }
    val balanceDueSection: @Composable () -> Unit = {
        val open = onOpenInvoices
        if (open != null) {
            BalanceDueLine(
                cents = balanceDueCents,
                onOpen = open,
                onReload = { balanceDueCents = null; balanceReloadKey += 1 },
            )
        }
    }
    val talesSection: @Composable () -> Unit = {
        TalesSection(
            tales = tales,
            failed = talesFailed,
            limit = talesLimit,
            onOpenKinTales = onOpenKinTales,
            onOpenKinTale = onOpenKinTale,
            onRetry = {
                // Show the spinner while the refetch runs, then bump the key.
                tales = null
                talesFailed = false
                talesReloadKey += 1
            },
        )
    }
    val quickStartSection: @Composable () -> Unit = {
        QuickStartSection(onBookVisit = onBookVisit)
    }

    fun renderById(id: String): (@Composable () -> Unit)? = when (id) {
        "liveVisit" -> liveVisitSection
        "upNext" -> upNextSection
        "tales" -> talesSection
        "quickStart" -> quickStartSection
        // "roster" has no renderer since #1412: the kin list is Tribe's. A
        // config row that still names it is skipped, like any unknown id.
        else -> null
    }

    // The standard order keeps the two-column wide split: main = liveVisit +
    // upNext + tales, aside = quickStart; narrow puts quickStart first. When
    // the operator has changed the order, we honor that order in a single
    // column (a custom order can't be meaningfully forced into two fixed
    // columns). Both shapes skip switched-off sections and apply limits.
    // #1987: the order alone chooses. A Limit or a hidden card never does
    // (see homeLayoutMode in HomeLayout.kt).
    val stacked = remember(sections) { homeLayoutMode(sections) == HomeLayoutMode.Stacked }
    fun shows(id: String): Boolean = cfg(id) != null

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
            notice?.let { text -> SaveNoticeRow(text = text, onDismiss = { notice = null }) }
            if (pushCoordinator != null) {
                val cardDismissed by pushCoordinator.homeCardDismissed.collectAsState()
                if (!cardDismissed) DevicePushCard(pushCoordinator, onDismiss = { pushCoordinator.dismissHomeCard() })
            }

            if (stacked) {
                // Operator order: liveVisit spans full width, everything else
                // stacks in the configured order within the padded column.
                // #1462: Balance due follows Up next, or goes last when Up next
                // is switched off, the same as web.
                val hasUpNext = layout.any { it.id == "upNext" }
                layout.forEach { sec ->
                    val render = renderById(sec.id) ?: return@forEach
                    if (sec.id == "liveVisit") {
                        render()
                    } else {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                        ) {
                            render()
                            if (sec.id == "upNext") balanceDueSection()
                        }
                    }
                }
                if (!hasUpNext) {
                    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
                        balanceDueSection()
                    }
                }
            } else {
                if (shows("liveVisit")) liveVisitSection()
                val mainColumn: @Composable () -> Unit = {
                    if (shows("upNext")) upNextSection()
                    balanceDueSection()
                    if (shows("tales")) talesSection()
                }
                val asideColumn: @Composable () -> Unit = {
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
                    // #1412: Quick Start leads the phone column so it is above
                    // the fold; the schedule and tales follow.
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                    ) {
                        asideColumn()
                        mainColumn()
                    }
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

// ---- Sections ----

/**
 * A section heading. #1461: with [onOpen] the heading itself opens the full
 * list (the separate trailing link is gone); it keeps the heading semantics so
 * TalkBack still announces it as one, and a chevron shows it can be tapped.
 */
@Composable
private fun SectLabel(text: String, onOpen: (() -> Unit)? = null, openLabel: String? = null) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .let { m ->
                if (onOpen == null) {
                    m
                } else {
                    m.clip(KinfolkShapes.pill)
                        .clickable(role = Role.Button, onClickLabel = openLabel, onClick = onOpen)
                        .padding(vertical = 2.dp)
                }
            }
            .semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(text.uppercase(), style = type.sansMeta)
        if (onOpen != null) {
            Text("\u203A", style = type.sansMeta, modifier = Modifier.clearAndSetSemantics {})
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
private fun UpNextSection(
    data: BookingsResult?,
    limit: Int = 5,
    onOpenSchedule: () -> Unit,
    onOpenBooking: (visitId: String, batchId: String?) -> Unit,
    onReloadBookings: () -> Unit,
) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Up next", onOpen = onOpenSchedule, openLabel = "Open schedule")
            when {
                data == null -> KinLoading(
                    text = "Loading your schedule\u2026",
                    onSync = onReloadBookings,
                )
                data.upcoming.isEmpty() -> SectionNote(
                    title = "Nothing scheduled",
                    message = "Once your Auntie books visits, your upcoming care will appear here.",
                )
                else -> KinStaggerReveal(
                    items = data.upcoming.take(limit),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) { b -> UpcomingRow(b, onOpen = { onOpenBooking(b.id, b.batchId) }) }
            }
        }
    }
}

@Composable
private fun UpcomingRow(b: Booking, onOpen: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.card)
            .clickable(role = Role.Button, onClickLabel = "Open this booking", onClick = onOpen)
            .padding(vertical = KinfolkSpacing.xs),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(com.kinfolk.portal.util.visitTitle(b.title, b.serviceLabel) ?: "Booking", style = type.heritageTitle)
            Text(bookingWhenLabel(b, withDate = true), style = type.sansLabel)
            val withText = (listOf(b.auntieDisplayName).filterNotNull() + b.kinNames).joinToString(" • ").ifBlank { null }
            if (withText != null) Text(withText, style = type.sansMeta)
            // #1299: the cancellation or new time still waiting on the office.
            b.pendingChangeLabel()?.let { Text(it, style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted)) }
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
    onOpenKinTale: (String) -> Unit = {},
    onRetry: () -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Recent KinTales", onOpen = onOpenKinTales, openLabel = "Open KinTales")
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
                tales == null -> KinLoading(
                    text = "Loading recent KinTales\u2026",
                    onSync = onRetry,
                )
                tales.isEmpty() -> SectionNote(
                    title = "No tales yet",
                    message = "After each visit, your Auntie's KinTale lands here.",
                )
                else -> KinStaggerReveal(
                    items = tales.take(limit),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) { tale -> TaleRow(tale, onOpen = { onOpenKinTale(tale.id) }) }
            }
        }
    }
}

/** Test tag on a Recent KinTales row's headline line (#2166). */
internal const val HOME_TALE_HEADLINE_TAG = "homeTaleHeadline"

@Composable
private fun TaleRow(tale: KinTale, onOpen: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.card)
            .clickable(role = Role.Button, onClickLabel = "Open this KinTale", onClick = onOpen)
            .padding(vertical = KinfolkSpacing.xs),
    ) {
        // #2166: the headline leads, as on web Home (`t.title || t.body.slice(0, 60)`).
        // None to show (no title, blank body) means no line, not an empty one.
        kinTaleHeadline(tale.title, tale.body, KIN_TALE_HEADLINE_HOME_CHARS)?.let { headline ->
            Text(
                text = headline,
                style = type.sansBody.copy(fontWeight = FontWeight.SemiBold),
                modifier = Modifier.testTag(HOME_TALE_HEADLINE_TAG),
            )
        }
        Text(
            text = tale.body.ifBlank { "A new tale from your Auntie" },
            style = type.sansBody,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(KinfolkSpacing.xs))
        Text(kinTaleByline(tale.authorDisplayName, tale.sentAtMs, tale.sentAtText), style = type.sansMeta)
    }
}

/**
 * #1460 (mobile map, #1295): one button. Messages is on the bar and Invoices
 * is in the avatar menu, so Home no longer repeats them.
 */
@Composable
private fun QuickStartSection(onBookVisit: () -> Unit) {
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.m)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("Quick start")
            KinButton("Book a visit", onClick = onBookVisit, modifier = Modifier.fillMaxWidth())
        }
    }
}

/**
 * #1462: Home's one money cue. Drawn only when the household owes something;
 * the whole line opens Invoices. While the read runs it shows the same loading
 * cue as every other wait on Home.
 */
@Composable
private fun BalanceDueLine(cents: Long?, onOpen: () -> Unit, onReload: () -> Unit) {
    val type = LocalKinfolkTypography.current
    when {
        cents == null -> KinLoading(text = "Checking your balance\u2026", onSync = onReload)
        cents <= 0L -> Unit
        else -> GlassCard(
            modifier = Modifier
                .fillMaxWidth()
                .clip(KinfolkShapes.card)
                .clickable(role = Role.Button, onClickLabel = "Open invoices", onClick = onOpen),
            contentPadding = PaddingValues(horizontal = KinfolkSpacing.m, vertical = KinfolkSpacing.s),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Text("BALANCE DUE", style = type.sansMeta, modifier = Modifier.weight(1f))
                Text(formatUsd(cents.toDouble() / 100.0), style = type.heritageTitle)
                Text("\u203A", style = type.sansMeta, modifier = Modifier.clearAndSetSemantics {})
            }
        }
    }
}

// ---- Live Visit hero (unchanged) ----

@Composable
private fun LiveVisitCard(b: Booking, onOpen: () -> Unit) {
    val type = LocalKinfolkTypography.current
    // #1832: On the way and Arrived are different cards in words. It used to
    // say LIVE for both, as if the Auntie were already with the Kin.
    val arrived = b.stage() == VisitStage.Active
    // Signature full-bleed Tribe-gradient hero (orange to pink to teal) with white
    // text, the brightest moment on Home when an Auntie is actively with the Kin.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KinfolkSpacing.l)
            .clip(KinfolkShapes.card)
            .background(KinfolkGradients.tribe)
            .testTag(HOME_LIVE_VISIT_TAG)
            .clickable(role = Role.Button, onClickLabel = "Open this booking", onClick = onOpen)
            .padding(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(auntieName(b.auntieDisplayName) ?: "Auntie", style = type.heritageTitle.copy(color = Color.White))
                    Text(b.serviceLabel ?: "Visit", style = type.sansLabel.copy(color = Color.White.copy(alpha = 0.88f)))
                }
                LivePill(label = if (arrived) "LIVE" else "ON THE WAY", onGradient = true)
            }
            val kinText = b.kinNames.joinToString(", ").ifBlank { null }
            if (kinText != null) {
                Text(if (arrived) "With $kinText" else "On the way to $kinText", style = type.sansBody.copy(color = Color.White))
            }
            if (!b.notes.isNullOrBlank()) {
                Text(b.notes, style = type.sansBody.copy(color = Color.White.copy(alpha = 0.85f)))
            }
            Spacer(Modifier.height(KinfolkSpacing.s))
            VisitProgressTimeline(
                b.visitProgress ?: if (arrived) VisitProgress.Active else VisitProgress.EnRoute,
                onGradient = true,
            )
        }
    }
}

/** #1832: test tag on Home's live visit card. */
const val HOME_LIVE_VISIT_TAG = "home-live-visit"

@Composable
private fun LivePill(label: String = "LIVE", onGradient: Boolean = false) {
    val type = LocalKinfolkTypography.current
    val accent = if (onGradient) Color.White else KinfolkBrand.SnuggleCoral
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Surface(
            modifier = Modifier.size(8.dp),
            color = accent,
            shape = CircleShape,
        ) {}
        Text(label, style = type.sansMeta.copy(color = accent))
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
    // #1298: the words come from VisitStage.label(); only the colour is this screen's.
    val stage = b.stage()
    val color = when (stage) {
        VisitStage.Requested -> KinfolkBrand.KinfolkOrange
        VisitStage.Confirmed -> KinfolkBrand.KinTeal
        VisitStage.EnRoute -> KinfolkBrand.PackPink
        VisitStage.Active -> KinfolkBrand.SnuggleCoral
        VisitStage.Completed -> KinfolkBrand.KinTeal
        VisitStage.Cancelled -> KinfolkBrand.NavyMuted
    }
    val label = stage.label()
    GlassCard(
        modifier = Modifier,
        shape = KinfolkShapes.pill,
        contentPadding = PaddingValues(horizontal = KinfolkSpacing.m, vertical = 4.dp),
    ) {
        Text(label, style = type.sansMeta.copy(color = color))
    }
}
