package com.tribetails.auntieos.ui.kintales

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.LaunchedEffect
import coil3.compose.AsyncImage
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.X
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MoodOption
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.ui.components.AuntieMediaGrid
import com.tribetails.auntieos.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.DynamicFormFields
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.RouteMap
import com.tribetails.auntieos.ui.components.ServicePill
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ── Feature flags (read via the central ambient LocalFeatureFlags) ──
// Pet-mood is LIVE: the default template ships petMoodEnabled=true with mood
// options, the editor authors petMoodSelections, and the report renders them.
// Reads the central kintalePetMoodPills flag (default on).
// The comment thread is LIVE too: it reads the central kintaleCommentThread flag
// (LocalFeatureFlags, default on) and posts via the addKinTaleComment callable.
// View-as-kinfolk is now LIVE: a real read-only preview + a Share link action that
// mints a kinfolk-facing URL via the createShareLink callable (no flag gate).

/**
 * KinTale report screen (Den redesign), adapted from the web counterpart.
 *
 * Layout is the Den editor: a serif [DenScreenHeading] with a Sent/Draft status
 * pill + Back, an orange→pink gradient cover hero, then stacked [DenPanel]
 * sections for the Narrative, Photos, per-kin Checklist, and visit/recipient
 * meta. Pet mood and the comment thread are live, gated only by an ALWAYS_ON
 * kill-switch (LocalFeatureFlags); view-as-kinfolk has no flag gate at all.
 *
 * Wiring is preserved verbatim from the prior screen: report load, in-memory
 * field edits, draft persistence on blur / section change, media upload/remove,
 * and the send pipeline all go through [KinTaleReportViewModel] unchanged.
 */
@Composable
fun KinTaleReportScreen(
    sessionId: String,
    existingReportId: String?,
    onBack: () -> Unit,
    viewModel: KinTaleReportViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val flags = LocalFeatureFlags.current

    LaunchedEffect(sessionId, existingReportId) {
        viewModel.load(sessionId, existingReportId)
    }

    val pickMedia = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null) viewModel.addMedia(context, uri)
    }

    LaunchedEffect(state.sentSuccessfully) {
        if (state.sentSuccessfully) onBack()
    }

    val isSent = state.report.status == ReportStatus.SENT.name

    AuntieScreenScaffold(
        title = "KinTale Update",
        onBack = {
            viewModel.persistDraft()
            onBack()
        },
        imePaddingEnabled = true,
    ) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (state.isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    AuntieSpinner(modifier = Modifier.size(32.dp), color = AuntieTheme.colors.kinfolkOrange)
                }
            } else if (state.reportLoadFailed) {
                // A RESUME WHOSE READ FAILED GETS NO EDITOR. Rendering the blank
                // scaffold here is what let a transient read failure replace a
                // half-written KinTale with an empty one on the next keystroke: the
                // editor looked like a fresh draft and saved like one. The read is
                // offered again instead.
                Column(
                    modifier = Modifier.fillMaxSize().padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't open this KinTale",
                        icon = Lucide.CircleAlert,
                        trailing = { GhostButton(label = "Retry", onClick = viewModel::retryLoad) },
                        body = {
                            Text(
                                state.error ?: "This KinTale didn't load, so it isn't safe to edit yet.",
                                style = AuntieTheme.typography.bodyMedium,
                                color = AuntieTheme.colors.error,
                            )
                        },
                    )
                    Text(
                        "The saved KinTale is untouched. Nothing typed here would reach it, so " +
                            "load it again before writing.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textDim,
                    )
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)
                ) {
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
                                if (isSent) {
                                    AuntieStatusPill(label = "Sent", tone = AuntieStatusTone.Success, showDot = true)
                                } else {
                                    AuntieStatusPill(label = "Draft", tone = AuntieStatusTone.Orange, showDot = true)
                                }
                                GhostButton(
                                    label = "Back",
                                    onClick = {
                                        viewModel.persistDraft()
                                        onBack()
                                    },
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

                    // ── Cover hero: orange→pink brand gradient. Editable headline + author/recipient line. ──
                    ReportCover(
                        state = state,
                        onTitleChange = viewModel::updateTitle,
                        onTitleBlur = viewModel::persistDraft,
                    )

                    // ── View as kinfolk + Share link (live). Available once the report
                    // is SENT and a real id exists (createShareLink needs the persisted
                    // kin_care_reports doc). The toggle reveals a read-only kinfolk-facing
                    // preview with NO admin controls; Share link mints a kinfolk URL via
                    // the createShareLink callable. ──
                    if (isSent && state.report.id.isNotBlank()) {
                        ShareSection(
                            state = state,
                            onToggleView = viewModel::toggleViewAsKinfolk,
                            onShare = viewModel::requestShareLink,
                            onDismissShareError = viewModel::clearShareError,
                        )
                    }

                    // ── KinTale Narrative: the auntie's bodyCopy editor. ──
                    if (state.template.visitNotesEnabled) {
                        NarrativeSection(
                            bodyCopy = state.report.bodyCopy,
                            onChange = viewModel::updateBodyCopy,
                            onBlur = viewModel::persistDraft,
                            isGenerating = state.isGenerating,
                            onGenerate = { viewModel.generateDraft(flags.communicateGenerateViaFunction) },
                        )
                    }

                    // ── Photos: real uploaded MediaFile docs (entityType VISIT_LOG). ──
                    if (state.template.photoShowcaseEnabled) {
                        PhotosSection(
                            media = state.uploadedMedia,
                            attachedIdCount = state.report.mediaFileIds.size,
                            isUploading = state.isUploading,
                            onPickMedia = { pickMedia.launch("image/*") },
                            onRemoveMedia = viewModel::removeMedia,
                        )
                    }

                    // ── Per-kin + per-visit checklist from the live template + responses. ──
                    if (state.template.checklistEnabled && state.template.checklistItems.isNotEmpty()) {
                        ChecklistSection(
                            items = state.template.checklistItems.sortedBy { it.order },
                            kinList = state.kinList,
                            state = state,
                            viewModel = viewModel,
                        )
                    }

                    // ── Custom fields (admin-authored KINTALE form_schemas, Phase 14). ──
                    // Distinct from the template checklist above; answers persist into
                    // report.formValues. Only shown when a schema exists or a load failed.
                    if (state.kinTaleSchemas.isNotEmpty() || state.schemaError != null) {
                        DenPanel(title = "Custom fields") {
                            when {
                                // Fail loud: surface a schema load failure, never swallow it.
                                state.schemaError != null -> Text(
                                    "Couldn't load the custom fields: ${state.schemaError}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.error,
                                )
                                else -> DynamicFormFields(
                                    schemas = state.kinTaleSchemas,
                                    values = state.report.formValues,
                                    onValueChange = viewModel::updateFormValue,
                                )
                            }
                        }
                    }

                    // Per-pet mood pills (live). Renders only when the template
                    // enables pet mood and has options, and there are kin to tag.
                    if (LocalFeatureFlags.current.kintalePetMoodPills &&
                        state.template.petMoodEnabled &&
                        state.template.moodOptions.isNotEmpty() &&
                        state.kinList.isNotEmpty()
                    ) {
                        PetMoodSection(
                            kinList = state.kinList,
                            moodOptions = state.template.moodOptions.sortedBy { it.order },
                            selections = state.report.petMoodSelections,
                            onSelectMood = viewModel::setMoodForKin,
                        )
                    }

                    // ── GPS Route: read-only render of the captured trail. ──
                    if (state.gpsRoute.isNotEmpty()) {
                        GpsRouteSection(points = state.gpsRoute)
                    }

                    // ── Recipients + visit meta + delivery (the mockup's right rail). ──
                    RecipientsPanel(state)
                    VisitMetaPanel(state)
                    // Delivery receipt on a SENT report: the send pipeline writes a
                    // real deliveryReceiptId (first dispatchId), so this renders
                    // untagged (no SUGGESTION pill), at parity with web/desktop.
                    if (isSent) {
                        DeliveryPanel(state.report)
                    }

                    // ── KinTale comment thread (forum-style, 1-level). Live read from
                    // kin_care_reports/{taleId}/comments; admin posts via addKinTaleComment.
                    // Shown only on a SENT report once a real report id exists. The flag is
                    // a kill-switch (default on); when off, the section is hidden. ──
                    val commentThreadEnabled = LocalFeatureFlags.current.kintaleCommentThread
                    if (commentThreadEnabled && isSent && state.report.id.isNotBlank()) {
                        LaunchedEffect(state.report.id) { viewModel.observeComments(state.report.id) }
                        CommentThreadSection(
                            state = state,
                            onDraftChange = viewModel::updateCommentDraft,
                            onSetReplyTarget = viewModel::setReplyTarget,
                            onPost = {
                                viewModel.postComment(state.report.id, state.report.kinfolkId)
                            },
                        )
                    }

                    // Fail-loud: surface any save/send error inline, never swallow it.
                    state.error?.let { msg ->
                        AuntieBanner(
                            tone = AuntieBannerTone.Error,
                            icon = Lucide.CircleAlert,
                            onDismiss = viewModel::clearError,
                            body = {
                                Text(
                                    msg,
                                    style = AuntieTheme.typography.bodyMedium,
                                    color = AuntieTheme.colors.error,
                                )
                            },
                        )
                    }
                }
            }
        }

        // ── Save / Send action bar ──
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.background)
                .padding(16.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // The draft saves itself, so it has to say so - and say WHEN it last
            // succeeded. A silent autosave that fails is worse than none, because
            // the sitter stops thinking about whether the work is safe.
            if (!isSent) {
                val savedAt = state.lastSavedAtMillis
                val (autosaveLabel, autosaveColor) = when {
                    state.isSaving -> "Saving..." to AuntieTheme.colors.kinfolkOrange
                    state.saveStatus == SaveStatus.ERROR ->
                        "Not saved. Still on this phone only." to AuntieTheme.colors.error
                    state.hasUnsavedChanges -> "Unsaved changes" to AuntieTheme.colors.textDim
                    savedAt != null -> "Saved ${formatSavedAt(savedAt)}" to AuntieTheme.colors.success
                    else -> "Saves as you write" to AuntieTheme.colors.textDim
                }
                Text(
                    autosaveLabel,
                    style = AuntieTheme.typography.labelSmall,
                    color = autosaveColor,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                GhostButton(
                    label = when {
                        isSent -> "Saved"
                        state.hasUnsavedChanges || state.saveStatus == SaveStatus.ERROR -> "Save now"
                        state.saveStatus == SaveStatus.SAVED && !state.isSaving -> "Draft saved"
                        else -> "Save Draft"
                    },
                    onClick = { viewModel.persistDraft() },
                    modifier = Modifier.weight(1f),
                    enabled = !state.isSaving && !state.isSending
                )
                PrimaryButton(
                    label = if (state.isSending) "Sending..." else kinTaleSendLabel(state.session?.kinfolkName.orEmpty()),
                    onClick = { viewModel.send() },
                    modifier = Modifier.weight(1f),
                    enabled = !state.isSending && !isSent,
                    loading = state.isSending,
                    leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(18.dp)) }
                )
            }
            }
        }
    }
}

/**
 * The clock time of the last accepted save, as the sitter would read it off a
 * watch. Deliberately not "2 minutes ago": a relative label goes stale the moment
 * the screen stops recomposing, and this one is a promise about their work.
 */
internal fun formatSavedAt(millis: Long): String =
    java.text.SimpleDateFormat("h:mm a", java.util.Locale.getDefault())
        .format(java.util.Date(millis))

// ───────────────────────────── Hero ─────────────────────────────

/**
 * Cover hero: warm orange→pink brand gradient, eyebrow + editable headline.
 * The auntie types a headline that becomes the cover title; when blank the
 * "From {author} for {kinfolk}" line carries the cover (honest fallback). When a
 * headline is set, that line is demoted to a smaller sub-line beneath the field.
 */
@Composable
private fun ReportCover(
    state: KinTaleUiState,
    onTitleChange: (String) -> Unit,
    onTitleBlur: () -> Unit,
) {
    val c = AuntieTheme.colors
    val author = state.report.authorDisplayName.ifBlank { "Auntie" }
    val recipient = state.report.kinfolkName
        .ifBlank { state.kinfolk?.displayName.orEmpty() }
        .ifBlank { "your kinfolk" }
    val hasTitle = state.report.title.isNotBlank()
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 180.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(Brush.linearGradient(c.orangeToPinkColors)),
        contentAlignment = Alignment.BottomStart,
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "KINTALE · VISIT RECAP",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.4.sp),
                color = c.background,
            )
            // Editable headline. The field's glass styling keeps it legible on the
            // gradient; placeholder is a neutral hint, never written as the value.
            AuntieField(
                value = state.report.title,
                onValueChange = onTitleChange,
                placeholder = "Add a headline for $recipient",
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { focus -> if (!focus.isFocused) onTitleBlur() },
            )
            Text(
                "From $author for $recipient",
                style = if (hasTitle) {
                    AuntieTheme.typography.bodyMedium
                } else {
                    AuntieTheme.typography.titleLarge
                },
                color = c.background.copy(alpha = if (hasTitle) 0.9f else 1f),
            )
        }
    }
}

// ───────────────────────────── Narrative ─────────────────────────────

@Composable
private fun NarrativeSection(
    bodyCopy: String,
    onChange: (String) -> Unit,
    onBlur: () -> Unit,
    isGenerating: Boolean,
    onGenerate: () -> Unit,
) {
    DenPanel(
        title = "KinTale Narrative",
        subtitle = "This narrative is what your kinfolk reads first.",
    ) {
        AuntieField(
            value = bodyCopy,
            onValueChange = onChange,
            placeholder = "Tell the story, or jot shorthand and let Auntie draft it.",
            singleLine = false,
            minLines = 7,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 160.dp)
                .onFocusChanged { focus -> if (!focus.isFocused) onBlur() },
        )
        Spacer(Modifier.height(8.dp))
        GhostButton(
            label = if (isGenerating) "Auntie's writing…" else "Generate draft",
            onClick = onGenerate,
            enabled = !isGenerating,
        )
    }
}

// ───────────────────────────── Photos ─────────────────────────────

/**
 * Photos section, resolved to REAL media. [media] are the uploaded VISIT_LOG docs
 * (carry URLs). If the report says photos exist ([attachedIdCount] > 0) but none
 * resolved, fail loud with an honest hint rather than fabricate tiles.
 */
@Composable
private fun PhotosSection(
    media: List<MediaFile>,
    attachedIdCount: Int,
    isUploading: Boolean,
    onPickMedia: () -> Unit,
    onRemoveMedia: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val attachedCount = if (media.isNotEmpty()) media.size else attachedIdCount
    DenPanel(
        title = "Photos",
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "$attachedCount attached",
                    style = AuntieTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
                    color = c.primary,
                )
                if (isUploading) {
                    AuntieSpinner(modifier = Modifier.size(18.dp), color = c.kinfolkOrange, strokeWidth = 2.dp)
                }
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AddMomentTile(onClick = onPickMedia)
            when {
                media.isEmpty() && attachedIdCount > 0 ->
                    // mediaFileIds say photos exist but none resolved yet.
                    EmptyHint("$attachedCount file(s) attached but no media resolved yet.", error = false)
                media.isEmpty() ->
                    EmptyHint("No moments captured yet. Add one above.")
                else ->
                    AuntieMediaGrid(
                        items = media,
                        key = { it.id },
                        modifier = Modifier.heightIn(max = 480.dp),
                    ) { m ->
                        PhotoCell(media = m, onRemove = { onRemoveMedia(m.id) })
                    }
            }
        }
    }
}

@Composable
private fun AddMomentTile(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.primary.copy(alpha = 0.10f))
            .border(1.dp, c.primary.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AuntieIconTile(icon = Lucide.PawPrint, size = 36.dp, tone = AuntieStatusTone.Orange)
        Text("Add Moment", style = AuntieTheme.typography.titleMedium, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
    }
}

/** A single resolved media tile: real thumbnail + remove affordance. */
@Composable
private fun PhotoCell(media: MediaFile, onRemove: () -> Unit) {
    val c = AuntieTheme.colors
    Box(modifier = Modifier.fillMaxSize()) {
        AsyncImage(
            model = media.thumbnailUrl.ifBlank { media.storageUrl },
            contentDescription = media.description,
            modifier = Modifier.fillMaxSize(),
        )
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(6.dp)
                .size(24.dp)
                .clip(CircleShape)
                .background(c.background.copy(alpha = 0.7f))
                .clickable(onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.X, contentDescription = "Remove", tint = c.error, modifier = Modifier.size(16.dp))
        }
    }
}

// ───────────────────────────── Checklist ─────────────────────────────

/**
 * Send-button label bound to the REAL recipient household (spec 10 item 1.1),
 * mirroring the web `kinTaleSendLabel`. Falls back to neutral copy when the
 * household name is blank, never a hardcoded sample name. Pure; unit-tested.
 */
internal fun kinTaleSendLabel(recipient: String): String =
    if (recipient.isBlank()) "Send KinTale" else "Send to $recipient"

/**
 * Per-kin heading text: "Name · Species · Breed" from a real [Kin] (spec 11
 * item 4.1), dropping any blank part, and falling back to the raw kin id when the
 * kin has no name (never invents a pet name). Mirrors the web `kinHeading`. Pure;
 * unit-tested.
 */
internal fun kinHeading(kin: Kin): String {
    if (kin.name.isBlank()) return kin.id
    return listOf(kin.name, kin.species, kin.breed)
        .filter { it.isNotBlank() }
        .joinToString(" · ")
}

/**
 * Render-only shim around [kinHeading]: emits the same per-kin checklist heading
 * Text the report screen draws (ChecklistSection), in isolation so the Robolectric
 * compose UI test can render the join without building a full report state.
 * Behavior-neutral: same helper, same Text style.
 */
@Composable
internal fun KinHeadingText(kin: Kin) {
    Text(
        kinHeading(kin),
        style = AuntieTheme.typography.titleMedium,
        color = AuntieTheme.colors.textPrimary,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Checklist visibility seams: the two places this screen asks the engine what to
// show. Pure, so they are unit-tested without a Compose runtime
// ([KinTaleConditionEditorHelpersTest]), and mirrored in the commonMain
// KinTaleConditionEditorHelpers.kt that serves web and desktop.
//
// [kinfolk] has NO default value on either seam, on purpose. The engine fails
// OPEN on data it cannot resolve, so a call site that omits the household turns
// every KINFOLK_ATTRIBUTE / KINFOLK_TAG rule into "always show" with no error at
// all: the exact silent-wrong-answer bug I7 exists to close. Forcing the argument
// at every call site makes that omission a compile error rather than a live bug.
// [KinTaleEngineCallSiteTest] scans the sources to keep it that way.
// ─────────────────────────────────────────────────────────────────────────────

/** The per-pet checklist items [kin] actually qualifies for in this visit. */
internal fun applicablePerPetItems(
    items: List<ChecklistItem>,
    session: KinCareSession,
    kinList: List<Kin>,
    kin: Kin,
    kinfolk: Kinfolk?,
): List<ChecklistItem> = items.filter { item ->
    KinTaleTemplateEngine.applicableKinForChecklistItem(item, session, kinList, kinfolk)
        .any { it.id == kin.id }
}

/** The per-visit checklist items this visit qualifies for. */
internal fun visiblePerVisitItems(
    items: List<ChecklistItem>,
    session: KinCareSession,
    kinList: List<Kin>,
    kinfolk: Kinfolk?,
): List<ChecklistItem> = items.filter {
    KinTaleTemplateEngine.isChecklistItemVisible(it, session, kinList, kinfolk)
}

/**
 * Per-kin (PER_PET) and overall (PER_VISIT) checklist, driven by the live
 * template + the real fieldResponses map via the ViewModel. Per-kin headings use
 * the joined Kin name/species/breed when available, falling back to the raw kin
 * id otherwise (no invented pet names). Each row is a toggleable teal check pill.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChecklistSection(
    items: List<ChecklistItem>,
    kinList: List<Kin>,
    state: KinTaleUiState,
    viewModel: KinTaleReportViewModel,
) {
    val session = state.session ?: return
    val perVisit = items.filter { it.scope == ChecklistScope.PER_VISIT.name }
    val perPet = items.filter { it.scope == ChecklistScope.PER_PET.name }

    if (perPet.isNotEmpty()) {
        kinList.forEach { kin ->
            val applicableItems = applicablePerPetItems(perPet, session, kinList, kin, state.kinfolk)
            if (applicableItems.isNotEmpty()) {
                DenPanel(title = "Checklist") {
                    Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            AuntieIconTile(
                                icon = Lucide.PawPrint,
                                size = 34.dp,
                                tone = AuntieStatusTone.Orange,
                            )
                            Text(
                                kinHeading(kin),
                                style = AuntieTheme.typography.titleMedium,
                                color = AuntieTheme.colors.textPrimary,
                            )
                        }
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            applicableItems.forEach { item ->
                                ChecklistCheckPill(
                                    label = item.text,
                                    checked = viewModel.responseFor(item.key, kin.id).boolValue == true,
                                    onClick = {
                                        viewModel.setChecklistResponse(
                                            item.key,
                                            kin.id,
                                            viewModel.responseFor(item.key, kin.id).boolValue != true,
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    val visiblePerVisit = visiblePerVisitItems(perVisit, session, kinList, state.kinfolk)
    if (visiblePerVisit.isNotEmpty()) {
        DenPanel(title = "Overall visit checklist") {
            Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    visiblePerVisit.forEach { item ->
                        ChecklistCheckPill(
                            label = item.text,
                            checked = viewModel.responseFor(item.key, "").boolValue == true,
                            onClick = {
                                viewModel.setChecklistResponse(
                                    item.key,
                                    "",
                                    viewModel.responseFor(item.key, "").boolValue != true,
                                )
                            },
                        )
                    }
                }
                AuntieNoteCallout(text = "Things that apply to the whole visit")
            }
        }
    }
}

/** A toggleable teal check pill, matching the Den checklist treatment. */
@Composable
private fun ChecklistCheckPill(label: String, checked: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val tint = c.accent
    val bg = if (checked) tint.copy(alpha = 0.16f) else c.surface2
    val borderColor = if (checked) tint.copy(alpha = 0.5f) else c.border
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (checked) {
            Icon(Lucide.Check, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        }
        Text(
            label,
            style = AuntieTheme.typography.labelMedium,
            color = if (checked) c.textPrimary else c.textDim,
        )
    }
}

// ───────────────────────────── Pet mood (gated) ─────────────────────────────

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PetMoodSection(
    kinList: List<Kin>,
    moodOptions: List<MoodOption>,
    selections: Map<String, String>,
    onSelectMood: (String, String) -> Unit,
) {
    DenPanel(
        title = "Pet mood",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            kinList.forEach { kin ->
                Column {
                    Text(
                        kinHeading(kin),
                        style = AuntieTheme.typography.titleMedium,
                        color = AuntieTheme.colors.primary,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.height(6.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        moodOptions.forEach { mood ->
                            MoodChip(
                                label = mood.label,
                                emoji = mood.emoji,
                                selected = selections[kin.id] == mood.key,
                                onClick = { onSelectMood(kin.id, mood.key) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MoodChip(label: String, emoji: String, selected: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val tint = c.tertiary
    val borderColor = if (selected) tint else c.border
    val bg = if (selected) tint.copy(alpha = 0.15f) else c.surface2
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(emoji, style = AuntieTheme.typography.titleLarge)
        Text(label, style = AuntieTheme.typography.labelSmall, color = if (selected) tint else c.textDim)
    }
}

// ───────────────────────────── Comment thread ─────────────────────────────

/**
 * Replies section on a SENT KinTale. Renders the live thread as a chronological
 * 1-level tree (kinfolk / admin / guest authors) with an admin compose box that
 * posts a top-level comment or a reply via the addKinTaleComment callable (server
 * forces authorRole='admin'). Fail-loud: a read error shows an Error banner (no
 * fabricated rows); a post error surfaces in an Error banner under the compose box.
 */
@Composable
private fun CommentThreadSection(
    state: KinTaleUiState,
    onDraftChange: (String) -> Unit,
    onSetReplyTarget: (String?) -> Unit,
    onPost: () -> Unit,
) {
    val c = AuntieTheme.colors
    DenPanel(title = "Replies") {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxWidth()) {
            when (val s = state.comments) {
                is KinTaleCommentsRepository.CommentsState.Loading ->
                    EmptyHint("Loading comments...")
                is KinTaleCommentsRepository.CommentsState.Error ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        icon = Lucide.CircleAlert,
                        body = {
                            Text(
                                "Could not load comments: ${s.message}",
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.error,
                            )
                        },
                    )
                is KinTaleCommentsRepository.CommentsState.Data -> {
                    val rows = KinTaleCommentsRepository.buildCommentThread(s.comments)
                    if (rows.isEmpty()) {
                        EmptyHint("No replies yet. Start the conversation below.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                            rows.forEach { row ->
                                CommentRowView(
                                    row = row,
                                    isReplyTarget = state.replyTargetId == row.comment.id,
                                    onReply = { onSetReplyTarget(row.comment.id) },
                                )
                            }
                        }
                    }
                }
            }

            // ── Admin compose box (posts authorRole='admin'). ──
            if (state.replyTargetId != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Replying to a comment.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                    GhostButton(label = "Cancel reply", onClick = { onSetReplyTarget(null) })
                }
            }
            AuntieField(
                value = state.commentDraft,
                onValueChange = onDraftChange,
                placeholder = "Write a note back to the kinfolk...",
                singleLine = false,
                minLines = 3,
                isError = state.commentError != null,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 96.dp),
            )
            state.commentError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    icon = Lucide.CircleAlert,
                    body = {
                        Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.error)
                    },
                )
            }
            PrimaryButton(
                label = if (state.replyTargetId != null) "Post reply" else "Post comment",
                onClick = onPost,
                enabled = !state.isPostingComment,
                loading = state.isPostingComment,
                leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
        }
    }
}

/** One comment row: avatar + author label + body + relative time + a Reply affordance. */
@Composable
private fun CommentRowView(
    row: KinTaleCommentsRepository.CommentRow,
    isReplyTarget: Boolean,
    onReply: () -> Unit,
) {
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
            if (!row.isReply) {
                GhostButton(label = if (isReplyTarget) "Replying" else "Reply", onClick = onReply, enabled = !isReplyTarget)
            }
        }
    }
}

/**
 * Compact relative-time label for a comment timestamp (epoch ms). Coarse buckets
 * keep it deterministic and locale-free: "just now", "5m ago", "3h ago", "2d ago".
 * Future or zero timestamps fall back to "just now". Pure; unit-testable.
 */
internal fun relativeTimeLabel(epochMs: Long, nowMs: Long = System.currentTimeMillis()): String {
    val diff = nowMs - epochMs
    if (diff < 60_000L) return "just now"
    val minutes = diff / 60_000L
    if (minutes < 60L) return "${minutes}m ago"
    val hours = minutes / 60L
    if (hours < 24L) return "${hours}h ago"
    val days = hours / 24L
    return "${days}d ago"
}

// ───────────────────────────── GPS Route ─────────────────────────────

@Composable
private fun GpsRouteSection(points: List<GpsPoint>) {
    DenPanel(title = "GPS Route") {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    Lucide.MapPin,
                    contentDescription = null,
                    tint = AuntieTheme.colors.accent,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    "Captured trail",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textDim,
                )
            }
            RouteMap(points = points, live = false)
        }
    }
}

// ───────────────────────────── Recipients + meta ─────────────────────────────

@Composable
private fun RecipientsPanel(state: KinTaleUiState) {
    val report = state.report
    val recipientName = report.kinfolkName.ifBlank { state.kinfolk?.displayName.orEmpty() }
    if (recipientName.isBlank() && state.kinList.isEmpty() && report.authorDisplayName.isBlank()) return
    DenPanel(title = "Goes to") {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (recipientName.isNotBlank()) {
                AuntieKeyValueRow(label = "Kinfolk", value = recipientName)
            }
            if (state.kinList.isNotEmpty()) {
                AuntieKeyValueRow(
                    label = "On this visit",
                    value = state.kinList.joinToString(", ") { it.name.ifBlank { it.id } },
                )
            }
            if (report.authorDisplayName.isNotBlank()) {
                AuntieKeyValueRow(label = "Author", value = report.authorDisplayName, showDivider = false)
            }
        }
    }
}

@Composable
private fun VisitMetaPanel(state: KinTaleUiState) {
    val session = state.session ?: return
    val visitDate = session.startTime.take(10)
    DenPanel(
        title = "Visit",
        trailing = { if (session.serviceType.isNotBlank()) ServicePill(session.serviceType) },
    ) {
        Column {
            AuntieKeyValueRow(label = "Template", value = state.template.name)
            if (visitDate.isNotBlank()) {
                AuntieKeyValueRow(label = "Visit date", value = visitDate, valueMono = true)
            }
            if (!session.arrivedAt.isNullOrBlank()) {
                AuntieKeyValueRow(label = "Arrived", value = session.arrivedAt.orEmpty(), valueMono = true)
            }
            AuntieKeyValueRow(
                label = "Departed",
                value = session.departedAt?.takeIf { it.isNotBlank() } ?: "-",
                valueMono = true,
                showDivider = false,
            )
        }
    }
}

/**
 * Delivery receipt on a SENT KinTale: Sent at / Sent via / Receipt, sourced from
 * the real report fields the send pipeline writes (sentVia="catalog",
 * deliveryReceiptId=first dispatchId). No SUGGESTION pill: the receipt is now
 * reliably populated. Blank fields are skipped (fail-loud by omission, e.g. a
 * suppressed dispatch with no channels omits the receipt row rather than faking
 * an id). Returns nothing when all three are blank.
 */
@Composable
private fun DeliveryPanel(report: KinCareReport) {
    if (report.sentAt.isNullOrBlank() && report.sentVia.isBlank() && report.deliveryReceiptId.isBlank()) return
    DenPanel(title = "Delivery") {
        Column {
            if (!report.sentAt.isNullOrBlank()) {
                AuntieKeyValueRow(label = "Sent at", value = report.sentAt.orEmpty(), valueMono = true)
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

// ───────────────────────────── View as kinfolk + share ─────────────────────────────

/**
 * The read-only narrative a kinfolk sees in the preview. Prefers the authored
 * body copy; when blank, falls back to an honest placeholder rather than fabricating
 * content. Pure; unit-tested.
 */
internal fun kinfolkPreviewBody(report: KinCareReport): String =
    report.bodyCopy.ifBlank { "No narrative was written for this visit." }

/**
 * The cover headline a kinfolk sees. Prefers the authored title; when blank, falls
 * back to the "From {author} for {recipient}" line so the preview is never empty.
 * Pure; unit-tested.
 */
internal fun kinfolkPreviewHeadline(report: KinCareReport): String {
    if (report.title.isNotBlank()) return report.title
    val author = report.authorDisplayName.ifBlank { "Auntie" }
    val recipient = report.kinfolkName.ifBlank { "your kinfolk" }
    return "From $author for $recipient"
}

/**
 * View-as-kinfolk + Share link panel. Toggling the view reveals a read-only,
 * admin-control-free preview of how the kinfolk reads this report. Share link mints
 * a kinfolk-facing URL via the createShareLink callable and surfaces it with a Copy
 * affordance. Fail-loud: a share error renders an Error banner; the URL only shows
 * once the server returns it.
 */
@Composable
private fun ShareSection(
    state: KinTaleUiState,
    onToggleView: () -> Unit,
    onShare: () -> Unit,
    onDismissShareError: () -> Unit,
) {
    val c = AuntieTheme.colors
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    DenPanel(
        title = "Share with kinfolk",
        subtitle = "Preview how the kinfolk reads this update, or create a link to share it.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                GhostButton(
                    label = if (state.viewAsKinfolk) "Hide kinfolk view" else "View as kinfolk",
                    onClick = onToggleView,
                    modifier = Modifier.weight(1f),
                )
                PrimaryButton(
                    label = if (state.isSharing) "Creating..." else "Share link",
                    onClick = onShare,
                    enabled = !state.isSharing,
                    loading = state.isSharing,
                    modifier = Modifier.weight(1f),
                )
            }

            state.shareError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    icon = Lucide.CircleAlert,
                    onDismiss = onDismissShareError,
                    body = {
                        Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.error)
                    },
                )
            }

            state.shareUrl?.let { url ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Share link",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(c.surface2)
                            .border(1.dp, c.border, RoundedCornerShape(10.dp))
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(url, style = AuntieTheme.typography.mono.copy(fontSize = 12.sp), color = c.textPrimary)
                    }
                    GhostButton(
                        label = "Copy link",
                        onClick = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(url)) },
                    )
                }
            }

            if (state.viewAsKinfolk) {
                KinfolkPreview(state = state)
            }
        }
    }
}

/**
 * Read-only kinfolk-facing preview of the report. NO admin controls (no edit fields,
 * no send, no delete): just the headline, narrative, and any resolved photos exactly
 * as a kinfolk would read them. A bordered card frames it as a distinct surface.
 */
@Composable
private fun KinfolkPreview(state: KinTaleUiState) {
    val c = AuntieTheme.colors
    val report = state.report
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .border(1.dp, c.border, RoundedCornerShape(16.dp))
            .background(c.surface2)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "KINFOLK VIEW",
            style = AuntieTheme.typography.mono.copy(fontSize = 10.sp, letterSpacing = 1.4.sp),
            color = c.primary,
        )
        Text(
            kinfolkPreviewHeadline(report),
            style = AuntieTheme.typography.headlineLarge,
            color = c.textPrimary,
        )
        Text(
            kinfolkPreviewBody(report),
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
        if (state.uploadedMedia.isNotEmpty()) {
            AuntieMediaGrid(
                items = state.uploadedMedia,
                key = { it.id },
                modifier = Modifier.heightIn(max = 360.dp),
            ) { m ->
                AsyncImage(
                    model = m.thumbnailUrl.ifBlank { m.storageUrl },
                    contentDescription = m.description,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

// ───────────────────────────── Shared utilities ─────────────────────────────

/**
 * Save-status badge used in the scaffold `actions` slot by the KinTale template
 * editor screens (ChecklistEditor / MoodOptionsEditor / KinTaleTemplateEditor).
 * Kept here as the shared home for the helper; the report screen itself surfaces
 * save state through its Save Draft button label instead.
 */
@Composable
internal fun SaveStatusBadge(status: SaveStatus, isSaving: Boolean) {
    val (label, color) = when {
        isSaving -> "Saving..." to AuntieTheme.colors.kinfolkOrange
        status == SaveStatus.SAVED -> "Saved" to AuntieTheme.colors.success
        status == SaveStatus.ERROR -> "Save failed" to AuntieTheme.colors.error
        else -> null to AuntieTheme.colors.textDim
    }
    if (label != null) {
        Box(
            modifier = Modifier
                .padding(end = 12.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(color.copy(alpha = 0.15f))
                .padding(horizontal = 8.dp, vertical = 4.dp)
        ) {
            Text(label, style = AuntieTheme.typography.labelSmall, color = color)
        }
    }
}
