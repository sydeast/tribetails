package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Bringing the repo's notification templates into Firestore, from the phone.
 *
 * Issue #468. The operator ruled out `seed:notif-templates`, so this and the
 * React admin's import view are the only two routes the corpus has. A
 * notification whose template document is missing does not degrade quietly:
 * the channel sender throws and no email is delivered.
 *
 * The plan runs first and writes nothing. A template whose stored copy differs
 * from the repo copy is left alone unless the operator ticks it, so an import
 * cannot replace wording someone edited in the Bank. Matches the web view's
 * behaviour and its wording deliberately: an operator who learns the rule on
 * one surface should not have to learn it again on the other.
 */

/** The plan headline, as a sentence. Pure, so the JVM suite can read it. */
internal fun importPlanHeadline(report: TemplateRepository.ImportReport): String {
    val writes = plannedWriteCount(report)
    if (writes == 0 && report.refused.isEmpty()) {
        return "Every template on file already matches the repo. There is nothing to import."
    }
    val parts = buildList {
        report.counts["create"]?.takeIf { it > 0 }?.let { add("$it to create") }
        report.counts["overwrite"]?.takeIf { it > 0 }?.let { add("$it to replace") }
        report.counts["unchanged"]?.takeIf { it > 0 }?.let { add("$it already matching") }
        report.counts["skipped"]?.takeIf { it > 0 }?.let { add("$it differing and left alone") }
        report.counts["blocked"]?.takeIf { it > 0 }?.let { add("$it refused") }
    }
    val plural = if (writes == 1) "" else "s"
    return "${parts.joinToString(", ")}. Importing writes $writes document$plural."
}

/** How many documents the plan would write if applied as it stands. Pure. */
internal fun plannedWriteCount(report: TemplateRepository.ImportReport): Int =
    report.rows.sumOf { row ->
        row.channels.count { it.outcome == "create" || it.outcome == "overwrite" }
    }

/** One line summarising a template for the report list. Pure; mirrors the web copy. */
internal fun importRowSummary(row: TemplateRepository.ImportRow): String {
    if (row.blocked) return "Refused"
    val outcomes = row.channels.map { it.outcome }
    return when {
        outcomes.isNotEmpty() && outcomes.all { it == "unchanged" } -> "Already matches the repo"
        outcomes.contains("skipped") -> "Differs, not selected for overwrite"
        outcomes.contains("overwrite") -> "Will replace the stored copy"
        else -> "New"
    }
}

/**
 * Why a refused row was refused, for the line beside "Refused", or null for any
 * other row. Pure; mirrors the web row (#892 review 2).
 */
internal fun importRowReason(row: TemplateRepository.ImportRow): String? =
    if (row.blocked && row.issues.isNotEmpty()) row.issues.joinToString(" ") else null

/**
 * Whether ticking this row means anything.
 *
 * A brand new template needs nobody's permission to be created, and one that
 * already matches has nothing to replace, so only a differing row gets a tick.
 */
internal fun offersOverwriteChoice(row: TemplateRepository.ImportRow): Boolean =
    row.differsFromRepo && !row.blocked

/** Standalone import screen, for direct navigation. */
@Composable
fun TemplateImportScreen(
    onBack: () -> Unit,
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    AuntieScreenScaffold(title = "Import templates", onBack = onBack) {
        TemplateImportBody(templateRepo)
    }
}

/** Import content without the outer scaffold (see [TemplateImportScreen]). */
@Composable
fun TemplateImportBody(
    templateRepo: TemplateRepository = remember { TemplateRepository() },
) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    var report by remember { mutableStateOf<TemplateRepository.ImportReport?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var importing by remember { mutableStateOf(false) }
    val overwrite: SnapshotStateList<String> = remember { mutableListOf<String>().toMutableStateList() }

    suspend fun plan() {
        loading = true
        error = null
        notice = null
        templateRepo.importSeedTemplates(dryRun = true)
            .onSuccess { report = it }
            .onFailure {
                report = null
                error = "Could not read the import plan: ${it.message ?: "request failed"}"
            }
        loading = false
    }

    LaunchedEffect(Unit) { plan() }

    fun runImport() {
        if (importing) return
        importing = true
        error = null
        scope.launch {
            templateRepo.importSeedTemplates(dryRun = false, overwriteIds = overwrite.toList())
                .onSuccess { done ->
                    report = done
                    overwrite.clear()
                    notice = if (done.written == 0) {
                        "Nothing needed writing. Every template selected already matched the repo."
                    } else {
                        "Wrote ${done.written} document${if (done.written == 1) "" else "s"}."
                    }
                }
                .onFailure {
                    error = "The import did not run: ${it.message ?: "request failed"}. Nothing was written."
                }
            importing = false
        }
    }

    val current = report
    val writeCount = current?.let { plannedWriteCount(it) } ?: 0

    LazyColumn(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 16.dp),
    ) {
        item {
            DenScreenHeading(
                kicker = "The Den · Admin",
                title = "Import",
                accentTail = "templates.",
                subtitle = "Load the notification templates committed to the repo into Firestore. " +
                    "Nothing is written until you press Import.",
            )
        }

        error?.let { message ->
            item {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Import problem",
                    modifier = Modifier.fillMaxWidth(),
                    onDismiss = { error = null },
                    body = { Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
                )
            }
        }

        notice?.let { message ->
            item {
                AuntieBanner(
                    tone = AuntieBannerTone.Success,
                    title = "Import finished",
                    modifier = Modifier.fillMaxWidth(),
                    onDismiss = { notice = null },
                    body = { Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
                )
            }
        }

        if (loading) {
            item { Text("Working out what the import would change.", color = c.textDim) }
        } else if (current == null) {
            item { Text("No plan to show. Try again.", color = c.textDim) }
        } else {
            item {
                Text(
                    importPlanHeadline(current),
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }

            if (current.needsOverwriteChoice.isNotEmpty()) {
                item {
                    val n = current.needsOverwriteChoice.size
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "Some stored templates differ from the repo",
                        modifier = Modifier.fillMaxWidth(),
                        body = {
                            Text(
                                "$n template${if (n == 1) " has" else "s have"} been edited since they " +
                                    "were last imported, or were never imported from this corpus. They " +
                                    "are left alone unless you tick them below.",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        },
                    )
                }
            }

            if (current.refused.isNotEmpty()) {
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Refused, and not importable as written",
                        modifier = Modifier.fillMaxWidth(),
                        body = {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                current.refused.forEach { (id, reason) ->
                                    Text(
                                        "$id: $reason",
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                }
                            }
                        },
                    )
                }
            }

            items(current.rows, key = { it.templateId }) { row ->
                ImportRowCard(
                    row = row,
                    checked = row.templateId in overwrite,
                    onToggle = {
                        if (row.templateId in overwrite) overwrite.remove(row.templateId)
                        else overwrite.add(row.templateId)
                    },
                )
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    GhostButton(
                        label = "Re-check",
                        onClick = { scope.launch { plan() } },
                        modifier = Modifier.weight(1f),
                    )
                    PrimaryButton(
                        label = "Import $writeCount document${if (writeCount == 1) "" else "s"}",
                        onClick = { runImport() },
                        enabled = writeCount > 0 && !importing,
                        loading = importing,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun ImportRowCard(
    row: TemplateRepository.ImportRow,
    checked: Boolean,
    onToggle: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(row.templateId, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            Text(
                importRowSummary(row),
                style = AuntieTheme.typography.bodySmall,
                color = if (row.blocked) c.error else c.textDim,
            )
        }

        importRowReason(row)?.let { reason ->
            Text(reason, style = AuntieTheme.typography.bodySmall, color = c.error)
        }

        row.aliasOf?.let { canonical ->
            Text(
                "A retired key. Live sends now go through $canonical, and this copy is kept so an " +
                    "older binding pointing here still finds something.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }

        row.channels.forEach { channel ->
            Text(
                buildString {
                    append(channel.channel)
                    append(": ")
                    append(channel.outcome)
                    if (channel.notes.isNotEmpty()) {
                        append(". ")
                        append(channel.notes.joinToString(" "))
                    }
                },
                style = AuntieTheme.typography.bodySmall,
                color = if (channel.outcome == "blocked") c.error else c.textDim,
            )
        }

        if (offersOverwriteChoice(row)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AuntieCheckbox(checked = checked, onCheckedChange = { onToggle() })
                Text(
                    "Replace the stored copy with the repo wording",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
            }
        }
    }
}
