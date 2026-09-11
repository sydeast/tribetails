package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Phone
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.admin.householdLabel
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieFab
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.ui.components.ShimmerCard
import com.tribetails.auntieos.ui.components.SortMenu
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.util.SortOption

/**
 * Directory in the Den vocabulary, matched to its mock
 * (`ui-ideas/auntieos-directory-2026-05-27.html`, issue #755) so both platforms
 * read as one app: a mono kicker + serif heading with the Add CTA in its
 * trailing slot, a controls row of a segmented tab pill (with counts), the
 * search box and a Sort pill, then the household cards themselves. The phone
 * stacks the mock's card grid into a single column, but each card is the mock's
 * card: gradient glass on a hairline, the household's photo and name, its kin
 * as photo chips, contact glyphs and the last visit along the bottom, and a
 * badge in the corner for the exception (a new household, or a status other
 * than active).
 *
 * All data, search, status-filter, tag-filter and sort behavior is driven by
 * the existing [DirectoryViewModel] UiState. The last-visit footer and the
 * "New" badge come from the sessions the view model already reads; the web
 * Directory holds no sessions stream and draws neither yet.
 */
@OptIn(ExperimentalLayoutApi::class)
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
    // The Kin tab's sort sits here beside its search, the same way the Kinfolk
    // tab's sits on the view model beside its own filters.
    var kinSort by remember { mutableStateOf(SortOption.Default) }
    // #713: the Kin tab's tag filter sits here beside its search, the same way
    // the Kinfolk tab's sits on the view model beside its own. Kept separate
    // because household tags and Kin tags are separate vocabularies: carrying
    // one across would narrow the other list to nothing.
    var kinTag by remember { mutableStateOf(TAG_FILTER_ALL) }
    val kinfolkTagOptions = remember(state.allKinfolk) {
        directoryTagOptions(state.allKinfolk.map { it.tagNames() })
    }
    val kinTagOptions = remember(state.kinByKinfolkId) {
        directoryTagOptions(state.kinByKinfolkId.values.flatten().map { it.tagNames() })
    }
    // A Kin tag filter no loaded row can satisfy any more falls back to "All
    // tags". Deleting the tag being filtered by empties the option list, which
    // hides the dropdown; without this the list would sit on an empty result
    // with no control left to clear it. The Kinfolk tab's equivalent reset lives
    // on the view model, beside the state it is resetting.
    val activeKinTag = if (kinTagOptions.any { it.equals(kinTag, ignoreCase = true) }) kinTag else TAG_FILTER_ALL

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

    // The tab pill's counts, the mock's `.ct`: every household on file, and every
    // kin that is not archived (the same two numbers the web tabs show). Shown
    // only once the roster has landed, never fabricated as 0 while loading.
    val kinfolkCount = if (state.isLoading) null else state.allKinfolk.size
    val kinCount = if (state.isLoading) null else
        state.kinByKinfolkId.values.flatten().count { !it.status.equals("archived", ignoreCase = true) }

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
                    verticalArrangement = Arrangement.spacedBy(16.dp),
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

                    // ── Tabs: the mock's segmented pill, count beside each word ──
                    item {
                        SegmentedPicker(
                            options = listOf(0, 1),
                            selected = selectedTab,
                            onSelect = { selectedTab = it },
                            label = { index ->
                                if (index == 0) tabLabel("Kinfolk", kinfolkCount) else tabLabel("Kin", kinCount)
                            },
                        )
                    }

                    // ── Controls: search + Sort pill (+ status filter on the Kinfolk tab) ──
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
                                    SortMenu(
                                        selected = state.sortOption,
                                        onSelect = viewModel::setSortOption,
                                    )
                                }
                                AuntieDropdownField(
                                    value = state.statusFilter,
                                    options = listOf("Active", "Prospect", "Inactive", "Archived", "All"),
                                    onSelect = viewModel::setStatusFilter,
                                    displayText = { it },
                                    label = "Status",
                                    modifier = Modifier.width(160.dp),
                                )
                            } else {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    AuntieSearchField(
                                        value = kinSearch,
                                        onValueChange = { kinSearch = it },
                                        placeholder = "Search by name, species, or breed",
                                        onClear = { kinSearch = "" },
                                        modifier = Modifier.weight(1f),
                                    )
                                    SortMenu(
                                        selected = kinSort,
                                        onSelect = { kinSort = it },
                                        options = KIN_SORT_OPTIONS,
                                    )
                                }
                            }
                        }
                    }

                    // ── Tag filter (#713) ────────────────────────────────────────
                    //
                    // Rendered only when some row on THIS tab carries a tag. An
                    // empty picker on a tribe that has never tagged anyone is a
                    // dead control, and one shown while the roster is still
                    // loading would claim "no tags" about rows it has not read.
                    item {
                        val tagOptions = if (selectedTab == 0) kinfolkTagOptions else kinTagOptions
                        if (!state.isLoading && tagOptions.isNotEmpty()) {
                            AuntieDropdownField(
                                value = if (selectedTab == 0) state.tagFilter else activeKinTag,
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

                    // ── The cards ────────────────────────────────────────────────
                    if (selectedTab == 0) {
                        kinfolkSection(
                            state = state,
                            onKinfolkClick = onKinfolkClick,
                        )
                    } else {
                        kinSection(
                            state = state,
                            kinSearch = kinSearch,
                            kinTag = activeKinTag,
                            kinSort = kinSort,
                            onKinClick = onKinClick,
                        )
                    }
                }
            }

            // The heading's Add CTA scrolls away with the head; the FAB is the
            // phone's reach to it from anywhere in a long list. Not in the mock,
            // which is a desktop page with the CTA always in view.
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

/** The tab word with its count beside it, or the word alone while the count is unknown. */
internal fun tabLabel(word: String, count: Int?): String =
    if (count == null) word else "$word · $count"

/**
 * Kinfolk tab body: loading shimmer, a fail-loud error banner, an honest empty
 * state, or one [KinfolkDirectoryCard] per household.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.kinfolkSection(
    state: DirectoryUiState,
    onKinfolkClick: (String) -> Unit,
) {
    when {
        state.isLoading -> item {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                repeat(4) { ShimmerCard(height = 150) }
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

        else -> {
            val today = java.time.LocalDate.now().toString()
            items(state.displayedKinfolk) { kf ->
                val kin = state.kinByKinfolkId[kf.id].orEmpty()
                    .filter { !it.status.equals("archived", ignoreCase = true) }
                val kintaleCount = state.kintaleCountByKinfolkId[kf.id] ?: 0
                KinfolkDirectoryCard(
                    kf = kf,
                    kin = kin,
                    lastVisit = state.lastVisitByKinfolkId[kf.id],
                    kintaleCount = kintaleCount,
                    isNew = com.tribetails.auntieos.domain.isNewKinfolk(kf, kintaleCount, today),
                    onClick = { onKinfolkClick(kf.id) },
                )
            }
        }
    }
}

/**
 * Kin tab body. The Android VM exposes no separate Kin stream, so kin are derived
 * from the directory's [DirectoryUiState.kinByKinfolkId] map exactly as the prior
 * screen did, with the name / species / breed search, the tag filter and the
 * chosen sort. One [KinDirectoryCard] per pet.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.kinSection(
    state: DirectoryUiState,
    kinSearch: String,
    kinTag: String,
    kinSort: SortOption,
    onKinClick: (String) -> Unit,
) {
    // The search + tag + sort live in `filterKinDirectory`, so the rule a JUnit
    // test pins is the rule this list actually draws.
    val allKin = filterKinDirectory(state.kinByKinfolkId.values.flatten(), kinSearch, kinTag, kinSort)

    when {
        state.isLoading -> item {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                repeat(4) { ShimmerCard(height = 120) }
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
            AuntieEmptyState(
                icon = Lucide.Search,
                title = if (kinSearch.isBlank()) "No Kin on file yet"
                        else "No matches for \"$kinSearch\"",
                message = if (kinSearch.isBlank()) "Add Kin from a Kinfolk profile."
                          else "Try a different name, species, or breed.",
            )
        }

        else -> items(allKin) { kin ->
            val ownerName = state.allKinfolk.find { it.id == kin.kinfolkId }?.displayName.orEmpty()
            KinDirectoryCard(
                kin = kin,
                ownerName = ownerName,
                onClick = { onKinClick(kin.id) },
            )
        }
    }
}

/**
 * The mock's `.kcard` for a household: gradient glass on a hairline at 20dp,
 * the household's photo (or initials) beside its name and household label, the
 * active kin as photo chips, a hairline, then the contact glyphs at the left
 * and the last visit at the right. The corner badge is the exception only: a
 * new household wears "New" in the mock's orange, a household in any status
 * other than active wears that status. An active, settled household wears
 * nothing, which is what five of the mock's six cards draw.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KinfolkDirectoryCard(
    kf: Kinfolk,
    kin: List<Kin>,
    lastVisit: String?,
    kintaleCount: Int,
    isNew: Boolean,
    onClick: () -> Unit,
) {
    val c = AuntieTheme.colors
    val name = kf.displayName.ifBlank { "Unnamed" }
    val subtitle = householdLabel(kf.lastName).ifBlank { kin.map { it.name }.toOxfordList() }
    val badge = cardBadge(kf.status, isNew)

    DirectoryCardSurface(onClick = onClick) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(13.dp),
                // Leave the corner to the badge so a long name never runs under it.
                modifier = Modifier.padding(end = if (badge != null) 84.dp else 0.dp),
            ) {
                AuntieAvatar(
                    imageUrl = kf.profilePictureUrl.takeIf { it.isNotBlank() },
                    initials = initials(kf.displayName),
                    size = 50.dp,
                    shape = RoundedCornerShape(15.dp),
                    gradientSeed = kf.id.ifBlank { kf.displayName },
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = name,
                        style = AuntieTheme.typography.headlineSmall,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (subtitle.isNotBlank()) {
                        Text(
                            text = subtitle,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            if (kin.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    kin.forEach { k -> KinChip(k) }
                }
            }

            Hairline()

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (kf.phoneNumber.isNotBlank()) ContactLine(Lucide.Phone, kf.phoneNumber)
                    if (kf.email.isNotBlank()) ContactLine(Lucide.Mail, kf.email)
                }
                // The mock's `.last`: a mono label over a teal value. The last
                // completed visit when there is one; a household still onboarding
                // shows its KinTale count instead, as the mock's new card does.
                // Neither is invented: no visit and not new draws nothing here.
                when {
                    lastVisit != null -> LastVisit(label = "last visit", value = lastVisit)
                    isNew -> LastVisit(label = "onboarding", value = "$kintaleCount KinTales")
                }
            }
        }
        badge?.let { (label, tone) ->
            Box(modifier = Modifier.align(Alignment.TopEnd)) {
                // The mock's `.badge` is 9.5px on 4px 9px: the kit's compact
                // size (#780), where the default capsule sat larger.
                AuntieStatusPill(label = label, tone = tone, mono = true, compact = true)
            }
        }
    }
}

/**
 * The mock has no kin card; this one mirrors the household card's frame with
 * the pet's photo (or the paw on its gradient), the species and breed with the
 * age, and the household it lives in along the bottom. The badge is the same
 * exception rule as the household card's.
 */
@Composable
private fun KinDirectoryCard(kin: Kin, ownerName: String, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val detail = listOf(
        kin.species.ifBlank { null },
        kin.breed.ifBlank { null },
        kin.age.ifBlank { null }?.let { "$it yrs" },
    ).filterNotNull().joinToString(" · ")
    val badge = cardBadge(kin.status, isNew = false)

    DirectoryCardSurface(onClick = onClick) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(13.dp),
                modifier = Modifier.padding(end = if (badge != null) 84.dp else 0.dp),
            ) {
                AuntieAvatar(
                    imageUrl = kin.profilePictureUrl.takeIf { it.isNotBlank() },
                    glyph = Lucide.PawPrint,
                    size = 50.dp,
                    shape = RoundedCornerShape(15.dp),
                    gradientSeed = kin.id.ifBlank { kin.name },
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = kin.name.ifBlank { "Unnamed" },
                        style = AuntieTheme.typography.headlineSmall,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (detail.isNotBlank()) {
                        Text(
                            text = detail,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            if (ownerName.isNotBlank() || kin.sex.isNotBlank()) {
                Hairline()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = kin.sex,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                        modifier = Modifier.weight(1f),
                    )
                    if (ownerName.isNotBlank()) {
                        Text(
                            text = ownerName,
                            style = AuntieTheme.typography.labelSmall,
                            color = c.kinTeal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        badge?.let { (label, tone) ->
            Box(modifier = Modifier.align(Alignment.TopEnd)) {
                // The mock's `.badge` is 9.5px on 4px 9px: the kit's compact
                // size (#780), where the default capsule sat larger.
                AuntieStatusPill(label = label, tone = tone, mono = true, compact = true)
            }
        }
    }
}

/**
 * The card's frame: the kit's panel glass ([GlassSurface], the twin of
 * `.den-panel`) at the mock's 20dp radius and 18dp inset, tappable. The content
 * sits in a [Box] so a card can pin its badge to the top-right corner.
 */
@Composable
private fun DirectoryCardSurface(
    onClick: () -> Unit,
    content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    GlassSurface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
        cornerRadius = 20.dp,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            content = content,
        )
    }
}

/**
 * The mock's `.kin span`: a surface capsule on a hairline, the pet's own photo
 * in a framed circle (the paw on its gradient when it has none), then the name.
 */
@Composable
private fun KinChip(kin: Kin) {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
            .padding(start = 5.dp, top = 4.dp, end = 11.dp, bottom = 4.dp),
    ) {
        AuntieAvatar(
            imageUrl = kin.profilePictureUrl.takeIf { it.isNotBlank() },
            glyph = Lucide.PawPrint,
            size = 26.dp,
            gradientSeed = kin.id.ifBlank { kin.name },
        )
        Text(
            text = kin.name.ifBlank { "Unnamed" },
            style = AuntieTheme.typography.labelMedium,
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The mock's `.krow` top edge: a soft hairline across the card above the footer. */
@Composable
private fun Hairline() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(AuntieTheme.dims.borderHairline)
            .background(AuntieTheme.colors.borderSoft),
    )
}

/** The mock's `.krow .contact`: a dim glyph, with the value it stands for beside it. */
@Composable
private fun ContactLine(icon: androidx.compose.ui.graphics.vector.ImageVector, value: String) {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = c.textDim,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = value,
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The mock's `.last`: a mono label, then the value in teal beneath it, right-aligned. */
@Composable
private fun LastVisit(label: String, value: String) {
    val c = AuntieTheme.colors
    Column(horizontalAlignment = Alignment.End) {
        Text(
            text = label,
            style = AuntieTheme.typography.mono.copy(fontSize = 10.sp),
            color = c.textDim,
        )
        Text(
            text = value,
            style = AuntieTheme.typography.mono.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = c.kinTeal,
        )
    }
}

/**
 * What the corner badge says, if anything. "New" wins, in the mock's orange
 * (`.badge.new`); otherwise a status that is not the settled default wears its
 * own word and tone; an active household wears nothing. Pure; tested.
 */
internal fun cardBadge(status: String, isNew: Boolean): Pair<String, AuntieStatusTone>? {
    if (isNew) return "New" to AuntieStatusTone.Orange
    val s = status.trim().lowercase()
    if (s.isEmpty() || s == "active") return null
    val tone = when (s) {
        "prospect" -> AuntieStatusTone.Teal
        "inactive" -> AuntieStatusTone.Muted
        "archived" -> AuntieStatusTone.Warning
        else -> AuntieStatusTone.Neutral
    }
    return s to tone
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
