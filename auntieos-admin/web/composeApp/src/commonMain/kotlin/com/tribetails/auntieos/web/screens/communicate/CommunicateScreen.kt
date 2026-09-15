package com.tribetails.auntieos.web.screens.communicate

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.LayoutGrid
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.Bookmark
import com.composables.icons.lucide.Megaphone
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.Ban
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.AuditLog
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.CommunicationType
import com.tribetails.auntieos.web.data.Dossier
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.GenerateRequest
import com.tribetails.auntieos.web.data.GenerateResponse
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kin411
import com.tribetails.auntieos.web.data.mintBroadcastIdempotencyKey
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.N8nClient
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.invoices.humanizeDate
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieChipGroup
import com.tribetails.auntieos.web.ui.components.AuntieEmailPreviewCard
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.TagChip
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

// ─────────────────────────────────────────────────────────────────────────────
// Communicate: the Den comms surface.
//
// Backed today:
//   - templatesStream()  : KinTale templates feed the template bank drawer. Pick
//                           one to prefill an editable draft.
//   - kinfolkStream()    : the recipient picker resolves a real Kinfolk so a
//                           kinfolk_id is chosen client-side, not fuzzy-matched.
//   - N8nClient.generate : turns a recipient + tone + notes into an AI draft.
//   - approveGeneratedDraft : the backed send-path that promotes the draft in
//                           Firestore (canonical store) + writes the audit entry
//                           before the n8n downstream bridge is pinged.
//
// NOT backed yet (gated dark behind central feature flags, never faked):
//   - Broadcast (segment + multi-channel fan-out): no broadcast callable.
//   - External / outside-tribe send to a raw email or phone: N8nClient.sendMessage
//     exists in data/ but is not part of this screen's blessed write surface, so
//     it ships behind flags.communicateExternalSend with a Not-wired banner.
//   - Recent sends with open / read engagement metrics: no metrics source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose tone. n8n's `tone_hint` is free-text, so the mockup's tone set
 * (Warm / Cheerful / Professional / Playful) passes straight through.
 */
private enum class Tone(val key: String, val label: String) {
    Warm("warm", "Warm"),
    Cheerful("cheerful", "Cheerful"),
    Professional("professional", "Professional"),
    Playful("playful", "Playful"),
}

private enum class Length(val key: String, val label: String) {
    Short("short", "Short"), Medium("medium", "Medium"), Long("long", "Long")
}

/**
 * The KIND of message being composed (spec 19 item 1), mapped to the backend's
 * [CommunicationType]. [needsRecipient] is false for blog/social: those are authored
 * once, not addressed to a kinfolk (spec 19 item 2), so the recipient is omitted.
 */
internal enum class MessageType(val label: String, val type: CommunicationType, val needsRecipient: Boolean) {
    Visit("Visit report", CommunicationType.VISIT_REPORT, true),
    Text("Text", CommunicationType.SMS, true),
    Email("Email", CommunicationType.EMAIL, true),
    Blog("Blog", CommunicationType.BLOG_POST, false),
}

/** Recipient sent to generate(): empty for recipient-less types (blog/social). Pure; tested. */
internal fun generateRecipient(type: MessageType, recipientName: String): String =
    if (type.needsRecipient) recipientName else ""

/** Den compose modes. Only [Personalize] is backend-wired. */
private enum class ComposeMode(val label: String) {
    Personalize("Personalize"),
    Broadcast("Broadcast"),
}

@Composable
fun CommunicateScreen() {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()
    val n8n = remember { N8nClient() }
    val firestore = remember { FirestoreClient() }
    val auth = remember { AuthClient() }
    val featureFlags = LocalFeatureFlags.current

    // P0-FLICKER: hoist Flow construction via remember so the same Flow survives
    // recomposition (otherwise data flickers Loading -> Data each frame).
    val templatesState by remember { firestore.templatesStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkState by remember { firestore.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)

    var mode by remember { mutableStateOf(ComposeMode.Personalize) }
    var drawerOpen by remember { mutableStateOf(false) }

    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var notes by remember { mutableStateOf("") }
    var tone by remember { mutableStateOf(Tone.Warm) }
    var length by remember { mutableStateOf(Length.Medium) }
    var messageType by remember { mutableStateOf(MessageType.Visit) }
    var subject by remember { mutableStateOf("") }
    var fromTemplate by remember { mutableStateOf<String?>(null) }

    var loading by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<GenerateResponse?>(null) }
    var editedCopy by remember { mutableStateOf("") }

    var toastMsg by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }

    // Keep editedCopy in sync when a fresh AI result lands.
    LaunchedEffect(result) {
        result?.let { editedCopy = it.generated_copy }
    }

    fun showToast(text: String, kind: ToastKind = ToastKind.Info) { toastMsg = text to kind }

    val recipientName = selectedKinfolk?.displayName.orEmpty()

    fun generate() {
        if (notes.isBlank()) {
            showToast("Add a few notes first so Auntie has something to write about.", ToastKind.Error)
            return
        }
        // Blog/social are recipient-less (spec 19 item 2); the rest need a recipient.
        if (messageType.needsRecipient && recipientName.isBlank()) {
            showToast("Pick a recipient for this message type first.", ToastKind.Error)
            return
        }
        loading = true
        scope.launch {
            try {
                val resp = n8n.generate(
                    GenerateRequest(
                        communication_type = messageType.type,
                        recipient          = generateRecipient(messageType, recipientName),
                        raw_notes          = notes,
                        tone_hint          = tone.key,
                        max_length         = length.key,
                    ),
                    useFunction = featureFlags.communicateGenerateViaFunction,
                )
                if (resp.error != null) {
                    showToast("Generate error: ${resp.error}", ToastKind.Error)
                } else {
                    result = resp
                    showToast("Draft ready for your review.", ToastKind.Success)
                }
            } catch (t: Throwable) {
                showToast("Generate failed: ${t.message ?: "unknown error"}", ToastKind.Error)
            } finally {
                loading = false
            }
        }
    }

    fun approveDraft() {
        val r = result ?: return
        val draftId = r.draft_id ?: run {
            showToast(
                "This draft has no n8n draft id, so it cannot be approved. Regenerate and try again.",
                ToastKind.Error,
            )
            return
        }
        saving = true
        scope.launch {
            try {
                // 1. Promote the draft in Firestore (canonical store). Fail loud on
                //    error per project policy: do NOT ping the n8n downstream if the
                //    source-of-truth write fails.
                val writeResult = firestore.approveGeneratedDraft(draftId, editedCopy)
                if (writeResult is WriteResult.Err) {
                    showToast("Approve failed: Firestore rejected it (${writeResult.message}).", ToastKind.Error)
                    return@launch
                }
                // 2. Activity log emit per project policy. Actor uid resolved from
                //    the current Auth session.
                val actorUid = auth.authStateStream().first()?.uid ?: ""
                AuditLog.fire(
                    scope = scope,
                    client = firestore,
                    actorId = actorUid,
                    actionType = "DRAFT_APPROVED",
                    description = "Approved generated_drafts/$draftId (${r.kinfolk_id ?: "no-kinfolk"})",
                    targetId = draftId,
                    targetCollection = "generated_drafts",
                )
                showToast("Draft #$draftId approved and queued for delivery.", ToastKind.Success)
            } catch (t: Throwable) {
                showToast("Approve failed: ${t.message ?: "unknown error"}", ToastKind.Error)
            } finally {
                saving = false
            }
        }
    }

    fun applyTemplate(t: KinTaleTemplate) {
        fromTemplate = t.name.ifBlank { t._id }
        // Prefill the editable body from the template's default message + the
        // draft editor. This is real template content, not fabricated copy.
        notes = t.defaultEmailMessage
        editedCopy = t.defaultEmailMessage
        result = null
        drawerOpen = false
        showToast("Pulled \"${t.name.ifBlank { "template" }}\" into the draft.", ToastKind.Success)
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker = "The Den · Communicate",
            title = "Talk to your",
            accentTail = "kinfolk.",
            subtitle = "Pull a saved template or write from scratch, let Auntie draft it, then approve before it goes home.",
            trailing = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space3),
                ) {
                    GhostButton(
                        label = "Template bank",
                        onClick = { drawerOpen = true },
                        leading = {
                            Icon(Lucide.LayoutGrid, contentDescription = null, modifier = Modifier.size14())
                        },
                    )
                    SegmentedPicker(
                        options = ComposeMode.values().toList(),
                        selected = mode,
                        onSelect = { mode = it },
                        label = { it.label },
                    )
                }
            },
        )
        Spacer(Modifier.height(dims.space5))

        StatusToast(
            visible = toastMsg != null,
            message = toastMsg?.first.orEmpty(),
            kind = toastMsg?.second ?: ToastKind.Info,
            onDismiss = { toastMsg = null },
        )
        Spacer(Modifier.height(if (toastMsg != null) dims.space3 else 0.dp))

        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val twoCol = maxWidth >= 860.dp

            if (twoCol) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(dims.space5),
                ) {
                    Box(modifier = Modifier.weight(1.15f)) {
                        ComposePanel(
                            mode = mode,
                            fromTemplate = fromTemplate,
                            onClearTemplate = { fromTemplate = null },
                            messageType = messageType,
                            onMessageType = { messageType = it },
                            subject = subject,
                            onSubject = { subject = it },
                            recipient = selectedKinfolk,
                            onPickRecipient = { selectedKinfolk = it },
                            kinfolkState = kinfolkState,
                            notes = notes, onNotes = { notes = it },
                            tone = tone, onTone = { tone = it },
                            length = length, onLength = { length = it },
                            loading = loading, saving = saving,
                            result = result,
                            editedCopy = editedCopy, onEditedCopy = { editedCopy = it },
                            onGenerate = ::generate, onApprove = ::approveDraft,
                            firestore = firestore,
                            onToast = { msg, kind -> showToast(msg, kind) },
                        )
                    }
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(dims.space5),
                    ) {
                        RecipientContextPanel(
                            recipient = selectedKinfolk,
                            firestore = firestore,
                        )
                        // #12: Live preview is the primary right-column panel and stays
                        // open; the secondary panels collapse by default so the column
                        // no longer overflows below the fold (expand on demand).
                        PreviewPanel(recipientName = recipientName, subject = subject, body = editedCopy)
                        ExternalSendPanel(
                            firestore = firestore,
                            onToast = { msg, kind -> showToast(msg, kind) },
                            collapsible = true,
                            initiallyExpanded = false,
                        )
                        RecentPanel(collapsible = true, initiallyExpanded = false)
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space5)) {
                    ComposePanel(
                        mode = mode,
                        fromTemplate = fromTemplate,
                        onClearTemplate = { fromTemplate = null },
                        messageType = messageType,
                        onMessageType = { messageType = it },
                        subject = subject,
                        onSubject = { subject = it },
                        recipient = selectedKinfolk,
                        onPickRecipient = { selectedKinfolk = it },
                        kinfolkState = kinfolkState,
                        notes = notes, onNotes = { notes = it },
                        tone = tone, onTone = { tone = it },
                        length = length, onLength = { length = it },
                        loading = loading, saving = saving,
                        result = result,
                        editedCopy = editedCopy, onEditedCopy = { editedCopy = it },
                        onGenerate = ::generate, onApprove = ::approveDraft,
                        firestore = firestore,
                        onToast = { msg, kind -> showToast(msg, kind) },
                    )
                    RecipientContextPanel(
                        recipient = selectedKinfolk,
                        firestore = firestore,
                    )
                    PreviewPanel(recipientName = recipientName, subject = subject, body = editedCopy)
                    ExternalSendPanel(
                        firestore = firestore,
                        onToast = { msg, kind -> showToast(msg, kind) },
                    )
                    RecentPanel()
                }
            }
        }

        if (drawerOpen) {
            Spacer(Modifier.height(dims.space5))
            TemplateBankPanel(
                state = templatesState,
                onClose = { drawerOpen = false },
                onPick = ::applyTemplate,
            )
        }
    }
}

private fun Modifier.size14(): Modifier = this.height(14.dp).width(14.dp)

// ─────────────────────────────────────────────────────────────────────────────
// Compose panel (left)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ComposePanel(
    mode: ComposeMode,
    fromTemplate: String?,
    onClearTemplate: () -> Unit,
    messageType: MessageType,
    onMessageType: (MessageType) -> Unit,
    subject: String,
    onSubject: (String) -> Unit,
    recipient: Kinfolk?,
    onPickRecipient: (Kinfolk?) -> Unit,
    kinfolkState: FirestoreResult<List<Kinfolk>>,
    notes: String,
    onNotes: (String) -> Unit,
    tone: Tone,
    onTone: (Tone) -> Unit,
    length: Length,
    onLength: (Length) -> Unit,
    loading: Boolean,
    saving: Boolean,
    result: GenerateResponse?,
    editedCopy: String,
    onEditedCopy: (String) -> Unit,
    onGenerate: () -> Unit,
    onApprove: () -> Unit,
    firestore: FirestoreClient,
    onToast: (String, ToastKind) -> Unit,
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

            if (fromTemplate != null) {
                FromTemplateChip(name = fromTemplate, onClear = onClearTemplate)
            }

            if (mode == ComposeMode.Broadcast) {
                if (flags.communicateBroadcast) {
                    // Live (Stage 2 step 6): saved segments + multichannel fan-out
                    // via the broadcastMessage / audience-segment callables.
                    BroadcastForm(firestore = firestore, onToast = onToast)
                } else {
                    // Kill-switch off: surface it loud, never a silent blank.
                    AuntieBanner(
                        tone = AuntieBannerTone.Suggestion,
                        title = "Broadcast is turned off",
                        icon = Lucide.Megaphone,
                        pillLabel = "OFF",
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
            FieldLabel("Message type")
            SegmentedPicker(
                options = MessageType.values().toList(),
                selected = messageType,
                onSelect = onMessageType,
                label = { it.label },
            )

            // ── Recipient ── omitted for recipient-less blog/social (spec 19 item 2)
            if (messageType.needsRecipient) {
                FieldLabel("Recipient")
                RecipientPicker(
                    recipient = recipient,
                    onPick = onPickRecipient,
                    kinfolkState = kinfolkState,
                )
                recipient?._id?.takeIf { it.isNotBlank() }?.let { id ->
                    LastCommunicationBox(kinfolkId = id, firestore = firestore)
                }
            }

            // ── Subject (spec 19 item 3) ── author-typed; bound to the preview ─
            FieldLabel("Subject")
            BottomBorderField(
                value = subject,
                onValueChange = onSubject,
                label = "",
                // TODO(copy): subject wording is author-owned; this is just the field.
                placeholder = "What is this about?",
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Tone + Length ─────────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space5),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    FieldLabel("Tone")
                    AuntieChipGroup(
                        options = Tone.values().toList(),
                        selected = setOf(tone),
                        onSelectionChange = { next -> next.firstOrNull()?.let(onTone) },
                        label = { it.label },
                        singleSelect = true,
                    )
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    FieldLabel("Length")
                    AuntieChipGroup(
                        options = Length.values().toList(),
                        selected = setOf(length),
                        onSelectionChange = { next -> next.firstOrNull()?.let(onLength) },
                        label = { it.label },
                        singleSelect = true,
                    )
                }
            }

            // ── Raw notes ─────────────────────────────────────────────────────
            MultilineField(
                value = notes,
                onValueChange = onNotes,
                label = "What is it about?",
                placeholder = "Bullets or free-form. The more honest, the warmer the draft.",
                minLines = 6,
            )

            // ── Generate / Regenerate ─────────────────────────────────────────
            Row(horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                PrimaryButton(
                    label = if (result == null) "Generate draft" else "Regenerate",
                    onClick = onGenerate,
                    loading = loading,
                    leading = {
                        Icon(
                            imageVector = if (result == null) Lucide.Sparkles else Lucide.RefreshCw,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size14(),
                        )
                    },
                )
            }

            // ── Generated draft callout + editor ──────────────────────────────
            result?.let { r ->
                DraftCallout(
                    subtitle = listOfNotNull(
                        r.kinfolk_name?.let { "for $it" },
                        r.communication_type,
                        r.model,
                        r.draft_id?.let { "draft #$it" },
                    ).joinToString(" · "),
                )
                MultilineField(
                    value = editedCopy,
                    onValueChange = onEditedCopy,
                    label = "Edit before approving",
                    minLines = 8,
                )
            }

            // ── Approve bar (backed send-path: approveGeneratedDraft) ──────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space4),
            ) {
                PrimaryButton(
                    label = "Approve draft",
                    onClick = onApprove,
                    loading = saving,
                    enabled = result?.draft_id != null,
                    leading = {
                        Icon(
                            imageVector = Lucide.Send,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size14(),
                        )
                    },
                )
                Text(
                    text = "approving promotes the draft in Firestore and logs it to the audit trail",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast form (Stage 2 step 6): pick a saved audience segment (or build an
// ad-hoc one), choose channels, write the message, send. Saved segments load via
// listAudienceSegments; the send routes through broadcastMessage which resolves
// the audience server-side and fans out, honoring opt-outs. Fail-loud: server
// sentinels and provider errors surface verbatim.
// ─────────────────────────────────────────────────────────────────────────────
@Composable
private fun BroadcastForm(
    firestore: FirestoreClient,
    onToast: (String, ToastKind) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()

    var segments by remember { mutableStateOf<List<AudienceSegment>>(emptyList()) }
    var loadingSegments by remember { mutableStateOf(true) }
    var selectedSegmentId by remember { mutableStateOf<String?>(null) } // null = ad-hoc

    // Ad-hoc criteria builder.
    var kind by remember { mutableStateOf(SegmentKind.All) }
    var statusesText by remember { mutableStateOf("") }
    var selectedTags by remember { mutableStateOf<List<String>>(emptyList()) }
    var tagQuery by remember { mutableStateOf("") }
    var tagMatch by remember { mutableStateOf(TagMatch.Any) }
    var newSegmentName by remember { mutableStateOf("") }

    // The household tag vocabulary the "By tag" audience picks from. HOUSEHOLD
    // ONLY, on purpose: the server criteria schema has no pet-tag kind and the
    // resolver reads `kinfolk.tags` (audienceCriteria.ts), so a pet tag offered
    // here would build an audience the server quietly ignores.
    val settingsState by remember(firestore) { firestore.businessSettingsStream() }
        .collectAsState(initial = FirestoreResult.Loading)
    val householdVocab: List<TagDef> =
        (settingsState as? FirestoreResult.Data)?.value?.householdTags ?: emptyList()
    val vocabLoaded = settingsState is FirestoreResult.Data
    val vocabError = (settingsState as? FirestoreResult.Error)?.message

    val channels = remember { mutableStateListOf(BroadcastChannel.InApp) }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }

    var sending by remember { mutableStateOf(false) }
    var savingSegment by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<BroadcastResult?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }
    /**
     * #814: one key per SUBMISSION, re-minted only when the message or its
     * audience has changed since the key was minted. An operator who sees an
     * error presses Send again, and that press is what used to put a second
     * email and a second text in front of every household the segment matched;
     * with the key the server answers from the broadcast the first press
     * claimed. There is no automatic retry here, see `data/SendIdempotency.kt`.
     */
    var submissionKey by remember { mutableStateOf<String?>(null) }
    var submissionSignature by remember { mutableStateOf<String?>(null) }
    /**
     * #867 review: the signature of a draft whose send timed out, or null. While the
     * draft still matches it, Send reuses the key and lands on that broadcast. Once
     * the draft differs, the next Send is a second broadcast, and the screen says so.
     */
    var timedOutSignature by remember { mutableStateOf<String?>(null) }

    fun adhocCriteria(): BroadcastCriteria = BroadcastCriteria(
        kind = kind,
        statuses = statusesText.split(',').map { it.trim() }.filter { it.isNotEmpty() },
        // Already normalized and deduped by the picker, and carrying the
        // vocabulary's casing, which is what the server compares against.
        tags = selectedTags,
        tagMatch = tagMatch,
    )

    /**
     * The one tag problem that genuinely stops a send: over the server's cap the
     * whole call is rejected, so blocking here with readable copy beats letting
     * Zod answer. Only applies to an ad-hoc tag audience; a saved segment was
     * validated when it was saved.
     */
    fun tagCapProblem(): String? =
        if (selectedSegmentId == null && kind == SegmentKind.Tags) broadcastTagCapProblem(selectedTags) else null

    fun loadSegments() {
        scope.launch {
            loadingSegments = true
            when (val r = firestore.listAudienceSegments()) {
                is WriteResult.Ok -> { segments = r.value; loadingSegments = false }
                is WriteResult.Err -> { loadingSegments = false; onToast("Could not load segments: ${r.message}", ToastKind.Error) }
            }
        }
    }

    LaunchedEffect(Unit) { loadSegments() }

    fun saveSegment() {
        val criteria = adhocCriteria()
        val blocker = tagCapProblem() ?: segmentSaveBlocker(newSegmentName, criteria)
        if (blocker != null) { onToast(blocker, ToastKind.Error); return }
        savingSegment = true
        scope.launch {
            when (val r = firestore.saveAudienceSegment(id = null, name = newSegmentName.trim(), criteria = criteria)) {
                is WriteResult.Ok -> {
                    onToast("Saved segment \"${newSegmentName.trim()}\".", ToastKind.Success)
                    newSegmentName = ""
                    selectedSegmentId = r.value
                    loadSegments()
                }
                is WriteResult.Err -> onToast("Save failed: ${r.message}", ToastKind.Error)
            }
            savingSegment = false
        }
    }

    fun deleteSegment(seg: AudienceSegment) {
        scope.launch {
            when (val r = firestore.deleteAudienceSegment(seg.id)) {
                is WriteResult.Ok -> {
                    if (selectedSegmentId == seg.id) selectedSegmentId = null
                    onToast("Deleted segment \"${seg.name}\".", ToastKind.Success)
                    loadSegments()
                }
                is WriteResult.Err -> onToast("Delete failed: ${r.message}", ToastKind.Error)
            }
        }
    }

    fun send() {
        errorText = null
        val criteria = if (selectedSegmentId == null) adhocCriteria() else null
        val effectiveCriteria = criteria ?: segments.firstOrNull { it.id == selectedSegmentId }?.criteria ?: BroadcastCriteria()
        val blocker = tagCapProblem() ?: broadcastBlocker(channels.toSet(), effectiveCriteria, subject, body)
        if (blocker != null) { errorText = blocker; onToast(blocker, ToastKind.Error); return }
        sending = true
        val signature = broadcastSignature(selectedSegmentId, kind, statusesText, selectedTags, tagMatch, channels, subject, body)
        if (submissionKey == null || submissionSignature != signature) {
            submissionKey = mintBroadcastIdempotencyKey()
            submissionSignature = signature
        }
        val key = submissionKey
        scope.launch {
            when (val r = firestore.broadcastMessage(
                segmentId = selectedSegmentId,
                criteria = criteria,
                channels = channels.toList(),
                subject = subject.trim().ifBlank { null },
                body = body.trim(),
                idempotencyKey = key,
            )) {
                is WriteResult.Ok -> {
                    result = r.value
                    errorText = null
                    submissionKey = null
                    timedOutSignature = null
                    onToast(broadcastSummary(r.value), ToastKind.Success)
                }
                is WriteResult.Err -> {
                    result = null
                    timedOutSignature = if (isBroadcastTimeout(r.message)) signature else null
                    errorText = broadcastErrorText(r.message)
                    onToast(broadcastErrorText(r.message), ToastKind.Error)
                }
            }
            sending = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
        // ── Audience ───────────────────────────────────────────────────────
        FieldLabel("Audience")
        if (loadingSegments) {
            Text("Loading segments…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieChip(
                label = "Ad-hoc",
                selected = selectedSegmentId == null,
                onClick = { selectedSegmentId = null },
                tone = AuntieChipTone.Accent,
            )
        }
        if (segments.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                segments.forEach { seg ->
                    AuntieChip(
                        label = seg.name,
                        secondaryLabel = seg.description,
                        selected = selectedSegmentId == seg.id,
                        onClick = { selectedSegmentId = seg.id },
                        onRemove = { deleteSegment(seg) },
                        tone = AuntieChipTone.Teal,
                    )
                }
            }
        }

        // ── Ad-hoc criteria builder (only when ad-hoc) ─────────────────────
        if (selectedSegmentId == null) {
            FieldLabel("Who is this for?")
            SegmentedPicker(
                options = SegmentKind.values().toList(),
                selected = kind,
                onSelect = { kind = it },
                label = { it.label },
            )
            if (kind == SegmentKind.Status) {
                BottomBorderField(
                    value = statusesText,
                    onValueChange = { statusesText = it },
                    label = "Statuses",
                    placeholder = "active, prospect",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (kind == SegmentKind.Tags) {
                FieldLabel("Household tags")
                Text(
                    text = "A broadcast matches tags on the household, not tags on individual pets.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )

                vocabError?.let { msg ->
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
                if (selectedTags.isNotEmpty()) {
                    TagChipFlow {
                        selectedTags.forEach { name ->
                            TagChip(
                                name = name,
                                vocab = householdVocab,
                                onRemove = { selectedTags = removeBroadcastTag(selectedTags, name) },
                            )
                        }
                    }
                }

                AuntieSearchField(
                    value = tagQuery,
                    onValueChange = { tagQuery = it },
                    placeholder = "Type or pick a household tag",
                    leadingIcon = Lucide.Search,
                    onClear = { tagQuery = "" },
                    // Enter takes what was typed, so a free-form tag that predates
                    // the vocabulary is still reachable.
                    onSubmit = {
                        selectedTags = addBroadcastTag(selectedTags, tagQuery, householdVocab)
                        tagQuery = ""
                    },
                    modifier = Modifier.fillMaxWidth(),
                )

                val suggestions = broadcastTagSuggestions(tagQuery, householdVocab, selectedTags)
                when {
                    !vocabLoaded && vocabError == null ->
                        Text("Loading your tag list…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    householdVocab.isEmpty() ->
                        Text(
                            text = "No household tags yet. Add some in Settings, Tags, or type one here to use it anyway.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    suggestions.isEmpty() && tagQuery.isNotBlank() ->
                        Text(
                            text = "Nothing in your list matches \"${tagQuery.trim()}\". Press enter to use it anyway.",
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
                            Box(
                                modifier = Modifier.clickable {
                                    selectedTags = addBroadcastTag(selectedTags, def.name, householdVocab)
                                    tagQuery = ""
                                },
                            ) {
                                TagChip(name = def.name, vocab = householdVocab)
                            }
                        }
                    }
                }

                // Fail loud on both counts: a tag nobody carries would report a
                // clean zero, and going over the cap is a whole-call rejection.
                broadcastTagVocabWarning(selectedTags, householdVocab, vocabLoaded)?.let { warn ->
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "Check these tag names",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(text = warn, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    }
                }
                broadcastTagCapProblem(selectedTags)?.let { problem ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Too many tags", icon = Lucide.Ban) {
                        Text(text = problem, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    }
                }

                SegmentedPicker(
                    options = TagMatch.values().toList(),
                    selected = tagMatch,
                    onSelect = { tagMatch = it },
                    label = { it.label },
                )
            }
            // Save the current ad-hoc criteria as a reusable segment.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                BottomBorderField(
                    value = newSegmentName,
                    onValueChange = { newSegmentName = it },
                    label = "",
                    placeholder = "Name to save this audience",
                    modifier = Modifier.weight(1f),
                )
                GhostButton(
                    label = if (savingSegment) "Saving…" else "Save segment",
                    onClick = ::saveSegment,
                    enabled = !savingSegment,
                    leading = { Icon(Lucide.Bookmark, contentDescription = null, modifier = Modifier.size14()) },
                )
            }
        }

        // ── Channels (multi-select) ─────────────────────────────────────────
        FieldLabel("Channels")
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
            BroadcastChannel.values().forEach { ch ->
                AuntieChip(
                    label = ch.label,
                    selected = ch in channels,
                    onClick = { if (ch in channels) channels.remove(ch) else channels.add(ch) },
                    tone = AuntieChipTone.Purple,
                )
            }
        }

        // ── Message ─────────────────────────────────────────────────────────
        FieldLabel("Subject / title")
        BottomBorderField(
            value = subject,
            onValueChange = { subject = it },
            label = "",
            placeholder = "Used as the email subject and in-app title",
            modifier = Modifier.fillMaxWidth(),
        )
        MultilineField(
            value = body,
            onValueChange = { body = it },
            label = "Message",
            placeholder = "Write the message you want to send to this audience.",
            minLines = 4,
        )

        broadcastEditWarning(
            timedOutSignature,
            broadcastSignature(selectedSegmentId, kind, statusesText, selectedTags, tagMatch, channels, subject, body),
        )?.let { warning ->
            AuntieBanner(tone = AuntieBannerTone.Warning, title = "This will be a new broadcast", icon = Lucide.TriangleAlert) {
                Text(text = warning, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            }
        }

        PrimaryButton(
            label = "Send broadcast",
            onClick = ::send,
            loading = sending,
            leading = {
                Icon(Lucide.Megaphone, contentDescription = null, tint = c.background, modifier = Modifier.size14())
            },
        )

        errorText?.let { msg ->
            val title = if (timedOutSignature != null) "Send may still be running" else "Broadcast blocked"
            AuntieBanner(tone = AuntieBannerTone.Error, title = title, icon = Lucide.Ban) {
                Text(text = msg, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            }
        }
        result?.let { r ->
            AuntieBanner(tone = AuntieBannerTone.Success, title = "Broadcast sent", icon = Lucide.Megaphone) {
                Text(text = broadcastSummary(r), style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            }
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.2.sp),
        color = AuntieTheme.colors.textDim,
    )
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

/** "from template" source chip shown above the draft once a template is pulled. */
@Composable
private fun FromTemplateChip(name: String, onClear: () -> Unit) {
    val c = AuntieTheme.colors
    AuntieBanner(
        tone = AuntieBannerTone.Info,
        pillLabel = "FROM TEMPLATE",
        icon = Lucide.LayoutGrid,
        onDismiss = onClear,
    ) {
        Text(
            text = name,
            style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
            color = c.textPrimary,
        )
    }
}

/**
 * Recipient picker. Resolves a real [Kinfolk] from [kinfolkStream] so a kinfolk_id
 * is chosen client-side instead of leaving n8n to fuzzy-match a typed name. Shows
 * the selected kinfolk as a card with a "Change" toggle that reveals a searchable
 * list of households.
 */
@Composable
private fun RecipientPicker(
    recipient: Kinfolk?,
    onPick: (Kinfolk?) -> Unit,
    kinfolkState: FirestoreResult<List<Kinfolk>>,
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
                    initials = recipient?.displayName?.take(2) ?: "?",
                    size = 42.dp,
                    gradientSeed = recipient?._id ?: "kinfolk",
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
                leadingIcon = Lucide.Search,
                onClear = { query = "" },
            )
            when (kinfolkState) {
                is FirestoreResult.Loading -> EmptyHint("Loading kinfolk…")
                is FirestoreResult.Error ->
                    EmptyHint("Couldn't load kinfolk: ${kinfolkState.message}", error = true)
                is FirestoreResult.Data -> {
                    val matches = kinfolkState.value
                        .filter { it.status != "archived" }
                        .filter {
                            query.isBlank() ||
                                it.displayName.contains(query, ignoreCase = true) ||
                                it.email.contains(query, ignoreCase = true)
                        }
                        .sortedBy { it.displayName.lowercase() }
                    if (matches.isEmpty()) {
                        EmptyHint("No kinfolk match \"$query\".")
                    } else {
                        Column(
                            modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            matches.take(40).forEach { k ->
                                AuntieEntityRow(
                                    title = k.displayName,
                                    subtitle = k.email.ifBlank { k.phoneNumber.ifBlank { "no contact on file" } },
                                    selected = recipient?._id == k._id,
                                    leading = {
                                        AuntieAvatar(initials = k.displayName.take(2), size = 34.dp, gradientSeed = k._id)
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
// Recipient context panel (right). An admin-only / internal read: the selected
// recipient's live dossier (short summary) + a "The 411" list of kin cards
// (parity with Android DossierPanel + KinCard). The Refresh-intelligence action
// moved to the profile screens in a later phase; this panel is read-only.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun RecipientContextPanel(
    recipient: Kinfolk?,
    firestore: FirestoreClient,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Recipient context",
        subtitle = "Dossier and kin Auntie reads before drafting",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            Text(
                "Admin only / internal",
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
            )
            if (recipient == null) {
                EmptyHint("Pick a recipient to see the dossier and kin Auntie reads for them.")
            } else {
                RecipientContextBody(kinfolkId = recipient._id, firestore = firestore)
            }
        }
    }
}

/**
 * Live dossier + kin "411" for the selected recipient. Mirrors the Android
 * ContextPanel: a single loading spinner while either profile stream is in
 * flight, then the dossier card + a "The 411" list of kin cards. Each stream
 * fails LOUD ([FirestoreResult.Error] → a visible banner), never a silent blank.
 *
 * Text + avatar only. This surface shows the written dossier + 411, which is the data
 * actually populated in production. The legacy migrated image arrays (`media` /
 * `gallery` / `photos`) are empty everywhere, so the image strips were dropped here
 * (and on Android) as unnecessary in this spot; the kin avatar falls back to its
 * gradient tile when there is no profile picture.
 */
@Composable
private fun RecipientContextBody(kinfolkId: String, firestore: FirestoreClient) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val dossierState by remember(kinfolkId) { firestore.dossierStream(kinfolkId) }
        .collectAsState(initial = FirestoreResult.Loading)
    val kinState by remember(kinfolkId) { firestore.kinStream(kinfolkId) }
        .collectAsState(initial = FirestoreResult.Loading)

    // Mirror Android's single profileLoading spinner: wait for both streams to
    // settle before rendering so the panel doesn't flicker section-by-section.
    if (dossierState is FirestoreResult.Loading || kinState is FirestoreResult.Loading) {
        Box(modifier = Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
            AuntieSpinner(strokeWidth = 2.dp)
        }
        return
    }

    val dossier = (dossierState as? FirestoreResult.Data)?.value
    val kin = (kinState as? FirestoreResult.Data)?.value ?: emptyList()

    Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
        // ── Dossier ──────────────────────────────────────────────────────────
        (dossierState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load dossier", icon = Lucide.TriangleAlert) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            }
        }
        dossier?.let { DossierPanel(it) }

        // ── The 411 (per-kin) ────────────────────────────────────────────────
        (kinState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load kin", icon = Lucide.TriangleAlert) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            }
        }
        if (kin.isNotEmpty()) {
            FieldLabel("The 411")
            kin.forEach { k -> KinCard(kin = k, firestore = firestore) }
        }

        // Both streams resolved but nothing on file yet (a fresh recipient with no
        // synthesized dossier and no kin): say so loudly instead of a blank panel.
        if (dossierState is FirestoreResult.Data && kinState is FirestoreResult.Data &&
            dossier == null && kin.isEmpty()
        ) {
            EmptyHint("No saved dossier or kin on file yet for this recipient.")
        }
    }
}

/**
 * The dossier card: a collapsible block of the narrative + structured profile
 * facts the reconcile pipeline writes per kinfolk. Mirrors the Android
 * DossierPanel (text fields only on web; see [RecipientContextBody]).
 */
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
            Text(
                text = "THE DOSSIER",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.2.sp),
                color = c.primary,
            )
            Icon(
                imageVector = if (expanded) Lucide.ChevronDown else Lucide.ChevronRight,
                contentDescription = null,
                tint = c.textDim,
                modifier = Modifier.size14(),
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
 * One kin's card under "The 411". Collapsed: avatar + name + "species · breed"
 * (see [kinMetaLine]). Expanded: the 411 care fields. Each card OWNS its own
 * [FirestoreClient.kin411Stream] so the dynamic per-kin fan-out is handled by
 * composition (no manual map in the parent); a 411 load error fails loud in-card.
 */
@Composable
private fun KinCard(kin: Kin, firestore: FirestoreClient) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var expanded by remember { mutableStateOf(false) }

    val k411State by remember(kin._id) { firestore.kin411Stream(kin._id) }
        .collectAsState(initial = FirestoreResult.Loading)
    val kin411 = (k411State as? FirestoreResult.Data)?.value

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
                    imageUrl = kin.profilePictureUrl.ifBlank { null },
                    initials = kin.name.take(2).ifBlank { "?" },
                    size = 44.dp,
                    shape = CircleShape,
                    gradientSeed = kin._id,
                )
                Spacer(Modifier.width(dims.space3))
                Column {
                    Text(
                        text = kin.name.ifBlank { "(unnamed)" },
                        style = AuntieTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
                    val meta = kinMetaLine(kin.species, kin411?.breed ?: "")
                    if (meta.isNotBlank()) {
                        Text(meta, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
            }
            Icon(
                imageVector = if (expanded) Lucide.ChevronDown else Lucide.ChevronRight,
                contentDescription = null,
                tint = c.textDim,
                modifier = Modifier.size14(),
            )
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space3),
            ) {
                (k411State as? FirestoreResult.Error)?.let { err ->
                    AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.TriangleAlert) {
                        Text(
                            text = "Couldn't load the 411: ${err.message}",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textPrimary,
                        )
                    }
                }
                kin411?.let { f ->
                    ContextField("411", summaryLine(f.tldr, f.rawSummary, 200))
                }
            }
        }
    }
}

/**
 * A labelled dossier / 411 fact. Hidden entirely when the value is blank or the
 * reconcile placeholder (see [contextFieldShown]) so a card shows only real
 * content, never empty filler rows.
 */
@Composable
private fun ContextField(label: String, value: String) {
    if (!contextFieldShown(value)) return
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        FieldLabel(label)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

/**
 * "Where things last left off" for the selected recipient, shown under the
 * recipient picker. Reuses the existing global comms streams ([smsStream] etc.),
 * filtered client-side by kinfolkId, to find the single most recent record.
 *
 * When [FeatureFlags.communicateCommsRecap] is on it asks the admin-gated
 * recap_recent_comms callable for a 1-2 sentence AI summary; on any error it
 * falls back to the raw latest message and says so (disclosed fallback, never a
 * silent blank). Comms-stream load errors surface as fail-loud banners.
 */
@Composable
private fun LastCommunicationBox(
    kinfolkId: String,
    firestore: FirestoreClient,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val flags = LocalFeatureFlags.current

    // Reuse the existing global comms streams, filtered client-side by kinfolkId.
    val smsState by remember { firestore.smsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val callsState by remember { firestore.callsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val emailsState by remember { firestore.emailsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val vmState by remember { firestore.voicemailsStream() }.collectAsState(initial = FirestoreResult.Loading)

    val sms = (smsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val calls = (callsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val emails = (emailsState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val vms = (vmState as? FirestoreResult.Data)?.value.orEmpty().filter { it.kinfolkId == kinfolkId }
    val latest = latestCommunication(sms, emails, calls, vms)

    var recap by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var recapError by remember(kinfolkId) { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId, flags.communicateCommsRecap) {
        recap = null
        recapError = null
        if (flags.communicateCommsRecap) {
            when (val r = firestore.recapRecentComms(kinfolkId)) {
                is WriteResult.Ok -> recap = r.value.recap
                is WriteResult.Err -> recapError = r.message  // fail-loud; box falls back to raw-latest
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
        // Surface any comms-stream load errors (fail-loud, no silent blank).
        listOf(smsState, callsState, emailsState, vmState).forEach { st ->
            (st as? FirestoreResult.Error)?.let { err ->
                AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.TriangleAlert) {
                    Text(
                        "Couldn't load recent messages: ${err.message}",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textPrimary,
                    )
                }
            }
        }
        recapError?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Warning, icon = Lucide.TriangleAlert) {
                Text(
                    "AI recap unavailable ($msg). Showing the latest message instead.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
            }
        }

        when (val state = commsBoxState(flags.communicateCommsRecap, recap, latest)) {
            is CommsBoxState.AiRecap -> {
                FieldLabel("Where things last left off")
                Text(state.recap, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
            is CommsBoxState.RawLatest -> {
                FieldLabel("Latest message")
                Text(
                    "${state.latest.channel} · ${humanizeDate(state.latest.timestamp)}: ${state.latest.snippet}",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
                if (state.disclosedFallback) {
                    Text(
                        "Showing the raw latest message (AI recap unavailable).",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                    )
                }
            }
            CommsBoxState.Empty -> {
                Text(
                    "No messages on file yet.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview panel (right). Binds straight to the editable body so it updates the
// moment a template is pulled or the draft is edited (no network round-trip).
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PreviewPanel(recipientName: String, subject: String, body: String) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Live preview",
        subtitle = "How kinfolk see it",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieEmailPreviewCard(
                modifier = Modifier.fillMaxWidth(),
                // Author-typed subject (spec 19 item 3); falls back to a computed
                // placeholder only until the author types one. CTA stays placeholder.
                subject = subject.ifBlank {
                    if (recipientName.isNotBlank()) "A note about $recipientName" else "A note from Auntie"
                },
                body = body.ifBlank { "Pull a template or generate a draft and it shows up here." },
                ctaLabel = "Book a visit",
                highlightTokens = true,
            )
        }
    }
}

/**
 * External send (Stage 2 step 5). A real, backend-wired one-off send to a raw
 * email or phone that is NOT a kinfolk, straight from Communicate. The body is
 * authored by the admin here (no message template is fabricated); the callable
 * validates, honors opt-outs, sends via SendGrid/Twilio, and writes an audit
 * entry with the recipient redacted. On success only the redacted recipient is
 * shown back. Includes a suppress (opt-out) affordance.
 */
@Composable
private fun ExternalSendPanel(
    firestore: FirestoreClient,
    onToast: (String, ToastKind) -> Unit,
    collapsible: Boolean = false,
    initiallyExpanded: Boolean = true,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()

    var channel by remember { mutableStateOf(ExternalChannel.Email) }
    var recipient by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }

    var sending by remember { mutableStateOf(false) }
    var suppressing by remember { mutableStateOf(false) }
    var lastResult by remember { mutableStateOf<ExternalSendResult?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }

    fun send() {
        errorText = null
        val blocker = externalSendBlocker(channel, recipient, subject, body)
        if (blocker != null) {
            onToast(blocker, ToastKind.Error)
            return
        }
        sending = true
        scope.launch {
            try {
                val r = firestore.sendExternalMessage(
                    channel = channel.wire,
                    to = recipient.trim(),
                    subject = if (channel == ExternalChannel.Email) subject.trim() else null,
                    body = body.trim(),
                )
                when (r) {
                    is WriteResult.Ok -> {
                        lastResult = r.value
                        errorText = null
                        onToast("Sent to ${r.value.recipientRedacted}.", ToastKind.Success)
                    }
                    is WriteResult.Err -> {
                        lastResult = null
                        errorText = externalSendErrorText(r.message)
                        onToast(externalSendErrorText(r.message), ToastKind.Error)
                    }
                }
            } catch (t: Throwable) {
                errorText = t.message ?: "unknown error"
                onToast("Send failed: ${t.message ?: "unknown error"}", ToastKind.Error)
            } finally {
                sending = false
            }
        }
    }

    fun suppress() {
        errorText = null
        // The suppress action only needs a valid recipient (no subject/body).
        when (validateRecipient(channel, recipient)) {
            is RecipientValidation.Valid -> Unit
            RecipientValidation.Empty -> { onToast("Add a recipient to opt out first.", ToastKind.Error); return }
            RecipientValidation.BadEmail -> { onToast("That does not look like a valid email address.", ToastKind.Error); return }
            RecipientValidation.BadPhone -> { onToast("That does not look like a valid phone number.", ToastKind.Error); return }
        }
        suppressing = true
        scope.launch {
            try {
                when (val r = firestore.suppressExternalRecipient(channel.wire, recipient.trim())) {
                    is WriteResult.Ok -> {
                        errorText = null
                        onToast("Opted ${r.value.recipientRedacted} out. Future sends are blocked.", ToastKind.Success)
                    }
                    is WriteResult.Err -> {
                        errorText = r.message
                        onToast("Opt-out failed: ${r.message}", ToastKind.Error)
                    }
                }
            } catch (t: Throwable) {
                errorText = t.message ?: "unknown error"
                onToast("Opt-out failed: ${t.message ?: "unknown error"}", ToastKind.Error)
            } finally {
                suppressing = false
            }
        }
    }

    DenPanel(
        title = "Send outside the tribe",
        subtitle = "A one-off email or text to someone who is not a kinfolk. You write the message; I send it and log it.",
        modifier = Modifier.fillMaxWidth(),
        collapsible = collapsible,
        initiallyExpanded = initiallyExpanded,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
            FieldLabel("Channel")
            SegmentedPicker(
                options = ExternalChannel.values().toList(),
                selected = channel,
                onSelect = { channel = it },
                label = { it.label },
            )

            FieldLabel(if (channel == ExternalChannel.Email) "Email address" else "Phone number")
            BottomBorderField(
                value = recipient,
                onValueChange = { recipient = it },
                label = "",
                placeholder = if (channel == ExternalChannel.Email) "name@example.com" else "+1 555 123 4567",
                modifier = Modifier.fillMaxWidth(),
            )

            if (channel == ExternalChannel.Email) {
                FieldLabel("Subject")
                BottomBorderField(
                    value = subject,
                    onValueChange = { subject = it },
                    label = "",
                    placeholder = "What is this about?",
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            MultilineField(
                value = body,
                onValueChange = { body = it },
                label = "Message",
                placeholder = "Write the message you want to send.",
                minLines = 5,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space3),
            ) {
                PrimaryButton(
                    label = "Send",
                    onClick = ::send,
                    loading = sending,
                    leading = {
                        Icon(
                            imageVector = Lucide.Send,
                            contentDescription = null,
                            tint = c.background,
                            modifier = Modifier.size14(),
                        )
                    },
                )
                GhostButton(
                    label = if (suppressing) "Opting out…" else "Opt out recipient",
                    onClick = ::suppress,
                    enabled = !suppressing && !sending,
                    leading = { Icon(Lucide.Ban, contentDescription = null, modifier = Modifier.size14()) },
                )
            }

            errorText?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Send blocked",
                    icon = Lucide.Ban,
                ) {
                    Text(text = msg, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
            }

            lastResult?.let { r ->
                AuntieBanner(
                    tone = AuntieBannerTone.Info,
                    title = "Delivered to provider",
                    icon = Lucide.Mail,
                    pillLabel = r.channel.uppercase(),
                ) {
                    Text(
                        text = "Sent to ${r.recipientRedacted}. Provider id ${r.providerMessageId}. " +
                            "The full recipient is never stored in the audit log.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                }
            }
        }
    }
}

/**
 * "Recent" sends + engagement. Reads recent external sends via the listRecentSends
 * callable and shows the delivery / open / click counts the SendGrid + Twilio
 * webhooks reported. Honest: only measured events are shown (no fabricated rates);
 * fail-loud on a load error. Counts populate as provider events arrive.
 */
@Composable
private fun RecentPanel(
    collapsible: Boolean = false,
    initiallyExpanded: Boolean = true,
) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    var state by remember { mutableStateOf<RecentSendsUi>(RecentSendsUi.Loading) }
    LaunchedEffect(Unit) {
        state = when (val r = client.listRecentSends()) {
            is WriteResult.Ok -> RecentSendsUi.Loaded(r.value)
            is WriteResult.Err -> RecentSendsUi.Error(r.message)
        }
    }
    DenPanel(
        title = "Recent",
        modifier = Modifier.fillMaxWidth(),
        collapsible = collapsible,
        initiallyExpanded = initiallyExpanded,
    ) {
        when (val s = state) {
            is RecentSendsUi.Loading -> ShimmerCard(height = 64.dp)
            is RecentSendsUi.Error -> AuntieBanner(
                tone = AuntieBannerTone.Warning,
                icon = Lucide.TriangleAlert,
            ) {
                Text(
                    text = "Couldn't load recent sends: ${s.message}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
            }
            is RecentSendsUi.Loaded -> if (s.items.isEmpty()) {
                Text(
                    text = "No external sends yet. Sends from Communicate show here with delivery and open counts.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    s.items.forEach { snd ->
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

private sealed interface RecentSendsUi {
    data object Loading : RecentSendsUi
    data class Loaded(val items: List<RecentSend>) : RecentSendsUi
    data class Error(val message: String) : RecentSendsUi
}

// ─────────────────────────────────────────────────────────────────────────────
// Template bank: pulls real KinTale templates (templatesStream) and prefills the
// draft when one is picked. Replaces the old "no template backend" banner.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun TemplateBankPanel(
    state: FirestoreResult<List<KinTaleTemplate>>,
    onClose: () -> Unit,
    onPick: (KinTaleTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var query by remember { mutableStateOf("") }

    DenPanel(
        title = "Template bank",
        subtitle = "Pull a saved template to prefill an editable draft.",
        modifier = Modifier.fillMaxWidth(),
        trailing = {
            GhostButton(
                label = "Close",
                onClick = onClose,
                leading = { Icon(Lucide.X, contentDescription = null, modifier = Modifier.size14()) },
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = "Search templates by name or service",
                leadingIcon = Lucide.Search,
                onClear = { query = "" },
            )
            when (state) {
                is FirestoreResult.Loading -> EmptyHint("Loading templates…")
                is FirestoreResult.Error ->
                    EmptyHint("Couldn't load templates: ${state.message}", error = true)
                is FirestoreResult.Data -> {
                    val matches = state.value
                        .filter { it.isActive }
                        .filter {
                            query.isBlank() ||
                                it.name.contains(query, ignoreCase = true) ||
                                it.description.contains(query, ignoreCase = true) ||
                                it.serviceTypeKeys.any { s -> s.contains(query, ignoreCase = true) }
                        }
                        .sortedWith(compareByDescending<KinTaleTemplate> { it.isDefault }.thenBy { it.name.lowercase() })
                    if (matches.isEmpty()) {
                        EmptyHint(
                            if (query.isBlank()) "No active templates yet. Add one in the Template Bank screen."
                            else "No templates match \"$query\".",
                        )
                    } else {
                        Column(
                            modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            matches.forEach { t ->
                                AuntieEntityRow(
                                    title = t.name.ifBlank { t._id },
                                    subtitle = t.description.ifBlank {
                                        t.serviceTypeKeys.joinToString(", ").ifBlank { "visit recap" }
                                    },
                                    leading = {
                                        AuntieIconTile(
                                            icon = Lucide.LayoutGrid,
                                            tone = if (t.isDefault) AuntieStatusTone.Orange else AuntieStatusTone.Teal,
                                            size = 34.dp,
                                            contentDescription = null,
                                        )
                                    },
                                    trailing = if (t.isDefault) {
                                        { AuntieStatusPill(label = "default", tone = AuntieStatusTone.Orange, mono = true) }
                                    } else null,
                                    onClick = { onPick(t) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
