package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Workflow
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.failingKeysWithRepoCopy
import com.tribetails.auntieos.web.data.keysAwaitingImport
import com.tribetails.auntieos.web.data.keysFailingOnSend
import com.tribetails.auntieos.web.data.resolvedTemplateMissing
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieNoteCallout
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import kotlinx.coroutines.launch

/**
 * Template Routing on the desktop console, the shape web (`TemplateAssignments.tsx`)
 * and Android (`ui/admin/TemplateAssignmentScreen.kt`) moved to in #382 and #384
 * (#1739).
 *
 * WHAT THIS SCREEN SHOWS. It used to list the `notificationTemplateBindings`
 * collection, and on a business with no overrides that read "No bindings yet",
 * which the operator rightly called false: routing happens by NAME. The server
 * looks for a binding for a catalog key and, finding none, sends the template of
 * the same name. A binding is an OVERRIDE on a system that already works. So the
 * list is the routing table from `listCatalogKeys`: every notification, the
 * template it sends right now, and why.
 *
 * THE NOTIFICATION IS NEVER TYPED. The old Add Binding dialog took the catalog key
 * as free text (`e.g. kincare.booking.confirm`), and a misspelled key wrote a
 * binding nothing reads; the server now refuses an unknown key, but the operator
 * should never be asked to spell one. Every editable row comes from the table, and
 * its Override / Change override action opens the editor for that notification.
 *
 * Two limits stated rather than implied, matching web and Android: an override
 * changes the EMAIL template only, and the binding's audience is stored and read
 * by no sender.
 */

// Verbatim audience list from source (kinfolk, auntie, admin, guest). Single-select,
// nullable: clicking the selected one clears it back to null.
private val AUDIENCES = listOf("kinfolk", "auntie", "admin", "guest")

/**
 * The "Trigger:" echo only renders for a GENUINE override: the stored triggerKey is
 * present, non-blank, AND differs from the catalogKey. The server (MyTribe
 * assignTemplate) defaults a blank triggerKey to the catalogKey, so this guard keeps
 * an echo from firing on every binding. Pure, so it is unit-tested directly (mirrors
 * the Android helper).
 */
internal fun genuineTriggerOverride(triggerKey: String?, catalogKey: String): String? =
    triggerKey?.takeIf { it.isNotBlank() && it != catalogKey }

/** The row being edited: the routing row, plus its binding when it already has one. */
internal data class RoutingEditTarget(
    val row: CatalogKeyRow,
    val binding: TemplateService.TemplateBinding?,
)

/**
 * Standalone Template Routing screen. Kept for the desktop screenshot harness;
 * the merged two-tab [TemplatesScreen] renders [TemplateAssignmentBody] directly
 * inside its shared scaffold.
 */
@Composable
fun TemplateAssignmentScreen(
    templateService: TemplateService = remember { TemplateService() },
) {
    ScreenScaffold { TemplateAssignmentBody(templateService) }
}

/**
 * Template Routing content WITHOUT the outer [ScreenScaffold]. Renders inside
 * either the standalone screen above or the merged [TemplatesScreen]'s scaffold.
 */
@Composable
fun TemplateAssignmentBody(
    templateService: TemplateService = remember { TemplateService() },
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()
    var bindings by remember { mutableStateOf<List<TemplateService.TemplateBinding>>(emptyList()) }
    var templates by remember { mutableStateOf<List<TemplateService.EmailTemplate>>(emptyList()) }
    // The routing table itself. It comes from listCatalogKeys, so a bindings
    // failure cannot make it wrong; it only costs the audience line and the
    // editor's starting values.
    var catalogRows by remember { mutableStateOf<List<CatalogKeyRow>>(emptyList()) }
    var catalogError by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    // Separate read-error channels, so a bindings failure and a templates failure
    // are never conflated and a recovered call drops its own stale banner.
    var bindingsError by remember { mutableStateOf<String?>(null) }
    var templatesError by remember { mutableStateOf<String?>(null) }
    // Write-path error from assignTemplate / unassignTemplate, loud and dismissable.
    var saveError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<RoutingEditTarget?>(null) }
    // Client-side search over the loaded routing table. Pure in-memory filter.
    var query by remember { mutableStateOf("") }

    suspend fun reload() {
        loading = true
        bindingsError = null
        templatesError = null
        catalogError = null
        when (val r = templateService.listBindings()) {
            is WriteResult.Ok -> bindings = r.value
            is WriteResult.Err -> bindingsError = r.message
        }
        when (val r = templateService.listTemplates()) {
            is WriteResult.Ok -> templates = r.value
            is WriteResult.Err -> templatesError = r.message
        }
        when (val r = templateService.listCatalogKeyRows()) {
            is WriteResult.Ok -> catalogRows = r.value
            is WriteResult.Err -> catalogError = r.message
        }
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    val bindingByKey = bindings.associateBy { it.catalogKey }
    // #1592: the operator reads names, never a template id or a catalog key.
    val templateNames = templates.associate { it.templateId to bankTemplateName(it) }
    val bankIds = templates.map { it.templateId }.toSet()
    val bankLoaded = !loading && templatesError == null && templates.isNotEmpty()
    val templatesMissing = !loading && templatesError == null && templates.isEmpty()
    val overrideCount = catalogRows.count(::isOverridden)

    Column(Modifier.fillMaxWidth()) {
        DenScreenHeading(
            kicker = "The Den · Admin",
            title = "Template",
            accentTail = "Routing.",
            subtitle = "Every notification already sends a template. An override points one at another.",
        )
        Spacer(Modifier.height(20.dp))

        // Fail-loud: surface each callable error inline rather than swallowing it.
        bindingsError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load overrides",
                icon = Lucide.Workflow,
                onDismiss = { bindingsError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "$msg What each notification sends below is still correct, but the audience on an override is not shown and the editor opens without it.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        templatesError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load templates",
                icon = Lucide.Workflow,
                onDismiss = { templatesError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "$msg Rows cannot name their templates until the bank loads, and an override cannot be saved.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        saveError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Save failed",
                icon = Lucide.Workflow,
                onDismiss = { saveError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
        }
        // Templates loaded but empty (no error): warn loudly, since the editor's
        // template picker would otherwise be an unselectable dead end.
        if (templatesMissing) {
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                title = "No email templates found",
                icon = Lucide.Workflow,
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "The Template Bank is empty, so no override can be saved until at least one template exists.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        // Without the catalog there is no routing table at all, which is a
        // different failure from the ones above.
        catalogError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Could not load the routing table",
                icon = Lucide.Workflow,
                onDismiss = { catalogError = null },
                modifier = Modifier.padding(bottom = dims.space3),
            ) {
                Text(
                    "$msg Nothing below is trustworthy until this loads.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        if (!loading && catalogError == null && catalogRows.isNotEmpty()) {
            val failing = keysFailingOnSend(catalogRows, bankIds, bankLoaded)
            val loadable = failingKeysWithRepoCopy(catalogRows, bankIds, bankLoaded)
            val awaiting = keysAwaitingImport(catalogRows, bankIds, bankLoaded)
            if (failing.isNotEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "${failing.size} ${if (failing.size == 1) "notification fails" else "notifications fail"} on the next send",
                    icon = Lucide.Workflow,
                    modifier = Modifier.padding(bottom = dims.space3),
                ) {
                    Text(
                        failingKeysLine(failing, loadable, catalogRows),
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            }
            if (awaiting.isNotEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "Not in the bank yet, still delivered",
                    icon = Lucide.Workflow,
                    modifier = Modifier.padding(bottom = dims.space3),
                ) {
                    Text(
                        awaitingImportLine(awaiting, catalogRows),
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            }
        }

        DenPanel(
            title = "What each notification sends today",
            subtitle = "Every notification, the template that renders it right now, and where that choice came from.",
            trailing = {
                if (!loading && catalogRows.isNotEmpty()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        AuntieStatusPill(label = "Override $overrideCount", tone = AuntieStatusTone.Success, showDot = true)
                        AuntieStatusPill(
                            label = "By name ${catalogRows.size - overrideCount}",
                            tone = AuntieStatusTone.Muted,
                            showDot = true,
                        )
                    }
                }
            },
        ) {
            when {
                loading -> EmptyHint("Loading the routing table…")
                catalogError != null -> EmptyHint("The routing table did not load.", error = true)
                catalogRows.isEmpty() -> EmptyHint(ROUTING_TABLE_EMPTY)
                else -> {
                    Text(routingSummary(catalogRows), style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                    Spacer(Modifier.height(dims.space3))
                    AuntieSearchField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = "Search by notification or template...",
                        onClear = { query = "" },
                        modifier = Modifier.fillMaxWidth().widthIn(min = 240.dp),
                    )
                    Spacer(Modifier.height(dims.space3))

                    val visible = filterRoutingRows(catalogRows, query, templateNames)
                    if (visible.isEmpty()) {
                        EmptyHint("No notifications match \"${query.trim()}\".")
                    } else {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(dims.space2),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            visible.forEach { row ->
                                val binding = bindingByKey[row.key]
                                RoutingRow(
                                    row = row,
                                    subtitle = routingRowSubtitle(
                                        row = row,
                                        binding = binding,
                                        namesById = templateNames,
                                        bankLoaded = bankLoaded,
                                        missing = failsOnSend(row, bankIds, bankLoaded),
                                        missingNote = missingTemplateNote(row, resolvedTemplateMissing(row, bankIds, bankLoaded)),
                                    ),
                                    onEdit = { selected = RoutingEditTarget(row, binding) },
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(dims.space4))
            AuntieNoteCallout(
                text = "An override changes the EMAIL template only. The text message and push notification keep their own wording, which you change in the template editor. Audience is stored with the override and no sender reads it, so it records intent and changes nothing.",
            )
        }
    }

    selected?.let { target ->
        OverrideEditorDialog(
            target = target,
            templates = templates,
            onDismiss = { selected = null },
            // AO-56: remove the override via unassignTemplate. Null when the key has
            // no binding yet, so the action only shows where there is one to remove.
            onUnassign = if (!target.row.bound) null else {
                {
                    scope.launch {
                        when (val r = templateService.unassignTemplate(target.row.key)) {
                            is WriteResult.Ok -> {
                                selected = null
                                saveError = null
                                reload()
                            }
                            is WriteResult.Err -> saveError = r.message
                        }
                    }
                }
            },
            onSave = { updated ->
                scope.launch {
                    when (
                        val r = templateService.assignTemplate(
                            catalogKey = updated.catalogKey,
                            templateId = updated.templateId,
                            audience = updated.audience,
                            triggerKey = updated.triggerKey,
                            active = updated.active,
                        )
                    ) {
                        is WriteResult.Ok -> {
                            selected = null
                            saveError = null
                            reload()
                        }
                        is WriteResult.Err -> saveError = r.message
                    }
                }
            },
        )
    }
}

/**
 * One notification in the routing table: its name is the title (#1592: never the
 * dotted key), what it sends and why sit in the subtitle ([routingRowSubtitle]),
 * and an OVERRIDE / BY NAME pill and the Override / Change override action trail.
 */
@Composable
private fun RoutingRow(
    row: CatalogKeyRow,
    subtitle: String,
    onEdit: () -> Unit,
) {
    val dims = AuntieTheme.dims
    AuntieEntityRow(
        title = catalogKeyName(row),
        subtitle = subtitle,
        leading = { AuntieIconTile(icon = Lucide.Workflow, tone = AuntieStatusTone.Purple, size = 38.dp) },
        trailing = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                AuntieStatusPill(
                    label = if (isOverridden(row)) "OVERRIDE" else "BY NAME",
                    tone = if (isOverridden(row)) AuntieStatusTone.Success else AuntieStatusTone.Muted,
                    mono = true,
                )
                GhostButton(label = routingActionLabel(row), onClick = onEdit)
            }
        },
        showDivider = true,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OverrideEditorDialog(
    target: RoutingEditTarget,
    templates: List<TemplateService.EmailTemplate>,
    onDismiss: () -> Unit,
    onSave: (TemplateService.TemplateBinding) -> Unit,
    // AO-56: only where a binding exists. Null when the notification routes by name.
    onUnassign: (() -> Unit)? = null,
) {
    val row = target.row
    val binding = target.binding
    // Seeded from what the notification sends TODAY rather than from blank, so
    // opening a by-name row and saving records the template it already uses.
    var templateId by remember(row.key) { mutableStateOf(binding?.templateId ?: row.resolvedTemplateId) }
    var audience by remember(row.key) { mutableStateOf(binding?.audience) }
    var triggerKey by remember(row.key) { mutableStateOf(binding?.triggerKey ?: "") }
    var active by remember(row.key) { mutableStateOf(binding?.active ?: true) }
    // Two-tap confirm for the destructive removal, rather than a second nested
    // dialog (two AuntieDialogs would fight over dismiss).
    var confirmingUnassign by remember(row.key) { mutableStateOf(false) }
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    AuntieDialog(
        visible = true,
        title = overrideDialogTitle(row),
        onDismiss = onDismiss,
        maxWidth = 560.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.Workflow, tone = AuntieStatusTone.Purple, size = 38.dp) },
        hint = OVERRIDE_DIALOG_HINT,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
            if (onUnassign != null) {
                GhostButton(
                    // First tap arms, second tap removes: a lightweight confirm on a
                    // change that alters what dispatch sends.
                    label = if (confirmingUnassign) "Confirm remove" else "Remove override",
                    onClick = { if (confirmingUnassign) onUnassign() else confirmingUnassign = true },
                    modifier = Modifier.weight(1f),
                )
            }
            PrimaryButton(
                label = "Save override",
                // The notification comes from the table, so only the template can be
                // unset. Save enables once one is chosen.
                enabled = templateId.isNotBlank(),
                onClick = {
                    onSave(
                        TemplateService.TemplateBinding(
                            catalogKey = row.key,
                            templateId = templateId,
                            audience = audience,
                            triggerKey = triggerKey.ifBlank { null },
                            active = active,
                        ),
                    )
                },
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        // The notification is never typed: it is the row the operator opened.
        AuntieFieldLabel(text = "Notification")
        Text(
            catalogKeyName(row),
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
            modifier = Modifier.padding(top = dims.space1, bottom = dims.space1),
        )
        AuntieNoteCallout(
            text = "The notification cannot be changed here. To route a different one, close this and open its row.",
        )

        // Template selector: one selectable chip per Template Bank doc, by name.
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Template")
            if (templates.isEmpty()) {
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "No templates to choose from") {
                    Text(
                        "No email templates loaded, so this override cannot be saved. Add a template in the Template Bank first.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textPrimary,
                    )
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space1)) {
                    templates.forEach { tpl ->
                        AuntieChip(
                            label = bankTemplateName(tpl),
                            secondaryLabel = tpl.category,
                            selected = tpl.templateId == templateId,
                            onClick = { templateId = tpl.templateId },
                            tone = AuntieChipTone.Orange,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }

        // Audience pills: single-select; clicking the selected one clears it (nullable).
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            AuntieFieldLabel(text = "Audience (stored, unused)")
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                AUDIENCES.forEach { a ->
                    val isSelected = a == audience
                    AuntieChip(
                        label = a,
                        selected = isSelected,
                        onClick = { audience = if (isSelected) null else a },
                        tone = AuntieChipTone.Orange,
                    )
                }
            }
        }

        BottomBorderField(
            value = triggerKey,
            onValueChange = { triggerKey = it },
            label = "Trigger Key (optional override)",
            modifier = Modifier.fillMaxWidth(),
        )

        // A paused override falls back to the name-matched default, which is what
        // the server does at send time.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            AuntieToggle(checked = active, onCheckedChange = { active = it })
            Text(
                if (active) "Active" else "Paused, sends the name-matched default",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
    }
}
