package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.foundation.background
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.time.Clock
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.Share2
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.SentChecklistItem
import com.tribetails.auntieos.web.data.resolveSentChecklist
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.toBreadcrumbs
import com.tribetails.auntieos.web.screens.sessions.RouteMap
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ServicePill

/**
 * KinTale report screen (Den redesign).
 *
 * Lives in two modes off the live report's status:
 *  - DRAFT: the auntie's narrative editor (Visit Notes) + Save / Send actions.
 *  - SENT:  a read-only published-artifact view of the same data.
 *
 * Wiring fixes (per 2026-06-01 web audit):
 *  - The report is read via a LIVE stream (P0-FLICKER remember{}.collectAsState),
 *    not a one-shot `.first()`, so status / delivery-receipt mutations land live.
 *  - Loading / Error / empty first emissions are surfaced fail-loud (banner), no
 *    longer silently showing a blank default report.
 *  - Sending no longer pops the screen back; it flips to the SENT artifact view in
 *    place so the auntie actually sees the published KinTale.
 *  - Photos resolve to REAL media docs (mediaStream entityType "VISIT_LOG") with
 *    thumbnails + video duration pips, instead of generic placeholder tiles.
 */
@Composable
fun KinTaleReportScreen(
    sessionId: String,
    dataSource: AuntieDataSource,
    onBack: () -> Unit,
) {
    val vm = remember(sessionId) { KinTaleReportViewModel(sessionId = sessionId, dataSource = dataSource) }

    // P0-FLICKER: hoist Flow construction via remember so the live report + media
    // survive recomposition (otherwise data flickers Loading -> Data each frame).
    val reportState by remember(vm) { vm.reportStream() }.collectAsState(initial = FirestoreResult.Loading)
    val mediaState by remember(vm) { vm.mediaStream() }.collectAsState(initial = FirestoreResult.Loading)
    // Live kin for the per-kin checklist name/species join (spec 11 item 4.1).
    val kinState by remember(vm) { vm.kinStream() }.collectAsState(initial = FirestoreResult.Loading)
    // Live session: carries the persisted GpsSummary for the SENT report's route
    // stats AND the kinfolkId/sourceBookingId the send pipeline routes on.
    val sessionState by remember(vm) { vm.sessionStream() }.collectAsState(initial = FirestoreResult.Loading)

    val liveReport = (reportState as? FirestoreResult.Data)?.value
    val media = (mediaState as? FirestoreResult.Data)?.value.orEmpty()
    val kinById = (kinState as? FirestoreResult.Data)?.value.orEmpty().associateBy { it._id }
    val liveSession = (sessionState as? FirestoreResult.Data)?.value

    ScreenScaffold {
        // ── Den heading: mono kicker + serif title + Back / status trailing ──
        DenScreenHeading(
            kicker = "KinTale · Visit Recap",
            title = "KinTale",
            accentTail = "Update.",
            subtitle = "Tell the story of today's visit, then send it home.",
            trailing = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    val sent = liveReport?.status == "SENT"
                    if (sent) {
                        AuntieStatusPill(label = "Sent", tone = AuntieStatusTone.Success, showDot = true)
                    } else {
                        AuntieStatusPill(label = "Draft", tone = AuntieStatusTone.Orange, showDot = true)
                    }
                    GhostButton(
                        label = "Back",
                        onClick = onBack,
                        leading = {
                            Icon(
                                Lucide.ArrowLeft,
                                contentDescription = null,
                                tint = AuntieTheme.colors.textPrimary,
                                modifier = Modifier.size(15.dp),
                            )
                        },
                    )
                }
            },
        )
        Spacer(Modifier.height(20.dp))

        when {
            // Fail-loud load failure: never silently show a blank editor.
            reportState is FirestoreResult.Error -> {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Could not load this KinTale",
                    icon = Lucide.CircleAlert,
                    body = {
                        Text(
                            (reportState as FirestoreResult.Error).message,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.error,
                        )
                    },
                )
            }

            reportState is FirestoreResult.Loading -> {
                DenPanel(title = "Loading") { EmptyHint("Loading this visit's KinTale…") }
            }

            // Data with a null value: there is no report doc for this session yet.
            liveReport == null -> {
                DenPanel(title = "No KinTale yet") {
                    EmptyHint(
                        "No report exists for this visit yet. Start one below by writing the visit notes.",
                    )
                    Spacer(Modifier.height(14.dp))
                    DraftEditorAndActions(vm = vm, report = KinCareReport(sessionId = sessionId), session = liveSession)
                }
            }

            liveReport.status == "SENT" -> {
                SentReportView(vm = vm, report = liveReport, session = liveSession, media = media, kinById = kinById)
            }

            else -> {
                DraftBody(vm = vm, report = liveReport, session = liveSession)
            }
        }
    }
}

/** DRAFT mode body: editor panel + error toast + save/send actions. */
@Composable
private fun DraftBody(vm: KinTaleReportViewModel, report: KinCareReport, session: KinCareSession?) {
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        DenPanel(
            title = "Visit Notes",
            subtitle = "This narrative is what your kinfolk reads first.",
        ) {
            DraftEditorAndActions(vm = vm, report = report, session = session)
        }

        // Visit meta + recipients shown alongside the editor so context is visible
        // while writing. Driven entirely by the live report; blank fields skipped.
        VisitMetaPanel(report = report)
        RecipientsPanel(report = report)
    }
}

/** The Visit Notes textarea + fail-loud error + Save Draft / Send buttons. */
@Composable
private fun DraftEditorAndActions(vm: KinTaleReportViewModel, report: KinCareReport, session: KinCareSession?) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        MultilineField(
            value = vm.effectiveBody(report.bodyCopy),
            onValueChange = vm::updateBodyCopy,
            label = "Visit Notes",
            placeholder = "Tell the story of today's visit...",
            minLines = 7,
            modifier = Modifier.fillMaxWidth(),
        )

        // Fail-loud: surface any save/send error inline, never swallow it.
        vm.error?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                icon = Lucide.CircleAlert,
                onDismiss = vm::clearError,
                body = { Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.error) },
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            GhostButton(
                label = if (vm.isDraftSaved) "Draft saved" else "Save Draft",
                onClick = { vm.saveDraft(report) },
                enabled = !vm.isSending,
                modifier = Modifier.weight(1f),
            )
            PrimaryButton(
                label = if (vm.isSending) "Sending..." else "Send to kinfolk",
                onClick = { vm.send(report, session) },
                enabled = !vm.isSending,
                loading = vm.isSending,
                modifier = Modifier.weight(1f),
                leading = if (vm.isSending) null else {
                    {
                        Icon(
                            Lucide.Send,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                },
            )
        }
    }
}

/**
 * Read-only render of a SENT KinTale, laid out per the Den mockup. Every value
 * comes straight off [KinCareReport] / live [media]; no fields are invented.
 * Sections with no real data are skipped (rather than faked), keeping the
 * fail-loud contract.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SentReportView(
    vm: KinTaleReportViewModel,
    report: KinCareReport,
    session: KinCareSession?,
    media: List<MediaFile>,
    kinById: Map<String, Kin>,
) {
    val c = AuntieTheme.colors
    val flags = LocalFeatureFlags.current

    Column(verticalArrangement = Arrangement.spacedBy(18.dp), modifier = Modifier.fillMaxWidth()) {

        // Confirm the auntie's own just-completed send (the screen no longer pops).
        if (vm.justSent) {
            AuntieBanner(
                tone = AuntieBannerTone.Success,
                icon = Lucide.CircleCheckBig,
                body = {
                    Text(
                        "This KinTale has been sent.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                },
            )
        }

        // ── Cover hero: orange→pink brand gradient. Eyebrow + author/recipient line. ──
        ReportCover(report = report)

        // ── View-as-kinfolk toggle + Share link action (live). The toggle flips the
        // SENT view into a read-only kinfolk preview (admin compose box + delivery
        // rail hidden). "Share link" mints a public read-only link via the
        // createShareLink callable and opens a copyable dialog. Hidden while the
        // preview is active so it reads exactly as a kinfolk sees it. ──
        ViewAsKinfolkBar(vm = vm, report = report)
        ShareLinkDialog(vm = vm)

        // ── KinTale Narrative: bodyCopy (verbatim section label from the composer). ──
        DenPanel(title = "KinTale Narrative") {
            if (report.bodyCopy.isNotBlank()) {
                Text(
                    report.bodyCopy,
                    style = AuntieTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                    color = c.textPrimary,
                )
            } else {
                Text(
                    "Tell the story of today's visit...",
                    style = AuntieTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                    color = c.textFaint,
                )
            }
        }

        // ── Photos: resolved from real MediaFile docs (entityType VISIT_LOG). ──
        PhotosPanel(report = report, media = media)

        // ── Per-pet + overall checklist from real FieldResponse boolValue. ──
        ChecklistSections(report = report, kinById = kinById)

        // Per-pet mood pills from petMoodSelections. Now a live feature: the
        // default template ships petMoodEnabled=true with mood options, the
        // composer authors selections, and the report renders them read-only.
        // Renders nothing when there are no selections (no faked pills). When a
        // selected mood key has no matching option, the raw key shows (visible,
        // not fabricated) rather than being dropped.
        if (flags.kintalePetMoodPills && report.petMoodSelections.isNotEmpty()) {
            val moodByKey = DefaultKinTaleTemplate.template.moodOptions.associateBy { it.key }
            DenPanel(title = "Pet mood") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    report.petMoodSelections.forEach { (kinId, moodKey) ->
                        val option = moodByKey[moodKey]
                        val label = option?.let { "${it.emoji} ${it.label}".trim() } ?: moodKey
                        AuntieChip(
                            label = label,
                            secondaryLabel = kinHeading(kinId, kinById),
                            tone = AuntieChipTone.Purple,
                        )
                    }
                }
            }
        }

        // ── GPS Route: real route + Distance/Duration/Pings when the session has a
        // persisted GpsSummary (baked on DEPARTED in Auntie Time). Falls back to the
        // id-only trail string when GPS never ran but a route id was recorded; hidden
        // entirely otherwise. Stats are NEVER fabricated when the route is empty. ──
        val summaryBreadcrumbs = session?.gpsSummary?.takeIf { it.route.isNotEmpty() }?.toBreadcrumbs()
        when {
            summaryBreadcrumbs != null && summaryBreadcrumbs.isNotEmpty() -> {
                DenPanel(title = "GPS Route") {
                    RouteMap(breadcrumbs = summaryBreadcrumbs, live = false)
                }
            }
            report.visitRouteId.isNotBlank() -> {
                DenPanel(title = "GPS Route") {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Icon(
                            Lucide.MapPin,
                            contentDescription = null,
                            tint = c.accent,
                            modifier = Modifier.size(18.dp),
                        )
                        // No GpsSummary on the session: show the route id only.
                        // Distance/time are not invented from a missing summary.
                        Text(report.visitRouteId, style = AuntieTheme.typography.mono, color = c.textDim)
                    }
                }
            }
        }

        // ── Recipients + visit meta. Delivery receipt is admin-only ops metadata,
        // so it is hidden in the kinfolk preview. ──
        RecipientsPanel(report = report)
        VisitMetaPanel(report = report)
        if (!vm.viewAsKinfolk) {
            DeliveryPanel(report = report)
        }

        // ── KinTale comment thread (forum-style, 1-level). Live read from
        // kin_care_reports/{taleId}/comments; admin posts via addKinTaleComment.
        // Flag is a kill-switch (default on); when off, the section is hidden. In
        // the kinfolk preview the admin compose box is suppressed (read-only). ──
        if (flags.kintaleCommentThread) {
            CommentThread(vm = vm, report = report, readOnly = vm.viewAsKinfolk)
        }
    }
}

/**
 * View-as-kinfolk toggle + Share link action row, shown above a SENT KinTale.
 * Toggling preview hides admin-only ops (the share action, delivery rail, comment
 * compose) so the page reads exactly as a kinfolk would see it; a small inline
 * banner makes the preview state unmistakable. "Share link" mints a public
 * read-only link via the createShareLink callable and opens [ShareLinkDialog].
 */
@Composable
private fun ViewAsKinfolkBar(vm: KinTaleReportViewModel, report: KinCareReport) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            GhostButton(
                label = if (vm.viewAsKinfolk) "Exit preview" else "View as kinfolk",
                onClick = { vm.toggleViewAsKinfolk() },
                leading = {
                    Icon(
                        Lucide.Eye,
                        contentDescription = null,
                        tint = c.textPrimary,
                        modifier = Modifier.size(15.dp),
                    )
                },
            )
            // The share action is an admin op: hidden inside the kinfolk preview.
            if (!vm.viewAsKinfolk) {
                PrimaryButton(
                    label = "Share link",
                    onClick = { vm.createShareLink(report) },
                    leading = {
                        Icon(
                            Lucide.Share2,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size(15.dp),
                        )
                    },
                )
            }
        }
        if (vm.viewAsKinfolk) {
            AuntieBanner(
                tone = AuntieBannerTone.Info,
                icon = Lucide.Eye,
                body = {
                    Text(
                        "Previewing this KinTale as your kinfolk sees it. Admin controls are hidden.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                },
            )
        }
    }
}

/**
 * Share-link dialog: shows the minted public read-only URL with a copy action, a
 * loading state while createShareLink is in flight, and a fail-loud error banner
 * if minting fails. The URL is always SHOWN (selectable text), so a clipboard
 * failure never hides the link (fail-loud, never fake).
 */
@Composable
private fun ShareLinkDialog(vm: KinTaleReportViewModel) {
    val c = AuntieTheme.colors
    AuntieDialog(
        visible = vm.shareDialogOpen,
        title = "Share this KinTale",
        hint = "A read-only public link your kinfolk can open. No sign-in required.",
        onDismiss = { vm.dismissShareDialog() },
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        footer = {
            GhostButton(label = "Done", onClick = { vm.dismissShareDialog() })
            val url = vm.shareUrl
            if (url != null) {
                PrimaryButton(
                    label = if (vm.shareCopied) "Copied" else "Copy link",
                    onClick = { vm.copyShareUrl() },
                    leading = {
                        Icon(
                            Lucide.Copy,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size(15.dp),
                        )
                    },
                )
            }
        },
    ) {
        when {
            vm.isCreatingShareLink -> EmptyHint("Creating a share link...")
            vm.shareError != null -> AuntieBanner(
                tone = AuntieBannerTone.Error,
                icon = Lucide.CircleAlert,
                body = {
                    Text(
                        vm.shareError ?: "",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                },
            )
            vm.shareUrl != null -> {
                Text(
                    vm.shareUrl ?: "",
                    style = AuntieTheme.typography.mono,
                    color = c.textPrimary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(c.surface2)
                        .padding(14.dp),
                )
            }
        }
    }
}

/**
 * Replies section on a SENT KinTale. Streams the comment thread live and renders a
 * chronological 1-level tree (kinfolk / admin / guest authors), with an admin compose
 * box that posts a top-level comment or a reply via the addKinTaleComment callable.
 * Fail-loud: a read error shows an Error banner (no fabricated rows); a post error
 * surfaces in an Error banner under the compose box.
 */
@Composable
private fun CommentThread(vm: KinTaleReportViewModel, report: KinCareReport, readOnly: Boolean = false) {
    val c = AuntieTheme.colors
    // P0-FLICKER: remember the Flow keyed on the report id, never collect inline.
    val commentsState = remember(report._id) {
        vm.commentsStream(report._id, report.kinfolkId)
    }.collectAsState(FirestoreResult.Loading)

    DenPanel(title = "Replies") {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxWidth()) {
            when (val s = commentsState.value) {
                is FirestoreResult.Loading -> EmptyHint("Loading comments...")
                is FirestoreResult.Error -> AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    icon = Lucide.CircleAlert,
                    body = {
                        Text(
                            "Could not load comments: ${s.message}",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                    },
                )
                is FirestoreResult.Data -> {
                    val rows = buildCommentThread(s.value)
                    if (rows.isEmpty()) {
                        EmptyHint("No replies yet. Start the conversation below.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                            rows.forEach { row ->
                                CommentRowView(
                                    row = row,
                                    isReplyTarget = vm.replyTargetId == row.comment._id,
                                    onReply = { vm.setReplyTarget(row.comment._id) },
                                    canReply = !readOnly,
                                )
                            }
                        }
                    }
                }
            }

            // In the kinfolk preview the admin compose box is hidden: a kinfolk on
            // the public share would only read the thread, not post as the auntie.
            if (readOnly) return@Column

            // ── Admin compose box (posts authorRole='admin'). ──
            if (vm.replyTargetId != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Replying to a comment.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                    GhostButton(label = "Cancel reply", onClick = { vm.setReplyTarget(null) })
                }
            }
            MultilineField(
                value = vm.commentDraft,
                onValueChange = { vm.updateCommentDraft(it) },
                label = if (vm.replyTargetId != null) "Your reply" else "Add a comment",
                placeholder = "Write a note back to the kinfolk...",
                minLines = 3,
                isError = vm.commentError != null,
                modifier = Modifier.fillMaxWidth(),
            )
            vm.commentError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    icon = Lucide.CircleAlert,
                    body = {
                        Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    },
                )
            }
            PrimaryButton(
                label = if (vm.replyTargetId != null) "Post reply" else "Post comment",
                onClick = { vm.postComment(report._id, report.kinfolkId) },
                enabled = !vm.isPostingComment,
                loading = vm.isPostingComment,
                leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
        }
    }
}

/**
 * Compact relative-time label for a comment timestamp (epoch ms). Coarse buckets
 * keep it deterministic and locale-free: "just now", "5m ago", "3h ago", "2d ago".
 * Future or zero timestamps fall back to "just now" rather than rendering nonsense.
 */
@OptIn(kotlin.time.ExperimentalTime::class)
private fun relativeTimeLabel(epochMs: Long): String {
    val now = Clock.System.now().toEpochMilliseconds()
    val diff = now - epochMs
    if (diff < 60_000L) return "just now"
    val minutes = diff / 60_000L
    if (minutes < 60L) return "${minutes}m ago"
    val hours = minutes / 60L
    if (hours < 24L) return "${hours}h ago"
    val days = hours / 24L
    return "${days}d ago"
}

/** One comment row: avatar + author label + body + relative time + a Reply affordance. */
@Composable
private fun CommentRowView(row: CommentRow, isReplyTarget: Boolean, onReply: () -> Unit, canReply: Boolean = true) {
    val c = AuntieTheme.colors
    val comment = row.comment
    val authorLabel = when (comment.authorRole) {
        "admin" -> "Auntie"
        "guest" -> comment.guestName?.takeIf { it.isNotBlank() } ?: "Guest"
        else -> "Kinfolk"
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = if (row.isReply) 28.dp else 0.dp),
    ) {
        AuntieAvatar(initials = authorLabel.take(2), size = 32.dp, ring = false)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(authorLabel, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                comment.createdAtMs?.let { ms ->
                    Text(relativeTimeLabel(ms), style = AuntieTheme.typography.bodySmall, color = c.textFaint)
                }
            }
            Text(comment.body, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            if (!row.isReply && canReply) {
                GhostButton(label = if (isReplyTarget) "Replying" else "Reply", onClick = onReply, enabled = !isReplyTarget)
            }
        }
    }
}

/** Cover hero: warm orange→pink brand gradient, eyebrow + author/recipient line. */
@Composable
private fun ReportCover(report: KinCareReport) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(Brush.linearGradient(c.orangeToPinkColors)),
        contentAlignment = Alignment.BottomStart,
    ) {
        Column(modifier = Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "KINTALE · VISIT RECAP",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.4.sp),
                color = c.background,
            )
            val author = report.authorDisplayName.ifBlank { "Auntie" }
            val recipient = report.kinfolkName.ifBlank { "your kinfolk" }
            if (report.title.isNotBlank()) {
                // Auntie-authored headline carries the cover; the from-line is
                // demoted to a smaller sub-line beneath it.
                Text(
                    report.title,
                    style = AuntieTheme.typography.displayLarge,
                    color = c.background,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "From $author for $recipient",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.background.copy(alpha = 0.9f),
                )
            } else {
                // Honest fallback: no headline authored, the from-line carries the
                // cover exactly as before.
                Text(
                    "From $author for $recipient",
                    style = AuntieTheme.typography.titleLarge,
                    color = c.background,
                )
            }
        }
    }
}

/**
 * Photos section, resolved to REAL media. mediaFileIds on the report tell us how
 * many were attached; the live media stream resolves them to thumbnails + video
 * duration pips. If the report says photos exist but the stream has none, we fail
 * loud with a hint rather than fabricate tiles.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PhotosPanel(report: KinCareReport, media: List<MediaFile>) {
    val c = AuntieTheme.colors
    if (report.mediaFileIds.isEmpty() && media.isEmpty()) return

    // Prefer the live media docs (carry URLs); fall back to the id count.
    val attachedCount = if (media.isNotEmpty()) media.size else report.mediaFileIds.size

    DenPanel(title = "Photos", trailing = {
        Text(
            "$attachedCount attached",
            style = AuntieTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
            color = c.primary,
        )
    }) {
        when {
            media.isEmpty() ->
                // mediaFileIds say photos exist but none resolved from the stream.
                EmptyHint(
                    "$attachedCount file(s) attached but no media resolved yet.",
                    error = false,
                )
            else -> FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                media.forEach { m -> PhotoTile(m) }
            }
        }
    }
}

/** A single resolved media tile: real thumbnail + video duration pip. */
@Composable
private fun PhotoTile(media: MediaFile) {
    val c = AuntieTheme.colors
    val isVideo = media.fileType.equals("VIDEO", ignoreCase = true)
    val url = media.thumbnailUrl.ifBlank { media.storageUrl }
    Box(modifier = Modifier.size(112.dp), contentAlignment = Alignment.BottomEnd) {
        AuntieAvatar(
            imageUrl = url.ifBlank { null },
            emoji = if (url.isBlank()) "🐾" else null,
            size = 112.dp,
            shape = RoundedCornerShape(14.dp),
            ring = false,
            gradientSeed = media._id,
        )
        if (isVideo) {
            val seconds = media.durationSeconds.coerceAtMost(15)
            Box(
                modifier = Modifier
                    .padding(8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(c.background.copy(alpha = 0.78f))
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            ) {
                Text(
                    "VIDEO · 0:${seconds.toString().padStart(2, '0')}",
                    style = AuntieTheme.typography.mono.copy(fontSize = 9.sp, letterSpacing = 0.4.sp),
                    color = c.textPrimary,
                )
            }
        }
    }
}

/** Recipients / author rows. */
@Composable
private fun RecipientsPanel(report: KinCareReport) {
    if (report.kinfolkName.isBlank() && report.kinIds.isEmpty() && report.authorDisplayName.isBlank()) return
    DenPanel(title = "Goes to") {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (report.kinfolkName.isNotBlank()) {
                RecipientRow(title = report.kinfolkName, subtitle = "Kinfolk", seed = report.kinfolkName)
            }
            if (report.kinIds.isNotEmpty()) {
                RecipientRow(
                    title = "${report.kinIds.size} kin",
                    subtitle = "On this visit",
                    seed = report.kinIds.firstOrNull() ?: "kin",
                    emoji = "🐾",
                )
            }
            if (report.authorDisplayName.isNotBlank()) {
                RecipientRow(title = report.authorDisplayName, subtitle = "Author", seed = report.authorDisplayName)
            }
        }
    }
}

/** Visit meta: serviceType, visitDate, arrivedAt, departedAt. */
@Composable
private fun VisitMetaPanel(report: KinCareReport) {
    if (report.serviceType.isBlank() && report.visitDate.isBlank() &&
        report.arrivedAt.isBlank() && report.departedAt.isBlank()
    ) return
    DenPanel(title = "Visit", trailing = {
        if (report.serviceType.isNotBlank()) ServicePill(report.serviceType)
    }) {
        Column {
            if (report.visitDate.isNotBlank()) {
                AuntieKeyValueRow(label = "Visit date", value = report.visitDate, valueMono = true)
            }
            if (report.arrivedAt.isNotBlank()) {
                AuntieKeyValueRow(label = "Arrived", value = report.arrivedAt, valueMono = true)
            }
            if (report.departedAt.isNotBlank()) {
                AuntieKeyValueRow(
                    label = "Departed",
                    value = report.departedAt,
                    valueMono = true,
                    showDivider = false,
                )
            }
        }
    }
}

/** Delivery receipt: sentAt + sentVia (+ deliveryReceiptId). The send pipeline now
 *  reliably writes a real deliveryReceiptId (first dispatchId from
 *  dispatchVisitNotification), so the SUGGESTION tag is gone. Blank fields are
 *  still skipped (e.g. a suppressed dispatch with no channels omits the receipt
 *  row rather than faking an id). */
@Composable
private fun DeliveryPanel(report: KinCareReport) {
    if (report.sentAt.isBlank() && report.sentVia.isBlank() && report.deliveryReceiptId.isBlank()) return
    DenPanel(title = "Delivery") {
        Column {
            if (report.sentAt.isNotBlank()) {
                AuntieKeyValueRow(label = "Sent at", value = report.sentAt, valueMono = true)
            }
            if (report.sentVia.isNotBlank()) {
                AuntieKeyValueRow(label = "Sent via", value = report.sentVia, valueMono = true)
            }
            if (report.deliveryReceiptId.isNotBlank()) {
                AuntieKeyValueRow(
                    label = "Receipt",
                    value = report.deliveryReceiptId,
                    valueMono = true,
                    showDivider = false,
                )
            }
        }
    }
}

/** A recipient / author row: avatar + name + subtitle. */
@Composable
private fun RecipientRow(title: String, subtitle: String, seed: String, emoji: String? = null) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AuntieAvatar(
            initials = if (emoji == null) title else null,
            emoji = emoji,
            size = 42.dp,
            shape = RoundedCornerShape(13.dp),
            gradientSeed = seed,
        )
        Column {
            Text(title, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            Text(subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

/**
 * Per-pet and overall (per-visit) checklist sections, driven by the real
 * fieldResponses map. Item labels resolve from the DefaultKinTaleTemplate by key.
 * Only checked items render (showWhenUnchecked=false, Precise semantics).
 */
/**
 * Per-kin checklist heading: joins the report's raw [kinId] to a real kin
 * (spec 11 item 4.1) and renders "Name · Species · Breed", dropping any blank
 * part. Falls back to the raw [kinId] when the kin can't be resolved or has no
 * name, so a missing join shows the id rather than a fabricated pet name. Pure;
 * unit-tested.
 */
internal fun kinHeading(kinId: String, kinById: Map<String, Kin>): String {
    val kin = kinById[kinId] ?: return kinId
    if (kin.name.isBlank()) return kinId
    return listOf(kin.name, kin.species, kin.breed)
        .filter { it.isNotBlank() }
        .joinToString(" · ")
}

/**
 * Render-only shim around [kinHeading]: emits the same per-kin checklist heading
 * Text the report screen draws (KinTaleReportScreen ChecklistSections), but in
 * isolation so the desktop compose UI test can render the join without building a
 * full KinCareReport. Behavior-neutral: same helper, same Text style.
 */
@Composable
internal fun KinHeadingText(kinId: String, kinById: Map<String, Kin>) {
    Text(
        kinHeading(kinId, kinById),
        style = AuntieTheme.typography.titleMedium,
        color = AuntieTheme.colors.textPrimary,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChecklistSections(report: KinCareReport, kinById: Map<String, Kin>) {
    val c = AuntieTheme.colors
    if (report.fieldResponses.isEmpty()) return

    // Render off the REAL template the visit used (custom item labels + custom
    // keys), not the built-in default, and honor conditions - so the sent report
    // never shows an item a condition excludes and never drops a custom item.
    // Streams the best-fit active template for the report's service type (same
    // selection the composer used); falls back to the built-in default until it
    // resolves. Matches the Android report (which already uses the real template).
    val client = remember { FirestoreClient() }
    val template by remember(report.serviceType) {
        client.activeTemplateForService(report.serviceType)
    }.collectAsState(initial = DefaultKinTaleTemplate.template)

    // The household the visit belongs to, for the KINFOLK_* conditions. Without
    // it those rules evaluate against an empty household and silently hide
    // checked items (see resolveSentChecklist). remember{} so the stream is not
    // re-subscribed every recomposition.
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolk = (kinfolkState as? FirestoreResult.Data)?.value?.firstOrNull { it._id == report.kinfolkId }

    val resolved = resolveSentChecklist(template, report, kinById, kinfolk)
    if (resolved.perKin.isEmpty() && resolved.perVisit.isEmpty()) return

    @Composable
    fun chipsFor(items: List<SentChecklistItem>) {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items.forEach { item ->
                AuntieChip(
                    label = item.label,
                    selected = true,
                    tone = AuntieChipTone.Teal,
                    leading = {
                        Icon(
                            Lucide.Check,
                            contentDescription = null,
                            tint = c.accent,
                            modifier = Modifier.size(13.dp),
                        )
                    },
                )
            }
        }
    }

    resolved.perKin.forEach { kinChecklist ->
        DenPanel(title = "Checklist") {
            Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AuntieAvatar(
                        emoji = "🐾",
                        size = 34.dp,
                        shape = RoundedCornerShape(11.dp),
                        gradientSeed = kinChecklist.kinId,
                    )
                    // Real "Name · Species · Breed" joined from the live kin
                    // stream (spec 11 item 4.1). Falls back to the raw kinId
                    // when the kin can't be resolved: never invents a name.
                    Text(
                        kinHeading(kinChecklist.kinId, kinById),
                        style = AuntieTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
                }
                chipsFor(kinChecklist.items)
            }
        }
    }

    if (resolved.perVisit.isNotEmpty()) {
        DenPanel(title = "Overall visit checklist") {
            Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                chipsFor(resolved.perVisit)
                AuntieNoteCallout(text = "Things that apply to the whole visit")
            }
        }
    }
}
