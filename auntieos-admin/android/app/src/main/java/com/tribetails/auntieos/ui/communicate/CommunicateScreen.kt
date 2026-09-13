package com.tribetails.auntieos.ui.communicate

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.Megaphone
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.Sparkles
import com.tribetails.auntieos.data.model.Dossier
import com.tribetails.auntieos.data.model.HouseholdBank
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieEmailPreviewCard
import com.tribetails.auntieos.ui.components.MergePreview
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieIconBtn
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.TagChip
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.ui.theme.AuntieColors
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.domain.engagementSummary
import com.tribetails.auntieos.domain.channelLabel
import com.tribetails.auntieos.domain.isoDatePrefixOrNull

// ─────────────────────────────────────────────────────────────────────────────
// Communicate: the Den comms surface, ported from the web CommunicateScreen and
// stacked into a single phone-width column.
//
// Backed today (drives off CommunicateViewModel / CommunicateUiState):
//   - kinfolkList    : the recipient picker resolves a real Kinfolk, and the
//                      generate call now SENDS that kinfolk_id, so the server
//                      reads the household directly instead of fuzzy-matching
//                      the display name back into one of possibly several Danas.
//                      This comment used to make that claim while the id was
//                      being thrown away; it is true as of this slice.
//   - VM.generate    : turns recipient + tone + length + notes into an AI draft.
//   - VM.approveDraft: promotes the draft in Firestore and THEN writes the audit
//                      entry, in that order, the write gating everything after
//                      it. The audit half also only became real in this slice;
//                      before it, nothing in ui/communicate ever called
//                      logActivity while the on-screen caption promised it did.
//   - dossier / kin / kin411 + VM.synthesizeProfile : the recipient's living
//                      context panel.
//   - External / outside-tribe send to a raw email or phone, backed by the
//     deployed sendExternalMessage + suppressExternalRecipient callables
//     (see ExternalSendSection).
//   - Broadcast: saved segments, ad-hoc criteria, four channels, per-channel
//     tally. Gated by auntieos.communicate.broadcast, which defaults ON.
//   - Recent sends with engagement counts, via listRecentSends.
// ─────────────────────────────────────────────────────────────────────────────

/** Den compose modes. */
private enum class ComposeMode(val label: String) {
    Personalize("Personalize"),
    Broadcast("Broadcast"),
}

// Broadcast (auntieos.communicate.broadcast) ships dark behind the central FeatureFlags
// registry (read via LocalFeatureFlags.current); it has no backing ViewModel path yet, so
// it surfaces a Not-wired banner. External send is now built for real (no flag).

// The seven message types the composer offers, in the operator's order.
//
// A message type is a COPY FORMAT, not a delivery channel. `push` here asks the
// generator for a notification-shelf line: front-loaded, no greeting, no signoff,
// short enough to survive a lock screen. It has nothing to do with the broadcast
// push channel that actually delivers one, and approving a push draft in
// Personalize sends nothing.
//
// This list was four entries until 2026-07-24, which was two bugs at once. The
// archive declared `social_post` and `general` on its CommunicationType enum and
// mapped no UI option to them, so both were accepted by the function and
// reachable from nothing for that app's whole life. And `push` was not supported
// by the server at all. The bidirectional drift guard in
// web/functions/test/generate.test.js now fails if this list and the function's
// ALLOWED_TYPES disagree in EITHER direction, which is what makes a silently
// missing format impossible to reintroduce.
//
// `visit_report` reads "KinTale" because that is this product's word for a visit
// report. The WIRE value stays visit_report, because that is what generate.js
// switches its prompt framing and its training_documents lookup on; renaming it
// would quietly change the voice. There is still deliberately no KinTale
// BROADCAST channel: broadcastMessage dispatches inapp/email/sms/push and has no
// KinTale delivery leg, so such a chip could not deliver.
private val commTypeDisplayMap = mapOf(
    "email" to "Email",
    "sms" to "SMS",
    "push" to "Push",
    "social_post" to "Social",
    "blog_post" to "Blog",
    "general" to "General",
    "visit_report" to "KinTale",
)

private val commTypeOptions =
    listOf("email", "sms", "push", "social_post", "blog_post", "general", "visit_report")

/** The offered wire values, in order. Exposed for the catalog test. */
internal fun communicateMessageTypeOptions(): List<String> = commTypeOptions

/**
 * The operator-facing label for a wire value. An unknown value renders as
 * itself rather than blank or crashing, which is the honest fallback for a
 * format this build does not know about yet.
 */
internal fun communicateMessageTypeLabel(wire: String): String = commTypeDisplayMap[wire] ?: wire

// The archive's Tone enum, verbatim. The previous Android set
// (warm/casual/celebratory/urgent/professional) was invented here and shared
// only one value with the archive and with web, so the same tone chip produced
// different copy depending on which surface the operator was standing in.
private val toneOptions = listOf("warm", "cheerful", "professional", "playful")
private val lengthOptions = listOf("short", "medium", "long")

private fun titleCase(raw: String): String = raw.replaceFirstChar { it.uppercase() }

@Composable
fun CommunicateScreen(
    viewModel: CommunicateViewModel,
    onNavigateToMarketingBlasts: () -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    val dims = AuntieTheme.dims
    LaunchedEffect(Unit) { viewModel.loadRecentSends() }

    var mode by remember { mutableStateOf(ComposeMode.Personalize) }

    AuntieScreenScaffold(
        title = "Communicate",
        imePaddingEnabled = true,
        actions = {
            // Marketing blasts (scheduled campaigns) is Communicate's sibling: the
            // same act at a later time. Operator ruling 2026-09-12: it stays with
            // communication rather than the admin dashboard's catch-all, so it is
            // reached from here, the way Calendar reaches Scheduling Options
            // (ScheduleViewScreen's `actions` icon) — not a new pattern. Not the
            // Megaphone glyph: that already means "send now" on this screen (the
            // Broadcast mode above), and a scheduled send is a different act.
            AuntieIconBtn(onClick = onNavigateToMarketingBlasts) {
                Icon(
                    imageVector = Lucide.CalendarClock,
                    contentDescription = "Marketing blasts",
                    tint = AuntieTheme.colors.textDim,
                )
            }
        },
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space5),
            contentPadding = PaddingValues(
                top = dims.space6,
                bottom = 96.dp,
            ),
        ) {
            // ── Heading ──────────────────────────────────────────────────────
            // The mock's one title, "Talk to your kinfolk", over both modes
            // (`ui-ideas/auntieos-communicate-2026-05-27.html`); the web screen
            // prints the same words. The explanation follows the mode, behind
            // the info button.
            item {
                DenScreenHeading(
                    kicker = "The Den · Communicate",
                    title = "Talk to your",
                    accentTail = "kinfolk",
                    subtitle = if (mode == ComposeMode.Broadcast)
                        "Send to a saved audience or one you build here, across in-app, email, text, and push."
                    else
                        "Give Auntie the notes, pick a tone and a length, then read the draft and approve it before it goes home.",
                )
            }

            // ── Compose mode switch (Personalize / Broadcast) ─────────────────
            // The mock's `.modesw`: one track with the selected segment filled,
            // which is the kit's SegmentedPicker, not a row of filter chips.
            item {
                SegmentedPicker(
                    options = ComposeMode.values().toList(),
                    selected = mode,
                    onSelect = { mode = it },
                    label = { it.label },
                )
            }

            // ── Status banners (fail-loud) ────────────────────────────────────
            if (state.error != null) {
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        icon = Lucide.Mail,
                        onDismiss = viewModel::clearError,
                    ) {
                        Text(
                            text = state.error!!,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.error,
                        )
                    }
                }
            }
            if (state.successMessage != null) {
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Success,
                        icon = Lucide.Send,
                        onDismiss = viewModel::clearSuccess,
                    ) {
                        Text(
                            text = state.successMessage!!,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.success,
                        )
                    }
                }
            }

            // ── Compose panel ────────────────────────────────────────────────
            item {
                ComposePanel(
                    mode = mode,
                    state = state,
                    viewModel = viewModel,
                )
            }

            // ── Live preview ──────────────────────────────────────────────────
            item {
                PreviewPanel(
                    recipientName = state.selectedKinfolk?.displayName.orEmpty(),
                    subject = state.subject,
                    body = state.generatedCopy,
                )
            }

            // ── Where things last left off (comms box) ────────────────────────
            if (state.selectedKinfolk != null) {
                item {
                    LastCommunicationBox(state = state, viewModel = viewModel)
                }
            }

            // ── Recipient context (dossier + kin + 411) ───────────────────────
            if (state.selectedKinfolk != null) {
                item {
                    ContextPanel(state = state, viewModel = viewModel)
                }
            }

            // ── Recent (sends + engagement) ───────────────────────────────────
            item { RecentPanel(state) }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose panel
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ComposePanel(
    mode: ComposeMode,
    state: CommunicateUiState,
    viewModel: CommunicateViewModel,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val flags = LocalFeatureFlags.current

    DenPanel(
        title = if (mode == ComposeMode.Broadcast) "Broadcast" else "Personalize",
        subtitle = if (mode == ComposeMode.Broadcast)
            "Send one message to a group."
        else
            "A 1:1 note that uses the recipient's dossier and kin context.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {

            if (mode == ComposeMode.Broadcast) {
                if (flags.communicateBroadcast) {
                    // Live (Stage 2 step 6): saved segments + multichannel fan-out.
                    BroadcastSection(state = state, viewModel = viewModel)
                } else {
                    // Kill-switch off: surface it loud, never a silent blank.
                    AuntieBanner(
                        tone = AuntieBannerTone.Suggestion,
                        title = "Broadcast is turned off",
                        icon = Lucide.Megaphone,
                        pillLabel = "OFF",
                        dashed = true,
                    ) {
                        Text(
                            text = "Broadcast is built but currently disabled by a feature flag. " +
                                "Turn auntieos.communicate.broadcast on to use it.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textDim,
                        )
                    }
                }
                return@Column
            }

            // ── Message type (spec 19 item 1) ─────────────────────────────────
            // Chips, not a dropdown: four options that change what the whole rest
            // of the form means should be visible at once, and this matches the
            // archive and the web twin.
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                AuntieFieldLabel(text = "Message type")
                AuntieChipGroup(
                    options = commTypeOptions,
                    selected = setOf(state.commType),
                    onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setCommType) },
                    label = { commTypeDisplayMap[it] ?: it },
                    singleSelect = true,
                )
            }

            // ── Recipient ── omitted for recipient-less blog/social (spec 19 item 2)
            if (needsRecipient(state.commType)) {
                AuntieFieldLabel(text = "Recipient")
                RecipientPicker(
                    recipient = state.selectedKinfolk,
                    kinfolkList = state.kinfolkList,
                    loading = state.kinfolkLoading,
                    onPick = viewModel::selectKinfolk,
                )
            }

            // ── Subject (spec 19 item 3) ── author-typed; bound to the preview ─
            AuntieField(
                value = state.subject,
                onValueChange = viewModel::setSubject,
                label = "Subject",
                placeholder = "What is this about?",
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Tone + Length ──────────────────────────────────────────────────
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                AuntieFieldLabel(text = "Tone")
                AuntieChipGroup(
                    options = toneOptions,
                    selected = setOf(state.toneHint),
                    onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setToneHint) },
                    label = ::titleCase,
                    singleSelect = true,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                AuntieFieldLabel(text = "Length")
                AuntieChipGroup(
                    options = lengthOptions,
                    selected = setOf(state.messageLength),
                    onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setMessageLength) },
                    label = ::titleCase,
                    singleSelect = true,
                )
            }

            // ── Raw notes ──────────────────────────────────────────────────────
            Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                AuntieFieldLabel(text = "What is it about?")
                AuntieField(
                    value = state.rawNotes,
                    onValueChange = viewModel::setRawNotes,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
                    placeholder = "Bullets or free-form. The more honest, the warmer the draft.",
                    singleLine = false,
                    minLines = 5,
                )
            }

            // ── Generate / Regenerate ──────────────────────────────────────────
            PrimaryButton(
                label = if (state.generatedCopy.isBlank()) "Generate draft" else "Regenerate",
                onClick = { viewModel.generate(flags.communicateGenerateViaFunction) },
                enabled = !state.isGenerating && !state.isSaving,
                loading = state.isGenerating,
                leading = {
                    Icon(
                        imageVector = if (state.generatedCopy.isBlank()) Lucide.Sparkles else Lucide.RefreshCw,
                        contentDescription = null,
                        tint = c.background,
                        modifier = Modifier.size(14.dp),
                    )
                },
            )

            // ── Generated draft callout + editor ───────────────────────────────
            if (state.generatedCopy.isNotBlank()) {
                DraftCallout(
                    subtitle = listOf(
                        state.generatedKinfolkName.takeIf { it.isNotBlank() }?.let { "for $it" },
                        state.generatedCommType.takeIf { it.isNotBlank() },
                        state.generatedModel.takeIf { it.isNotBlank() },
                        state.draftId?.let { "draft #$it" },
                    ).filterNotNull().joinToString(" · "),
                )
                Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                    AuntieFieldLabel(text = "Edit before approving")
                    AuntieField(
                        value = state.generatedCopy,
                        onValueChange = viewModel::setGeneratedCopy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                        singleLine = false,
                        minLines = 7,
                    )
                }

                // ── Approve bar (backed send-path: approveDraft) ───────────────
                Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                    PrimaryButton(
                        label = if (state.savedDraftId != null) "Approved" else "Approve draft",
                        onClick = viewModel::approveDraft,
                        enabled = state.draftId != null && state.savedDraftId == null && !state.isSaving && !state.isGenerating,
                        loading = state.isSaving,
                        leading = {
                            Icon(
                                imageVector = Lucide.Send,
                                contentDescription = null,
                                tint = c.background,
                                modifier = Modifier.size(14.dp),
                            )
                        },
                    )
                    Text(
                        text = "approving promotes the draft in Firestore, then logs it to the audit trail. Nothing runs unless the write lands",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }

            // ── External send (one-off email/SMS to a non-kinfolk recipient) ─────
            ExternalSendSection(state = state, viewModel = viewModel)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast (Stage 2 step 6): pick a saved audience segment (or build an ad-hoc
// one), choose channels, write the message, send. Saved segments load via
// listAudienceSegments; the send routes through broadcastMessage which resolves
// the audience server-side and fans out, honoring opt-outs. Fail-loud.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BroadcastSection(state: CommunicateUiState, viewModel: CommunicateViewModel) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    LaunchedEffect(Unit) {
        viewModel.loadSegments()
        // The household tag vocabulary the "By tag" audience picks from.
        viewModel.loadHouseholdTagVocab()
    }

    Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
        // ── Audience ────────────────────────────────────────────────────────
        AuntieFieldLabel(text = "Audience")
        if (state.segmentsLoading) {
            Text("Loading segments…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        // null id = ad-hoc; the rest are saved segment ids.
        val audienceOptions: List<String?> = listOf<String?>(null) + state.segments.map { it.id }
        AuntieChipGroup(
            options = audienceOptions,
            selected = setOf(state.selectedSegmentId),
            onSelectionChange = { next -> viewModel.selectSegment(next.firstOrNull()) },
            label = { id -> if (id == null) "Ad-hoc" else state.segments.firstOrNull { it.id == id }?.name ?: id },
            singleSelect = true,
        )
        if (state.selectedSegmentId != null) {
            GhostButton(
                label = "Delete this segment",
                onClick = { state.selectedSegmentId?.let(viewModel::deleteSegment) },
            )
        }

        // ── Ad-hoc criteria builder ───────────────────────────────────────────
        if (state.selectedSegmentId == null) {
            AuntieFieldLabel(text = "Who is this for?")
            AuntieChipGroup(
                options = SegmentKind.values().toList(),
                selected = setOf(state.bcKind),
                onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setBcKind) },
                label = { it.label },
                singleSelect = true,
            )
            if (state.bcKind == SegmentKind.Status) {
                AuntieField(
                    value = state.bcStatusesText,
                    onValueChange = viewModel::setBcStatuses,
                    label = "Statuses",
                    placeholder = "active, prospect",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.bcKind == SegmentKind.Tags) {
                AuntieFieldLabel(text = "Household tags")
                Text(
                    text = "A broadcast matches tags on the household, not tags on individual pets.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )

                state.tagVocabError?.let { msg ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Your tag list did not load",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(
                            text = "$msg. You can still type a tag name, but spell it exactly as it appears on the household.",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textDim,
                        )
                    }
                }

                // The chosen tags, painted from the vocabulary entry so the chip
                // here reads the same as the chip on the profile.
                if (state.bcSelectedTags.isNotEmpty()) {
                    TagChipFlow {
                        state.bcSelectedTags.forEach { name ->
                            TagChip(
                                name = name,
                                vocab = state.householdTagVocab,
                                onRemove = { viewModel.removeBcTag(name) },
                            )
                        }
                    }
                }

                AuntieSearchField(
                    value = state.bcTagQuery,
                    onValueChange = viewModel::setBcTagQuery,
                    placeholder = "Type or pick a household tag",
                    leadingIcon = Lucide.Search,
                    onClear = { viewModel.setBcTagQuery("") },
                    // Submit takes what was typed, so a free-form tag that predates
                    // the vocabulary is still reachable.
                    onSubmit = { viewModel.addBcTag(state.bcTagQuery) },
                    modifier = Modifier.fillMaxWidth(),
                )

                val suggestions = broadcastTagSuggestions(
                    query = state.bcTagQuery,
                    vocab = state.householdTagVocab,
                    selected = state.bcSelectedTags,
                )
                when {
                    !state.tagVocabLoaded && state.tagVocabError == null ->
                        Text("Loading your tag list…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    state.householdTagVocab.isEmpty() ->
                        Text(
                            text = "No household tags yet. Add some in Settings, Tags, or type one here to use it anyway.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    suggestions.isEmpty() && state.bcTagQuery.isNotBlank() ->
                        Text(
                            text = "Nothing in your list matches \"${state.bcTagQuery.trim()}\". Press the keyboard's search key to use it anyway.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    suggestions.isEmpty() ->
                        Text(
                            text = "Every household tag is already on this audience.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    // TagChip is a read-only pill (its only affordance is remove),
                    // so a suggestion gets its tap target from the wrapper.
                    else -> TagChipFlow {
                        suggestions.forEach { def ->
                            Box(modifier = Modifier.clickable { viewModel.addBcTag(def.name) }) {
                                TagChip(name = def.name, vocab = state.householdTagVocab)
                            }
                        }
                    }
                }

                // Fail loud on both counts: a tag nobody carries would report a
                // clean zero, and going over the cap is a whole-call rejection.
                broadcastTagVocabWarning(
                    selected = state.bcSelectedTags,
                    vocab = state.householdTagVocab,
                    vocabLoaded = state.tagVocabLoaded,
                )?.let { warn ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "Check these tag names",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(text = warn, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    }
                }
                broadcastTagCapProblem(state.bcSelectedTags)?.let { problem ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Too many tags",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(text = problem, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    }
                }

                AuntieChipGroup(
                    options = TagMatch.values().toList(),
                    selected = setOf(state.bcTagMatch),
                    onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setBcTagMatch) },
                    label = { it.label },
                    singleSelect = true,
                )
            }
            // Save the current ad-hoc criteria as a reusable segment.
            AuntieField(
                value = state.bcNewSegmentName,
                onValueChange = viewModel::setBcNewSegmentName,
                label = "Save this audience as",
                placeholder = "Segment name",
                modifier = Modifier.fillMaxWidth(),
            )
            GhostButton(
                label = if (state.isSavingSegment) "Saving…" else "Save segment",
                onClick = viewModel::saveSegment,
                enabled = !state.isSavingSegment,
            )
        }

        // ── Channels (multi-select) ───────────────────────────────────────────
        AuntieFieldLabel(text = "Channels")
        AuntieChipGroup(
            options = BroadcastChannel.values().toList(),
            selected = state.bcChannels,
            onSelectionChange = viewModel::setBcChannels,
            label = { it.label },
            singleSelect = false,
        )

        // ── Message ────────────────────────────────────────────────────────────
        AuntieField(
            value = state.bcSubject,
            onValueChange = viewModel::setBcSubject,
            label = "Subject / title",
            placeholder = "Used as the email subject and in-app title",
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = state.bcBody,
            onValueChange = viewModel::setBcBody,
            label = "Message",
            placeholder = "Write the message you want to send to this audience.",
            singleLine = false,
            minLines = 4,
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
        )

        // The broadcast copy as a recipient reads it, with `emptyMap()` as the
        // sample. That is not a placeholder waiting to be filled in later, it is
        // the accurate one: `broadcastMessage` calls `sendTemplatedEmail` with
        // `data: {}` and hands Twilio / FCM / the in-app write the string
        // verbatim, so nothing on this path can resolve a merge field. Every
        // {{token}} typed here IS unresolved, and the footnote says what each
        // channel does with it rather than leaving the operator to find out from
        // a customer. Matches CommunicateCompose.tsx word for word.
        MergePreview(
            subject = state.bcSubject,
            body = state.bcBody,
            sample = emptyMap(),
            footnote = "A broadcast carries no merge data. Email sends these blank; in-app, SMS and push send the braces as typed.",
            modifier = Modifier.fillMaxWidth(),
        )

        PrimaryButton(
            label = "Send broadcast",
            onClick = viewModel::sendBroadcast,
            enabled = !state.isBroadcasting,
            loading = state.isBroadcasting,
            leading = {
                Icon(Lucide.Megaphone, contentDescription = null, tint = c.background, modifier = Modifier.size(14.dp))
            },
        )

        state.broadcastError?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Broadcast blocked", icon = Lucide.Megaphone) {
                Text(text = msg, style = AuntieTheme.typography.bodyMedium, color = c.error)
            }
        }
        state.broadcastResult?.let { r ->
            AuntieBanner(tone = AuntieBannerTone.Success, title = "Broadcast sent", icon = Lucide.Megaphone) {
                Text(text = broadcastSummary(r), style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            }
        }
    }
}

/** Wrapping row of tag chips, so a long vocabulary never pushes the form sideways. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagChipFlow(content: @Composable () -> Unit) {
    val dims = AuntieTheme.dims
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalArrangement = Arrangement.spacedBy(dims.space2),
    ) { content() }
}

// ─────────────────────────────────────────────────────────────────────────────
// External send: a one-off email or SMS to an arbitrary recipient (not a kinfolk),
// backed by the deployed sendExternalMessage / suppressExternalRecipient callables.
// Validation is client-side first (fail fast) and the server consent gate + audit
// + provider send are authoritative. On success the SERVER-REDACTED recipient is
// shown; on failure the verbatim server error (including recipient_opted_out)
// surfaces fail-loud. The operator authors all customer-facing words (subject/body).
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ExternalSendSection(state: CommunicateUiState, viewModel: CommunicateViewModel) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    DenPanel(
        title = "Send outside the tribe",
        subtitle = "A one-off email or text to someone who is not a kinfolk yet.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {

            // ── Channel selector ──────────────────────────────────────────────
            Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                AuntieFieldLabel(text = "Channel")
                AuntieChipGroup(
                    options = ExternalChannel.values().toList(),
                    selected = setOf(state.externalChannel),
                    onSelectionChange = { next ->
                        next.firstOrNull()?.let(viewModel::setExternalChannel)
                    },
                    label = { if (it == ExternalChannel.Email) "Email" else "SMS" },
                    singleSelect = true,
                )
            }

            // ── Recipient ─────────────────────────────────────────────────────
            AuntieField(
                value = state.externalTo,
                onValueChange = viewModel::setExternalTo,
                label = if (state.externalChannel == ExternalChannel.Email) "Recipient email" else "Recipient phone",
                placeholder = if (state.externalChannel == ExternalChannel.Email)
                    "name@example.com" else "Phone number",
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Subject (email only) ──────────────────────────────────────────
            if (state.externalChannel == ExternalChannel.Email) {
                AuntieField(
                    value = state.externalSubject,
                    onValueChange = viewModel::setExternalSubject,
                    label = "Subject",
                    placeholder = "What is this about?",
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // ── Body ──────────────────────────────────────────────────────────
            Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                AuntieFieldLabel(text = "Message")
                AuntieField(
                    value = state.externalBody,
                    onValueChange = viewModel::setExternalBody,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
                    placeholder = "Type the message to send.",
                    singleLine = false,
                    minLines = 5,
                )
            }

            // ── Fail-loud error banner (client validation + server errors) ────
            if (state.externalError != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    icon = Lucide.Mail,
                    onDismiss = viewModel::clearExternalError,
                ) {
                    Text(
                        text = state.externalError,
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.error,
                    )
                }
            }

            // ── Success banner: server-redacted recipient ─────────────────────
            if (state.externalSentRedacted != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Success,
                    icon = Lucide.Send,
                    onDismiss = viewModel::clearExternalSent,
                ) {
                    Text(
                        text = "Sent to ${state.externalSentRedacted}.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.success,
                    )
                }
            }

            // ── Suppression confirmation banner ───────────────────────────────
            if (state.externalSuppressedRedacted != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Info,
                    icon = Lucide.Mail,
                    onDismiss = viewModel::clearExternalSuppressed,
                ) {
                    Text(
                        text = "${state.externalSuppressedRedacted} will no longer receive messages.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                }
            }

            // ── Send action ───────────────────────────────────────────────────
            PrimaryButton(
                label = "Send message",
                onClick = viewModel::sendExternal,
                enabled = !state.isSendingExternal && !state.isSuppressing,
                loading = state.isSendingExternal,
                leading = {
                    Icon(
                        imageVector = Lucide.Send,
                        contentDescription = null,
                        tint = c.background,
                        modifier = Modifier.size(14.dp),
                    )
                },
            )

            // ── Opt-out action ────────────────────────────────────────────────
            GhostButton(
                label = "Mark recipient opted out",
                onClick = viewModel::suppressExternal,
                enabled = !state.isSendingExternal && !state.isSuppressing,
                leading = {
                    if (state.isSuppressing) {
                        AuntieSpinner(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Lucide.Mail, contentDescription = null, modifier = Modifier.size(14.dp))
                    }
                },
            )
            Text(
                text = "opting out records a suppression so future sends to this recipient are blocked at the source",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/**
 * Recipient picker. Resolves a real [Kinfolk] from the VM's kinfolk list so a
 * kinfolk_id is chosen client-side instead of leaving the generator to
 * fuzzy-match a typed name. Shows the selected kinfolk as a card with a
 * "Change" toggle that reveals a searchable list of households.
 */
@Composable
private fun RecipientPicker(
    recipient: Kinfolk?,
    kinfolkList: List<Kinfolk>,
    loading: Boolean,
    onPick: (Kinfolk?) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var expanded by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
        // Selected recipient card (or a prompt when none chosen).
        AuntieEntityRow(
            title = recipient?.displayName ?: "No recipient selected",
            subtitle = if (recipient != null) "uses their dossier and kin context" else "pick a household to personalize",
            leading = {
                AuntieAvatar(
                    imageUrl = recipient?.profilePictureUrl,
                    initials = recipient?.displayName?.take(2) ?: "?",
                    size = 42.dp,
                    gradientSeed = recipient?.id ?: "kinfolk",
                )
            },
            trailing = {
                GhostButton(
                    label = if (expanded) "Close" else if (recipient != null) "Change" else "Choose",
                    onClick = { expanded = !expanded },
                )
            },
        )

        if (expanded) {
            AuntieSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = "Search kinfolk by name or email",
                onClear = { query = "" },
            )
            when {
                loading -> EmptyHint("Loading kinfolk…")
                else -> {
                    val matches = kinfolkList
                        .filter { !it.isArchived }
                        .filter {
                            query.isBlank() ||
                                it.displayName.contains(query, ignoreCase = true) ||
                                it.email.contains(query, ignoreCase = true)
                        }
                        .sortedBy { it.displayName.lowercase() }
                    if (matches.isEmpty()) {
                        EmptyHint(
                            if (query.isBlank()) "No kinfolk on file yet."
                            else "No kinfolk match \"$query\".",
                        )
                    } else {
                        Column(
                            modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp),
                            verticalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            matches.take(40).forEach { k ->
                                AuntieEntityRow(
                                    title = k.displayName,
                                    subtitle = k.email.ifBlank { k.phoneNumber.ifBlank { "no contact on file" } },
                                    selected = recipient?.id == k.id,
                                    leading = {
                                        AuntieAvatar(
                                            imageUrl = k.profilePictureUrl,
                                            initials = k.displayName.take(2),
                                            size = 34.dp,
                                            gradientSeed = k.id,
                                        )
                                    },
                                    onClick = {
                                        onPick(k)
                                        expanded = false
                                        query = ""
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

/** "Auntie AI draft · needs approval" callout above the editable copy. */
@Composable
private fun DraftCallout(subtitle: String) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space3),
    ) {
        AuntieIconTile(
            icon = Lucide.Sparkles,
            tone = AuntieStatusTone.Purple,
            size = 30.dp,
            contentDescription = null,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Auntie AI draft",
                style = AuntieTheme.typography.titleMedium,
                color = c.textPrimary,
            )
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
        AuntieStatusPill(
            label = "needs approval",
            tone = AuntieStatusTone.Purple,
            mono = true,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview panel. Binds straight to the editable body so it updates the moment a
// draft is generated or edited (no network round-trip).
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PreviewPanel(recipientName: String, subject: String, body: String) {
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Live preview",
        subtitle = "How kinfolk see it",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieEmailPreviewCard(
                modifier = Modifier.fillMaxWidth(),
                // Author-typed subject (spec 19 item 3); computed placeholder only
                // until the author types one. CTA stays placeholder.
                subject = subject.ifBlank {
                    if (recipientName.isNotBlank()) "A note about $recipientName" else "A note from Auntie"
                },
                body = body.ifBlank { "Generate a draft and it shows up here." },
                ctaLabel = "Book a visit",
                highlightTokens = true,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// "Where things last left off": a short read on the recipient's most recent
// contact. When auntieos.communicate.commsRecap is on it shows the AI recap;
// otherwise (or if the recap fails) it discloses the raw latest message. Reads
// are fail-loud: a load error is shown, never a silent blank.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun LastCommunicationBox(state: CommunicateUiState, viewModel: CommunicateViewModel) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val flags = LocalFeatureFlags.current

    LaunchedEffect(state.selectedKinfolk?.id, flags.communicateCommsRecap) {
        state.selectedKinfolk?.id?.takeIf { it.isNotBlank() }?.let { id ->
            viewModel.loadCommsBox(id, flags.communicateCommsRecap)
        }
    }

    DenPanel(
        title = "Where things last left off",
        subtitle = "The recipient's most recent contact",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            // Fail-loud: surface any recap error and disclose the raw fallback.
            state.commsRecapError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    icon = Lucide.TriangleAlert,
                    dashed = true,
                ) {
                    Text(
                        text = "AI recap unavailable ($msg). Showing the latest message instead.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textPrimary,
                    )
                }
            }

            if (state.commsBoxLoading) {
                Text("Loading recent messages…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            } else {
                when (val cb = state.commsBox) {
                    is CommsBoxState.AiRecap -> {
                        Text(cb.recap, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    }
                    is CommsBoxState.RawLatest -> {
                        AuntieFieldLabel(text = "Latest message")
                        Text(
                            text = "${cb.latest.channel} · ${humanizeDate(cb.latest.timestamp)} · ${cb.latest.snippet}",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                        if (cb.disclosedFallback) {
                            Text(
                                text = "Showing the raw latest message; the AI recap was not available.",
                                style = AuntieTheme.typography.labelSmall,
                                color = c.textDim,
                            )
                        }
                    }
                    CommsBoxState.Empty -> {
                        Text(
                            text = "No messages on file yet.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient context: the dossier + kin + 411 panel. Backed by VM.loadProfiles
// and VM.synthesizeProfile.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ContextPanel(state: CommunicateUiState, viewModel: CommunicateViewModel) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Recipient context",
        subtitle = "Dossier, household bank and kin Auntie reads before drafting",
        modifier = Modifier.fillMaxWidth(),
    ) {
        // This panel is internal admin context, not customer-facing copy.
        Text(
            text = "Admin only / internal",
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
            modifier = Modifier.padding(bottom = dims.space3),
        )
        if (state.profileLoading) {
            Box(modifier = Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
                AuntieSpinner(color = c.primary, strokeWidth = 2.dp)
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                state.dossier?.let { DossierPanel(it) }
                state.householdBank?.let { HouseholdBankPanel(it) }

                if (state.kin.isNotEmpty()) {
                    AuntieFieldLabel(text = "The 411")
                    state.kin.forEach { kin ->
                        KinCard(kin, state.kin411Map[kin.id])
                    }
                }
            }
        }
    }
}

@Composable
private fun DossierPanel(dossier: Dossier) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var expanded by remember { mutableStateOf(true) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surfaceGlass)
            .padding(dims.space4),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("THE DOSSIER", style = AuntieTheme.typography.labelSmall, color = c.primary)
            Icon(
                if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                contentDescription = null, tint = c.textDim,
            )
        }
        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = dims.space3),
                verticalArrangement = Arrangement.spacedBy(dims.space3),
            ) {
                ContextField("Summary", summaryLine(dossier.tldr, dossier.rawSummary, 280))
            }
        }
    }
}

/**
 * The household bank (issue #461), the peer of [DossierPanel] and built to the
 * same recipe: same card, same collapsible header, same summary line, same
 * [ContextField] that hides a blank or a "Not yet documented." placeholder.
 *
 * Read-only, exactly as the dossier and the 411 are here. The only thing that
 * writes any of the three is the reconcile pipeline, reachable from this screen
 * through the existing "Refresh intelligence" action, so there is no editor to
 * add and no control that would do nothing.
 */
@Composable
private fun HouseholdBankPanel(bank: HouseholdBank) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var expanded by remember { mutableStateOf(true) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surfaceGlass)
            .padding(dims.space4),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("THE HOUSEHOLD BANK", style = AuntieTheme.typography.labelSmall, color = c.primary)
            Icon(
                if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                contentDescription = null, tint = c.textDim,
            )
        }
        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = dims.space3),
                verticalArrangement = Arrangement.spacedBy(dims.space3),
            ) {
                ContextField("Summary", summaryLine(bank.tldr, bank.rawSummary, 280))
                ContextField("Access and entry", bank.accessAndEntry)
                ContextField("The property", bank.propertyNotes)
                ContextField("How the home runs", bank.householdRoutine)
                ContextField("Standing instructions", bank.standingInstructions)
                ContextField("Scheduling", bank.schedulingNotes)
            }
        }
    }
}

@Composable
private fun KinCard(kin: Kin, kin411: Kin411?) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface2)
            .padding(dims.space3),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                AuntieAvatar(
                    imageUrl = kin.photos.firstOrNull()?.url,
                    initials = kin.name.take(2).ifBlank { "?" },
                    size = 44.dp,
                    shape = CircleShape,
                    gradientSeed = kin.id,
                )
                Spacer(Modifier.size(dims.space3))
                Column {
                    Text(kin.name.ifBlank { "(unnamed)" }, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                    val meta = listOf(
                        kin.species.takeIf { it.isNotBlank() },
                        kin411?.breed?.takeIf { it.isNotBlank() },
                    ).filterNotNull().joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            Icon(
                if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                contentDescription = null, tint = c.textDim,
            )
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space3),
            ) {
                kin411?.let { f ->
                    ContextField("411", summaryLine(f.tldr, f.rawSummary, 200))
                }
            }
        }
    }
}

@Composable
private fun ContextField(label: String, value: String) {
    if (value.isBlank() || value == "Not yet documented.") return
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        AuntieFieldLabel(text = label)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

/**
 * "Recent" sends + engagement. Reads recent external sends from the VM (listRecentSends
 * callable) and shows the delivery / open / click counts the SendGrid + Twilio webhooks
 * reported. Honest: only measured events are shown (no fabricated rates); fail-loud on
 * a load error. Counts populate as provider events arrive.
 */
@Composable
private fun RecentPanel(state: CommunicateUiState) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Recent",
        modifier = Modifier.fillMaxWidth(),
    ) {
        when {
            state.recentSendsLoading -> Text(
                text = "Loading recent sends…",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textDim,
            )
            state.recentSendsError != null -> AuntieBanner(
                tone = AuntieBannerTone.Warning,
                icon = Lucide.TriangleAlert,
                dashed = true,
            ) {
                Text(
                    text = "Couldn't load recent sends: ${state.recentSendsError}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
            }
            state.recentSends.isEmpty() -> Text(
                text = "No external sends yet. Sends from Communicate show here with delivery and open counts.",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textDim,
            )
            else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.recentSends.forEach { snd ->
                    // The mock's `.br`: a 9dp dot in the channel's tone leads
                    // the row. Teal for email (the mock's default), orange for
                    // a text, purple for push, dim for anything else.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(11.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(9.dp)
                                .clip(CircleShape)
                                .background(recentSendDot(snd.channel, c)),
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "${channelLabel(snd.channel)} · ${snd.recipientRedacted}",
                                style = AuntieTheme.typography.titleMedium,
                                color = c.textPrimary,
                            )
                            snd.subject?.takeIf { it.isNotBlank() }?.let { subj ->
                                Text(subj, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                            Text(
                                text = engagementSummary(snd.channel, snd.counts),
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The Recent row's dot colour per channel; mirrors `.communicate__row-dot` on web. */
private fun recentSendDot(channel: String, c: AuntieColors): Color =
    when (channel.trim().lowercase()) {
        "email" -> c.accent
        "sms" -> c.primary
        "push" -> c.tertiary
        else -> c.textFaint
    }

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "MMM d" label from an ISO timestamp or date string; falls back to the raw string. */
private fun humanizeDate(date: String): String {
    val iso = isoDatePrefixOrNull(date) ?: return date.trim()
    return runCatching {
        val d = java.time.LocalDate.parse(iso)
        val month = d.month.name.lowercase().replaceFirstChar { it.uppercase() }.take(3)
        "$month ${d.dayOfMonth}"
    }.getOrDefault(date.trim())
}
