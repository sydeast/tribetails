package com.tribetails.auntieos.ui.admin

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Inbox
import com.composables.icons.lucide.Mail
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
import com.tribetails.auntieos.ui.components.ENRICHABLE_SAMPLE
import com.tribetails.auntieos.ui.components.MergeFieldWarning
import com.tribetails.auntieos.ui.components.MergePreview
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.TagAssignField
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.AuntieSearchField
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
 * The description the Template Bank card shows, or null when there is none.
 *
 * Trimmed, and blank-is-null, so a description of spaces draws nothing rather
 * than an empty line: the same `description !== ''` guard the React card uses
 * (`src/screens/Templates.tsx#TemplateCard`).
 *
 * This and [templateCardTags] exist because the Android card was missing two of
 * the six fields the mock's card names (`ui-ideas/auntieos-template-bank-2026-05-27.html`
 * l.235: "title, subject, description, tags (max 4), category, key") while the
 * React card had been showing all six. That is the Android half of the
 * list-shape rule: one column either way on a phone, so what has to match
 * across consoles is what the card CARRIES.
 */
internal fun templateCardDescription(tpl: TemplateRepository.EmailTemplate): String? =
    tpl.description?.trim()?.takeIf { it.isNotEmpty() }

/**
 * The tags the Template Bank card shows, capped at [max].
 *
 * Mirrors the web's `previewTags(tpl.tags, 4)`; the cap is the mock's own
 * "tags (max 4)", and it keeps a heavily tagged template from blowing the
 * card's height out on either console.
 */
internal fun templateCardTags(
    tpl: TemplateRepository.EmailTemplate,
    max: Int = 4,
): List<String> = tpl.tags.take(max)

/**
 * The subject line the card shows, carrying the mock's "Subject:" prefix
 * (`ui-ideas/auntieos-template-bank-2026-05-27.html` l.245), per #716.
 *
 * The prefix labels a real subject. A template with no subject keeps the bare
 * "No subject set" fallback, because "Subject: No subject set" labels a
 * sentence that is already about the missing subject. Same rule as the React
 * card.
 */
internal fun templateCardSubjectLine(tpl: TemplateRepository.EmailTemplate): String =
    tpl.subject.trim().takeIf { it.isNotEmpty() }?.let { "Subject: $it" } ?: "No subject set"

/**
 * The label for one category filter chip.
 *
 * The chips render ABOVE the `loading` branch, so before this they carried a
 * count in every state, including the two where nothing had been read:
 * `listTemplates()` leaves `loading` false and the list empty on failure, so a
 * failed load said "All (0)" about a collection it never managed to read.
 * That is the confident zero the web console already refuses.
 *
 * Rows already on screen settle it either way: a failed REFRESH over twelve
 * visible rows still leaves twelve, so the chip keeps describing them. The
 * chip itself always renders (it is also a drop target for the drag-to-
 * categorize gesture); only the number goes away.
 */
internal fun templateBankChipLabel(
    option: String,
    count: Int,
    loaded: Int,
    loading: Boolean,
    hasError: Boolean,
): String = if (loaded == 0 && (loading || hasError)) option else "$option ($count)"

/**
 * What the empty list says, given WHY it is empty.
 *
 * Four facts, and the old copy told two of them wrong. "No templates in this
 * category." rendered whenever the visible list came back empty, including on
 * "All" with a search query typed, so it named the category as the reason when
 * the search box was doing the excluding. And "No templates yet." rendered
 * over a FAILED read, which claims an empty bank on the strength of a list
 * nobody managed to load.
 *
 * This console says "all N" where the web one has to hedge: the Android
 * `TemplateRepository.listTemplates()` sends no `limit`, so it holds the whole
 * collection and its search really did cover everything.
 */
internal fun templateBankEmptyMessage(
    loaded: Int,
    /** The selected chip: "All", or a real category name. */
    category: String,
    query: String,
    hasError: Boolean,
): String {
    if (loaded == 0) {
        return if (hasError) {
            "Templates could not be loaded. See the error above."
        } else {
            "No templates yet. Use New template to create one."
        }
    }
    val where = if (category == "All") "" else " in $category"
    val q = query.trim()
    if (q.isEmpty()) return "No templates$where."
    val plural = if (loaded == 1) "" else "s"
    return "Nothing$where matches \"$q\". Searched all $loaded template$plural, by title and key."
}

/**
 * Den-redesign Template Bank (admin email-template library), ported from the web
 * counterpart at web/.../admin/TemplateBankScreen.kt.
 *
 * Mono kicker + serif [DenScreenHeading] with one primary action, brand-tone
 * filter chips, and a [DenPanel] list of templates rendered as [AuntieEntityRow]
 * lines with the category / key shown as an [AuntieStatusPill]. A row tap opens
 * a read-only viewer; Edit opens the editor; New template opens the editor in
 * create mode.
 *
 * No stat strip, per #716: the mock draws none, and the chips already carry the
 * counts it claimed. The [DenPanel] stays on this console, unlike the React
 * screen's: its subtitle is the only place the long-press drag-to-categorize
 * gesture is announced, and the chips inside it are that gesture's drop targets.
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
    // A failed save is the editor's to show: the editor replaces the bank while
    // it is open (#755), so a banner on the bank would sit behind it unread.
    var saveError by remember { mutableStateOf<String?>(null) }
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

    // The editor replaces the bank while it is open: a page of its own with the
    // email creation mock's "Template bank / Edit template" crumb trail, the
    // same swap the web Templates screen makes. It was an AuntieDialog over the
    // list until the #755 sweep.
    editing?.let { current ->
        TemplateEditorScreen(
            template = current,
            creating = creating,
            categories = categories,
            // Operator-supplied keys already taken (create mode collision guard).
            existingKeys = templates.map { it.templateId },
            saveError = saveError,
            onDismissError = { saveError = null },
            onDismiss = { editing = null; creating = false; saveError = null },
            onSave = { updated ->
                scope.launch {
                    // expectNew on create: the collision check above only sees
                    // the templates this screen loaded, and the server sees them
                    // all. Issue #468.
                    templateRepo.saveTemplate(updated, expectNew = creating)
                        .onSuccess { editing = null; creating = false; saveError = null; reload() }
                        .onFailure { saveError = it.message ?: "Save failed." }
                }
            },
        )
        return
    }

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

            // No stat strip. This screen drew three StatCards (Templates /
            // Categories / Untagged); the mock draws none, and #716 settled that
            // the mock owns the page frame on both consoles. The counts they
            // carried are still here, on the category chips below.

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
                                label = templateBankChipLabel(
                                    option = opt,
                                    count = count,
                                    loaded = templates.size,
                                    loading = loading,
                                    hasError = error != null,
                                ),
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
                                    // Which fact this is: empty bank, failed
                                    // read, empty category, or no search match.
                                    title = templateBankEmptyMessage(
                                        loaded = templates.size,
                                        category = selectedFilter,
                                        query = query,
                                        hasError = error != null,
                                    ),
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
}

@OptIn(ExperimentalLayoutApi::class)
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
    val description = templateCardDescription(tpl)
    val tags = templateCardTags(tpl)
    // The card's remaining two mock fields, below the title row rather than in
    // it: tag chips reflowing under the Edit button would read as belonging to
    // it. Null when the template has neither, so an untagged, undescribed
    // template draws no empty strip.
    val supportingFields: (@Composable ColumnScope.() -> Unit)? =
        if (description == null && tags.isEmpty()) {
            null
        } else {
            {
                if (description != null) {
                    Text(
                        text = description,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textFaint,
                        // Mock l.127: up to two lines, ellipsis. Tapping the
                        // card opens the full text, so nothing is unreachable.
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (tags.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        tags.forEach { tag ->
                            AuntieStatusPill(label = tag, tone = AuntieStatusTone.Orange)
                        }
                    }
                }
            }
        }
    AuntieEntityRow(
        title = tpl.title.ifBlank { tpl.templateId.ifBlank { "Untitled template" } },
        subtitle = templateCardSubjectLine(tpl),
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
        supporting = supportingFields,
    )
}

/**
 * Read-only viewer (row-tap open). Renders the full template plus an inbox preview
 * so the operator can read it without entering edit mode. Edit hands off to
 * [TemplateEditorScreen].
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
            // MergePreview, not the bare card: it fills the twelve tokens
            // `enrichTemplateData.ts` hydrates with sample values, so what is on
            // screen is the copy a kinfolk receives rather than the source, and
            // it names the merge fields nothing binds. `account.welcome.business`
            // is the reason: it has shipped for months ending "See their account
            // here: []" and no admin surface had ever rendered it.
            MergePreview(
                subject = template.subject,
                body = template.body,
                sample = ENRICHABLE_SAMPLE,
                html = template.html?.takeIf { it.isNotBlank() },
                footnote = "sample values, filled in at send",
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
 * The merge-field chips the mock (auntieos-email-creation) draws over the body.
 * Tapping one drops its `{{token}}` at the cursor; tokens resolve per recipient
 * at send via Handlebars.
 *
 * The tokens are the keys of [ENRICHABLE_SAMPLE], the twelve
 * `enrichTemplateData.ts` fills on every notification send, and the same list
 * the web editor offers. The mock's illustrative names (`{{kinfolk_name}}`,
 * `{{invoice_no}}`) are not names the enricher knows, and this chip row used to
 * insert them, so every chip tap was immediately flagged by [MergeFieldWarning]
 * underneath as a token nothing would fill.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MergeFieldChips(onInsert: (String) -> Unit) {
    val tokens = ENRICHABLE_SAMPLE.keys.map { "{{$it}}" }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AuntieFieldLabel(text = "Insert merge field")
            Spacer(Modifier.width(8.dp))
            Text(
                "tap to drop the token at the cursor",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textFaint,
            )
        }
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

/**
 * The template key rule, phrased for a human.
 *
 * Issue #468: Android used to check only that the key was non-blank and unused
 * among the templates it had loaded, so a key with a slash or a space in it
 * reached the server and came back as a zod complaint about a regex. The rule
 * is a document id rule, and it is the same one the React admin's
 * `templateIdError` enforces; the wording matches so an operator reads one
 * sentence, not two.
 */
internal const val TEMPLATE_KEY_RULE: String =
    "Letters, numbers, dots, dashes and underscores only, up to 120 characters. " +
        "The convention is a dotted key that matches the notification it renders, " +
        "for example kincare.reschedule.requested."
private val TEMPLATE_KEY_PATTERN = Regex("^[a-zA-Z0-9_.-]+$")
internal const val TEMPLATE_KEY_MAX_LENGTH = 120
/**
 * What is wrong with a proposed template key, or null when it is usable.
 *
 * [existingKeys] is the page of templates the Bank happens to hold, so a null
 * here is not a promise the key is free: `saveTemplate` is called with
 * `expectNew` and the server has the last word. This is the fast, local half.
 */
internal fun templateKeyError(key: String, existingKeys: List<String>): String? {
    val trimmed = key.trim()
    return when {
        trimmed.isEmpty() -> "A template key is required. $TEMPLATE_KEY_RULE"
        trimmed.length > TEMPLATE_KEY_MAX_LENGTH ->
            "That key is ${trimmed.length} characters, and the limit is $TEMPLATE_KEY_MAX_LENGTH. $TEMPLATE_KEY_RULE"
        !TEMPLATE_KEY_PATTERN.matches(trimmed) ->
            "That key uses characters a template key cannot carry. $TEMPLATE_KEY_RULE"
        trimmed in existingKeys ->
            "A template with the key \"$trimmed\" already exists. Pick a different key, " +
                "or close this and edit the existing one."
        else -> null
    }
}
/**
 * The editor as the email creation mock draws it (#755,
 * `ui-ideas/auntieos-email-creation-2026-05-27.html`): a page with the
 * "Template bank / Edit template" crumb trail and "Email template" heading,
 * Save in the heading, the form in one glass panel, then the live preview and
 * the resolved sample values in two panels under it (the mock's right-hand
 * column, stacked on a phone). The first crumb and the system back gesture
 * both return to the bank without saving; the mock's Cancel button is not
 * drawn beside Save because the two do not fit beside the title at phone
 * width, and the crumb is the same action.
 *
 * In create mode the operator names a fresh templateId + title. In edit mode
 * the key is immutable (changing it would orphan the old doc) and shows as a
 * read-only mono line; the display name stays editable in both modes, as the
 * mock draws it.
 *
 * The mock's Push / SMS switch positions are disabled there and would be dead
 * here (only the email bank exists), and its "Active binding" toggle belongs
 * to a TemplateBinding this editor does not hold, so the channel strip states
 * the channel and nothing else.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TemplateEditorScreen(
    template: TemplateRepository.EmailTemplate,
    creating: Boolean,
    categories: List<String>,
    existingKeys: List<String>,
    saveError: String?,
    onDismissError: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (TemplateRepository.EmailTemplate) -> Unit,
) {
    val c = AuntieTheme.colors
    var templateId by remember(template.templateId, creating) { mutableStateOf(template.templateId) }
    var title by remember(template.templateId, creating) { mutableStateOf(template.title) }
    var subject by remember(template.templateId, creating) { mutableStateOf(template.subject) }
    // 13.3/13.4: body edited as Markdown (TextFieldValue for selection-aware toolbar);
    // the email HTML is DERIVED on save (markdownToHtml) - no hand-edited HTML field.
    var bodyValue by remember(template.templateId, creating) { mutableStateOf(TextFieldValue(template.body)) }
    var category by remember(template.templateId, creating) { mutableStateOf(template.category ?: "") }
    var description by remember(template.templateId, creating) { mutableStateOf(template.description ?: "") }
    // Tags are persisted on the doc and used to be decoded but not editable
    // here; the mock draws the tag row, so they are.
    var tags by remember(template.templateId, creating) { mutableStateOf(template.tags) }

    val keyError = if (creating) templateKeyError(templateId, existingKeys) else null
    val canSave = subject.isNotBlank() && bodyValue.text.isNotBlank() && keyError == null

    // Back returns to the bank, never out of Templates, the same as the crumb.
    BackHandler { onDismiss() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        DenScreenHeading(
            kicker = "The Den · Template bank",
            crumbs = listOf(
                DenCrumb("Template bank", onDismiss),
                DenCrumb(if (creating) "New template" else "Edit template"),
            ),
            title = "Email",
            accentTail = "template",
            subtitle = "Subject and body render with Handlebars. Merge fields resolve to each recipient at send time.",
            modifier = Modifier.fillMaxWidth(),
            trailing = {
                PrimaryButton(
                    label = "Save",
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
                                tags = tags,
                            ),
                        )
                    },
                )
            },
        )

        // Fail loud: the save's own error, on the page that made the call.
        saveError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't save",
                icon = Lucide.X,
                onDismiss = onDismissError,
                body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
            )
        }

        // The mock's left panel. No title of its own: the heading names the
        // screen and the mono caps name each field.
        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                // Only complain once the operator has started typing. An empty
                // field on a page that just opened is not a mistake yet.
                if (keyError != null && templateId.isNotBlank()) {
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "That key will not do",
                        modifier = Modifier.fillMaxWidth(),
                        body = {
                            Text(
                                keyError,
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        },
                    )
                }

                // The mock's `.idrow`: key, then display name.
                if (creating) {
                    Column {
                        AuntieFieldLabel(text = "Template key", required = true)
                        Spacer(Modifier.height(6.dp))
                        AuntieField(
                            value = templateId,
                            onValueChange = { templateId = it },
                            placeholder = "invoice.sent",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(6.dp))
                        // The rule is readable before it is broken, not only after.
                        Text(
                            TEMPLATE_KEY_RULE,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textFaint,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                } else {
                    ReadField("Template key", template.templateId, mono = true)
                }
                Column {
                    AuntieFieldLabel(text = "Display name")
                    Spacer(Modifier.height(6.dp))
                    AuntieField(
                        value = title,
                        onValueChange = { title = it },
                        placeholder = "Defaults to the template key",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                // The mock's channel strip: the channel, stated with a kit pill.
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(c.surface2)
                        .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(14.dp))
                        .padding(horizontal = 15.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AuntieStatusPill(
                        label = "Channel · Email",
                        tone = AuntieStatusTone.Teal,
                        mono = true,
                        leadingIcon = Lucide.Mail,
                    )
                }

                Column {
                    AuntieFieldLabel(text = "Subject", required = true)
                    Spacer(Modifier.height(6.dp))
                    AuntieField(
                        value = subject,
                        onValueChange = { subject = it },
                        placeholder = "Your booking is confirmed",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                // Tap a merge-field chip to drop its {{token}} at the cursor.
                MergeFieldChips(onInsert = { snip ->
                    val e = insertSnippet(bodyValue.text, bodyValue.selection.start, snip)
                    bodyValue = TextFieldValue(e.text, TextRange(e.cursor))
                })

                // 13.3/13.4 Markdown toolbar + body editor; HTML is generated on save.
                // The field draws its own caps label, so the caption rides on it
                // rather than a second label above the toolbar.
                Column {
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
                        label = "Body · Markdown and Handlebars",
                        minLines = 6,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(6.dp))
                    // The mock's `.edmeta`: the count, and what happens to a token.
                    Text(
                        "${bodyValue.text.length} chars · tokens left as-is, never sent literally",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textFaint,
                    )
                }

                Column {
                    AuntieFieldLabel(text = "Internal description", optionalNote = "admin-only note")
                    Spacer(Modifier.height(6.dp))
                    AuntieField(
                        value = description,
                        onValueChange = { description = it },
                        placeholder = "What is this template for? Who receives it?",
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = false,
                        minLines = 2,
                    )
                }

                // Category: free-text entry plus tap-to-fill suggestion chips from
                // the server-deduped list. A brand-new name is fine: saveTemplate
                // persists it into the pool so it appears next time.
                Column {
                    AuntieFieldLabel(text = "Category")
                    Spacer(Modifier.height(6.dp))
                    AuntieField(
                        value = category,
                        onValueChange = { category = it },
                        placeholder = "Booking",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (categories.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
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
                }

                // The mock's tag row: one capsule per tag with its own remove,
                // then the add box. No vocabulary: template tags are free text.
                Column {
                    AuntieFieldLabel(text = "Tags")
                    Spacer(Modifier.height(6.dp))
                    TagAssignField(
                        value = tags,
                        vocab = emptyList(),
                        onChange = { tags = it },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        // The mock's right-hand column, stacked: the live preview panel, then
        // the resolved sample values.
        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieFieldLabel(text = "Live preview")
                if (subject.isNotBlank()) {
                    Text(subject, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                }
                // Renders the SAME parsed blocks the save path emits to HTML; {{vars}} literal.
                MarkdownPreview(bodyValue.text, modifier = Modifier.fillMaxWidth())
                // The markdown preview stays, because it is a true picture of the
                // save path. The warning is the other half: which of those literal
                // {{vars}} the dispatch pipeline will NOT fill, named while the
                // author is still in a position to do something about it.
                MergeFieldWarning(
                    subject = subject,
                    body = bodyValue.text,
                    sample = ENRICHABLE_SAMPLE,
                )
                Text(
                    "Sample values. Dispatch fills these in at send",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                )
            }
        }

        GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp)) {
                AuntieFieldLabel(text = "Resolved with sample values")
                Spacer(Modifier.height(4.dp))
                ENRICHABLE_SAMPLE.entries.forEachIndexed { index, (key, value) ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            "{{$key}}",
                            style = AuntieTheme.typography.mono,
                            color = c.accent,
                            modifier = Modifier.width(132.dp),
                        )
                        Text("→", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        Text(
                            value,
                            style = AuntieTheme.typography.titleSmall,
                            color = c.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (index < ENRICHABLE_SAMPLE.size - 1) {
                        HorizontalDivider(color = c.border, thickness = AuntieTheme.dims.borderHairline)
                    }
                }
            }
        }
    }
}
