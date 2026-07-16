package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Bold
import com.composables.icons.lucide.Braces
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.Heading
import com.composables.icons.lucide.Image
import com.composables.icons.lucide.Inbox
import com.composables.icons.lucide.Italic
import com.composables.icons.lucide.Link
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieEmailPreviewCard
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.MultilineFieldValue
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.StatCard
import kotlinx.coroutines.launch

// In-memory search box. The source EmailTemplate model carries no search index and
// TemplateService has no search callable, so this only narrows the already-loaded
// list by title / templateId client-side.

/**
 * Client-side Template Bank search: a blank query returns the list unchanged,
 * otherwise keeps templates whose title or templateId contains the (case-insensitive)
 * query. Pure, so it is unit-tested directly.
 */
internal fun templateBankSearchFilter(
    templates: List<TemplateService.EmailTemplate>,
    query: String,
): List<TemplateService.EmailTemplate> {
    val q = query.trim()
    if (q.isBlank()) return templates
    return templates.filter {
        it.title.contains(q, ignoreCase = true) ||
            it.templateId.contains(q, ignoreCase = true)
    }
}

/**
 * Den-redesign Template Bank (admin email-template library).
 *
 * Mirrors ui-ideas/auntieos-template-bank-2026-05-27.html: a mono kicker + serif
 * heading, a stat strip, brand-tone filter chips, and a card grid of email
 * templates. Built on the real [TemplateService] callables (listTemplates /
 * saveTemplate); errors surface loudly in an inline banner.
 *
 * Bug fixes vs the prior build:
 *  - A card tap now opens a read-only view of the template (previously the Edit
 *    button was the only way to see a template's body).
 *  - "New template" now opens the editor in create mode and persists a fresh
 *    template via [TemplateService.saveTemplate] (upsert by a new templateId).
 */
/**
 * Standalone Template Bank screen. Kept for the desktop screenshot harness and any
 * direct route; the merged two-tab [TemplatesScreen] renders [TemplateBankBody]
 * directly inside its own scaffold. Both share identical content.
 */
@Composable
fun TemplateBankScreen(
    templateService: TemplateService = remember { TemplateService() },
) {
    ScreenScaffold { TemplateBankBody(templateService) }
}

/**
 * Template Bank content WITHOUT the outer [ScreenScaffold]. Renders inside either
 * the standalone screen above or the merged [TemplatesScreen]'s shared scaffold.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TemplateBankBody(
    templateService: TemplateService = remember { TemplateService() },
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    var templates by remember { mutableStateOf<List<TemplateService.EmailTemplate>>(emptyList()) }
    // Server-deduped category list (hybrid managed-collection ∪ distinct-on-templates).
    // Replaces the old hardcoded FILTER_OPTIONS + powers the editor's category picker.
    var categories by remember { mutableStateOf<List<String>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedFilter by remember { mutableStateOf("All") }
    // Edit/create overlay target. `creating` distinguishes a fresh blank template
    // (Save persists a new doc) from editing an existing one.
    var editing by remember { mutableStateOf<TemplateService.EmailTemplate?>(null) }
    var creating by remember { mutableStateOf(false) }
    // FIX: read-only view target. A card tap sets this so the operator can read the
    // full subject / body / html / description without entering the editor.
    var viewing by remember { mutableStateOf<TemplateService.EmailTemplate?>(null) }
    var query by remember { mutableStateOf("") }

    // Drag-drop category assign (13.8): long-press a card, drop it on a category
    // chip. Each non-"All" chip records its window bounds below; the pure hit-test
    // in TemplateCategoryDrag.kt decides the target. "All" is excluded so a drop
    // there is a no-op (never silently clears the category).
    val categoryTargets = remember { mutableStateMapOf<String, Rect>() }
    var draggingId by remember { mutableStateOf<String?>(null) }
    var hoveredCategory by remember { mutableStateOf<String?>(null) }

    fun assignCategory(tpl: TemplateService.EmailTemplate, newCategory: String) {
        val prev = templates
        // Optimistic: reflect the move immediately (chip counts derive from templates).
        templates = templates.map { if (it.templateId == tpl.templateId) it.copy(category = newCategory) else it }
        scope.launch {
            when (val r = templateService.saveTemplate(tpl.copy(category = newCategory))) {
                is WriteResult.Ok -> {}
                is WriteResult.Err -> {
                    // Fail loud: revert the optimistic move and surface the error.
                    templates = prev
                    error = "Couldn't move \"${tpl.title.ifBlank { tpl.templateId }}\" to $newCategory: ${r.message}"
                }
            }
        }
    }

    suspend fun reload() {
        loading = true
        when (val r = templateService.listTemplates()) {
            is WriteResult.Ok -> { templates = r.value; error = null }
            is WriteResult.Err -> { error = r.message }
        }
        // Category list is secondary chrome: a failure here must not blank the
        // template list, but it is surfaced (not silently swallowed).
        when (val cr = templateService.listCategories()) {
            is WriteResult.Ok -> categories = cr.value
            is WriteResult.Err -> if (error == null) error = "Categories unavailable: ${cr.message}"
        }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    // Filter chips come from the real category list now (was hardcoded FILTER_OPTIONS).
    val filterOptions = remember(categories) { listOf("All") + categories }

    Column(Modifier.fillMaxWidth()) {
        DenScreenHeading(
            kicker = "The Den · Admin",
            title = "Template",
            accentTail = "Bank.",
            subtitle = "Browse, preview, and edit the email templates SendGrid delivers.",
            trailing = {
                // FIX: New template now works. Opens the editor in create mode with a
                // fresh blank template; Save persists via saveTemplate (upsert by a new
                // templateId). Backed by a real callable, so it ships live.
                PrimaryButton(
                    label = "New template",
                    onClick = {
                        creating = true
                        editing = TemplateService.EmailTemplate(
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
        Spacer(Modifier.height(20.dp))

        // ── stat strip ────────────────────────────────────────────────────────
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
        Spacer(Modifier.height(20.dp))

        // Fail-loud: surface load/save errors inline, never silently swallow them.
        error?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Template Bank hit an error",
                icon = Lucide.X,
                onDismiss = { error = null },
                modifier = Modifier.padding(bottom = 20.dp),
            ) {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        DenPanel(
            title = "Templates",
            subtitle = "Tap a card to read it, or Edit to change the subject, body, and HTML. Long-press a card to drag it onto a category.",
            modifier = Modifier.fillMaxWidth(),
        ) {
            // Controls: real category filter chips (left) + SUGGESTION search (right).
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
                    // Non-"All" chips double as drop targets while a card is dragged:
                    // record their window bounds and light up when hovered.
                    val dropHovered = draggingId != null && opt != "All" && hoveredCategory == opt
                    AuntieChip(
                        label = opt,
                        selected = selectedFilter == opt || dropHovered,
                        onClick = { selectedFilter = opt },
                        tone = AuntieChipTone.Orange,
                        trailingTag = count.toString(),
                        modifier = if (opt == "All") {
                            Modifier
                        } else {
                            Modifier.onGloballyPositioned { categoryTargets[opt] = it.boundsInWindow() }
                        },
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            AuntieSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = "Search templates by title or key...",
                leadingIcon = Lucide.Search,
                shortcutHint = "Ctrl K",
                onClear = { query = "" },
                modifier = Modifier.widthIn(max = 340.dp),
            )

            Spacer(Modifier.height(16.dp))

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
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            filtered.forEach { tpl ->
                                TemplateCard(
                                    tpl = tpl,
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
                                    modifier = Modifier.widthIn(min = 300.dp).weight(1f),
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    // FIX: read-only viewer (card tap). Edit from here hands off to the editor.
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
                    when (val r = templateService.saveTemplate(updated)) {
                        is WriteResult.Ok -> { editing = null; creating = false; reload() }
                        is WriteResult.Err -> error = r.message
                    }
                }
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TemplateCard(
    tpl: TemplateService.EmailTemplate,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    modifier: Modifier = Modifier,
    isDragging: Boolean = false,
    onDragStart: () -> Unit = {},
    onDragMove: (windowPos: Offset) -> Unit = {},
    onDragEnd: (windowPos: Offset) -> Unit = {},
    onDragCancel: () -> Unit = {},
) {
    val c = AuntieTheme.colors
    val shape = RoundedCornerShape(18.dp)
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val borderColor = when {
        isDragging -> c.primary
        hovered    -> c.primary.copy(alpha = 0.45f)
        else       -> c.border
    }

    // Drag-drop: long-press lifts the card, which then follows the pointer via a
    // graphicsLayer translation (draw-only, so [basePos] stays the true layout
    // position for the window-coordinate hit-test). The parent owns the target
    // hit-test + the assign; this just reports pointer positions.
    var basePos by remember { mutableStateOf(Offset.Zero) }
    var translation by remember { mutableStateOf(Offset.Zero) }
    var lastWindow by remember { mutableStateOf(Offset.Zero) }

    Column(
        modifier = modifier
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
            .clip(shape)
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, borderColor, shape)
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
            }
            // The whole card is tappable (read-only view); long-press starts a drag.
            .clickable(interaction, indication = null, onClick = onOpen)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(tpl.title, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)

        // Category pill + templateId key (the model carries both).
        if (!tpl.category.isNullOrBlank() || tpl.templateId.isNotBlank()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                tpl.category?.takeIf { it.isNotBlank() }?.let { cat ->
                    AuntieChip(label = cat, tone = AuntieChipTone.Purple, mono = true)
                }
                tpl.templateId.takeIf { it.isNotBlank() }?.let { key ->
                    Text(key, style = AuntieTheme.typography.mono, color = c.textDim)
                }
            }
        }

        Text(
            text = tpl.subject.ifBlank { "No subject set" },
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        tpl.description?.takeIf { it.isNotBlank() }?.let { desc ->
            Text(
                desc,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (tpl.tags.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.padding(top = 4.dp),
            ) {
                tpl.tags.take(4).forEach { tag ->
                    AuntieChip(label = tag, tone = AuntieChipTone.Orange)
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            GhostButton(
                label = "Open",
                onClick = onOpen,
                leading = { Icon(Lucide.Eye, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            GhostButton(
                label = "Edit",
                onClick = onEdit,
                leading = { Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
        }
    }
}

/**
 * Read-only viewer (FIX: card-tap open). Renders the full template plus an inbox
 * preview so the operator can read it without entering edit mode. Edit hands off
 * to [TemplateEditorOverlay].
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TemplateViewOverlay(
    template: TemplateService.EmailTemplate,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
) {
    val c = AuntieTheme.colors
    AuntieDialog(
        visible = true,
        title = template.title.ifBlank { template.templateId.ifBlank { "Template" } },
        onDismiss = onDismiss,
        maxWidth = 860.dp,
        closeIcon = Lucide.X,
        hint = "Stored in Firestore, rendered with Handlebars. SendGrid delivers as a dumb pipe.",
        footer = {
            GhostButton(label = "Close", onClick = onDismiss, modifier = Modifier.weight(1f))
            PrimaryButton(
                label = "Edit",
                onClick = onEdit,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
        },
    ) {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(
                modifier = Modifier.widthIn(min = 300.dp).weight(1f),
                verticalArrangement = Arrangement.spacedBy(14.dp),
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
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            template.tags.forEach { AuntieChip(label = it, tone = AuntieChipTone.Orange) }
                        }
                    }
                }
            }

            Column(
                modifier = Modifier.widthIn(min = 280.dp).weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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

@OptIn(ExperimentalLayoutApi::class)
/** 13.3/13.4 formatting toolbar: Bold/Italic wrap the selection; the rest insert a
 *  Markdown snippet at the cursor (the "variable" button wraps with {{ }}). */
@Composable
private fun MarkdownToolbar(onWrap: (String, String) -> Unit, onInsert: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        AuntieIconButton(Lucide.Bold, "Bold", { onWrap("**", "**") }, size = 32.dp)
        AuntieIconButton(Lucide.Italic, "Italic", { onWrap("_", "_") }, size = 32.dp)
        AuntieIconButton(Lucide.Heading, "Heading", { onInsert("## ") }, size = 32.dp)
        AuntieIconButton(Lucide.Link, "Link", { onInsert("[text](https://)") }, size = 32.dp)
        AuntieIconButton(Lucide.Image, "Image", { onInsert("![alt](https://)") }, size = 32.dp)
        AuntieIconButton(Lucide.Braces, "Insert variable", { onWrap("{{", "}}") }, size = 32.dp)
    }
}

/**
 * #15: named merge-field chips (mock auntieos-email-creation). Click drops the specific
 * {{token}} at the cursor; the tokens resolve per-recipient at send via Handlebars.
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
                AuntieChip(label = tok, onClick = { onInsert(tok) }, mono = true, tone = AuntieChipTone.Teal)
            }
        }
    }
}

@Composable
private fun TemplateEditorOverlay(
    template: TemplateService.EmailTemplate,
    creating: Boolean,
    categories: List<String>,
    existingKeys: List<String>,
    onDismiss: () -> Unit,
    onSave: (TemplateService.EmailTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    // In create mode the operator names a fresh templateId + title. In edit mode the
    // key is immutable (changing it would orphan the old doc), so it stays read-only.
    var templateId by remember(template.templateId, creating) { mutableStateOf(template.templateId) }
    var title by remember(template.templateId, creating) { mutableStateOf(template.title) }
    var subject by remember(template.templateId, creating) { mutableStateOf(template.subject) }
    // 13.3/13.4: body is edited as Markdown (TextFieldValue for selection-aware toolbar
    // wrapping); the email HTML is DERIVED on save (markdownToHtml), so the operator
    // never hand-edits raw HTML.
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
        maxWidth = 860.dp,
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
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
            ) {
                Text(
                    "A template with key \"${templateId.trim()}\" already exists. Pick a unique key, or close and edit the existing one.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }

        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(
                modifier = Modifier.widthIn(min = 320.dp).weight(1f),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (creating) {
                    // Key is the doc id and immutable after create, so it is only
                    // editable here. Title is operator chrome (not customer copy).
                    BottomBorderField(
                        value = templateId,
                        onValueChange = { templateId = it },
                        label = "Key (e.g. booking.confirmed)",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = title,
                        onValueChange = { title = it },
                        label = "Title",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                // Category: free-text entry plus tap-to-fill suggestion chips drawn
                // from the server-deduped list. Editable in both create + edit modes
                // (it is metadata, not the immutable key). Picking a brand-new name is
                // fine: saveTemplate persists it into the pool so it appears next time.
                BottomBorderField(
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
                                tone = AuntieChipTone.Orange,
                            )
                        }
                    }
                }
                BottomBorderField(
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
                // 13.3/13.4 Markdown toolbar: Bold/Italic wrap the selection; the rest
                // insert a snippet at the cursor. The email HTML is generated on save.
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
                MultilineFieldValue(
                    value = bodyValue,
                    onValueChange = { bodyValue = it },
                    label = "Body (Markdown + Handlebars)",
                    minLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )
                MultilineField(
                    value = description,
                    onValueChange = { description = it },
                    label = "Description",
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Column(
                modifier = Modifier.widthIn(min = 280.dp).weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AuntieFieldLabel(text = "Live preview")
                if (subject.isNotBlank()) {
                    Text(subject, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                }
                // Renders the SAME parsed blocks the save path emits to HTML, so what the
                // operator sees here is what SendGrid sends. {{vars}} show literally.
                MarkdownPreview(bodyValue.text, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
