package com.tribetails.auntieos.web.screens.admin.formschemas

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

/**
 * Den-redesign Form Schemas list ("The Den · Admin").
 *
 * Mirrors ui-ideas/auntieos-formschema-list-2026-05-27.html: a mono kicker +
 * serif heading, a "New schema" primary action, and a glass panel holding the
 * sortable Name / Version / Updated / Updated-by table. Load failures surface
 * loudly via [AuntieBanner] (fail-loud policy) instead of a transient toast.
 *
 * The search field and row-count chip ship live. The per-row delete affordance
 * (and its actions column) are also live: a hover-revealed trash icon opens an
 * [AuntieDialog] confirm, then calls [FormSchemaRepository.deleteSchema] (the
 * deployed deleteFormSchema callable the editor already uses) and reloads the
 * list. Failures surface loudly in the same banner the load path uses.
 */
private enum class SortCol { Name, Version, UpdatedAt, UpdatedBy }

/**
 * Sentinel detail id for the create-new editor route.
 *
 * The old code called onOpenEditor("") which set App.kt's editingFormSchemaId
 * to an empty string. routeToHash serializes that to "#/form-schemas/" (empty
 * segment), then parseHash's `filter { it.isNotBlank() }` drops the segment and
 * yields detailId = null, so the editor mounted then instantly bounced back to
 * this list (the reported "New schema" flicker plus red error flash on remount).
 *
 * A non-blank sentinel survives the hash round-trip ("#/form-schemas/new" parses
 * back to detailId = "new"), so the editor stays mounted. The editor ViewModel
 * already recognizes this value: FormSchemaEditorViewModel.isCreateMode treats
 * both a blank id and FORM_SCHEMA_NEW_SENTINEL (also "new") as create-new, so the
 * round-trip lands in create mode without bouncing. This constant must keep the
 * same value as that sentinel; the main thread should collapse the two duplicate
 * constants into one shared declaration (see flagsNeeded / clientMethodsNeeded).
 */
const val NEW_SCHEMA_ID: String = "new"

/**
 * Maps a deleteFormSchema result to the fail-loud banner message the list shows,
 * or null on success (the row is removed and the list reloads). Pure + unit-tested
 * so the delete-confirm wiring's error contract is covered without a live callable.
 */
internal fun deleteResultMessage(result: WriteResult<Unit>): String? = when (result) {
    is WriteResult.Ok -> null
    is WriteResult.Err -> "deleteFormSchema failed: ${result.message}"
}

@Composable
fun FormSchemaListScreen(
    repository: FormSchemaRepository = remember { CloudFormSchemaRepository() },
    onOpenEditor: (schemaId: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberCoroutineScope()

    var schemas by remember { mutableStateOf<List<FormSchemaSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    // Fail-loud: a non-null error string renders an AuntieBanner(Error). Cleared on
    // every successful reload so a stale failure never lingers behind fresh data.
    var loadError by remember { mutableStateOf<String?>(null) }
    // The schema currently pending a delete confirm (null = no dialog). Reusing the
    // summary keeps the dialog copy honest (real name/id) without an extra fetch.
    var pendingDelete by remember { mutableStateOf<FormSchemaSummary?>(null) }
    var deleting by remember { mutableStateOf(false) }
    // Default: most-recently-updated first to match Android operator workflow
    // (mirrors Android SortColumn.UPDATED_AT semantics: descending by updatedAt).
    var sortCol by remember { mutableStateOf(SortCol.UpdatedAt) }
    var sortAsc by remember { mutableStateOf(false) }
    // SUGGESTION: local-only filter query. Not part of the shipped contract; the
    // backend list payload is filtered client-side, never re-queried.
    var query by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        when (val r = repository.listSchemas()) {
            is WriteResult.Ok  -> { schemas = r.value; loadError = null }
            is WriteResult.Err -> { loadError = r.message }
        }
        loading = false
    }

    // Delete the confirmed schema via the deployed deleteFormSchema callable (the
    // same path the editor uses), then reload the list. Fail-loud: an error
    // surfaces in the shared loadError banner and the row stays put.
    suspend fun confirmDelete(target: FormSchemaSummary) {
        deleting = true
        val message = deleteResultMessage(repository.deleteSchema(target.id))
        deleting = false
        pendingDelete = null
        if (message == null) {
            reload()
        } else {
            loadError = message
        }
    }

    LaunchedEffect(Unit) { reload() }

    val sorted = remember(schemas, sortCol, sortAsc) {
        val cmp = when (sortCol) {
            SortCol.Name      -> compareBy<FormSchemaSummary> { it.name.lowercase() }
            SortCol.Version   -> compareBy { it.version }
            // Blank updatedAt sorts last in both directions (mirror Android null-last semantics).
            SortCol.UpdatedAt -> compareBy<FormSchemaSummary> { it.updatedAt.isBlank() }
                .thenBy { it.updatedAt }
            SortCol.UpdatedBy -> compareBy { it.updatedBy.lowercase() }
        }
        if (sortAsc) {
            schemas.sortedWith(cmp)
        } else if (sortCol == SortCol.UpdatedAt) {
            // Keep blanks at the tail even when reversing primary order.
            schemas.sortedWith(
                compareBy<FormSchemaSummary> { it.updatedAt.isBlank() }
                    .thenByDescending { it.updatedAt },
            )
        } else {
            schemas.sortedWith(cmp.reversed())
        }
    }

    // Filter the already-sorted list by name or id. Empty query is a no-op so the
    // shipped behavior (show every schema) is preserved when nothing is typed.
    val visible = remember(sorted, query) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) sorted
        else sorted.filter { it.name.lowercase().contains(q) || it.id.lowercase().contains(q) }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Admin",
            title      = "Form",
            accentTail = "Schemas",
            subtitle   = "Author the dynamic forms kinfolk fill out.",
            trailing   = {
                PrimaryButton(
                    label = "New schema",
                    // FIX: route through the non-blank NEW_SCHEMA_ID sentinel instead of ""
                    // so the create-new editor route survives the hash round-trip and the
                    // editor stops bouncing back to this list (the reported flicker bug).
                    onClick = { onOpenEditor(NEW_SCHEMA_ID) },
                    leading = {
                        Icon(
                            Lucide.Plus,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = c.background,
                        )
                    },
                )
            },
        )
        Spacer(Modifier.height(20.dp))

        // Fail-loud: surface a list-load failure as a persistent error banner with a
        // retry, never a silent empty list. Surfaced above the panel so it is unmissable.
        loadError?.let { msg ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load schemas",
                icon  = Lucide.TriangleAlert,
                trailing = { GhostButton(label = "Retry", onClick = { scope.launch { reload() } }) },
            ) {
                Text(
                    "listFormSchemas failed: $msg",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
            Spacer(Modifier.height(16.dp))
        }

        DenPanel(
            title    = "All schemas",
            subtitle = "Tap a row to open it in the editor. The editor owns create, edit, save, and delete.",
            trailing = {
                if (!loading && loadError == null && sorted.isNotEmpty()) {
                    // Row-count chip reflecting the visible (filtered) count.
                    AuntieChip(
                        label = "${visible.size} schemas",
                        tone  = AuntieChipTone.Neutral,
                        mono  = true,
                    )
                }
            },
        ) {
            when {
                loading -> EmptyHint("Loading schemas…")
                loadError != null -> EmptyHint("Schemas unavailable while the load is failing.", error = true)
                sorted.isEmpty() -> EmptyHint("No schemas yet. Click New schema to create one.")
                else -> {
                    // Search row: filter the loaded schemas by name or id.
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(bottom = dims.space3),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space3),
                    ) {
                        AuntieSearchField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = "Filter schemas by name or id…",
                            leadingIcon = Lucide.Search,
                            onClear = { query = "" },
                            modifier = Modifier.weight(1f),
                        )
                    }

                    // #10/#17: card list (the old sortable table is retired). Tap a card
                    // to open the editor; the trash affordance reveals on hover.
                    Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                        visible.forEach { row ->
                            SchemaRow(
                                row = row,
                                onOpenEditor = onOpenEditor,
                                onDelete = { pendingDelete = row },
                            )
                        }
                    }

                    Spacer(Modifier.height(16.dp))
                    GhostButton(label = "Reload", onClick = { scope.launch { reload() } })
                }
            }
        }
    }

    // Per-row delete confirm. Shown over the page; calls the deployed
    // deleteFormSchema callable on confirm. Names the real schema so the operator
    // confirms the right one. Fail-loud handling lives in confirmDelete().
    pendingDelete?.let { target ->
        AuntieDialog(
            visible = true,
            title = "Delete this form schema?",
            hint = "${target.name.ifBlank { target.id }} (v${target.version}). This cannot be undone.",
            onDismiss = { if (!deleting) pendingDelete = null },
            maxWidth = 480.dp,
            closeIcon = Lucide.X,
            footer = {
                GhostButton(
                    label = "Cancel",
                    onClick = { pendingDelete = null },
                    enabled = !deleting,
                )
                PrimaryButton(
                    label = if (deleting) "Deleting..." else "Delete schema",
                    onClick = { scope.launch { confirmDelete(target) } },
                    enabled = !deleting,
                    loading = deleting,
                    leading = {
                        Icon(
                            Lucide.Trash2,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                            tint = c.background,
                        )
                    },
                )
            },
        ) {
            Text(
                "Schema id: ${target.id}",
                style = AuntieTheme.typography.mono,
                color = c.textDim,
            )
        }
    }
}

@Composable
private fun SchemaRow(
    row: FormSchemaSummary,
    onOpenEditor: (schemaId: String) -> Unit,
    onDelete: () -> Unit,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    // #10/#17: a card (was a table row). Rounded surface + a hairline that warms on hover.
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (hovered) c.surface2 else c.surfaceGlass)
            .border(
                AuntieTheme.dims.borderHairline,
                if (hovered) c.primary else c.border,
                RoundedCornerShape(14.dp),
            )
            .clickable(interactionSource = interaction, indication = null) { onOpenEditor(row.id) }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text  = row.name.ifBlank { row.id },
                style = AuntieTheme.typography.titleMedium,
                color = if (row.name.isBlank()) c.textDim else c.textPrimary,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text  = row.id,
                style = AuntieTheme.typography.labelSmall.copy(fontFamily = AuntieTheme.typography.mono.fontFamily),
                color = c.textFaint,
            )
            Spacer(Modifier.height(6.dp))
            // Meta line: version, updated date, updated by - blank parts dropped.
            val meta = listOf(
                "v${row.version}",
                row.updatedAt.takeIf { it.isNotBlank() },
                row.updatedBy.takeIf { it.isNotBlank() }?.let { "by $it" },
            ).filterNotNull().joinToString("  ·  ")
            Text(text = meta, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        // Hover-revealed per-row delete affordance. Live: it opens the confirm
        // dialog, which calls the deployed deleteFormSchema callable (the same path
        // the editor uses). The icon button has its own click, so the row's open-
        // editor click never fires when deleting.
        Box(modifier = Modifier.size(44.dp), contentAlignment = Alignment.CenterEnd) {
            if (hovered) {
                AuntieIconButton(
                    icon = Lucide.Trash2,
                    contentDescription = "Delete schema",
                    onClick = onDelete,
                    destructive = true,
                    revealOnHover = true,
                    size = 32.dp,
                )
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.HeaderCell(
    label: String,
    col: SortCol,
    currentSort: SortCol,
    asc: Boolean,
    weight: Float,
    onClick: (SortCol) -> Unit,
) {
    val c = AuntieTheme.colors
    val isOn = col == currentSort
    Row(
        modifier = Modifier
            .weight(weight)
            .clickable { onClick(col) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text       = label.uppercase(),
            style      = AuntieTheme.typography.labelSmall.copy(fontFamily = AuntieTheme.typography.mono.fontFamily),
            fontWeight = FontWeight.SemiBold,
            color      = if (isOn) c.primary else c.textDim,
        )
        Icon(
            imageVector        = Lucide.ChevronDown,
            contentDescription = null,
            tint               = if (isOn) c.primary else c.textFaint,
            modifier           = Modifier
                .size(12.dp)
                .rotate(if (isOn && !asc) 180f else 0f),
        )
    }
}
