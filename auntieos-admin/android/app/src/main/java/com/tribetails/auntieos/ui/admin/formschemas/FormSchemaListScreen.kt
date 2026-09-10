package com.tribetails.auntieos.ui.admin.formschemas

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
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
import com.tribetails.auntieos.ui.components.AuntieDashedAddButton
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Den-redesign Form Schemas list ("The Den · Admin"), ported from the redesigned
 * web counterpart (web/.../admin/formschemas/FormSchemaListScreen.kt).
 *
 * A mono kicker + serif heading, a dashed "New schema" add affordance, and a glass
 * [DenPanel] holding a sort strip ([SchemaSortHeader], issue #717) over the schema
 * rows. Each row is an [AuntieEntityRow] showing the schema name, its id, and
 * updated metadata, with an [AuntieStatusPill] version tag. Load failures surface
 * loudly via [AuntieBanner] (fail-loud policy), never a silent empty list.
 *
 * The android ViewModel/repository contract is preserved exactly:
 * [AuntieRepository.listFormSchemas] returns Result<List<FormSchemaSummary>>, and
 * [onOpenEditor] takes a nullable schemaId (null = create-new) as before.
 *
 * The client-side search field and the visible-count chip are always on. Per-row
 * delete is wired to the deployed `deleteFormSchema` callable (via
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
    // Actually reachable now: the sort strip below calls setSortColumn/onSort,
    // where before this state had no header to move it and never changed.
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
                    trailing = {
                        AuntieDashedAddButton(
                            text = "New schema",
                            // Preserve the android create-new contract: null opens the
                            // editor in create mode.
                            onClick = { onOpenEditor(null) },
                            leadingIcon = Lucide.Plus,
                        )
                    },
                )
            }

            // Fail-loud: surface a list-load failure as a persistent error banner with
            // a retry, never a silent empty list. Surfaced above the panel so it is
            // unmissable.
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

            item {
                DenPanel(
                    title = "All schemas",
                    subtitle = "Tap a row to open it in the editor. The editor owns create, edit, save, and delete.",
                    modifier = Modifier.fillMaxWidth(),
                    trailing = {
                        if (!loading && loadError == null && sorted.isNotEmpty()) {
                            // Row-count chip reflecting the visible (filtered) count.
                            AuntieStatusPill(
                                label = "${visible.size} schemas",
                                tone = AuntieStatusTone.Neutral,
                                mono = true,
                            )
                        }
                    },
                ) {
                    when {
                        loading -> EmptyHint("Loading schemas…")
                        loadError != null -> EmptyHint(
                            "Schemas unavailable while the load is failing.",
                            error = true,
                        )
                        sorted.isEmpty() -> EmptyHint("No schemas yet. Tap New schema to create one.")
                        else -> {
                            // Client-side search over the loaded schemas (always on).
                            AuntieSearchField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = "Filter schemas by name or id...",
                                leadingIcon = Lucide.Search,
                                onClear = { query = "" },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(bottom = dims.space3),
                            )

                            // The sort strip: four tappable column labels, the active one
                            // tinted with a caret. This is what makes sortColumn /
                            // sortDescending (declared above) reachable at all; before this
                            // change nothing in the composable ever assigned them.
                            SchemaSortHeader(
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
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(bottom = dims.space2),
                            )

                            Column(
                                verticalArrangement = Arrangement.spacedBy(dims.space2),
                            ) {
                                visible.forEachIndexed { idx, row ->
                                    SchemaRow(
                                        row = row,
                                        emailByUid = emailByUid,
                                        showDivider = idx < visible.lastIndex,
                                        deleting = deletingId == row.id,
                                        deleteEnabled = deletingId == null,
                                        onClick = { onOpenEditor(row.id) },
                                        onRequestDelete = { deleteTarget = row },
                                    )
                                }
                            }

                            Spacer(Modifier.height(dims.space4))
                            GhostButton(label = "Reload", onClick = { scope.launch { reload() } })
                        }
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

@Composable
private fun SchemaRow(
    row: FormSchemaSummary,
    emailByUid: Map<String, String>,
    showDivider: Boolean,
    deleting: Boolean,
    deleteEnabled: Boolean,
    onClick: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    // Fold the Updated / Updated-by fields into the row subtitle: a phone is one
    // column wide, so the web table's four columns collapse to this single-line
    // AuntieEntityRow, per the design doc's Android rule for the redesign (a
    // phone row carries the same FIELDS the web draws in columns, name/version/
    // updated/updated-by, all four are still here, just stacked into one line
    // instead of laid out side by side).
    //
    // Through [formSchemaUpdatedMeta], NOT the raw `updatedAt`. This line used
    // to interpolate `row.updatedAt` directly and printed the machine instant
    // ("updated 2026-08-02T10:15:00.000Z by e2e-admin") at the operator; the
    // helper formats it as a LOCAL `MM-DD HH:mm` and says `date unknown` out
    // loud when the field is absent. This intentionally does NOT match the web
    // table's own Updated cell, which now prints the FULL local timestamp with
    // the year in its own column: a bare "-" is unambiguous under a column
    // header naming the field, but ambiguous stacked into one subtitle line
    // with nothing to say what field it names, so this row keeps
    // `formSchemaUpdatedLabel`'s "date unknown" here instead of borrowing "-".
    //
    // `updatedBy` is resolved through `emailByUid` (from `listBusinessAdmins`,
    // loaded by [FormSchemaListScreen]) before it reaches the meta string, so a
    // known admin's uid reads as their email, matching the web table's Updated
    // by column; an unresolved value (a seed script name, staff who left) is
    // shown as-is.
    val subtitle = if (deleting) {
        "Deleting..."
    } else {
        val by = emailByUid[row.updatedBy] ?: row.updatedBy
        "${row.id}  ·  ${formSchemaUpdatedMeta(row.updatedAt, by)}"
    }

    AuntieEntityRow(
        title = row.name.ifBlank { row.id },
        subtitle = subtitle,
        showDivider = showDivider,
        onClick = onClick,
        trailing = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
            ) {
                AuntieStatusPill(
                    label = "v${row.version}",
                    tone = AuntieStatusTone.Teal,
                    mono = true,
                )
                AuntieIconButton(
                    icon = Lucide.Trash2,
                    contentDescription = "Delete ${row.name.ifBlank { row.id }}",
                    onClick = onRequestDelete,
                    destructive = true,
                    enabled = deleteEnabled,
                    size = 36.dp,
                )
            }
        },
    )
}

/**
 * The strip that makes [SortColumn] / `sortDescending` in [FormSchemaListScreen]
 * reachable: four tappable mono labels, weighted 3 / 1 / 2 / 2 to match the web
 * table's Name / Version / Updated / Updated-by columns, the active one tinted
 * with a caret that flips for descending. Clicking the active column flips its
 * direction; clicking a different column selects it ascending, the same click
 * semantics the mock's header (and this screen's `onSort` callback) describe.
 *
 * A phone still renders [SchemaRow] as one card, not four literal columns
 * (see the design doc's Android rule), so this strip is the part of the mock's
 * table that DOES have a phone analogue: choosing what order the cards come in.
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
