package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Inbox
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDialog
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.tribetails.auntieos.ui.components.AuntieEmailPreviewCard
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch


/**
 * Pure client-side Template Bank search: narrows the already-loaded templates by a
 * case-insensitive substring match on title or templateId. A blank query returns
 * the list unchanged. No server search exists; this only filters what is loaded.
 * Mirrors the web TemplateBankScreen filter. Unit-tested.
 */
internal fun templateBankSearchFilter(
    templates: List<TemplateRepository.EmailTemplate>,
    query: String,
): List<TemplateRepository.EmailTemplate> {
    val q = query.trim()
    if (q.isBlank()) return templates
    return templates.filter {
        it.title.contains(q, ignoreCase = true) ||
            it.templateId.contains(q, ignoreCase = true)
    }
}

/**
 * Den-redesign Template Bank (admin email-template library), ported from the web
 * counterpart at web/.../admin/TemplateBankScreen.kt.
 *
 * Mono kicker + serif [DenScreenHeading], a stat strip, brand-tone filter chips,
 * and a [DenPanel] list of templates rendered as [AuntieEntityRow] lines with the
 * category / key shown as an [AuntieStatusPill]. A row tap opens a read-only
 * viewer; Edit opens the editor; New template opens the editor in create mode.
 *
 * Built on the real [TemplateRepository] callables (listTemplates / saveTemplate).
 * Load and save errors surface loudly in an inline [AuntieBanner] (fail-loud).
 */
/**
 * Standalone Template Bank screen. Kept for direct/standalone use; the merged
 * two-tab [TemplatesScreen] renders [TemplateBankBody] inside its shared scaffold.
 */
@Composable
fun TemplateBankScreen(
    onBack: () -> Unit,
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    AuntieScreenScaffold(title = "Template Bank", onBack = onBack) {
        TemplateBankBody(templateRepo)
    }
}

/** Template Bank content without the outer scaffold (see [TemplateBankScreen]). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TemplateBankBody(
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    var templates by remember { mutableStateOf<List<TemplateRepository.EmailTemplate>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedFilter by remember { mutableStateOf("All") }
    // Edit/create overlay target. `creating` distinguishes a fresh blank template
    // (Save persists a new doc) from editing an existing one.
    var editing by remember { mutableStateOf<TemplateRepository.EmailTemplate?>(null) }
    var creating by remember { mutableStateOf(false) }
    // Read-only view target. A row tap sets this so the operator can read the full
    // subject / body / html / description without entering the editor.
    var viewing by remember { mutableStateOf<TemplateRepository.EmailTemplate?>(null) }
    var query by remember { mutableStateOf("") }
    // Server-deduped category list (hybrid managed-collection ∪ distinct-on-templates).
    // Replaces the old hardcoded FILTER_OPTIONS + powers the editor's category picker.
    var categories by remember { mutableStateOf<List<String>>(emptyList()) }

    // Drag-drop category assign (13.8): long-press a row, drop it on a category
    // chip. Each non-"All" chip records its window bounds below; the pure hit-test
    // in TemplateCategoryDrag.kt decides the target. "All" is excluded (no-op drop).
    val categoryTargets = remember { mutableStateMapOf<String, Rect>() }
    var draggingId by remember { mutableStateOf<String?>(null) }
    var hoveredCategory by remember { mutableStateOf<String?>(null) }

    fun assignCategory(tpl: TemplateRepository.EmailTemplate, newCategory: String) {
        val prev = templates
        // Optimistic: reflect the move immediately (chip counts derive from templates).
        templates = templates.map { if (it.templateId == tpl.templateId) it.copy(category = newCategory) else it }
        scope.launch {
            templateRepo.saveTemplate(tpl.copy(category = newCategory))
                .onFailure {
                    // Fail loud: revert the optimistic move and surface the error.
                    templates = prev
                    error = "Couldn't move \"${tpl.title.ifBlank { tpl.templateId }}\" to $newCategory: ${it.message}"
                }
        }
    }

    suspend fun reload() {
        loading = true
        templateRepo.listTemplates()
            .onSuccess { templates = it; error = null }
            .onFailure { error = it.message ?: "Could not load templates." }
        // Category list is secondary chrome: a failure must not blank the templates,
        // but it is surfaced (not silently swallowed).
        templateRepo.listCategories()
            .onSuccess { categories = it }
            .onFailure { if (error == null) error = "Categories unavailable: ${it.message}" }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    // Filter chips come from the real category list now (was hardcoded FILTER_OPTIONS).
    val filterOptions = remember(categories) { listOf("All") + categories }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            item {
                DenScreenHeading(
                    kicker = "The Den · Admin",
                    title = "Template",
                    accentTail = "Bank.",
                    subtitle = "Browse, preview, and edit the email templates SendGrid delivers.",
                    trailing = {
                        // New template opens the editor in create mode with a fresh
                        // blank template; Save persists via saveTemplate (upsert by a
                        // new templateId). Backed by a real callable, so it ships live.
                        PrimaryButton(
                            label = "New template",
                            onClick = {
                                creating = true
                                editing = TemplateRepository.EmailTemplate(
                                    templateId = "",
                                    subject = "",
                                    body = "",
                                    html = null,
                                    title = "",
                                    description = null,
                                    tags = emptyList(),
                                    category = null,
                                )
                            },
                            leading = {
                                Icon(
                                    imageVector = Lucide.Plus,
                                    contentDescription = null,
                                    tint = c.background,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                        )
                    },
                )
            }

            // ── stat strip ──────────────────────────────────────────────────────
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    StatCard(
                        label = "Templates",
                        value = if (loading) "…" else templates.size.toString(),
                        trend = "in the bank",
                        tone = AuntieStatusTone.Orange,
                        feature = true,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Categories",
                        value = if (loading) "…" else categories.size.toString(),
                        trend = "in use",
                        tone = AuntieStatusTone.Purple,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Untagged",
                        value = if (loading) "…" else templates.count { it.tags.isEmpty() }.toString(),
                        trend = "no tags yet",
                        tone = AuntieStatusTone.Teal,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            // Fail-loud: surface load / save errors inline, never silently swallow.
            error?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Template Bank hit an error",
                        icon = Lucide.X,
                        onDismiss = { error = null },
                        body = {
                            Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        },
                    )
                }
            }

            item {
                DenPanel(
                    title = "Templates",
                    subtitle = "Tap a row to read it, or Edit to change the subject, body, and HTML. Long-press a row to drag it onto a category.",
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    // Real category filter chips (left). Counts mirror the web spec.
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        filterOptions.forEach { opt ->
                            val count = if (opt == "All") {
                                templates.size
                            } else {
                                templates.count { it.category.equals(opt, ignoreCase = true) }
                            }
                            // Non-"All" chips double as drop targets while a row is
                            // dragged: record window bounds and light up when hovered.
                            val dropHovered = draggingId != null && opt != "All" && hoveredCategory == opt
                            AuntieChip(
                                label = "$opt ($count)",
                                selected = selectedFilter == opt || dropHovered,
                                onClick = { selectedFilter = opt },
                                modifier = if (opt == "All") {
                                    Modifier
                                } else {
                                    Modifier.onGloballyPositioned { categoryTargets[opt] = it.boundsInWindow() }
                                },
                            )
                        }
                    }

                    // Client-side search over the loaded templates (always on).
                    Spacer(Modifier.height(12.dp))
                    AuntieSearchField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = "Search templates by title or key...",
                        leadingIcon = Lucide.Search,
                        onClear = { query = "" },
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Spacer(Modifier.height(8.dp))

                    when {
                        loading -> EmptyHint("Loading templates…")
                        else -> {
                            val byCategory = if (selectedFilter == "All") {
                                templates
                            } else {
                                templates.filter { it.category.equals(selectedFilter, ignoreCase = true) }
                            }
                            val filtered = templateBankSearchFilter(byCategory, query)

                            if (filtered.isEmpty()) {
                                AuntieEmptyState(
                                    title = if (templates.isEmpty()) {
                                        "No templates yet. Use New template to create one."
                                    } else {
                                        "No templates in this category."
                                    },
                                    icon = Lucide.Inbox,
                                    compact = true,
                                )
                            } else {
                                filtered.forEachIndexed { index, tpl ->
                                    TemplateRow(
                                        tpl = tpl,
                                        showDivider = index < filtered.lastIndex,
                                        onOpen = { viewing = tpl },
                                        onEdit = { creating = false; editing = tpl },
                                        isDragging = draggingId == tpl.templateId,
                                        onDragStart = { draggingId = tpl.templateId; hoveredCategory = null },
                                        onDragMove = { windowPos -> hoveredCategory = categoryDropTarget(windowPos, categoryTargets) },
                                        onDragEnd = { windowPos ->
                                            val target = categoryAssignmentForDrop(windowPos, categoryTargets, tpl.category)
                                            draggingId = null
                                            hoveredCategory = null
                                            if (target != null) assignCategory(tpl, target)
                                        },
                                        onDragCancel = { draggingId = null; hoveredCategory = null },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    // Read-only viewer (row tap). Edit from here hands off to the editor.
    viewing?.let { current ->
        TemplateViewOverlay(
            template = current,
            onDismiss = { viewing = null },
            onEdit = {
                viewing = null
                creating = false
                editing = current
            },
        )
    }

    editing?.let { current ->
        TemplateEditorOverlay(
            template = current,
            creating = creating,
            categories = categories,
            // Operator-supplied keys already taken (create mode collision guard).
            existingKeys = templates.map { it.templateId },
            onDismiss = { editing = null; creating = false },
            onSave = { updated ->
                scope.launch {
                    templateRepo.saveTemplate(updated)
                        .onSuccess { editing = null; creating = false; reload() }
                        .onFailure { error = it.message ?: "Save failed." }
                }
            },
        )
    }
}

@Composable
private fun TemplateRow(
    tpl: TemplateRepository.EmailTemplate,
    showDivider: Boolean,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    isDragging: Boolean = false,
    onDragStart: () -> Unit = {},
    onDragMove: (windowPos: Offset) -> Unit = {},
    onDragEnd: (windowPos: Offset) -> Unit = {},
    onDragCancel: () -> Unit = {},
) {
    // Drag-drop: long-press lifts the row, which then follows the pointer via a
    // graphicsLayer translation (draw-only, so [basePos] stays the true layout
    // position for the window-coordinate hit-test). The parent owns the assign.
    var basePos by remember { mutableStateOf(Offset.Zero) }
    var translation by remember { mutableStateOf(Offset.Zero) }
    var lastWindow by remember { mutableStateOf(Offset.Zero) }
    AuntieEntityRow(
        title = tpl.title.ifBlank { tpl.templateId.ifBlank { "Untitled template" } },
        subtitle = tpl.subject.ifBlank { "No subject set" },
        showDivider = showDivider,
        onClick = onOpen,
        modifier = Modifier
            .onGloballyPositioned { basePos = it.positionInWindow() }
            .graphicsLayer {
                if (isDragging) {
                    translationX = translation.x
                    translationY = translation.y
                    alpha = 0.92f
                    scaleX = 1.02f
                    scaleY = 1.02f
                    shadowElevation = 16f
                }
            }
            .pointerInput(tpl.templateId) {
                detectDragGesturesAfterLongPress(
                    onDragStart = { startLocal ->
                        translation = Offset.Zero
                        lastWindow = basePos + startLocal
                        onDragStart()
                    },
                    onDrag = { change, dragAmount ->
                        change.consume()
                        translation += dragAmount
                        lastWindow = basePos + change.position
                        onDragMove(lastWindow)
                    },
                    onDragEnd = { onDragEnd(lastWindow); translation = Offset.Zero },
                    onDragCancel = { translation = Offset.Zero; onDragCancel() },
                )
            },
        trailing = {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                tpl.category?.takeIf { it.isNotBlank() }?.let { cat ->
                    AuntieStatusPill(label = cat, tone = AuntieStatusTone.Purple)
                }
                tpl.templateId.takeIf { it.isNotBlank() }?.let { key ->
                    AuntieStatusPill(label = key, tone = AuntieStatusTone.Teal, mono = true)
                }
                GhostButton(
                    label = "Edit",
                    onClick = onEdit,
                    leading = {
                        Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp))
                    },
                )
            }
        },
    )
}

/**
 * Read-only viewer (row-tap open). Renders the full template plus an inbox preview
 * so the operator can read it without entering edit mode. Edit hands off to
 * [TemplateEditorOverlay].
 */
@Composable
private fun TemplateViewOverlay(
    template: TemplateRepository.EmailTemplate,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
) {
    AuntieDialog(
        visible = true,
        title = template.title.ifBlank { template.templateId.ifBlank { "Template" } },
        onDismiss = onDismiss,
        closeIcon = Lucide.X,
        hint = "Stored in Firestore, rendered with Handlebars. SendGrid delivers as a dumb pipe.",
        footer = {
            GhostButton(label = "Close", onClick = onDismiss, modifier = Modifier.weight(1f))
            PrimaryButton(
                label = "Edit",
                onClick = onEdit,
                modifier = Modifier.weight(1f),
                leading = {
                    Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp))
                },
            )
        },
    ) {
        if (template.templateId.isNotBlank()) {
            ReadField("Key", template.templateId, mono = true)
        }
        template.category?.takeIf { it.isNotBlank() }?.let { ReadField("Category", it) }
        ReadField("Subject", template.subject.ifBlank { "(none)" })
        ReadField("Body", template.body.ifBlank { "(empty)" })
        template.html?.takeIf { it.isNotBlank() }?.let { ReadField("HTML", it, mono = true) }
        template.description?.takeIf { it.isNotBlank() }?.let { ReadField("Description", it) }
        if (template.tags.isNotEmpty()) {
            Column {
                AuntieFieldLabel(text = "Tags")
                Spacer(Modifier.height(6.dp))
                FlowRowTags(template.tags)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieFieldLabel(text = "Inbox preview")
            AuntieEmailPreviewCard(
                subject = template.subject,
                body = template.body,
                html = template.html?.takeIf { it.isNotBlank() },
                highlightTokens = true,
                footer = "merge fields resolve at send",
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowTags(tags: List<String>) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        tags.forEach { AuntieStatusPill(label = it, tone = AuntieStatusTone.Orange) }
    }
}

@Composable
private fun ReadField(label: String, value: String, mono: Boolean = false) {
    val c = AuntieTheme.colors
    Column {
        AuntieFieldLabel(text = label)
        Spacer(Modifier.height(6.dp))
        Text(
            value,
            style = if (mono) AuntieTheme.typography.mono else AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
    }
}

/**
 * #15: named merge-field chips (mock auntieos-email-creation). Click drops the specific
 * {{token}} at the cursor; tokens resolve per-recipient at send via Handlebars.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MergeFieldChips(onInsert: (String) -> Unit) {
    val tokens = listOf(
        "{{kinfolk_name}}", "{{kin_names}}", "{{date}}", "{{time}}",
        "{{service}}", "{{invoice_no}}", "{{amount}}", "{{link}}",
    )
    Column {
        AuntieFieldLabel(text = "Insert merge field")
        Spacer(Modifier.height(6.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            tokens.forEach { tok ->
                AuntieChip(onClick = { onInsert(tok) }, label = tok, selected = false)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TemplateEditorOverlay(
    template: TemplateRepository.EmailTemplate,
    creating: Boolean,
    categories: List<String>,
    existingKeys: List<String>,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.EmailTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    // In create mode the operator names a fresh templateId + title. In edit mode the
    // key is immutable (changing it would orphan the old doc), so it stays hidden.
    var templateId by remember(template.templateId, creating) { mutableStateOf(template.templateId) }
    var title by remember(template.templateId, creating) { mutableStateOf(template.title) }
    var subject by remember(template.templateId, creating) { mutableStateOf(template.subject) }
    // 13.3/13.4: body edited as Markdown (TextFieldValue for selection-aware toolbar);
    // the email HTML is DERIVED on save (markdownToHtml) - no hand-edited HTML field.
    var bodyValue by remember(template.templateId, creating) { mutableStateOf(TextFieldValue(template.body)) }
    var category by remember(template.templateId, creating) { mutableStateOf(template.category ?: "") }
    var description by remember(template.templateId, creating) { mutableStateOf(template.description ?: "") }

    val keyTaken = creating && templateId.trim() in existingKeys
    val keyValid = !creating || (templateId.isNotBlank() && !keyTaken)
    val canSave = subject.isNotBlank() && bodyValue.text.isNotBlank() && keyValid

    AuntieDialog(
        visible = true,
        title = if (creating) "New template" else "Edit: ${template.title}",
        onDismiss = onDismiss,
        closeIcon = Lucide.X,
        hint = "Stored in Firestore, rendered with Handlebars. SendGrid delivers as a dumb pipe.",
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
            PrimaryButton(
                label = if (creating) "Create" else "Save",
                enabled = canSave,
                onClick = {
                    onSave(
                        template.copy(
                            templateId = templateId.trim(),
                            title = title.ifBlank { templateId.trim() },
                            subject = subject,
                            body = bodyValue.text,
                            html = markdownToHtml(bodyValue.text).ifBlank { null },
                            category = category.ifBlank { null },
                            description = description.ifBlank { null },
                        ),
                    )
                },
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        if (keyTaken) {
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                title = "That key is already taken",
                modifier = Modifier.fillMaxWidth(),
                body = {
                    Text(
                        "A template with key \"${templateId.trim()}\" already exists. Pick a unique key, or close and edit the existing one.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                },
            )
        }

        if (creating) {
            // Key is the doc id and immutable after create, so it is only editable
            // here. Title is operator chrome (not customer copy).
            AuntieField(
                value = templateId,
                onValueChange = { templateId = it },
                label = "Key (e.g. booking.confirmed)",
                modifier = Modifier.fillMaxWidth(),
            )
            AuntieField(
                value = title,
                onValueChange = { title = it },
                label = "Title",
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // Category: free-text entry plus tap-to-fill suggestion chips from the
        // server-deduped list. Editable in both create + edit modes (it is metadata,
        // not the immutable key). A brand-new name is fine: saveTemplate persists it
        // into the pool so it appears next time.
        AuntieField(
            value = category,
            onValueChange = { category = it },
            label = "Category (optional)",
            modifier = Modifier.fillMaxWidth(),
        )
        if (categories.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                categories.forEach { cat ->
                    AuntieChip(
                        label = cat,
                        selected = category.equals(cat, ignoreCase = true),
                        onClick = { category = cat },
                    )
                }
            }
        }
        AuntieField(
            value = subject,
            onValueChange = { subject = it },
            label = "Subject",
            modifier = Modifier.fillMaxWidth(),
        )
        // #15: click a named merge-field chip to drop its {{token}} at the cursor.
        MergeFieldChips(onInsert = { snip ->
            val e = insertSnippet(bodyValue.text, bodyValue.selection.start, snip)
            bodyValue = TextFieldValue(e.text, TextRange(e.cursor))
        })
        // 13.3/13.4 Markdown toolbar + body editor; HTML is generated on save.
        MarkdownToolbar(
            onWrap = { p, s ->
                val e = wrapSelection(bodyValue.text, bodyValue.selection.start, bodyValue.selection.end, p, s)
                bodyValue = TextFieldValue(e.text, TextRange(e.cursor))
            },
            onInsert = { snip ->
                val e = insertSnippet(bodyValue.text, bodyValue.selection.start, snip)
                bodyValue = TextFieldValue(e.text, TextRange(e.cursor))
            },
        )
        AuntieMarkdownField(
            value = bodyValue,
            onValueChange = { bodyValue = it },
            label = "Body (Markdown + Handlebars)",
            minLines = 6,
            modifier = Modifier.fillMaxWidth(),
        )
        AuntieField(
            value = description,
            onValueChange = { description = it },
            label = "Description",
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            minLines = 2,
        )

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieFieldLabel(text = "Live preview")
            if (subject.isNotBlank()) {
                Text(subject, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            }
            // Renders the SAME parsed blocks the save path emits to HTML; {{vars}} literal.
            MarkdownPreview(bodyValue.text, modifier = Modifier.fillMaxWidth())
        }
    }
}
