package com.tribetails.auntieos.ui.admin.formschemas

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.FormSchemaSummary
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Den-redesign Form Schemas list ("The Den · Admin"), matched to
 * ui-ideas/auntieos-formschema-list-2026-05-27.html on the navy ground
 * (#755, 2026-09-12).
 *
 * The mock's head is the kit hero band with the clipboard tile before the
 * kicker and title and a PrimaryButton "New schema"; under it the mock's
 * controls row (the filter box and the count chip, both the mock's own
 * SUGGESTION items, built) and then the table: a hairline frame with the
 * sort strip ([SchemaSortHeader], issue #717) as its header row on navy-3 and
 * striped rows below. No DenPanel wraps any of it and no second title sits
 * over it; that panel-with-a-title shape was this screen's own invention.
 * Reload is the mock's footer ghost button. Load failures surface loudly via
 * [AuntieBanner] (fail-loud policy), never a silent empty list, and the
 * loading, failing and proven-empty states sit in the mock's centred box.
 *
 * A phone row stays ONE row per schema, not four literal columns: the row
 * carries the same four fields the web table lays out side by side (name,
 * version, updated, updated by), stacked, the way the design doc's Android
 * rule reads. The sort strip is the part of the mock's table that does have a
 * phone analogue, choosing what order the rows come in.
 *
 * The android ViewModel/repository contract is preserved exactly:
 * [AuntieRepository.listFormSchemas] returns Result<List<FormSchemaSummary>>, and
 * [onOpenEditor] takes a nullable schemaId (null = create-new) as before.
 *
 * Per-row delete is wired to the deployed `deleteFormSchema` callable (via
 * [AuntieRepository.deleteFormSchema]) behind a confirm dialog; the list reloads on
 * success and fails loud on error.
 */

/**
 * Pure client-side schema filter: narrows the already-sorted list by a
 * case-insensitive substring match on name or id. A blank query is a no-op so the
 * full list shows. No server search exists; this only filters what is loaded.
 * Mirrors the web FormSchemaListScreen filter. Unit-tested.
 */
internal fun formSchemaSearchFilter(
    schemas: List<FormSchemaSummary>,
    query: String,
): List<FormSchemaSummary> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return schemas
    return schemas.filter { it.name.lowercase().contains(q) || it.id.lowercase().contains(q) }
}

/**
 * Human-facing label for the row a delete confirm targets, never blank and never an
 * invented name: prefers the schema name, falls back to the raw id. Pure; unit-tested.
 */
internal fun formSchemaDeleteTargetLabel(schema: FormSchemaSummary): String =
    schema.name.ifBlank { schema.id }

/**
 * Fail-loud message for a failed row delete. Carries the underlying cause so the
 * banner is honest about what broke (no silent swallow). Pure; unit-tested.
 */
internal fun formSchemaDeleteErrorMessage(label: String, cause: Throwable): String {
    val reason = cause.message?.takeIf { it.isNotBlank() } ?: cause::class.simpleName ?: "Unknown error"
    return "Couldn't delete \"$label\": $reason"
}

internal enum class SortColumn { NAME, VERSION, UPDATED_AT, UPDATED_BY }

/**
 * The list order. Lifted out of the composable so it is unit-testable, the same
 * treatment [formSchemaSearchFilter] already has; the comparators are the ones
 * that were inline here, blank-handling fixed (see below).
 *
 * COMPARING `updatedAt` AS A STRING IS CORRECT, and that is a checked claim.
 * The sibling defect confirmed in production (PR #241) was this exact shape:
 * `invoices.date` / `payments.date` hold free text like "February 17, 2026", so
 * a byte compare ordered rows alphabetically by month name. This field is not
 * that. `formSchemas.updatedAt` is written ONLY by the `saveFormSchema`
 * callable, as `FieldValue.serverTimestamp()`, and reaches any client only
 * after `listFormSchemas#toIsoOrNull` has run `.toDate().toISOString()` over
 * it, so every non-blank value is a fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` UTC
 * instant, for which lexicographic order IS chronological order. The React
 * admin's `sortSchemas` rests on the same audit and is left comparing raw
 * strings for the same reason.
 *
 * A blank `updatedAt` or `updatedBy` sorts LAST in BOTH directions, matching
 * the React sibling's `sortSchemas`. Blank-last is handled as its own
 * comparison, independent of `descending`, rather than by reversing the whole
 * comparator: reversing would put a blank row FIRST on an ascending sort (""
 * precedes every real value), which is the bug this fixes. `sortColumn` /
 * `sortDescending` were dead state before this change, always UPDATED_AT/true
 * with no header to move them: the sort strip added to the screen below is
 * what actually calls this with every column and both directions now.
 *
 * `updatedByLabel` resolves a raw `updatedBy` uid to what the row actually
 * DISPLAYS (an admin's email, when [FormSchemaListScreen] has one from
 * `listBusinessAdmins`) before comparing, so the on-screen order matches what
 * the operator is looking at, the same reasoning the React sibling's
 * `resolveUpdatedBy` + `sortSchemas` use. Defaults to identity so the existing
 * uid-based tests below still hold.
 */
internal fun formSchemaSort(
    schemas: List<FormSchemaSummary>,
    column: SortColumn,
    descending: Boolean,
    updatedByLabel: (String) -> String = { it },
): List<FormSchemaSummary> {
    val dir = if (descending) -1 else 1

    fun blankLast(aBlank: Boolean, bBlank: Boolean): Int? =
        if (aBlank == bBlank) null else if (aBlank) 1 else -1

    val comparator = Comparator<FormSchemaSummary> { a, b ->
        when (column) {
            SortColumn.NAME -> a.name.lowercase().compareTo(b.name.lowercase()) * dir
            SortColumn.VERSION -> a.version.compareTo(b.version) * dir
            SortColumn.UPDATED_AT -> {
                blankLast(a.updatedAt.isBlank(), b.updatedAt.isBlank())
                    ?: (a.updatedAt.compareTo(b.updatedAt) * dir)
            }
            SortColumn.UPDATED_BY -> {
                val aLabel = updatedByLabel(a.updatedBy)
                val bLabel = updatedByLabel(b.updatedBy)
                blankLast(aLabel.isBlank(), bLabel.isBlank())
                    ?: (aLabel.lowercase().compareTo(bLabel.lowercase()) * dir)
            }
        }
    }
    return schemas.sortedWith(comparator)
}

@Composable
fun FormSchemaListScreen(
    onBack: () -> Unit,
    onOpenEditor: (schemaId: String?) -> Unit,
    repository: AuntieRepository = remember { AuntieOSApp.instance.repository },
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var schemas by remember { mutableStateOf<List<FormSchemaSummary>>(emptyList()) }
    // Fail-loud: a non-null error string renders an AuntieBanner(Error). Cleared on
    // every successful reload so a stale failure never lingers behind fresh data.
    var loadError by remember { mutableStateOf<String?>(null) }
    // Default: most-recently-updated first (matches the mock's shipped default).
    // The sort strip below calls onSort, where before #717 this state had no
    // header to move it and never changed.
    var sortColumn by remember { mutableStateOf(SortColumn.UPDATED_AT) }
    var sortDescending by remember { mutableStateOf(true) }
    // uid -> email, from listBusinessAdmins (issue #450's roster reader). Loaded
    // independently of the schemas list: a roster failure must not cost the
    // operator the schemas list, it only leaves Updated-by showing the raw uid.
    // Never chained into reload(). Mirrors the React sibling's `emailByUid`.
    var emailByUid by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // Local-only filter query; the loaded list is filtered client-side, never re-queried.
    var query by remember { mutableStateOf("") }
    // Row-delete: the schema awaiting confirmation (null = no dialog), an in-flight
    // delete id (disables affordances + shows progress), and a fail-loud error string.
    var deleteTarget by remember { mutableStateOf<FormSchemaSummary?>(null) }
    var deletingId by remember { mutableStateOf<String?>(null) }
    var deleteError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        loading = true
        repository.listFormSchemas()
            .onSuccess { schemas = it; loadError = null }
            .onFailure { loadError = it.message ?: it::class.simpleName ?: "Unknown error" }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    // See emailByUid's doc above: independent load, swallowed failure.
    LaunchedEffect(Unit) {
        repository.listBusinessAdmins()
            .onSuccess { roster ->
                emailByUid = roster.members.mapNotNull { m -> m.email?.let { m.uid to it } }.toMap()
            }
    }

    // Confirmed delete: route through the deployed deleteFormSchema callable, then
    // reload so the row disappears only after the server confirms. Fail-loud: a
    // failure sets deleteError (banner) and leaves the list intact.
    fun confirmDelete(schema: FormSchemaSummary) {
        deleteTarget = null
        deletingId = schema.id
        deleteError = null
        scope.launch {
            repository.deleteFormSchema(schema.id)
                .onSuccess {
                    deletingId = null
                    reload()
                }
                .onFailure {
                    deletingId = null
                    deleteError = formSchemaDeleteErrorMessage(formSchemaDeleteTargetLabel(schema), it)
                }
        }
    }

    val sorted = remember(schemas, sortColumn, sortDescending, emailByUid) {
        formSchemaSort(schemas, sortColumn, sortDescending) { uid -> emailByUid[uid] ?: uid }
    }

    // Filter the already-sorted list by name or id (always on). Empty query is a
    // no-op so the full list shows.
    val visible = remember(sorted, query) { formSchemaSearchFilter(sorted, query) }

    AuntieScreenScaffold(
        title = "Form Schemas",
        onBack = onBack,
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space4),
            contentPadding = PaddingValues(vertical = dims.space4),
        ) {
            item {
                DenScreenHeading(
                    kicker = "The Den · Admin",
                    title = "Form",
                    accentTail = "Schemas",
                    subtitle = "Author the dynamic forms kinfolk fill out.",
                    // The mock's `.hicon`: a 46dp tile on the teal-to-purple brand
                    // gradient with the clipboard glyph in cream. Decorative: it
                    // restates the title, so it announces nothing of its own.
                    leading = {
                        AuntieIconTile(
                            icon = Lucide.ClipboardList,
                            size = 46.dp,
                            background = Brush.linearGradient(c.tealToPurpleColors),
                        )
                    },
                    trailing = {
                        // The mock's PrimaryButton "New schema" with a plus. Under the
                        // title block: that is where the band puts the actions of a
                        // heading that has a leading tile.
                        PrimaryButton(
                            label = "New schema",
                            // Preserve the android create-new contract: null opens the
                            // editor in create mode.
                            onClick = { onOpenEditor(null) },
                            leading = {
                                Icon(
                                    imageVector = Lucide.Plus,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                        )
                    },
                )
            }

            // Fail-loud: surface a list-load failure as a persistent error banner with
            // a retry, never a silent empty list. Above the table so it is unmissable.
            loadError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't load schemas",
                        icon = Lucide.TriangleAlert,
                        trailing = {
                            GhostButton(label = "Retry", onClick = { scope.launch { reload() } })
                        },
                    ) {
                        Text(
                            text = "listFormSchemas failed: $msg",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }

            // Fail-loud: a row delete that failed surfaces its own dismissible error
            // banner so the operator knows the schema was NOT removed.
            deleteError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Delete failed",
                        icon = Lucide.TriangleAlert,
                        onDismiss = { deleteError = null },
                    ) {
                        Text(
                            text = msg,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }

            when {
                loading -> item { SchemaStateBox("Loading schemas…") }
                loadError != null -> item {
                    SchemaStateBox("Schemas unavailable while the load is failing.", error = true)
                }
                // "Tap", not the mock's "Click": the mock quotes the web screen and
                // this is the one place the word has to match the device.
                sorted.isEmpty() -> item { SchemaStateBox("No schemas yet. Tap New schema to create one.") }
                else -> {
                    item {
                        // The mock's `.controls`: the filter box taking the row and
                        // the count chip beside it, reflecting the visible count.
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(dims.space3),
                        ) {
                            AuntieSearchField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = "Filter schemas by name or id...",
                                leadingIcon = Lucide.Search,
                                onClear = { query = "" },
                                modifier = Modifier.weight(1f),
                            )
                            SchemaCountChip(count = visible.size)
                        }
                    }

                    item {
                        SchemaTable(
                            rows = visible,
                            emailByUid = emailByUid,
                            sortColumn = sortColumn,
                            sortDescending = sortDescending,
                            onSort = { column ->
                                if (sortColumn == column) {
                                    sortDescending = !sortDescending
                                } else {
                                    sortColumn = column
                                    sortDescending = false
                                }
                            },
                            deletingId = deletingId,
                            onOpen = { onOpenEditor(it.id) },
                            onRequestDelete = { deleteTarget = it },
                        )
                    }

                    // The mock's footer: Reload as a ghost button under the table.
                    item {
                        GhostButton(label = "Reload", onClick = { scope.launch { reload() } })
                    }
                }
            }
        }

        // Row-delete confirm. Reuses the editor's destructive-delete copy + warning
        // about kinfolk-side forms falling back to static fields, so deleting from
        // the list reads identically to deleting from the editor.
        deleteTarget?.let { target ->
            val label = formSchemaDeleteTargetLabel(target)
            AuntieDialog(
                visible = true,
                title = "Delete schema",
                onDismiss = { deleteTarget = null },
                footer = {
                    GhostButton(label = "Cancel", onClick = { deleteTarget = null })
                    GhostButton(
                        label = "Delete",
                        onClick = { confirmDelete(target) },
                    )
                },
            ) {
                Text(
                    "Delete \"$label\"? Kinfolk-side forms will fall back to static fields.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
            }
        }
    }
}

/** The mock's `.table` corner: it says 9px. */
private val SchemaTableShape = RoundedCornerShape(9.dp)

/** The mock's `.search`, `.countchip` and `.panel` corner: 13 and 12; one step. */
private val SchemaBoxShape = RoundedCornerShape(12.dp)

/**
 * The mock's `.panel`: the loading, failing and proven-empty states in one
 * centred box on the panel top, on a hairline, 26dp inside, in the dim text
 * (coral when it is a failure). A state, not a titled section, so not a
 * DenPanel.
 */
@Composable
private fun SchemaStateBox(text: String, error: Boolean = false) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(SchemaBoxShape)
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.border, SchemaBoxShape)
            .padding(26.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = AuntieTheme.typography.bodyMedium,
            color = if (error) c.error else c.textDim,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * The mock's `.countchip`: the visible count in 11sp mono on the navy-3 box
 * the search field wears, with a hairline. Not an AuntieStatusPill: it is a
 * count, not a state, and the mock draws it as a box rather than a capsule.
 */
@Composable
private fun SchemaCountChip(count: Int) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .clip(SchemaBoxShape)
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.border, SchemaBoxShape)
            .padding(horizontal = 13.dp, vertical = 10.dp),
    ) {
        Text(
            text = "$count schemas",
            style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 0.6.sp),
            color = c.textDim,
        )
    }
}

/**
 * The mock's `.table`: a hairline frame, the sort strip as the header row on
 * navy-3, then one striped [SchemaRow] per schema. The stripes are the panel
 * gradient's two stops laid out as alternate rows, the way the mock's
 * `.trow:nth-child` rules read.
 */
@Composable
private fun SchemaTable(
    rows: List<FormSchemaSummary>,
    emailByUid: Map<String, String>,
    sortColumn: SortColumn,
    sortDescending: Boolean,
    onSort: (SortColumn) -> Unit,
    deletingId: String?,
    onOpen: (FormSchemaSummary) -> Unit,
    onRequestDelete: (FormSchemaSummary) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(SchemaTableShape)
            .border(dims.borderHairline, c.border, SchemaTableShape),
    ) {
        SchemaSortHeader(
            sortColumn = sortColumn,
            sortDescending = sortDescending,
            onSort = onSort,
            modifier = Modifier
                .fillMaxWidth()
                .background(c.surface2)
                .padding(horizontal = 14.dp, vertical = 11.dp),
        )
        rows.forEachIndexed { idx, row ->
            SchemaRow(
                row = row,
                emailByUid = emailByUid,
                striped = idx % 2 == 1,
                deleting = deletingId == row.id,
                deleteEnabled = deletingId == null,
                onClick = { onOpen(row) },
                onRequestDelete = { onRequestDelete(row) },
            )
        }
    }
}

/**
 * One schema, the mock's `.trow` on a phone: the name in Fraunces over the
 * mono id, the updated line under them, the version in mono and the
 * hover-revealed trash on the right. Tapping the row opens the editor.
 *
 * The updated line goes through [formSchemaUpdatedMeta], NOT the raw
 * `updatedAt`. This line used to interpolate `row.updatedAt` directly and
 * printed the machine instant ("updated 2026-08-02T10:15:00.000Z by
 * e2e-admin") at the operator; the helper formats it as a LOCAL `MM-DD HH:mm`
 * and says `date unknown` out loud when the field is absent. This
 * intentionally does NOT match the web table's own Updated cell, which prints
 * the FULL local timestamp with the year in its own column: a bare "-" is
 * unambiguous under a column header naming the field, but ambiguous stacked
 * into one line with nothing to say what field it names, so this row keeps
 * `formSchemaUpdatedLabel`'s "date unknown" here instead of borrowing "-".
 *
 * `updatedBy` is resolved through `emailByUid` (from `listBusinessAdmins`,
 * loaded by [FormSchemaListScreen]) before it reaches the meta string, so a
 * known admin's uid reads as their email, matching the web table's Updated
 * by column; an unresolved value (a seed script name, staff who left) is
 * shown as-is.
 */
@Composable
private fun SchemaRow(
    row: FormSchemaSummary,
    emailByUid: Map<String, String>,
    striped: Boolean,
    deleting: Boolean,
    deleteEnabled: Boolean,
    onClick: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val name = row.name.ifBlank { row.id }
    val meta = if (deleting) {
        "Deleting..."
    } else {
        val by = emailByUid[row.updatedBy] ?: row.updatedBy
        formSchemaUpdatedMeta(row.updatedAt, by)
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (striped) c.surface2.copy(alpha = 0.5f) else c.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = name,
                    style = AuntieTheme.typography.titleLarge,
                    color = c.textPrimary,
                )
                Text(
                    text = row.id,
                    style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp),
                    color = c.textFaint,
                )
            }
            // The mock's `.ver`: mono 13 in the dim text, not a capsule.
            Text(
                text = "v${row.version}",
                style = AuntieTheme.typography.mono.copy(fontSize = 13.sp),
                color = c.textDim,
            )
            AuntieIconButton(
                icon = Lucide.Trash2,
                contentDescription = "Delete $name",
                onClick = onRequestDelete,
                destructive = true,
                revealOnHover = true,
                enabled = deleteEnabled,
                size = 32.dp,
            )
        }
        Text(
            text = meta,
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

/**
 * The strip that makes [SortColumn] / `sortDescending` in [FormSchemaListScreen]
 * reachable: four tappable mono labels, weighted 3 / 1 / 2 / 2 to match the web
 * table's Name / Version / Updated / Updated-by columns, the active one tinted
 * with a caret that flips for descending. Clicking the active column flips its
 * direction; clicking a different column selects it ascending, the same click
 * semantics the mock's header (and this screen's `onSort` callback) describe.
 *
 * A phone still renders [SchemaRow] as one row, not four literal columns
 * (see the design doc's Android rule), so this strip is the part of the mock's
 * table that DOES have a phone analogue: choosing what order the rows come in.
 * Since #755 it is the header row of [SchemaTable], on navy-3, the way the
 * mock's `.thead` sits over its striped rows.
 */
@Composable
private fun SchemaSortHeader(
    sortColumn: SortColumn,
    sortDescending: Boolean,
    onSort: (SortColumn) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3)) {
        SortHeaderCell("Name", SortColumn.NAME, sortColumn, sortDescending, onSort, Modifier.weight(3f))
        SortHeaderCell("Version", SortColumn.VERSION, sortColumn, sortDescending, onSort, Modifier.weight(1f))
        SortHeaderCell("Updated", SortColumn.UPDATED_AT, sortColumn, sortDescending, onSort, Modifier.weight(2f))
        SortHeaderCell("Updated by", SortColumn.UPDATED_BY, sortColumn, sortDescending, onSort, Modifier.weight(2f))
    }
}

@Composable
private fun SortHeaderCell(
    label: String,
    column: SortColumn,
    activeColumn: SortColumn,
    descending: Boolean,
    onSort: (SortColumn) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val active = activeColumn == column
    Row(
        modifier = modifier
            .clickable { onSort(column) }
            .padding(vertical = AuntieTheme.dims.space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space1),
    ) {
        Text(
            text = label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = if (active) c.primary else c.textDim,
        )
        if (active) {
            Icon(
                imageVector = if (descending) Lucide.ChevronDown else Lucide.ChevronUp,
                contentDescription = null,
                tint = c.primary,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}
