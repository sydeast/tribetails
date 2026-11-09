package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.House
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Save
import com.composables.icons.lucide.Settings
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.ChecklistBankItem
import com.tribetails.auntieos.web.data.ChecklistItem
import com.tribetails.auntieos.web.data.bankItemsNotInChecklist
import com.tribetails.auntieos.web.data.checklistItemFromBank
import com.tribetails.auntieos.web.data.ConditionOp
import com.tribetails.auntieos.web.data.ConditionSource
import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FieldCondition
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.KinTaleTemplateRemoval
import com.tribetails.auntieos.web.data.KinTaleTemplateUsage
import com.tribetails.auntieos.web.data.kinTaleTemplateArchiveImpact
import com.tribetails.auntieos.web.data.kinTaleTemplateDeleteHeadline
import com.tribetails.auntieos.web.data.kinTaleTemplateRemovalImpact
import com.tribetails.auntieos.web.data.kinTaleTemplateRestoreClearsDefault
import com.tribetails.auntieos.web.data.MoodOption
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.conditionSummary
import com.tribetails.auntieos.web.data.conditionUsesAttributeKey
import com.tribetails.auntieos.web.data.conditionUsesValueInput
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.rememberReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDashedAddButton
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.Crumb
import com.tribetails.auntieos.web.ui.components.AuntieBreadcrumbs
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.launch

/**
 * KinTale template editor - Auntie can edit which sections appear in the report
 * card and customise the per-pet / per-visit checklist items. Mirrors the
 * Configure Checklist Items modal from the reference doc.
 *
 * What lands in the kinfolk-facing report:
 *   - Items that Auntie *checks* during the visit, always.
 *   - Items that are unchecked: hidden by default. Per-item override via the
 *     "Show even when unchecked" toggle (rare - kept for cases like "Trash
 *     taken out - N/A" that the kinfolk should still see).
 *
 * Den redesign (mirrors ui-ideas/auntieos-kintale-template-editor-2026-05-27.html).
 * The Pet mood toggle, Review booster toggle, the Mood options editor, and the
 * per-item "Add condition" affordance are marked // SUGGESTION: they were deferred
 * in the prior live web editor but all map to real fields on the shared
 * [KinTaleTemplate] model (petMoodEnabled / reviewBoosterEnabled / moodOptions /
 * FieldCondition), so they write straight into the draft. The condition editor
 * itself is genuinely TBD (FieldCondition has no UI yet on either platform).
 */
@Composable
fun KinTaleTemplateEditorScreen(onClose: () -> Unit) {
    val client = remember { FirestoreClient() }
    val reload = rememberReloadableRead()
    val templatesRes by remember(reload.generation) { client.templatesStream().settlesRetry(reload) }.collectAsState(initial = FirestoreResult.Loading)

    // I7: the household tag vocabulary backs the KINFOLK_TAG condition picker, so
    // a rule can only target a tag the operator actually manages. Read-only here;
    // the vocabulary itself is edited in the Tags settings panel.
    val settingsRes by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val householdTags: List<TagDef> = (settingsRes as? FirestoreResult.Data)?.value?.householdTags.orEmpty()
    val tagVocabError: String? = (settingsRes as? FirestoreResult.Error)?.message

    var selectedId by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf<KinTaleTemplate?>(null) }
    // #994: the template as read (or as this screen last wrote it). Save diffs the
    // draft against it and writes only what changed. Null for a template that
    // does not exist yet, which Save creates instead.
    var loaded by remember { mutableStateOf<KinTaleTemplate?>(null) }
    var dirty by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    // #1593: items added this session start blank, so each waits here until the
    // operator leaves its field; a Save press shows every blank item at once.
    var freshIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var saveRevealed by remember { mutableStateOf(false) }
    fun resetChecklistReveal() {
        freshIds = emptySet()
        saveRevealed = false
    }
    // #1591: archive / restore / delete-for-good.
    var removing by remember { mutableStateOf<KinTaleTemplate?>(null) }
    var deleting by remember { mutableStateOf<KinTaleTemplate?>(null) }
    var deleteUsage by remember { mutableStateOf<KinTaleTemplateUsage?>(null) }
    var deleteUsageError by remember { mutableStateOf<String?>(null) }
    var removalBusy by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }
    val scope = rememberReportingScope()

    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    // Run-4 #7b: shared bank of common checklist items for the "Add from bank" picker.
    var bank by remember { mutableStateOf<List<ChecklistBankItem>>(emptyList()) }
    LaunchedEffect(Unit) {
        when (val r = client.listChecklistBank()) {
            is WriteResult.Ok  -> bank = r.value
            is WriteResult.Err -> showToast("Couldn't load the checklist bank: ${r.message}", ToastKind.Error)
        }
    }
    fun saveToBank(text: String, itemScope: String) {
        if (text.isBlank()) return
        scope.launch {
            when (val r = client.saveChecklistBankItem(text.trim(), itemScope)) {
                is WriteResult.Ok  -> {
                    showToast("Saved to bank.", ToastKind.Success)
                    (client.listChecklistBank() as? WriteResult.Ok)?.let { bank = it.value }
                }
                is WriteResult.Err -> showToast("Couldn't save to bank: ${r.message}", ToastKind.Error)
            }
        }
    }

    // Pick a sensible default template once data lands.
    LaunchedEffect(templatesRes) {
        val data = (templatesRes as? FirestoreResult.Data)?.value ?: return@LaunchedEffect
        if (selectedId == null) {
            val live = data.filterNot { it.archived }
            val first = live.firstOrNull { it.isDefault } ?: live.firstOrNull()
            if (first != null) {
                selectedId = first._id
                draft = first
                loaded = first
            } else {
                // No templates exist in Firestore yet - seed the editor with the
                // built-in default so Auntie can save her first one.
                selectedId = ""
                // #1614: the built-in's description describes the fallback, not
                // the operator's first template.
                draft = DefaultKinTaleTemplate.template.copy(_id = "", description = "")
                loaded = null
            }
            dirty = false
            resetChecklistReveal()
        }
    }

    // #1593: what is wrong with the checklist, and how much of it is on screen.
    val checklistNow = draft?.checklistItems.orEmpty()
    val problems = checklistProblems(checklistNow)
    val flagged = flaggedBlankIds(checklistNow, freshIds, saveRevealed)
    val saveBlockedReason = checklistSaveBlockedReason(problems, flagged)

    ScreenScaffold {
        AuntieBreadcrumbs(
            crumbs = listOf(
                Crumb("KinTales"),
                Crumb("Templates"),
                Crumb(draft?.name?.ifBlank { "Untitled template" } ?: "Default KinTale", isCurrent = true),
            ),
            modifier = Modifier.padding(bottom = 14.dp),
        )

        EditorHeader(
            title    = draft?.name?.ifBlank { "Untitled template" } ?: "Loading…",
            isDirty  = dirty,
            isSaving = saving,
            onClose  = onClose,
            saveBlockedReason = saveBlockedReason,
            onSave   = save@{
                val typed = draft ?: return@save
                if (typed.name.isBlank()) {
                    showToast("Give the template a name first.", ToastKind.Error)
                    return@save
                }
                // #1593: a blank item or an over-full checklist is never written.
                // The press shows every blank item's message, and Save stays off
                // until they are fixed.
                if (!checklistProblems(typed.checklistItems).isEmpty) {
                    saveRevealed = true
                    return@save
                }
                val d = typed.copy(checklistItems = trimChecklistItems(typed.checklistItems))
                val baseline = loaded
                if (d._id.isNotBlank() && baseline?._id != d._id) {
                    showToast("This template hasn't loaded yet. Try again in a moment.", ToastKind.Error)
                    return@save
                }
                scope.launch {
                    saving = true
                    val res = if (d._id.isBlank() || baseline == null) {
                        client.createKinTaleTemplate(d.copy(_id = ""))
                    } else {
                        when (val r = client.updateKinTaleTemplate(baseline, d)) {
                            is WriteResult.Ok  -> WriteResult.Ok(d._id)
                            is WriteResult.Err -> WriteResult.Err(r.message, r.code)
                        }
                    }
                    saving = false
                    when (res) {
                        is WriteResult.Ok -> {
                            if (d._id.isBlank()) {
                                selectedId = res.value
                                draft = d.copy(_id = res.value)
                            }
                            // Trimmed: what was written is what the next diff starts from.
                            loaded = d.copy(_id = res.value)
                            dirty = false
                            showToast("Template saved.", ToastKind.Success)
                        }
                        is WriteResult.Err -> showToast(
                            if (isPermissionDeniedMessage(res.message, res.code)) TEMPLATE_SAVE_REFUSED
                            else "Couldn't save: ${res.message}",
                            ToastKind.Error,
                        )
                    }
                }
            },
        )

        StatusToast(
            visible   = toastVisible,
            message   = toast,
            kind      = toastKind,
            onDismiss = { toastVisible = false },
        )

        Spacer(Modifier.height(18.dp))

        val allTemplates = (templatesRes as? FirestoreResult.Data)?.value.orEmpty()
        fun label(t: KinTaleTemplate) = t.name.ifBlank { "Untitled template" }
        fun runRemoval(t: KinTaleTemplate, mode: KinTaleTemplateRemoval, clearDefault: Boolean, done: String) {
            if (removalBusy) return
            removalBusy = true
            scope.launch {
                when (val r = client.removeKinTaleTemplate(t, mode, clearDefault)) {
                    is WriteResult.Ok -> {
                        if (selectedId == t._id && mode != KinTaleTemplateRemoval.RESTORE) {
                            selectedId = null // re-pick a live template on the next stream tick
                        }
                        showToast(done, ToastKind.Success)
                    }
                    is WriteResult.Err -> showToast("Couldn't change the template: ${r.message}", ToastKind.Error)
                }
                removalBusy = false
            }
        }
        RemovalDialogs(
            removing = removing,
            deleting = deleting,
            deleteUsage = deleteUsage,
            deleteUsageError = deleteUsageError,
            busy = removalBusy,
            onDismissRemove = { removing = null },
            onConfirmRemove = { t ->
                removing = null
                runRemoval(t, KinTaleTemplateRemoval.ARCHIVE, false, "${label(t)} moved to the archive.")
            },
            onDismissDelete = { deleting = null },
            onConfirmDelete = { t ->
                deleting = null
                runRemoval(t, KinTaleTemplateRemoval.DELETE, false, "${label(t)} deleted for good.")
            },
        )

        TemplatePicker(
            templates    = allTemplates.filterNot { it.archived },
            onRemove     = { tpl -> removing = tpl },
            selectedId   = selectedId,
            onSelect     = { tpl ->
                selectedId = tpl._id
                draft      = tpl
                loaded     = tpl
                dirty      = false
                resetChecklistReveal()
            },
            onAddNew = {
                selectedId = ""
                draft = DefaultKinTaleTemplate.template.copy(
                    _id = "",
                    name = "New template",
                    description = "",
                    isDefault = false,
                )
                loaded = null
                dirty = true
                resetChecklistReveal()
            },
        )

        // #1591: removed templates, restorable, and the only place one is deleted for good.
        val archivedTemplates = allTemplates.filter { it.archived }
        if (archivedTemplates.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            ArchiveSection(
                templates = archivedTemplates,
                busy = removalBusy,
                onRestore = { t ->
                    runRemoval(
                        t,
                        KinTaleTemplateRemoval.RESTORE,
                        kinTaleTemplateRestoreClearsDefault(t, allTemplates),
                        "${label(t)} is back in the template list.",
                    )
                },
                onDelete = { t ->
                    deleting = t
                    deleteUsage = null
                    deleteUsageError = null
                    scope.launch {
                        when (val r = client.getKinTaleTemplateUsage(t._id)) {
                            is WriteResult.Ok -> deleteUsage = r.value
                            is WriteResult.Err -> deleteUsageError = r.message
                        }
                    }
                },
            )
        }

        Spacer(Modifier.height(18.dp))

        val current = draft
        if (current == null) {
            // #867: a failed read shows its error, not a shimmer that never ends.
            (templatesRes as? FirestoreResult.Error)?.let {
                LoadErrorBanner("Couldn't load templates", it.message, onRetry = reload::retry, retrying = reload.retrying)
                return@ScreenScaffold
            }
            ShimmerCard(height = 200.dp)
            return@ScreenScaffold
        }

        // ---- Basic settings ----
        EditorSection(title = "Basic settings") {
            BottomBorderField(
                label = "Template name",
                value = current.name,
                onValueChange = { v ->
                    draft = current.copy(name = v); dirty = true
                },
                placeholder = "Default Pet Care Report",
            )
            Spacer(Modifier.height(8.dp))
            MultilineField(
                value = current.description,
                onValueChange = { v -> draft = current.copy(description = v); dirty = true },
                label    = "Description",
                placeholder = "What kind of visits is this template for?",
                minLines = 2,
            )
            Spacer(Modifier.height(8.dp))
            MultilineField(
                value = current.defaultEmailMessage,
                onValueChange = { v -> draft = current.copy(defaultEmailMessage = v); dirty = true },
                label    = "Default message to kinfolk",
                placeholder = "I had a wonderful time caring for your furry friends!",
                minLines = 3,
            )
            Spacer(Modifier.height(4.dp))
            ToggleRow(
                label = "Make default template",
                description = "Default templates are auto-selected when no service-specific template matches.",
                checked = current.isDefault,
                onCheckedChange = { v -> draft = current.copy(isDefault = v); dirty = true },
            )
            ToggleRow(
                label = "Active",
                description = "Inactive templates won't be selected by the composer.",
                checked = current.isActive,
                onCheckedChange = { v -> draft = current.copy(isActive = v); dirty = true },
                divider = false,
            )
        }
        Spacer(Modifier.height(18.dp))

        // ---- Display sections ----
        EditorSection(title = "Display sections") {
            ToggleRow(
                label = "Photo & video showcase",
                description = "Allow attaching photos and videos to the KinTale.",
                checked = current.photoShowcaseEnabled,
                onCheckedChange = { v -> draft = current.copy(photoShowcaseEnabled = v); dirty = true },
            )
            ToggleRow(
                label = "Checklist",
                description = "Per-pet and per-visit checklist items.",
                checked = current.checklistEnabled,
                onCheckedChange = { v -> draft = current.copy(checklistEnabled = v); dirty = true },
            )
            ToggleRow(
                label = "Visit notes",
                description = "Free-text notes from Auntie to the kinfolk.",
                checked = current.visitNotesEnabled,
                onCheckedChange = { v -> draft = current.copy(visitNotesEnabled = v); dirty = true },
            )
            ToggleRow(
                label = "Next appointment",
                description = "Show the kinfolk's next booking with a Book Now nudge.",
                checked = current.nextAppointmentEnabled,
                onCheckedChange = { v -> draft = current.copy(nextAppointmentEnabled = v); dirty = true },
            )
            // SUGGESTION: Pet mood toggle. petMoodEnabled exists on the shared model
            // (deferred in the prior live web editor; exposed on Android). Wires to draft.
            ToggleRow(
                label = "Pet mood",
                description = "Configure mood options that can be selected for each pet during visits.",
                checked = current.petMoodEnabled,
                onCheckedChange = { v -> draft = current.copy(petMoodEnabled = v); dirty = true },
                suggestion = true,
            )
            // SUGGESTION: Review booster toggle. reviewBoosterEnabled exists on the
            // shared model (Android-only previously). Wires to draft.
            ToggleRow(
                label = "Review booster",
                description = "Embeds a review request section to encourage kinfolk to leave reviews.",
                checked = current.reviewBoosterEnabled,
                onCheckedChange = { v -> draft = current.copy(reviewBoosterEnabled = v); dirty = true },
                suggestion = true,
                divider = false,
            )
        }
        Spacer(Modifier.height(18.dp))

        // ---- Checklist items ----
        if (current.checklistEnabled) {
            // Fail loud: without the vocabulary the tag picker cannot be trusted, so
            // say so and let the condition row fall back to free text rather than
            // showing an empty picker that looks like "you have no tags".
            if (tagVocabError != null) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load your household tags",
                    modifier = Modifier.padding(bottom = 12.dp),
                ) {
                    Text(
                        "$tagVocabError. Household tag conditions fall back to a typed tag name.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                }
            }
            ChecklistEditor(
                items = current.checklistItems,
                bank = bank,
                householdTags = householdTags,
                flagged = flagged,
                onUpdate = { newItems ->
                    draft = current.copy(checklistItems = newItems); dirty = true
                },
                onItemAdded = { id -> freshIds = freshIds + id },
                onItemLeft = { id -> freshIds = freshIds - id },
                onSaveToBank = { text, itemScope -> saveToBank(text, itemScope) },
            )
            Spacer(Modifier.height(18.dp))
        }

        // ---- Mood options (SUGGESTION) ----
        // moodOptions exists on the shared model; this editor mirrors "Configure
        // Mood Options" from Android. Only shown when the Pet mood toggle is on.
        if (current.petMoodEnabled) {
            MoodOptionsEditor(
                moods = current.moodOptions,
                onUpdate = { newMoods ->
                    draft = current.copy(moodOptions = newMoods); dirty = true
                },
            )
            Spacer(Modifier.height(18.dp))
        }
    }
}

// -----------------------------------------------------------------------------
// Header / picker / sections
// -----------------------------------------------------------------------------

@Composable
private fun EditorHeader(
    title: String,
    isDirty: Boolean,
    isSaving: Boolean,
    onClose: () -> Unit,
    onSave: () -> Unit,
    /** #1593: why Save is off, shown under it. Null means Save is on. */
    saveBlockedReason: String? = null,
) {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            // Kicker: "The Den · KinTale templates"
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Lucide.Settings, contentDescription = null, tint = c.primary, modifier = Modifier.size(13.dp))
                Text(
                    text = "THE DEN · KINTALE TEMPLATES",
                    style = AuntieTheme.typography.mono.copy(letterSpacing = 1.4.sp, fontSize = 11.sp),
                    color = c.primary,
                )
            }
            // Headline: "Editing <name>"
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Editing ",
                    style = AuntieTheme.typography.headlineLarge,
                    color = c.textPrimary,
                )
                Text(
                    text = title,
                    style = AuntieTheme.typography.headlineLarge.copy(fontWeight = FontWeight.SemiBold),
                    color = c.secondary,
                )
            }
            // Subtitle: "Editing · <name> · unsaved changes"
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieStatusPill(
                    label = if (isDirty) "Unsaved changes" else "Saved",
                    tone  = if (isDirty) AuntieStatusTone.Orange else AuntieStatusTone.Muted,
                    showDot = true,
                    glow  = isDirty,
                )
                Text(
                    text = "Editing · $title",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PrimaryButton(
                label   = if (isSaving) "Saving…" else "Save",
                onClick = onSave,
                enabled = saveBlockedReason == null,
                loading = isSaving,
                leading = { Icon(Lucide.Save, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
            if (saveBlockedReason != null) {
                Text(
                    text = saveBlockedReason,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.error,
                    modifier = Modifier.widthIn(max = 260.dp),
                )
            }
        }
        AuntieIconButton(
            icon = Lucide.X,
            contentDescription = "Close",
            onClick = onClose,
            size = 40.dp,
            destructive = true,
        )
    }
}

@Composable
private fun TemplatePicker(
    templates: List<KinTaleTemplate>,
    selectedId: String?,
    onSelect: (KinTaleTemplate) -> Unit,
    onAddNew: () -> Unit,
    onRemove: (KinTaleTemplate) -> Unit = {},
) {
    val c = AuntieTheme.colors
    EditorSection(title = "Templates") {
        if (templates.isEmpty()) {
            Text(
                text  = "No templates saved yet. Start with the built-in default below and save it.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                templates.forEach { tpl ->
                    val active = tpl._id == selectedId
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(11.dp))
                            .background(if (active) c.primary.copy(alpha = 0.10f) else c.surface2)
                            .border(
                                AuntieTheme.dims.borderHairline,
                                if (active) c.primary.copy(alpha = 0.5f) else c.borderSoft,
                                RoundedCornerShape(11.dp),
                            )
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                            ) { onSelect(tpl) }
                            .padding(horizontal = 13.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            tpl.name.ifBlank { "Untitled" },
                            style = AuntieTheme.typography.titleMedium,
                            color = c.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        if (tpl.isDefault) {
                            AuntieStatusPill(label = "Default", tone = AuntieStatusTone.Orange, mono = true)
                        }
                        if (!tpl.isActive) {
                            AuntieStatusPill(label = "Inactive", tone = AuntieStatusTone.Muted, mono = true)
                        }
                        // #1591: Remove moves it to the archive, after a confirm.
                        GhostButton(label = "Remove", onClick = { onRemove(tpl) })
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        AuntieDashedAddButton(
            text = "New template",
            onClick = onAddNew,
            leadingIcon = Lucide.Plus,
        )
    }
}

@Composable
private fun ChecklistEditor(
    items: List<ChecklistItem>,
    bank: List<ChecklistBankItem>,
    householdTags: List<TagDef>,
    /** #1593: [checklistItemId]s of the blank items whose message is due. */
    flagged: Set<String>,
    onUpdate: (List<ChecklistItem>) -> Unit,
    onItemAdded: (String) -> Unit,
    onItemLeft: (String) -> Unit,
    onSaveToBank: (String, String) -> Unit,
) {
    val perPet   = items.filter { it.scope.equals("PER_PET", ignoreCase = true) }.sortedBy { it.order }
    val perVisit = items.filter { it.scope.equals("PER_VISIT", ignoreCase = true) }.sortedBy { it.order }
    // #1593: the cap is on the whole checklist, so both sections fill together.
    val canAdd = canAddChecklistItem(items)
    fun addBlank(scope: String, sameScope: List<ChecklistItem>) {
        if (!canAdd) return
        val item = ChecklistItem(
            key   = freshKey(items),
            text  = "",
            scope = scope,
            order = (sameScope.maxOfOrNull { it.order } ?: -1) + 1,
        )
        onItemAdded(checklistItemId(item))
        onUpdate(items + item)
    }

    EditorSection(
        title = "Per-pet items",
        count = perPet.size,
        leadingIcon = Lucide.PawPrint,
        subtitle = "These appear once for each kin in the visit.",
    ) {
        perPet.forEach { item ->
            ChecklistItemRow(
                item = item,
                allItems = items,
                householdTags = householdTags,
                showBlankError = checklistItemId(item) in flagged,
                onUpdate = onUpdate,
                onLeave = { onItemLeft(checklistItemId(item)) },
                onSaveToBank = onSaveToBank,
            )
        }
        AuntieDashedAddButton(
            text = "Add per-pet item",
            leadingIcon = Lucide.Plus,
            enabled = canAdd,
            onClick = { addBlank("PER_PET", perPet) },
        )
        ChecklistLimitNote(visible = !canAdd)
        BankAddRow(bank = bank, items = items, scope = "PER_PET", enabled = canAdd, onAdd = { picked ->
            val nextOrder = (perPet.maxOfOrNull { it.order } ?: -1) + 1
            onUpdate(items + checklistItemFromBank(picked, key = freshKey(items), order = nextOrder))
        })
    }
    Spacer(Modifier.height(18.dp))
    EditorSection(
        title = "Per-visit items",
        count = perVisit.size,
        leadingIcon = Lucide.House,
        subtitle = "These appear once for the whole visit.",
    ) {
        perVisit.forEach { item ->
            ChecklistItemRow(
                item = item,
                allItems = items,
                householdTags = householdTags,
                showBlankError = checklistItemId(item) in flagged,
                onUpdate = onUpdate,
                onLeave = { onItemLeft(checklistItemId(item)) },
                onSaveToBank = onSaveToBank,
            )
        }
        AuntieDashedAddButton(
            text = "Add per-visit item",
            leadingIcon = Lucide.Plus,
            enabled = canAdd,
            onClick = { addBlank("PER_VISIT", perVisit) },
        )
        ChecklistLimitNote(visible = !canAdd)
        BankAddRow(bank = bank, items = items, scope = "PER_VISIT", enabled = canAdd, onAdd = { picked ->
            val nextOrder = (perVisit.maxOfOrNull { it.order } ?: -1) + 1
            onUpdate(items + checklistItemFromBank(picked, key = freshKey(items), order = nextOrder))
        })
    }
}

/**
 * Run-4 #7b: "Add from bank" affordance. Lists the common bank items for this [scope]
 * that are not already in the checklist (so it never offers a duplicate). Hidden when
 * nothing is available. Tapping a row appends that item.
 */
/** #1593: under a disabled Add item, the reason it is off. */
@Composable
private fun ChecklistLimitNote(visible: Boolean) {
    if (!visible) return
    Spacer(Modifier.height(6.dp))
    Text(
        CHECKLIST_LIMIT_REACHED,
        style = AuntieTheme.typography.bodySmall,
        color = AuntieTheme.colors.textDim,
    )
}

@Composable
private fun BankAddRow(
    bank: List<ChecklistBankItem>,
    items: List<ChecklistItem>,
    scope: String,
    /** False on a full checklist (#1593); the note beside Add item says why. */
    enabled: Boolean,
    onAdd: (ChecklistBankItem) -> Unit,
) {
    val c = AuntieTheme.colors
    val available = bankItemsNotInChecklist(bank, items)
        .filter { it.scope.equals(scope, ignoreCase = true) }
    if (available.isEmpty()) return
    Spacer(Modifier.height(10.dp))
    Text(
        "Add from bank",
        style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 0.6.sp),
        color = c.textDim,
    )
    Spacer(Modifier.height(6.dp))
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        available.forEach { bi ->
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = enabled) { onAdd(bi) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Lucide.Plus, contentDescription = null, tint = if (enabled) c.primary else c.textFaint, modifier = Modifier.size(12.dp))
                Text(bi.text, style = AuntieTheme.typography.bodySmall, color = if (enabled) c.textPrimary else c.textFaint)
            }
        }
    }
}

@Composable
private fun ChecklistItemRow(
    item: ChecklistItem,
    allItems: List<ChecklistItem>,
    householdTags: List<TagDef>,
    /** #1593: the text is blank and its message is due. */
    showBlankError: Boolean,
    onUpdate: (List<ChecklistItem>) -> Unit,
    /** The operator left the text field. */
    onLeave: () -> Unit,
    onSaveToBank: (String, String) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(11.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(11.dp))
            .padding(13.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(modifier = Modifier.weight(1f)) {
                BottomBorderField(
                    label = "Item text",
                    value = item.text,
                    onValueChange = { v ->
                        onUpdate(allItems.map { if (it.key == item.key && it.scope == item.scope) it.copy(text = v) else it })
                    },
                    placeholder = "e.g. Peed",
                    errorMessage = if (showBlankError) CHECKLIST_ITEM_BLANK else null,
                    onFocusLost = onLeave,
                )
            }
            // Reorder up
            AuntieIconButton(
                icon = Lucide.ArrowUp,
                contentDescription = "Move up",
                size = 30.dp,
                onClick = { onUpdate(reorderWithinScope(allItems, item, delta = -1)) },
            )
            // Reorder down
            AuntieIconButton(
                icon = Lucide.ArrowDown,
                contentDescription = "Move down",
                size = 30.dp,
                onClick = { onUpdate(reorderWithinScope(allItems, item, delta = +1)) },
            )
            // Run-4 #7b: save this custom item to the shared bank (only once it has text).
            if (item.text.isNotBlank()) {
                AuntieIconButton(
                    icon = Lucide.Save,
                    contentDescription = "Save to bank",
                    size = 30.dp,
                    onClick = { onSaveToBank(item.text, item.scope) },
                )
            }
            // Delete
            AuntieIconButton(
                icon = Lucide.Trash2,
                contentDescription = "Delete",
                size = 30.dp,
                destructive = true,
                onClick = { onUpdate(allItems.filterNot { it.key == item.key && it.scope == item.scope }) },
            )
        }
        ToggleRow(
            label = "Required",
            description = "Show a red * next to this item in the composer.",
            checked = item.required,
            compact = true,
            onCheckedChange = { v ->
                onUpdate(allItems.map { if (it.key == item.key && it.scope == item.scope) it.copy(required = v) else it })
            },
        )
        ToggleRow(
            label = "Show even when unchecked",
            description = "Off (default): unchecked items are hidden in the kinfolk's KinTale. On: shown with a 'no' marker.",
            checked = item.showWhenUnchecked,
            compact = true,
            divider = false,
            onCheckedChange = { v ->
                onUpdate(allItems.map { if (it.key == item.key && it.scope == item.scope) it.copy(showWhenUnchecked = v) else it })
            },
        )
        // Conditional visibility editor. An item with no conditions is always
        // shown; conditions narrow it to matching pets / services. The same engine
        // (KinTaleConditionEngine) evaluates these in the composer + on Android.
        ConditionsEditor(
            item = item,
            allItems = allItems,
            householdTags = householdTags,
            onUpdate = onUpdate,
        )
    }
}

/**
 * Per-item conditional-visibility editor. Lets Auntie say e.g. "only show
 * 'Litter box scooped' for cats" or "only show 'Meds given' for kin with
 * medication notes". Writes [FieldCondition]s onto the item; an empty list means
 * the item is always shown.
 */
@Composable
private fun ConditionsEditor(
    item: ChecklistItem,
    allItems: List<ChecklistItem>,
    householdTags: List<TagDef>,
    onUpdate: (List<ChecklistItem>) -> Unit,
) {
    val c = AuntieTheme.colors

    fun setConditions(newConditions: List<FieldCondition>) {
        onUpdate(allItems.map {
            if (it.key == item.key && it.scope == item.scope) it.copy(conditions = newConditions) else it
        })
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "CONDITIONS",
            style = AuntieTheme.typography.mono.copy(letterSpacing = 1.2.sp, fontSize = 10.sp),
            color = c.textDim,
        )
        if (item.conditions.isEmpty()) {
            Text(
                text = "Always shown. Add a condition to show this item only for certain pets, services, or households.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        } else {
            item.conditions.forEachIndexed { idx, cond ->
                ConditionRow(
                    condition = cond,
                    householdTags = householdTags,
                    onChange = { updated ->
                        setConditions(item.conditions.mapIndexed { i, existing -> if (i == idx) updated else existing })
                    },
                    onRemove = { setConditions(item.conditions.filterIndexed { i, _ -> i != idx }) },
                )
            }
        }
        AuntieDashedAddButton(
            text = "Add condition",
            leadingIcon = Lucide.Plus,
            onClick = {
                setConditions(
                    item.conditions + FieldCondition(
                        source = ConditionSource.KIN_SPECIES.name,
                        op = ConditionOp.EQUALS.name,
                        value = "",
                    ),
                )
            },
        )
    }
}

/**
 * One condition row: When (source) / Is (op), then the input the pair calls for.
 *
 * The pickers are keyed on the raw wire STRINGS, not the Kotlin enums, so a
 * source or op this build does not model (authored by a newer app) stays selected
 * and labelled "(unrecognised)" instead of being silently snapped to KIN_SPECIES
 * and rewritten on the next save. All the picking logic lives in
 * KinTaleConditionEditorHelpers.kt; this is the render shell.
 */
@Composable
private fun ConditionRow(
    condition: FieldCondition,
    householdTags: List<TagDef>,
    onChange: (FieldCondition) -> Unit,
    onRemove: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(9.dp))
            .padding(11.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(modifier = Modifier.weight(1f)) {
                AuntieSelectField(
                    label = "When",
                    options = conditionSourceChoices(condition.source),
                    selected = condition.source,
                    // Re-seeds the attribute key when the new source needs one, so
                    // the rule is never left pointing at a field that source cannot read.
                    onSelect = { src -> onChange(changeConditionSource(condition, src)) },
                    optionLabel = ::conditionSourceLabel,
                )
            }
            Box(modifier = Modifier.weight(1f)) {
                AuntieSelectField(
                    label = "Is",
                    options = conditionOpChoices(condition.op),
                    selected = condition.op,
                    onSelect = { onChange(condition.copy(op = it)) },
                    optionLabel = ::conditionOpLabel,
                )
            }
            AuntieIconButton(
                icon = Lucide.Trash2,
                contentDescription = "Remove condition",
                size = 30.dp,
                destructive = true,
                onClick = onRemove,
            )
        }
        // KIN_ATTRIBUTE and KINFOLK_ATTRIBUTE each draw from their own catalog.
        if (conditionUsesAttributeKey(condition.source)) {
            AuntieSelectField(
                label = if (condition.source == ConditionSource.KINFOLK_ATTRIBUTE.name) "Household field" else "Attribute",
                options = attributeKeyChoices(condition.source, condition.attributeKey),
                selected = condition.attributeKey,
                onSelect = { onChange(condition.copy(attributeKey = it)) },
                optionLabel = { attributeKeyLabel(condition.source, it) },
            )
        }
        if (conditionUsesValueInput(condition.op)) {
            val tagOptions = if (conditionUsesTagPicker(condition.source)) {
                tagPickerOptions(householdTags, condition.value)
            } else {
                emptyList()
            }
            when {
                // A tag rule picks from the operator's own vocabulary, so it cannot
                // target a tag no household will ever carry.
                conditionUsesTagPicker(condition.source) && tagOptions.isNotEmpty() -> AuntieSelectField(
                    label = "Tag",
                    options = tagOptions,
                    selected = condition.value.ifBlank { tagOptions.first() },
                    onSelect = { onChange(condition.copy(value = it)) },
                    optionLabel = { tagOptionLabel(it, householdTags) },
                )
                // Empty vocabulary: say so rather than render a picker with nothing
                // in it, and leave the field usable so the rule can still be written.
                conditionUsesTagPicker(condition.source) -> {
                    Text(
                        text = "No household tags yet. Add them in Settings, or type one below.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                    BottomBorderField(
                        label = "Tag",
                        value = condition.value,
                        onValueChange = { onChange(condition.copy(value = it)) },
                        placeholder = conditionValuePlaceholder(condition.source),
                    )
                }
                else -> BottomBorderField(
                    label = "Value",
                    value = condition.value,
                    onValueChange = { onChange(condition.copy(value = it)) },
                    placeholder = conditionValuePlaceholder(condition.source),
                )
            }
        }
        Text(
            text = conditionSummary(condition),
            style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
            color = c.accent,
        )
    }
}

@Composable
private fun MoodOptionsEditor(
    moods: List<MoodOption>,
    onUpdate: (List<MoodOption>) -> Unit,
) {
    val sorted = moods.sortedBy { it.order }
    EditorSection(
        title = "Mood options",
        count = sorted.size,
        leadingIcon = Lucide.Sparkles,
        subtitle = "Mirrors \"Configure Mood Options\" from Android.",
        suggestion = true,
    ) {
        sorted.forEach { mood ->
            MoodOptionRow(mood = mood, allMoods = moods, onUpdate = onUpdate)
        }
        AuntieDashedAddButton(
            text = "Add mood",
            leadingIcon = Lucide.Plus,
            onClick = {
                val nextOrder = (moods.maxOfOrNull { it.order } ?: -1) + 1
                onUpdate(moods + MoodOption(
                    key   = freshMoodKey(moods),
                    label = "",
                    emoji = "",
                    order = nextOrder,
                ))
            },
        )
    }
}

@Composable
private fun MoodOptionRow(
    mood: MoodOption,
    allMoods: List<MoodOption>,
    onUpdate: (List<MoodOption>) -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(11.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(11.dp))
            .padding(horizontal = 11.dp, vertical = 9.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(modifier = Modifier.width(56.dp)) {
            BottomBorderField(
                label = "Emoji",
                value = mood.emoji,
                onValueChange = { v ->
                    onUpdate(allMoods.map { if (it.key == mood.key) it.copy(emoji = v) else it })
                },
                placeholder = "🐾",
            )
        }
        Box(modifier = Modifier.weight(1f)) {
            BottomBorderField(
                label = "Mood label",
                value = mood.label,
                onValueChange = { v ->
                    onUpdate(allMoods.map { if (it.key == mood.key) it.copy(label = v) else it })
                },
                placeholder = "Happy",
            )
        }
        AuntieIconButton(
            icon = Lucide.Trash2,
            contentDescription = "Delete mood",
            size = 30.dp,
            destructive = true,
            onClick = { onUpdate(allMoods.filterNot { it.key == mood.key }) },
        )
    }
}

@Composable
private fun ToggleRow(
    label: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    compact: Boolean = false,
    divider: Boolean = true,
    suggestion: Boolean = false,
) {
    val c = AuntieTheme.colors
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = if (compact) 8.dp else 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        label,
                        style = if (compact) AuntieTheme.typography.titleSmall else AuntieTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
                    if (suggestion) SuggestionPill()
                }
                Text(description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            AuntieToggle(
                checked = checked,
                onCheckedChange = onCheckedChange,
                compact = compact,
            )
        }
        if (divider) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(AuntieTheme.dims.borderHairline)
                    .background(c.borderSoft),
            )
        }
    }
}

/** Small mono "Suggestion" pill (purple/family-tone) marking model-backed fields not previously in the live editor. */
@Composable
private fun SuggestionPill() {
    AuntieChip(
        label = "Suggestion",
        tone = AuntieChipTone.Purple,
        selected = true,
        mono = true,
    )
}

@Composable
private fun EditorSection(
    title: String,
    subtitle: String? = null,
    leadingIcon: ImageVector? = null,
    count: Int? = null,
    suggestion: Boolean = false,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(16.dp))
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (leadingIcon != null) {
                Icon(leadingIcon, contentDescription = null, tint = c.primary, modifier = Modifier.size(17.dp))
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(title, style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                    if (count != null) {
                        Text(
                            text = count.toString(),
                            style = AuntieTheme.typography.mono.copy(fontWeight = FontWeight.Medium),
                            color = c.accent,
                        )
                    }
                    if (suggestion) SuggestionPill()
                }
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
        content()
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

private fun reorderWithinScope(all: List<ChecklistItem>, item: ChecklistItem, delta: Int): List<ChecklistItem> {
    val sameScope = all.filter { it.scope.equals(item.scope, ignoreCase = true) }.sortedBy { it.order }
    val idx = sameScope.indexOfFirst { it.key == item.key }
    if (idx < 0) return all
    val swapWith = idx + delta
    if (swapWith !in sameScope.indices) return all
    val a = sameScope[idx]
    val b = sameScope[swapWith]
    return all.map { existing ->
        when {
            existing.key == a.key && existing.scope == a.scope -> existing.copy(order = b.order)
            existing.key == b.key && existing.scope == b.scope -> existing.copy(order = a.order)
            else -> existing
        }
    }
}

private fun freshKey(existing: List<ChecklistItem>): String {
    var i = 1
    while (existing.any { it.key == "item_$i" }) i++
    return "item_$i"
}

private fun freshMoodKey(existing: List<MoodOption>): String {
    var i = 1
    while (existing.any { it.key == "mood_$i" }) i++
    return "mood_$i"
}

/** #1591: the archived templates, each with Restore and Delete for good. */
@Composable
private fun ArchiveSection(
    templates: List<KinTaleTemplate>,
    busy: Boolean,
    onRestore: (KinTaleTemplate) -> Unit,
    onDelete: (KinTaleTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    EditorSection(title = "Archive") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            templates.forEach { tpl ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(11.dp))
                        .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(11.dp))
                        .padding(horizontal = 13.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        tpl.name.ifBlank { "Untitled template" },
                        style = AuntieTheme.typography.titleMedium,
                        color = c.textDim,
                        modifier = Modifier.weight(1f),
                    )
                    GhostButton(label = "Restore", onClick = { onRestore(tpl) }, enabled = !busy)
                    GhostButton(label = "Delete for good", onClick = { onDelete(tpl) }, enabled = !busy)
                }
            }
        }
    }
}

/** #1591: the Remove (archive) confirm and the delete-for-good confirm with the usage count. */
@Composable
private fun RemovalDialogs(
    removing: KinTaleTemplate?,
    deleting: KinTaleTemplate?,
    deleteUsage: KinTaleTemplateUsage?,
    deleteUsageError: String?,
    busy: Boolean,
    onDismissRemove: () -> Unit,
    onConfirmRemove: (KinTaleTemplate) -> Unit,
    onDismissDelete: () -> Unit,
    onConfirmDelete: (KinTaleTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    removing?.let { t ->
        AuntieDialog(
            visible = true,
            title = "Remove ${t.name.ifBlank { "Untitled template" }}?",
            onDismiss = onDismissRemove,
            footer = {
                GhostButton(label = "Cancel", onClick = onDismissRemove)
                PrimaryButton(label = "Move to archive", onClick = { onConfirmRemove(t) }, enabled = !busy)
            },
        ) {
            kinTaleTemplateArchiveImpact(t.isDefault).forEach { line ->
                Text(line, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
        }
    }
    deleting?.let { t ->
        AuntieDialog(
            visible = true,
            title = "Delete ${t.name.ifBlank { "Untitled template" }} for good?",
            onDismiss = onDismissDelete,
            footer = {
                GhostButton(label = "Cancel", onClick = onDismissDelete)
                // Off until the count has loaded: nobody deletes past a warning they never saw.
                PrimaryButton(
                    label = "Delete for good",
                    onClick = { onConfirmDelete(t) },
                    enabled = deleteUsage != null && !busy,
                )
            },
        ) {
            when {
                deleteUsageError != null -> Text(
                    "Couldn't count the KinTales that used it: $deleteUsageError",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.error,
                )
                deleteUsage == null -> Text(
                    "Counting the KinTales that used it…",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
                else -> {
                    Text(kinTaleTemplateDeleteHeadline(deleteUsage), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                    kinTaleTemplateRemovalImpact(deleteUsage).forEach { line ->
                        Text(line, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    }
                    Text("This cannot be undone.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
            }
        }
    }
}
