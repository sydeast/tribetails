package com.tribetails.auntieos.web.screens.kintales

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Play
import com.composables.icons.lucide.Save
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.ChecklistItem
import com.tribetails.auntieos.web.data.CommunicationType
import com.tribetails.auntieos.web.data.GenerateRequest
import com.tribetails.auntieos.web.data.N8nClient
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.appliesToSchemaIds
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleMediaConfig
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.responseKey
import com.tribetails.auntieos.web.screens.sessions.RouteMap
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieBreadcrumbs
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieEmailPreviewCard
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.AuntieMediaCell
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.Crumb
import com.tribetails.auntieos.web.ui.components.DynamicFormFields
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MediaCellGlyphs
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PetAvatar
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.util.nowIso
import com.tribetails.auntieos.web.util.openUrl
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/**
 * KinTale composer, opens after a Kin Care is "DEPARTED" and lets Auntie write
 * up the visit recap that goes home to the kinfolk.
 *
 * Redesigned to the Den "KinTale composer" mockup: a two-pane editor (a warm
 * cover hero + narrative + media + GPS route + moment chips on the left, a
 * recipient rail + a live kinfolk-facing preview on the right). Built only from
 * Den components on the warm-dark palette.
 *
 * Behavior pinned to product (unchanged from the prior revision):
 *  - Unchecked checklist items are *omitted* from the rendered KinTale (Precise
 *    semantics, opposite of Scritches). The composer respects per-item
 *    [ChecklistItem.showWhenUnchecked] but the default is `false`, so the
 *    natural behavior is hide-when-unchecked.
 *  - Up to 75 photos/videos combined; videos clipped to 15s.
 *
 * Deferred (call-out so reviewers don't expect them yet):
 *  - Firebase Storage upload for media, UI shows the cap + a placeholder picker.
 *  - Send-to-kinfolk transport (n8n / Cloud Function), Send marks the report
 *    SENT in Firestore via `markKinTaleReportSent`, which is the parity hook
 *    Android also uses; the actual delivery channel is wired by the existing
 *    backend pipeline.
 *  - Web template editor, the composer reads from Firestore templates already
 *    written by the Android editor, falling back to [DefaultKinTaleTemplate].
 */
@Composable
fun KinTaleComposeScreen(
    sessionId: String,
    onClose: () -> Unit,
) {
    var editingTemplate by remember { mutableStateOf(false) }
    if (editingTemplate) {
        KinTaleTemplateEditorScreen(onClose = { editingTemplate = false })
        return
    }
    val client   = remember { FirestoreClient() }
    val sessions by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolks by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)

    val session = remember(sessions, sessionId) {
        (sessions as? FirestoreResult.Data)?.value?.firstOrNull { it._id == sessionId }
    }
    val kinfolk = remember(kinfolks, session) {
        val id = session?.kinfolkId ?: return@remember null
        (kinfolks as? FirestoreResult.Data)?.value?.firstOrNull { it._id == id }
    }
    val kinForKinfolk by remember(session?.kinfolkId) {
        (session?.kinfolkId?.takeIf { it.isNotBlank() }?.let { client.kinStream(it) }
            ?: flowOf(FirestoreResult.Data(emptyList<Kin>())))
    }.collectAsState(initial = FirestoreResult.Loading)
    val kinList: List<Kin> = remember(kinForKinfolk, session) {
        val all = (kinForKinfolk as? FirestoreResult.Data)?.value.orEmpty()
        if (session != null && session.kinIds.isNotEmpty()) all.filter { it._id in session.kinIds } else all
    }

    val template by (session?.serviceType?.let { client.activeTemplateForService(it) }
        ?: flowOf(DefaultKinTaleTemplate.template))
        .collectAsState(initial = DefaultKinTaleTemplate.template)

    if (session == null) {
        ScreenScaffold {
            SectionHeader(title = "Loading…", subtitle = "Pulling Kin Care", icon = Lucide.ClipboardList)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(3) { ShimmerCard(height = 100.dp) }
            }
        }
        return
    }

    KinTaleComposerBody(
        session  = session,
        kinfolk  = kinfolk,
        kinList  = kinList,
        template = template,
        client   = client,
        onClose  = onClose,
        onEditTemplate = { editingTemplate = true },
    )
}

// -----------------------------------------------------------------------------
// Body: local mutable report state, wired to FirestoreClient writes.
// -----------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KinTaleComposerBody(
    session: KinCareSession,
    kinfolk: Kinfolk?,
    kinList: List<Kin>,
    template: KinTaleTemplate,
    client: FirestoreClient,
    onClose: () -> Unit,
    onEditTemplate: () -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    val n8n = remember { N8nClient() }
    val featureFlags = LocalFeatureFlags.current

    // Scaffold the in-memory draft. `_id` blank → first save creates the doc.
    var report by remember(session._id, template._id) {
        mutableStateOf(scaffoldReport(session, template))
    }
    var bodyCopy by remember(report._id) { mutableStateOf(report.bodyCopy) }
    // Auntie-authored headline for the cover. Blank uses composerTitle(...) ONLY
    // as placeholder; we never write the derived value back onto the report.
    var titleDraft by remember(report._id) { mutableStateOf(report.title) }
    var isSaving by remember { mutableStateOf(false) }
    var isSending by remember { mutableStateOf(false) }
    var isUploading by remember { mutableStateOf(false) }
    var attachedMedia by remember(session._id) { mutableStateOf<List<MediaFile>>(emptyList()) }
    var toast    by remember { mutableStateOf("") }
    var toastVis by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }
    var isGenerating by remember { mutableStateOf(false) }
    // Opener of the last generated draft; fed back as avoid_opening on regenerate.
    var lastOpening by remember(report._id) { mutableStateOf<String?>(null) }

    // Phase 14: KINTALE form_schemas (appliesTo == KINTALE). Admin-authored custom
    // fields, DISTINCT from the template-driven fieldResponses above. Answers live on
    // report.formValues and ride along on every persist/send.
    val schemaRepo = remember { CloudFormSchemaRepository() }
    var taleSchemas by remember { mutableStateOf<List<FormSchema>>(emptyList()) }
    var schemaError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        when (val list = schemaRepo.listSchemas()) {
            is WriteResult.Err -> schemaError = list.message
            is WriteResult.Ok  -> {
                val loaded = mutableListOf<FormSchema>()
                for (id in appliesToSchemaIds(list.value, "KINTALE")) {
                    when (val s = schemaRepo.getSchema(id)) {
                        is WriteResult.Ok  -> loaded.add(s.value)
                        is WriteResult.Err -> schemaError = s.message
                    }
                }
                taleSchemas = loaded
            }
        }
    }

    // Hydrate any media already attached to this session: supports resume of
    // a draft started in another tab or on Android.
    val mediaStream by remember(session._id) { client.mediaForSessionStream(session._id) }.collectAsState(initial = FirestoreResult.Loading)
    LaunchedEffect(mediaStream) {
        val data = mediaStream as? FirestoreResult.Data ?: return@LaunchedEffect
        attachedMedia = data.value.sortedByDescending { it.uploadedAt }
        // Keep the in-memory report in sync so Send doesn't drop pre-existing media.
        val ids = data.value.mapNotNull { it._id.takeIf { id -> id.isNotBlank() } }
        if (ids.toSet() != report.mediaFileIds.toSet()) {
            report = report.copy(mediaFileIds = ids)
        }
    }

    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVis = true
    }

    fun mutateField(itemKey: String, kinId: String, transform: (FieldResponse) -> FieldResponse): KinCareReport {
        val key = responseKey(itemKey, kinId)
        val existing = report.fieldResponses[key] ?: FieldResponse(fieldKey = itemKey, kinId = kinId)
        val updated = report.fieldResponses + (key to transform(existing))
        val next = report.copy(fieldResponses = updated)
        report = next
        return next
    }

    /**
     * Persist the in-memory draft. Only round-trips when there's actual content
     * (we don't want a ghost row in Firestore the moment Auntie opens the screen).
     */
    fun persistDraft(latest: KinCareReport = report) {
        if (!hasContent(latest)) return
        scope.launch {
            isSaving = true
            val res = if (latest._id.isBlank()) {
                client.createKinTaleReport(latest)
            } else {
                when (val r = client.updateKinTaleReport(latest)) {
                    is WriteResult.Ok  -> WriteResult.Ok(latest._id)
                    is WriteResult.Err -> r
                }
            }
            isSaving = false
            when (res) {
                is WriteResult.Ok  -> {
                    if (latest._id.isBlank()) report = latest.copy(_id = res.value)
                }
                is WriteResult.Err -> showToast("Couldn't save draft: ${res.message}", ToastKind.Error)
            }
        }
    }

    fun setChecklistChecked(item: ChecklistItem, kinId: String, checked: Boolean) {
        val updated = mutateField(item.key, kinId) { it.copy(boolValue = checked) }
        persistDraft(updated)
    }

    /**
     * Generate-draft: turn the shorthand in [bodyCopy] into a full KinTale in
     * Auntie's voice via the same generate path as Communicate (function or n8n,
     * gated by FeatureFlags.communicateGenerateViaFunction). The result drops into
     * the editable body; manual editing still works. Regenerate passes the previous
     * opener as avoid_opening so a re-roll genuinely varies (the "I don't like v1"
     * path). Fail-loud on error.
     */
    fun generateDraft() {
        if (isGenerating) return
        val notes = bodyCopy.trim()
        if (notes.isEmpty()) {
            showToast("Jot a few notes first so Auntie has something to work with.", ToastKind.Error)
            return
        }
        val recipient = kinfolk?.displayName.orEmpty()
        if (recipient.isBlank()) {
            showToast("This Kin Care has no linked Kinfolk to write to.", ToastKind.Error)
            return
        }
        scope.launch {
            isGenerating = true
            try {
                val resp = n8n.generate(
                    GenerateRequest(
                        communication_type = CommunicationType.VISIT_REPORT,
                        recipient = recipient,
                        raw_notes = notes,
                        avoid_opening = lastOpening,
                    ),
                    useFunction = featureFlags.communicateGenerateViaFunction,
                )
                if (resp.error != null) {
                    showToast("Generate error: ${resp.error}", ToastKind.Error)
                } else {
                    val copy = resp.generated_copy
                    bodyCopy = copy
                    val updated = report.copy(bodyCopy = copy)
                    report = updated
                    lastOpening = copy.trim().takeWhile { !it.isWhitespace() }.ifBlank { null }
                    showToast("Auntie drafted a tale. Edit away.", ToastKind.Success)
                    persistDraft(updated)
                }
            } catch (t: Throwable) {
                showToast("Generate failed: ${t.message ?: "unknown error"}", ToastKind.Error)
            } finally {
                isGenerating = false
            }
        }
    }

    fun onSend() {
        if (!hasContent(report)) {
            showToast("Nothing to send yet. Fill in some details first.", ToastKind.Error)
            return
        }
        scope.launch {
            isSending = true
            // Persist any pending content first (creates the doc if needed).
            val latest = report
            val savedId = if (latest._id.isBlank()) {
                when (val r = client.createKinTaleReport(latest)) {
                    is WriteResult.Ok  -> { report = latest.copy(_id = r.value); r.value }
                    is WriteResult.Err -> { isSending = false; showToast("Couldn't save before sending: ${r.message}", ToastKind.Error); return@launch }
                }
            } else {
                when (val r = client.updateKinTaleReport(latest)) {
                    is WriteResult.Ok  -> latest._id
                    is WriteResult.Err -> { isSending = false; showToast("Couldn't save before sending: ${r.message}", ToastKind.Error); return@launch }
                }
            }

            // Mark the report SENT. Delivery transport is owned by the
            // existing backend (n8n / Cloud Function): Auntie sees the
            // status flip and the row clears from "Active" on the list.
            when (val r = client.markKinTaleReportSent(
                reportId          = savedId,
                sessionId         = session._id,
                sentVia           = "pending",  // backend pipeline overwrites with sms/email/fcm
                deliveryReceiptId = "",
                sentAtIso         = nowIso(),
            )) {
                is WriteResult.Ok -> {
                    isSending = false
                    showToast("KinTale sent. Kinfolk will hear from you soon.", ToastKind.Success)
                    onClose()
                }
                is WriteResult.Err -> {
                    isSending = false
                    showToast("Couldn't send: ${r.message}", ToastKind.Error)
                }
            }
        }
    }

    val isDirty = hasContent(report)

    ScreenScaffold {
        // ---- Header bar: breadcrumbs · draft pill · Preview / Send ----
        ComposerHeaderBar(
            session   = session,
            isSaving  = isSaving,
            isSending = isSending,
            isDirty   = isDirty,
            onClose   = onClose,
            onSend    = ::onSend,
        )

        StatusToast(
            visible   = toastVis,
            message   = toast,
            kind      = toastKind,
            onDismiss = { toastVis = false },
        )

        Spacer(Modifier.height(16.dp))

        // ---- Two-pane composer (reflows to single column on narrow widths) ----
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(22.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            // ── LEFT: editor ───────────────────────────────────────────────
            Column(
                modifier = Modifier.weight(1.45f).widthIn(min = 360.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                CoverHero(
                    session  = session,
                    kinList  = kinList,
                    titleDraft = titleDraft,
                    onTitleChange = {
                        titleDraft = it
                        report = report.copy(title = it)
                    },
                    onTitleBlur = { persistDraft() },
                    onEditTemplate = onEditTemplate,
                )

                // ---- KinTale Narrative ----
                if (template.visitNotesEnabled) {
                    ComposerBlock(label = "The tale") {
                        MultilineField(
                            value         = bodyCopy,
                            onValueChange = {
                                bodyCopy = it
                                report = report.copy(bodyCopy = it)
                            },
                            label    = "What you'd like the kinfolk to know",
                            placeholder = "Tell the tale, or jot shorthand and let Auntie draft it. How was the visit?",
                            minLines = 6,
                        )
                        GhostButton(
                            label   = if (isGenerating) "Auntie's writing…" else "Generate draft",
                            onClick = { generateDraft() },
                            leading = { Icon(Lucide.PawPrint, contentDescription = null, modifier = Modifier.size(13.dp)) },
                        )
                        GhostButton(
                            label   = "Save notes",
                            onClick = { persistDraft() },
                            leading = { Icon(Lucide.Save, contentDescription = null, modifier = Modifier.size(13.dp)) },
                        )
                    }
                }

                // ---- Photo strip ----
                if (template.photoShowcaseEnabled) {
                    MediaBlock(
                        attached    = attachedMedia,
                        isUploading = isUploading,
                        onPick = {
                            val remaining = KinTaleMediaConfig.MAX_FILES_PER_TALE - attachedMedia.size
                            if (remaining <= 0) {
                                showToast("You've hit the 75-file cap for this KinTale.", ToastKind.Error)
                                return@MediaBlock
                            }
                            scope.launch {
                                isUploading = true
                                when (val r = client.pickAndUploadKinTaleMedia(session._id, remaining)) {
                                    is WriteResult.Ok -> {
                                        if (r.value.isNotEmpty()) {
                                            attachedMedia = (r.value + attachedMedia).distinctBy { it._id.ifBlank { it.cloudinaryPublicId } }
                                            val newIds = report.mediaFileIds + r.value.mapNotNull { it._id.takeIf { id -> id.isNotBlank() } }
                                            val updated = report.copy(mediaFileIds = newIds.distinct())
                                            report = updated
                                            persistDraft(updated)
                                            showToast("Added ${r.value.size} item${if (r.value.size == 1) "" else "s"}.", ToastKind.Success)
                                        }
                                    }
                                    is WriteResult.Err -> showToast("Upload failed: ${r.message}", ToastKind.Error)
                                }
                                isUploading = false
                            }
                        },
                        onRemove = { mediaFile ->
                            if (mediaFile._id.isBlank()) return@MediaBlock
                            scope.launch {
                                // #577: send the row's OWN entityId (the session id) as
                                // the scope cross-check, so a stale attachment id can
                                // never delete another session's media.
                                when (val r = client.deleteKinTaleMedia(mediaFile._id, mediaFile.entityId)) {
                                    is WriteResult.Ok -> {
                                        attachedMedia = attachedMedia.filter { it._id != mediaFile._id }
                                        val updated = report.copy(mediaFileIds = report.mediaFileIds.filter { it != mediaFile._id })
                                        report = updated
                                        persistDraft(updated)
                                    }
                                    is WriteResult.Err -> showToast("Couldn't remove: ${r.message}", ToastKind.Error)
                                }
                            }
                        },
                        onOpen = { mediaFile -> openUrl(mediaFile.storageUrl) },
                    )
                }

                // ---- Walk route · auto-tracked ----
                if (session.visitRouteId.isNotBlank() || session._id.isNotBlank()) {
                    GpsRouteBlock(client = client, sessionId = session._id)
                }

                // ---- Moments · per-pet checklist ----
                val perPetItems = template.checklistItems
                    .filter { it.scope.equals("PER_PET", ignoreCase = true) }
                    .sortedBy { it.order }
                if (template.checklistEnabled && perPetItems.isNotEmpty() && kinList.isNotEmpty()) {
                    kinList.forEach { kin ->
                        // Conditional checklist: only the items whose conditions this
                        // kin satisfies (e.g. "Litter box scooped" for cats, "Meds
                        // given" for kin with medication notes). Matches the Android
                        // engine so the composer offers the same items either platform.
                        // The household goes in too: without it the KINFOLK_ATTRIBUTE
                        // and KINFOLK_TAG rules fail open and every item shows.
                        val itemsForKin = visiblePerPetItems(perPetItems, session, kin, kinfolk)
                        if (itemsForKin.isNotEmpty()) {
                            MomentsBlock(
                                label = "How was ${kin.name.ifBlank { "this kin" }} today?",
                                sublabel = listOfNotNull(
                                    kin.species.takeIf { it.isNotBlank() },
                                    kin.breed.takeIf { it.isNotBlank() },
                                ).joinToString(" · ").ifBlank { null },
                                items = itemsForKin,
                                responseFor = { itemKey -> report.fieldResponses[responseKey(itemKey, kin._id)] },
                                onToggle = { item, checked -> setChecklistChecked(item, kin._id, checked) },
                                onNotes  = { item, text -> mutateField(item.key, kin._id) { it.copy(stringValue = text) } },
                                onNotesBlur = { persistDraft() },
                            )
                        }
                    }
                }

                // ---- Moments · per-visit checklist ----
                // Drop per-visit items whose conditions this visit doesn't meet (e.g. a
                // service-type or household-tag rule). Same engine as the per-pet items.
                val perVisitItems = visiblePerVisitItems(
                    template.checklistItems
                        .filter { it.scope.equals("PER_VISIT", ignoreCase = true) }
                        .sortedBy { it.order },
                    session,
                    kinList,
                    kinfolk,
                )
                if (template.checklistEnabled && perVisitItems.isNotEmpty()) {
                    MomentsBlock(
                        label = "Overall visit checklist",
                        sublabel = "Things that apply to the whole visit",
                        items = perVisitItems,
                        responseFor = { itemKey -> report.fieldResponses[responseKey(itemKey, "")] },
                        onToggle    = { item, checked -> setChecklistChecked(item, "", checked) },
                        onNotes     = { item, text -> mutateField(item.key, "") { it.copy(stringValue = text) } },
                        onNotesBlur = { persistDraft() },
                    )
                }

                // ---- Custom fields (admin-authored KINTALE form_schemas, Phase 14) ----
                if (taleSchemas.isNotEmpty() || schemaError != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Custom fields", style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                        when {
                            // Fail loud: surface a schema load failure, never swallow it.
                            schemaError != null -> AuntieBanner(
                                tone = AuntieBannerTone.Error,
                                title = "Couldn't load the custom fields",
                            ) { Text(schemaError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
                            else -> DynamicFormFields(
                                schemas = taleSchemas,
                                values = report.formValues,
                                onValueChange = { k, v ->
                                    report = report.copy(formValues = report.formValues + (k to v))
                                },
                            )
                        }
                    }
                }

                // ---- Footer actions ----
                FooterActions(
                    isSaving  = isSaving,
                    isSending = isSending,
                    isDirty   = isDirty,
                    recipient = session.kinfolkName,
                    onDiscard = {
                        showToast("Discarded local edits. The draft on file is unchanged.", ToastKind.Info)
                        onClose()
                    },
                    onSaveDraft = { persistDraft() },
                    onSend = ::onSend,
                )
            }

            // ── RIGHT: recipient rail + live preview ───────────────────────
            Column(
                modifier = Modifier.weight(1f).widthIn(min = 300.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                RecipientRail(session = session, kinfolk = kinfolk, kinList = kinList)
                LivePreviewBlock(
                    title    = composerTitle(session, kinList),
                    bodyCopy = bodyCopy,
                    kinfolk  = kinfolk,
                    kinList  = kinList,
                    template = template,
                )
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Header bar: breadcrumbs · autosave status pill · Preview / Send
// -----------------------------------------------------------------------------

/**
 * Send-button label bound to the REAL recipient household, not a hardcoded sample
 * ("Send to the Thornes" was a placeholder). Falls back to neutral copy when blank.
 * Pure; unit-tested.
 */
internal fun kinTaleSendLabel(recipient: String): String =
    if (recipient.isBlank()) "Send KinTale" else "Send to $recipient"

@Composable
private fun ComposerHeaderBar(
    session: KinCareSession,
    isSaving: Boolean,
    isSending: Boolean,
    isDirty: Boolean,
    onClose: () -> Unit,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AuntieBreadcrumbs(
            crumbs = listOf(
                Crumb("KinTales"),
                Crumb("New tale", isCurrent = true),
            ),
            onCrumbClick = { onClose() },
        )
        AuntieStatusPill(
            label = if (isSaving) "Draft · saving…" else "Draft",
            tone  = AuntieStatusTone.Orange,
            showDot = true,
            mono = true,
        )
        Spacer(Modifier.weight(1f))
        // SUGGESTION: "Preview as Kinfolk" is shown live in the right rail; this
        // close affordance returns to the list (no separate preview route yet).
        GhostButton(
            label   = "Close",
            onClick = onClose,
        )
        PrimaryButton(
            label   = if (isSending) "Sending…" else kinTaleSendLabel(session.kinfolkName),
            onClick = onSend,
            enabled = isDirty && !isSending,
            loading = isSending,
            leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(14.dp)) },
        )
    }
}

// -----------------------------------------------------------------------------
// Cover hero: eyebrow (visit window) + big Fraunces-style title
// -----------------------------------------------------------------------------

@Composable
private fun CoverHero(
    session: KinCareSession,
    kinList: List<Kin>,
    titleDraft: String,
    onTitleChange: (String) -> Unit,
    onTitleBlur: () -> Unit,
    onEditTemplate: () -> Unit,
) {
    val c = AuntieTheme.colors
    val cover = Brush.linearGradient(
        c.sunsetGlowColors, // orange → pink → purple, the Den cover wash
    )
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 200.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(cover)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(22.dp))
            .padding(24.dp),
    ) {
        // Change cover / Edit template affordance, top-right.
        Box(modifier = Modifier.align(Alignment.TopEnd)) {
            GhostButton(
                label   = "Edit template",
                onClick = onEditTemplate,
            )
        }
        Column(
            modifier = Modifier.align(Alignment.BottomStart),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = listOfNotNull(
                    "Visit",
                    session.serviceType.takeIf { it.isNotBlank() },
                    sessionWindow(session),
                ).joinToString(" · "),
                style = AuntieTheme.typography.labelSmall,
                color = c.background.copy(alpha = 0.9f),
            )
            // Editable headline. Placeholder is the derived composerTitle so the
            // auntie sees a sensible default, but only what she types is written.
            MultilineField(
                value = titleDraft,
                onValueChange = onTitleChange,
                label = "Headline",
                placeholder = composerTitle(session, kinList),
                minLines = 1,
                onFocusLost = onTitleBlur,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

// -----------------------------------------------------------------------------
// Generic editor block: mono uppercase label + glass body
// -----------------------------------------------------------------------------

@Composable
private fun ComposerBlock(
    label: String,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text  = label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
        )
        content()
    }
}

// -----------------------------------------------------------------------------
// Photo strip: Den media tiles + add tile, cap notice
// -----------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MediaBlock(
    attached: List<MediaFile>,
    isUploading: Boolean,
    onPick: () -> Unit,
    onRemove: (MediaFile) -> Unit,
    onOpen: (MediaFile) -> Unit,
) {
    val c = AuntieTheme.colors
    val used = attached.size
    val remaining = (KinTaleMediaConfig.MAX_FILES_PER_TALE - used).coerceAtLeast(0)
    val countLabel = if (used == 1) "1 attached" else "$used attached"
    val glyphs = MediaCellGlyphs(
        play = Lucide.Play,
        document = Lucide.Images,
        broken = Lucide.TriangleAlert,
        delete = Lucide.Trash2,
        add = Lucide.Images,
    )

    ComposerBlock(label = "Photos · $countLabel") {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            attached.forEach { mf ->
                AuntieMediaCell(
                    media    = mf,
                    modifier = Modifier.size(108.dp),
                    onClick  = { onOpen(mf) },
                    onDelete = { onRemove(mf) },
                    glyphs   = glyphs,
                )
            }
            // Add tile (disabled visual state surfaces while uploading / at cap).
            AuntieMediaCell(
                media     = MediaFile(),
                modifier  = Modifier.size(108.dp),
                isAddTile = true,
                onAdd     = { if (!isUploading && remaining > 0) onPick() },
                glyphs    = glyphs,
            )
        }
        Text(
            text  = if (isUploading) {
                "Uploading…"
            } else {
                "Up to ${KinTaleMediaConfig.MAX_FILES_PER_TALE} combined • Videos auto-clipped at ${KinTaleMediaConfig.VIDEO_CLIP_SECONDS}s"
            },
            style = AuntieTheme.typography.labelSmall,
            color = c.textFaint,
        )
    }
}

// -----------------------------------------------------------------------------
// Walk route: read-only summary of breadcrumbs captured during the visit
// -----------------------------------------------------------------------------

@Composable
private fun GpsRouteBlock(
    client: FirestoreClient,
    sessionId: String,
) {
    val crumbsState by remember(sessionId) { client.breadcrumbsStream(sessionId) }.collectAsState(initial = FirestoreResult.Loading)
    val crumbs = (crumbsState as? FirestoreResult.Data)?.value.orEmpty()
    if (crumbs.isEmpty()) return  // hide entirely if nothing to show

    ComposerBlock(label = "Walk route · auto-tracked") {
        RouteMap(breadcrumbs = crumbs, live = false)
    }
}

// -----------------------------------------------------------------------------
// Moments: checklist rendered as tap-to-toggle Den chips (per-pet / per-visit)
// -----------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MomentsBlock(
    label: String,
    sublabel: String?,
    items: List<ChecklistItem>,
    responseFor: (itemKey: String) -> FieldResponse?,
    onToggle: (item: ChecklistItem, checked: Boolean) -> Unit,
    onNotes: (item: ChecklistItem, text: String) -> Unit,
    onNotesBlur: () -> Unit,
) {
    val c = AuntieTheme.colors
    ComposerBlock(label = "Moments · tap what happened") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Lucide.PawPrint, contentDescription = null, tint = c.primary, modifier = Modifier.size(16.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                if (!sublabel.isNullOrBlank()) {
                    Text(sublabel, style = AuntieTheme.typography.labelSmall, color = c.textDim)
                }
            }
        }

        // Rotate the brand tones so selected chips read like the mockup's
        // multi-hue moment pills, keyed stably off each item's order.
        val tones = listOf(
            AuntieChipTone.Orange,
            AuntieChipTone.Teal,
            AuntieChipTone.Accent,
            AuntieChipTone.Purple,
        )
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            items.forEach { item ->
                val response = responseFor(item.key)
                val checked  = response?.boolValue == true
                AuntieChip(
                    label    = item.text + if (item.required) " *" else "",
                    selected = checked,
                    onClick  = { onToggle(item, !checked) },
                    tone     = tones[item.order.coerceAtLeast(0) % tones.size],
                )
            }
        }

        Text(
            text  = "Unchecked items don't appear in the kinfolk's KinTale",
            style = AuntieTheme.typography.labelSmall,
            color = c.textFaint,
        )

        // Per-item notes. Mockup shows chips only; the existing data model keeps
        // optional notes per item, so they stay reachable below the chip row.
        items.forEach { item ->
            val notes = responseFor(item.key)?.stringValue.orEmpty()
            ChecklistNoteRow(
                item    = item,
                notes   = notes,
                onNotes = { onNotes(item, it) },
                onNotesBlur = onNotesBlur,
            )
        }
    }
}

@Composable
private fun ChecklistNoteRow(
    item: ChecklistItem,
    notes: String,
    onNotes: (String) -> Unit,
    onNotesBlur: () -> Unit,
) {
    val c = AuntieTheme.colors
    var notesOpen by remember(item.key) { mutableStateOf(notes.isNotBlank()) }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text  = if (notesOpen) "Hide note · ${item.text}" else "Add note · ${item.text}",
            style = AuntieTheme.typography.labelSmall,
            color = c.primary,
            textDecoration = TextDecoration.Underline,
            modifier = Modifier.clickable { notesOpen = !notesOpen },
        )
        if (notesOpen) {
            MultilineField(
                value         = notes,
                onValueChange = onNotes,
                label         = "Note for ${item.text}",
                placeholder   = "Anything specific the kinfolk should know about ${item.text.lowercase()}…",
                minLines      = 2,
            )
            GhostButton(
                label = "Save note",
                onClick = onNotesBlur,
                leading = { Icon(Lucide.Save, contentDescription = null, modifier = Modifier.size(12.dp)) },
            )
        }
    }
}

// -----------------------------------------------------------------------------
// Recipient rail: kinfolk + kin avatars, service / booking / visibility meta
// -----------------------------------------------------------------------------

@Composable
private fun RecipientRail(
    session: KinCareSession,
    kinfolk: Kinfolk?,
    kinList: List<Kin>,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text  = "Goes to",
            style = AuntieTheme.typography.headlineSmall,
            color = c.textPrimary,
        )

        val kinfolkName = kinfolk?.displayName ?: session.kinfolkName.ifBlank { "Kinfolk" }
        AuntieEntityRow(
            title    = kinfolkName,
            subtitle = "Kinfolk · kinfolk.tribetails.com",
            showDivider = true,
            leading = {
                AuntieAvatar(
                    imageUrl = kinfolk?.profilePictureUrl?.takeIf { it.isNotBlank() },
                    initials = initialsOf(kinfolkName),
                    size = 42.dp,
                    gradientSeed = kinfolkName,
                )
            },
        )

        if (kinList.isNotEmpty()) {
            kinList.forEach { kin ->
                AuntieEntityRow(
                    title    = kin.name.ifBlank { "Unnamed" },
                    subtitle = listOfNotNull(
                        kin.breed.takeIf { it.isNotBlank() } ?: kin.species.takeIf { it.isNotBlank() },
                        kin.age.takeIf { it.isNotBlank() },
                    ).joinToString(" · ").ifBlank { null },
                    showDivider = false,
                    leading = {
                        AuntieAvatar(
                            glyph = Lucide.PawPrint,
                            size = 42.dp,
                            gradientSeed = kin._id.ifBlank { kin.name },
                        )
                    },
                )
            }
        }

        Spacer(Modifier.height(6.dp))

        AuntieKeyValueRow(
            label = "Service",
            value = session.serviceType.ifBlank { "Visit" },
            // Divider only when a Booking row follows (no trailing divider).
            showDivider = session.sourceBookingId.isNotBlank(),
        )
        if (session.sourceBookingId.isNotBlank()) {
            AuntieKeyValueRow(
                label = "Booking",
                value = session.sourceBookingId,
                valueMono = true,
                showDivider = false,
            )
        }
        // Removed the hardcoded "Visibility: Kinfolk + shared link" row: there is no
        // per-report visibility field on the model, so presenting one fabricated a
        // configurable setting that does not exist (plan Verify-first fix).
    }
}

// -----------------------------------------------------------------------------
// Live preview: how the kinfolk sees the tale (Den email preview card)
// -----------------------------------------------------------------------------

@Composable
private fun LivePreviewBlock(
    title: String,
    bodyCopy: String,
    kinfolk: Kinfolk?,
    kinList: List<Kin>,
    template: KinTaleTemplate,
) {
    val c = AuntieTheme.colors
    val previewBody = bodyCopy.ifBlank { template.defaultEmailMessage }
    val pets = kinList.map { kin ->
        PetAvatar(initials = initialsOf(kin.name.ifBlank { "Kin" }))
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        AuntieEmailPreviewCard(
            subject = title,
            body    = previewBody,
            pets    = pets,
        )
        Text(
            text  = "Live preview · how ${kinfolk?.firstName?.takeIf { it.isNotBlank() } ?: "the kinfolk"} sees it",
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// -----------------------------------------------------------------------------
// Footer
// -----------------------------------------------------------------------------

@Composable
private fun FooterActions(
    isSaving: Boolean,
    isSending: Boolean,
    isDirty: Boolean,
    recipient: String,
    onDiscard: () -> Unit,
    onSaveDraft: () -> Unit,
    onSend: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            GhostButton(
                label   = "Discard",
                onClick = onDiscard,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Trash2, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
            GhostButton(
                label   = if (isSaving) "Saving…" else "Save Draft",
                onClick = onSaveDraft,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Save, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
            PrimaryButton(
                label   = if (isSending) "Sending…" else kinTaleSendLabel(recipient),
                onClick = onSend,
                modifier = Modifier.weight(1f),
                enabled = isDirty && !isSending,
                loading = isSending,
                leading = { Icon(Lucide.Send, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
        }
        if (!isDirty) {
            AuntieBanner(
                tone = AuntieBannerTone.Info,
                icon = Lucide.ClipboardList,
            ) {
                Text(
                    text  = "Tick a moment, write a note, or attach a photo to enable Send.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

private fun composerTitle(session: KinCareSession, kinList: List<Kin>): String {
    val names = kinList.mapNotNull { it.name.takeIf { n -> n.isNotBlank() } }
    return when {
        names.isEmpty() -> "KinTale · ${session.kinfolkName.ifBlank { "Kinfolk" }}"
        names.size == 1 -> "Checking on ${names.first()}"
        else            -> names.joinToString(" & ")
    }
}

private fun initialsOf(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts.first().take(2).uppercase()
        else            -> (parts.first().take(1) + parts.last().take(1)).uppercase()
    }
}

private fun scaffoldReport(session: KinCareSession, template: KinTaleTemplate): KinCareReport =
    KinCareReport(
        sessionId    = session._id,
        kinfolkId    = session.kinfolkId,
        kinfolkName  = session.kinfolkName,
        kinIds       = session.kinIds,
        serviceType  = session.serviceType,
        visitDate    = session.startTime,
        arrivedAt    = session.arrivedAt,
        departedAt   = session.departedAt,
        visitRouteId = session.visitRouteId,
        templateId   = template._id.takeUnless { it == DefaultKinTaleTemplate.ID }.orEmpty(),
        status       = "DRAFT",
    )

private fun hasContent(report: KinCareReport): Boolean =
    report.title.isNotBlank() ||
        report.bodyCopy.isNotBlank() ||
        report.fieldResponses.values.any { it.boolValue == true || it.stringValue.isNotBlank() } ||
        report.mediaFileIds.isNotEmpty() ||
        report.petMoodSelections.isNotEmpty() ||
        // Phase 14: an answered KINTALE custom field counts as content, so a
        // custom-fields-only tale still persists + sends.
        report.formValues.values.any { it.isNotBlank() }

private fun sessionWindow(s: KinCareSession): String {
    val start = shortIso(s.startTime)
    val end   = shortIsoTimeOnly(s.endTime)
    return when {
        start.isBlank() && end.isBlank() -> "Time TBD"
        end.isBlank()                    -> start
        else                             -> "$start to $end"
    }
}

private fun shortIso(iso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        "$month $day · $time"
    }.getOrDefault(iso)

private fun shortIsoTimeOnly(iso: String): String =
    runCatching { if (iso.length >= 16) iso.substring(11, 16) else iso }
        .getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
