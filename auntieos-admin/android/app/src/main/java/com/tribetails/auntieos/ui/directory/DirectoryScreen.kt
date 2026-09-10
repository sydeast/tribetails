package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieFab
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieTabRow
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.GhostButton
import androidx.compose.runtime.LaunchedEffect
import com.tribetails.auntieos.ui.components.ShimmerCard
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Directory in the Den vocabulary, ported from the web DirectoryScreen so both
 * platforms read as one app: a mono kicker + serif heading, an Add CTA in the
 * heading trailing slot, a controls row of tabs + search (+ status filter on the
 * Kinfolk tab), and a glass [DenPanel] holding [AuntieEntityRow] identity rows
 * with [AuntieAvatar] leading and an [AuntieStatusPill] trailing. The phone
 * stacks the web's responsive card grid into a single vertical column of rows.
 *
 * All data, search, and status-filter behavior is driven by the existing
 * [DirectoryViewModel] UiState. Where the web shows extras the Android VM does
 * not provide (a sort menu backed by a sort field, gradient kin chips fed by a
 * separate Kin stream, last-visit / new badges), those are dropped rather than
 * faked, keeping the screen honest against its real contract.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DirectoryScreen(
    viewModel: DirectoryViewModel,
    onKinfolkClick: (String) -> Unit,
    onKinClick: (String) -> Unit,
    onAddKinfolk: () -> Unit
) {
    val state by viewModel.directoryState.collectAsState()
    var selectedTab by remember { mutableIntStateOf(0) }
    var kinSearch by remember { mutableStateOf("") }
    // #713: the Kin tab's tag filter sits here beside its search, the same way
    // the Kinfolk tab's sits on the view model beside its own. Kept separate
    // because household tags and Kin tags are separate vocabularies: carrying
    // one across would narrow the other list to nothing.
    var kinTag by remember { mutableStateOf(TAG_FILTER_ALL) }

    // #14: bulk portal-invite state + Toast feedback.
    val inviteBusy by viewModel.inviteBusy.collectAsState()
    val inviteMessage by viewModel.inviteMessage.collectAsState()
    val dirContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(inviteMessage) {
        inviteMessage?.let {
            android.widget.Toast.makeText(dirContext, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.clearInviteMessage()
        }
    }

    AuntieScreenScaffold(title = "Directory") {
        Box(modifier = Modifier.fillMaxSize()) {
            AuntiePullRefresh(
                isRefreshing = state.isLoading,
                onRefresh = { viewModel.loadDirectory() },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    // ── Editorial head: mono kicker + serif title + Add CTA ──────
                    item {
                        DenScreenHeading(
                            kicker = "The Den · Directory",
                            title = "Your",
                            accentTail = "kinfolk",
                            trailing = if (selectedTab == 0) {
                                {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        GhostButton(
                                            label = if (inviteBusy) "Inviting…" else "Invite all",
                                            enabled = !inviteBusy,
                                            onClick = { viewModel.inviteAllKinfolk() },
                                        )
                                        PrimaryButton(
                                            label = "Add kinfolk",
                                            onClick = onAddKinfolk,
                                            leading = {
                                                Icon(
                                                    imageVector = Lucide.Plus,
                                                    contentDescription = null,
                                                    tint = AuntieTheme.colors.background,
                                                    modifier = Modifier.size(16.dp),
                                                )
                                            },
                                        )
                                    }
                                }
                            } else {
                                null
                            },
                        )
                    }

                    // ── Tabs ─────────────────────────────────────────────────────
                    item {
                        AuntieTabRow(
                            selectedIndex = selectedTab,
                            tabs = listOf("Kinfolk", "Kin"),
                            onSelect = { selectedTab = it },
                        )
                    }

                    // ── Controls: search (+ status filter on the Kinfolk tab) ────
                    item {
                        if (selectedTab == 0) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                AuntieSearchField(
                                    value = state.searchQuery,
                                    onValueChange = viewModel::search,
                                    placeholder = "Search by name, phone, or email",
                                    onClear = { viewModel.search("") },
                                    modifier = Modifier.weight(1f),
                                )
                                AuntieDropdownField(
                                    value = state.statusFilter,
                                    options = listOf("Active", "Prospect", "Inactive", "Archived", "All"),
                                    onSelect = viewModel::setStatusFilter,
                                    displayText = { it },
                                    modifier = Modifier.width(120.dp),
                                )
                            }
                        } else {
                            AuntieSearchField(
                                value = kinSearch,
                                onValueChange = { kinSearch = it },
                                placeholder = "Search by name, species, or breed",
                                onClear = { kinSearch = "" },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }

                    // ── Tag filter (#713) ────────────────────────────────────────
                    //
                    // Rendered only when some row on THIS tab carries a tag. An
                    // empty picker on a tribe that has never tagged anyone is a
                    // dead control, and one shown while the roster is still
                    // loading would claim "no tags" about rows it has not read.
                    item {
                        val tagOptions = if (selectedTab == 0) {
                            directoryTagOptions(state.allKinfolk.map { it.tagNames() })
                        } else {
                            directoryTagOptions(
                                state.kinByKinfolkId.values.flatten().map { it.tagNames() },
                            )
                        }
                        if (!state.isLoading && tagOptions.isNotEmpty()) {
                            AuntieDropdownField(
                                value = if (selectedTab == 0) state.tagFilter else kinTag,
                                options = listOf(TAG_FILTER_ALL) + tagOptions,
                                onSelect = { picked ->
                                    if (selectedTab == 0) {
                                        viewModel.setTagFilter(picked)
                                    } else {
                                        kinTag = picked
                                    }
                                },
                                displayText = { name -> if (name == TAG_FILTER_ALL) "All tags" else name },
                                label = "Tag",
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }

                    // ── Content panel ────────────────────────────────────────────
                    if (selectedTab == 0) {
                        kinfolkSection(
                            state = state,
                            onKinfolkClick = onKinfolkClick,
                        )
                    } else {
                        kinSection(
                            state = state,
                            kinSearch = kinSearch,
                            kinTag = kinTag,
                            onKinClick = onKinClick,
                        )
                    }
                }
            }

            if (selectedTab == 0) {
                AuntieFab(
                    onClick = onAddKinfolk,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(16.dp),
                    containerColor = AuntieTheme.colors.kinfolkOrange,
                    contentColor = AuntieTheme.colors.background,
                ) {
                    Icon(Lucide.Plus, contentDescription = "Add Kinfolk")
                }
            }
        }
    }
}

/**
 * Kinfolk tab body: loading shimmer, a fail-loud error banner, an honest empty
 * state, or a [DenPanel] of [AuntieEntityRow]s. Each row carries a gradient
 * [AuntieAvatar], the household name, a kin summary (or contact) subtitle, and a
 * status pill, mirroring the web Kinfolk card's identity + status read.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.kinfolkSection(
    state: DirectoryUiState,
    onKinfolkClick: (String) -> Unit,
) {
    when {
        state.isLoading -> item {
            DenPanel(title = "Kinfolk") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    repeat(6) { ShimmerCard(height = 64) }
                }
            }
        }

        state.error != null -> item {
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't load Kinfolk",
            ) {
                Text(
                    text = state.error,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
            }
        }

        state.displayedKinfolk.isEmpty() -> item {
            DenPanel(title = "Kinfolk") {
                AuntieEmptyState(
                    icon = Lucide.Search,
                    title = if (state.searchQuery.isBlank()) "No Kinfolk on file yet"
                            else "No matches for \"${state.searchQuery}\"",
                    message = if (state.searchQuery.isBlank())
                                "Tap Add to create the first Kinfolk."
                              else
                                "Try a different name, the last 4 of a phone number, or part of an email.",
                )
            }
        }

        else -> item {
            val today = remember { java.time.LocalDate.now().toString() }
            DenPanel(title = "Kinfolk", subtitle = "${state.displayedKinfolk.size} on file") {
                Column {
                    state.displayedKinfolk.forEachIndexed { index, kf ->
                        val kinNames = state.kinByKinfolkId[kf.id].orEmpty().map { it.name }
                        // Stage 2 Step 2: per-card last-visit footer + "New" badge.
                        val lastVisit = state.lastVisitByKinfolkId[kf.id]
                        val kintaleCount = state.kintaleCountByKinfolkId[kf.id] ?: 0
                        val isNew = com.tribetails.auntieos.domain.isNewKinfolk(kf, kintaleCount, today)
                        AuntieEntityRow(
                            title = kf.displayName.ifBlank { "Unnamed" },
                            subtitle = kinfolkSubtitle(kf, kinNames, lastVisit),
                            leading = {
                                AuntieAvatar(
                                    imageUrl = kf.profilePictureUrl.takeIf { it.isNotBlank() },
                                    initials = initials(kf.displayName),
                                    size = 44.dp,
                                    gradientSeed = kf.id.ifBlank { kf.displayName },
                                )
                            },
                            trailing = {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    if (isNew) {
                                        AuntieStatusPill(label = "New", tone = AuntieStatusTone.Teal)
                                    }
                                    StatusPill(kf.status)
                                }
                            },
                            showDivider = index < state.displayedKinfolk.lastIndex,
                            onClick = { onKinfolkClick(kf.id) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Kin tab body. The Android VM exposes no separate Kin stream, so kin are derived
 * from the directory's [DirectoryUiState.kinByKinfolkId] map exactly as the prior
 * screen did, with the same name / species / breed search and alphabetical sort.
 * Each row shows a paw-glyph [AuntieAvatar], a species · breed detail subtitle,
 * and the owning household name.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.kinSection(
    state: DirectoryUiState,
    kinSearch: String,
    kinTag: String,
    onKinClick: (String) -> Unit,
) {
    // The search + tag + sort now live in `filterKinDirectory`, so the rule a
    // JUnit test pins is the rule this list actually draws.
    val allKin = filterKinDirectory(state.kinByKinfolkId.values.flatten(), kinSearch, kinTag)

    when {
        state.isLoading -> item {
            DenPanel(title = "Kin") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    repeat(6) { ShimmerCard(height = 64) }
                }
            }
        }

        state.error != null -> item {
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't load Kin",
            ) {
                Text(
                    text = state.error,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.error,
                )
            }
        }

        allKin.isEmpty() -> item {
            DenPanel(title = "Kin") {
                AuntieEmptyState(
                    icon = Lucide.Search,
                    title = if (kinSearch.isBlank()) "No Kin on file yet"
                            else "No matches for \"$kinSearch\"",
                    message = if (kinSearch.isBlank()) "Add Kin from a Kinfolk profile."
                              else "Try a different name, species, or breed.",
                )
            }
        }

        else -> item {
            DenPanel(title = "Kin", subtitle = "${allKin.size} on file") {
                Column {
                    allKin.forEachIndexed { index, kin ->
                        val ownerName = state.allKinfolk.find { it.id == kin.kinfolkId }?.displayName.orEmpty()
                        AuntieEntityRow(
                            title = kin.name.ifBlank { "Unnamed" },
                            subtitle = kinSubtitle(kin, ownerName),
                            leading = {
                                AuntieAvatar(
                                    imageUrl = null,
                                    glyph = Lucide.PawPrint,
                                    size = 44.dp,
                                    gradientSeed = kin.id.ifBlank { kin.name },
                                )
                            },
                            trailing = { StatusPill(kin.status) },
                            showDivider = index < allKin.lastIndex,
                            onClick = { onKinClick(kin.id) },
                        )
                    }
                }
            }
        }
    }
}

/** Status pill tone mapping shared by both tabs, matching the web StatusPill. */
@Composable
private fun StatusPill(status: String) {
    val tone = when (status.lowercase()) {
        "active" -> AuntieStatusTone.Success
        "prospect" -> AuntieStatusTone.Warning
        "inactive" -> AuntieStatusTone.Muted
        "archived" -> AuntieStatusTone.Warning
        "draft" -> AuntieStatusTone.Neutral
        else -> AuntieStatusTone.Neutral
    }
    AuntieStatusPill(
        label = status.lowercase(),
        tone = tone,
        showDot = true,
    )
}

/**
 * Kinfolk row subtitle: the kin list (else best contact line), with the last-visit
 * footer appended when known (directory.lastVisit). The footer is omitted entirely
 * when there is no completed visit on record (never fabricate "no visits").
 */
private fun kinfolkSubtitle(kf: Kinfolk, kinNames: List<String>, lastVisit: String?): String? {
    val head = when {
        kinNames.isNotEmpty() -> kinNames.toOxfordList()
        kf.phoneNumber.isNotBlank() -> kf.phoneNumber
        kf.email.isNotBlank() -> kf.email
        else -> null
    }
    val footer = lastVisit?.let { "Last visit $it" }
    return listOfNotNull(head, footer).joinToString(" · ").ifBlank { null }
}

/** Kin row subtitle: a "species · breed" detail line plus the owning household. */
private fun kinSubtitle(kin: Kin, ownerName: String): String? {
    val detail = listOfNotNull(
        kin.species.ifBlank { null },
        kin.breed.ifBlank { null },
    ).joinToString(" · ")
    return listOfNotNull(
        detail.ifBlank { null },
        ownerName.ifBlank { null },
    ).joinToString(" · ").ifBlank { null }
}

private fun initials(name: String): String {
    val parts = name.split(" ").filter { it.isNotBlank() }
    return when (parts.size) {
        0 -> "?"
        1 -> parts[0].take(2).uppercase()
        else -> (parts.first().first().toString() + parts.last().first().toString()).uppercase()
    }
}

private fun List<String>.toOxfordList(): String = when (size) {
    0 -> ""
    1 -> first()
    2 -> "${first()} & ${last()}"
    else -> "${dropLast(1).joinToString(", ")} & ${last()}"
}
