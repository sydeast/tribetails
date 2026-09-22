package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Phone
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.tribetails.auntieos.web.data.FirestoreAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.NO_EMERGENCY_CONTACT
import com.tribetails.auntieos.web.data.emergencyContactsOf
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.data.WriteResult
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.SortMenu
import com.tribetails.auntieos.web.screens.invoices.humanizeDate
import com.tribetails.auntieos.web.screens.isNewKinfolk
import com.tribetails.auntieos.web.screens.lastVisitByKinfolk
import com.tribetails.auntieos.web.util.SortOption
import com.tribetails.auntieos.web.util.householdLabel
import com.tribetails.auntieos.web.util.nowIso
import com.tribetails.auntieos.web.util.sortedByOption

/**
 * Sub-routes inside the Directory tab. The top-level [DirectoryScreen] keeps
 * its own back-stack so the tab can drill into a profile / form without
 * disturbing the side rail. Press a destination tab and you're back at [List].
 */
private sealed interface DirectoryRoute {
    data object List : DirectoryRoute
    data class Profile     (val kinfolkId: String) : DirectoryRoute
    data object NewKinfolk : DirectoryRoute
    data class EditKinfolk (val kinfolkId: String) : DirectoryRoute
    data class NewKin      (val kinfolkId: String) : DirectoryRoute
    data class ViewKin     (val kinfolkId: String, val kinId: String) : DirectoryRoute
    data class EditKin     (val kinfolkId: String, val kinId: String) : DirectoryRoute
    data class Household   (val kinfolkId: String) : DirectoryRoute
}

/** Card layout constants. Fixed height keeps the responsive grid uniform like
 *  the mockup's CSS grid (repeat(auto-fill, minmax(290px, 1fr))). */
private val GRID_MIN_CARD = 290.dp
private val GRID_GAP = 16.dp
private val CARD_HEIGHT = 196.dp

/**
 * @param initialKinfolkId when non-null, the Directory opens straight to that
 *        kinfolk's profile (global-search / external deep-link). If
 *        [initialKinId] is also set, it opens the kin editor under that kinfolk.
 * @param initialKinId optional kin to open under [initialKinfolkId].
 */
@Composable
fun DirectoryScreen(
    initialKinfolkId: String? = null,
    initialKinId: String? = null,
    onOpenTale: (sessionId: String) -> Unit = {},
) {
    // Seed the back-stack from a deep-link once per (kinfolkId, kinId) target.
    val initialRoute: DirectoryRoute = remember(initialKinfolkId, initialKinId) {
        when {
            initialKinfolkId != null && initialKinId != null ->
                DirectoryRoute.ViewKin(initialKinfolkId, initialKinId)
            initialKinfolkId != null ->
                DirectoryRoute.Profile(initialKinfolkId)
            else -> DirectoryRoute.List
        }
    }
    var route  by remember(initialRoute) { mutableStateOf(initialRoute) }
    var activeTab by remember { mutableStateOf("Kinfolk") }

    when (val r = route) {
        DirectoryRoute.List ->
            DirectoryListScreen(
                activeTab     = activeTab,
                onTabChange   = { activeTab = it; route = DirectoryRoute.List },
                onOpenKinfolk = { route = DirectoryRoute.Profile(it) },
                onAddKinfolk  = { route = DirectoryRoute.NewKinfolk },
                onEditKin     = { kinfolkId, kinId -> route = DirectoryRoute.EditKin(kinfolkId, kinId) },
            )

        is DirectoryRoute.Profile ->
            KinfolkProfileScreen(
                kinfolkId       = r.kinfolkId,
                onBack          = { route = DirectoryRoute.List },
                onEdit          = { route = DirectoryRoute.EditKinfolk(r.kinfolkId) },
                onAddKin        = { route = DirectoryRoute.NewKin(r.kinfolkId) },
                onViewKin       = { kinId -> route = DirectoryRoute.ViewKin(r.kinfolkId, kinId) },
                onOpenHousehold = { route = DirectoryRoute.Household(r.kinfolkId) },
                onOpenTale      = onOpenTale,
            )

        DirectoryRoute.NewKinfolk ->
            KinfolkEditScreen(
                kinfolkId  = null,
                onBack     = { route = DirectoryRoute.List },
                onSaved    = { newId -> route = DirectoryRoute.Profile(newId) },
                onArchived = { route = DirectoryRoute.List },
                // #829 review item 6: leaving Add after the household was created
                // but its contact did not save opens THAT household, which shows
                // No Emergency Contact, so the contact is added there instead of
                // the household being Added a second time.
                onLeftWithoutContact = { createdId -> route = DirectoryRoute.Profile(createdId) },
                // #907 review item 1(b): Add was answered `duplicateOf`. That household's
                // edit screen opens with what was typed filled in as unsaved changes.
                onDuplicate = { existingId -> route = DirectoryRoute.EditKinfolk(existingId) },
            )

        is DirectoryRoute.EditKinfolk ->
            KinfolkEditScreen(
                kinfolkId  = r.kinfolkId,
                onBack     = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onSaved    = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onArchived = { route = DirectoryRoute.List },
            )

        is DirectoryRoute.NewKin ->
            KinEditScreen(
                kinfolkId  = r.kinfolkId,
                kinId      = null,
                onBack     = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onSaved    = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onArchived = { route = DirectoryRoute.Profile(r.kinfolkId) },
            )

        is DirectoryRoute.ViewKin ->
            KinViewScreen(
                kinfolkId = r.kinfolkId,
                kinId     = r.kinId,
                onBack    = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onEdit    = { route = DirectoryRoute.EditKin(r.kinfolkId, r.kinId) },
            )

        is DirectoryRoute.EditKin ->
            KinEditScreen(
                kinfolkId  = r.kinfolkId,
                kinId      = r.kinId,
                onBack     = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onSaved    = { route = DirectoryRoute.Profile(r.kinfolkId) },
                onArchived = { route = DirectoryRoute.Profile(r.kinfolkId) },
            )

        is DirectoryRoute.Household ->
            HouseholdDataScreen(
                kinfolkId   = r.kinfolkId,
                kinfolkName = "", // Resolved inside the screen via Kinfolk stream
                onBack      = { route = DirectoryRoute.Profile(r.kinfolkId) },
            )
    }
}

@Composable
private fun DirectoryListScreen(
    activeTab: String,
    onTabChange: (String) -> Unit,
    onOpenKinfolk: (String) -> Unit,
    onAddKinfolk: () -> Unit,
    onEditKin: (kinfolkId: String, kinId: String) -> Unit,
) {
    val client = remember { FirestoreClient() }

    // Wire the (previously dead) DirectoryViewModel: it owns the Kinfolk stream,
    // the search query, and the sort option. The Kin tab reuses the same query
    // and sort, but its data comes from a single allKinStream() collected here
    // (AuntieDataSource exposes no Kin stream, so the screen owns that).
    val vm = remember { DirectoryViewModel(FirestoreAuntieDataSource(client)) }
    val uiState by vm.state.collectAsState()

    // #14: bulk "Invite all to portal". Loops every kinfolk with an email through
    // the inviteKinfolkToPortal callable (which itself skips already-claimed
    // households and missing emails), then reports a summary. Operator-initiated.
    val inviteScope = rememberReportingScope()
    var bulkInviting by remember { mutableStateOf(false) }
    var bulkToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    fun inviteAllKinfolk() {
        if (bulkInviting) return
        val all = (uiState.allKinfolk as? FirestoreResult.Data)?.value.orEmpty()
        val withEmail = all.filter { it.email.isNotBlank() }
        if (withEmail.isEmpty()) {
            bulkToast = "No kinfolk have an email on file" to ToastKind.Error
            return
        }
        bulkInviting = true
        inviteScope.launch {
            var sent = 0; var already = 0; var failed = 0
            for (kf in withEmail) {
                when (val r = client.inviteKinfolkToPortal(kf._id)) {
                    is WriteResult.Ok -> when (r.value.status) {
                        "sent" -> sent++
                        "already_active" -> already++
                        else -> failed++ // no_email shouldn't happen (filtered), count defensively
                    }
                    is WriteResult.Err -> failed++
                }
            }
            val kind = if (failed > 0) ToastKind.Error else ToastKind.Success
            bulkToast = "Invites: $sent sent, $already already active" +
                (if (failed > 0) ", $failed failed" else "") to kind
            bulkInviting = false
        }
    }

    // Single Kin subscription for the whole screen. Used BOTH for the Kin tab and
    // to populate per-Kinfolk-card chips. This removes the per-card N+1
    // kinStream() listeners the old KinfolkCard opened (one per card).
    val allKinState by remember { client.allKinStream() }.collectAsState(initial = FirestoreResult.Loading)

    // Sessions feed the per-card "last visit" footer (last COMPLETED session per
    // kinfolk via the pure lastVisitByKinfolk helper). Reports feed the "New" badge
    // (zero KinTales => New). Both are single screen-level subscriptions, no N+1.
    val sessionsState by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val reportsState  by remember { client.reportsStream() }.collectAsState(initial = FirestoreResult.Loading)

    val allKin: List<Kin> = (allKinState as? FirestoreResult.Data)?.value.orEmpty()
    // kinfolkId -> its active (non-archived) kin, built once from the single stream.
    val kinByKinfolk: Map<String, List<Kin>> = remember(allKin) {
        allKin.filter { it.status != "archived" }.groupBy { it.kinfolkId }
    }

    // Last COMPLETED visit date per kinfolk (directory.lastVisit) and KinTale count
    // per kinfolk (directory.newBadge input), both derived once from their streams.
    val sessions = (sessionsState as? FirestoreResult.Data)?.value.orEmpty()
    val lastVisitByKf: Map<String, String> = remember(sessions) { lastVisitByKinfolk(sessions) }
    val reports = (reportsState as? FirestoreResult.Data)?.value.orEmpty()
    val kintaleCountByKf: Map<String, Int> = remember(reports) {
        reports.groupingBy { it.kinfolkId }.eachCount()
    }
    val todayIso = remember { nowIso() }

    // Tab counts shown in the segmented picker pills (mockup .ct micro-counts).
    val kinfolkCount = (uiState.allKinfolk as? FirestoreResult.Data)?.value?.size
    val kinCount = (allKinState as? FirestoreResult.Data)?.value?.count { it.status != "archived" }

    ScreenScaffold {
        // ── Editorial head: mono kicker + serif title + Add CTA ───────────────
        DenScreenHeading(
            kicker     = "The Den · Directory",
            title      = "Your",
            accentTail = "kinfolk",
            trailing = {
                if (activeTab == "Kinfolk") {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        GhostButton(
                            label = if (bulkInviting) "Inviting…" else "Invite all to portal",
                            enabled = !bulkInviting,
                            onClick = { inviteAllKinfolk() },
                        )
                        PrimaryButton(
                            label   = "Add kinfolk",
                            onClick = onAddKinfolk,
                            leading = {
                                androidx.compose.material3.Icon(
                                    imageVector        = Lucide.Plus,
                                    contentDescription = null,
                                    tint               = AuntieTheme.colors.background,
                                    modifier           = Modifier.size(16.dp),
                                )
                            },
                        )
                    }
                }
            },
        )
        bulkToast?.let { (msg, kind) ->
            StatusToast(visible = true, message = msg, kind = kind, onDismiss = { bulkToast = null })
            Spacer(Modifier.height(12.dp))
        }
        Spacer(Modifier.height(20.dp))

        // ── Controls row: tabs · search · sort ───────────────────────────────
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SegmentedPicker(
                options  = listOf("Kinfolk", "Kin"),
                selected = activeTab,
                onSelect = { onTabChange(it); vm.clearSearch() },
                label    = { tab ->
                    val count = if (tab == "Kinfolk") kinfolkCount else kinCount
                    if (count != null) "$tab  $count" else tab
                },
            )
            AuntieSearchField(
                value         = uiState.query,
                onValueChange = { vm.search(it) },
                placeholder   = if (activeTab == "Kinfolk") "Search by name, phone, or email"
                                else "Search by name, species, or breed",
                onClear       = { vm.clearSearch() },
                modifier      = Modifier.weight(1f),
            )
            SortMenu(
                selected = uiState.sort,
                onSelect = { vm.setSort(it) },
            )
        }
        Spacer(Modifier.height(20.dp))

        // Fail loud: a broken sessions/reports stream must not silently drop the
        // last-visit footer / New badge without saying why.
        (sessionsState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load visit history",
            ) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
            Spacer(Modifier.height(16.dp))
        }
        (reportsState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load KinTale history",
            ) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
            Spacer(Modifier.height(16.dp))
        }

        if (activeTab == "Kinfolk") {
            when (val s = uiState.allKinfolk) {
                FirestoreResult.Loading -> LoadingGrid()
                is FirestoreResult.Error -> AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Couldn't load Kinfolk",
                ) {
                    Text(s.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
                }
                is FirestoreResult.Data -> {
                    val filtered = uiState.filteredSorted
                    if (filtered.isEmpty()) {
                        AuntieEmptyState(
                            icon    = Lucide.Search,
                            title   = if (uiState.sourceIsEmpty) "No Kinfolk on file yet"
                                      else                       "No matches for \"${uiState.query}\"",
                            message = if (uiState.sourceIsEmpty) "Tap Add to create the first Kinfolk."
                                      else "Try a different name, the last 4 of a phone number, or part of an email.",
                        )
                    } else {
                        CardGrid(items = filtered) { kf ->
                            KinfolkCard(
                                kf        = kf,
                                kin       = kinByKinfolk[kf._id].orEmpty(),
                                lastVisit = lastVisitByKf[kf._id],
                                isNew     = isNewKinfolk(kf, kintaleCountByKf[kf._id] ?: 0, todayIso),
                                onClick   = { onOpenKinfolk(kf._id) },
                            )
                        }
                    }
                }
            }
        } else {
            when (val s = allKinState) {
                FirestoreResult.Loading -> LoadingGrid()
                is FirestoreResult.Error -> AuntieBanner(
                    tone  = AuntieBannerTone.Error,
                    title = "Couldn't load Kin",
                ) {
                    Text(s.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
                }
                is FirestoreResult.Data -> {
                    val filtered = s.value
                        .filter { it.status != "archived" && matchKin(it, uiState.query) }
                        .sortedByOption(
                            option    = uiState.sort,
                            name      = { k -> k.name },
                            // AO-26: the BACKEND already writes kin createdAt/updatedAt
                            // (addKin/updateKin/archiveKin, FieldValue.serverTimestamp),
                            // so the data exists — the old "Kin has no timestamp fields
                            // yet" comment was stale. What is missing is client plumbing:
                            // the Kin model + getMyKin contract don't decode those
                            // Timestamps into an ISO string here. This wasm surface is
                            // deleted at the React cutover (A8), so it stays an alphabetic
                            // fallback; the React directory MUST sort on the real fields.
                            createdAt = { _ -> "" },
                            updatedAt = { _ -> "" },
                        )
                    if (filtered.isEmpty()) {
                        AuntieEmptyState(
                            icon    = Lucide.Search,
                            title   = if (s.value.isEmpty()) "No Kin on file yet"
                                      else                   "No matches for \"${uiState.query}\"",
                            message = if (s.value.isEmpty()) "Add Kin from a Kinfolk profile."
                                      else "Try a different name, species, or breed.",
                        )
                    } else {
                        CardGrid(items = filtered) { kin ->
                            KinCard(
                                kin      = kin,
                                onClick  = { onEditKin(kin.kinfolkId, kin._id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Responsive equal-track grid that mirrors the mockup's
 * `grid-template-columns: repeat(auto-fill, minmax(290px, 1fr))`.
 *
 * Replaces the old FlowRow(widthIn(min=290).weight(1f)) which only distributed
 * leftover space among cards that happened to land on the same wrapped line, so
 * a 2-card line made each ~half-width while a 3-card line made each ~third. This
 * computes a single column count from the available width and lays every row out
 * with equal weights, padding the final row with invisible spacers so the last
 * row's tracks stay the same width as every other row. Every cell is a fixed
 * [CARD_HEIGHT] so heights are uniform across the whole grid.
 */
@Composable
private fun <T> CardGrid(
    items: List<T>,
    card: @Composable (T) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        // How many 290dp-min tracks fit (accounting for the inter-column gap).
        val columns = ((maxWidth + GRID_GAP) / (GRID_MIN_CARD + GRID_GAP))
            .toInt()
            .coerceAtLeast(1)
        Column(verticalArrangement = Arrangement.spacedBy(GRID_GAP)) {
            items.chunked(columns).forEach { rowItems ->
                Row(
                    modifier = Modifier.fillMaxWidth().height(CARD_HEIGHT),
                    horizontalArrangement = Arrangement.spacedBy(GRID_GAP),
                ) {
                    rowItems.forEach { item ->
                        Box(Modifier.weight(1f).fillMaxWidth().height(CARD_HEIGHT)) {
                            card(item)
                        }
                    }
                    // Pad the last (short) row so tracks keep equal width.
                    repeat(columns - rowItems.size) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/** Loading state: a uniform grid of shimmer cards at the real card height. */
@Composable
private fun LoadingGrid() {
    CardGrid(items = (0 until 6).toList()) {
        ShimmerCard(height = CARD_HEIGHT)
    }
}

private fun matchKin(kin: Kin, q: String): Boolean {
    if (q.isBlank()) return true
    val needle = q.trim().lowercase()
    return kin.name.lowercase().contains(needle)
        || kin.species.lowercase().contains(needle)
        || kin.breed.lowercase().contains(needle)
}

/**
 * Kinfolk card. Den .kcard: gradient avatar + name, kin chips with a tiny pet
 * avatar leading, a contact rail (phone / email icons), and a status pill that
 * stands in for the mockup's status badge in the card footer.
 *
 * Kin are passed in from the screen's single allKinStream() collection, so this
 * card opens NO Firestore listener of its own (was an N+1 per-card subscription).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun KinfolkCard(
    kf: Kinfolk,
    kin: List<Kin>,
    lastVisit: String?,
    isNew: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(CARD_HEIGHT)
            .clip(RoundedCornerShape(20.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(18.dp)) {
            // ── Top: avatar + name / household summary ────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                AuntieAvatar(
                    imageUrl     = kf.profilePictureUrl.takeIf { it.isNotBlank() },
                    initials     = initials(kf.displayName),
                    size         = 50.dp,
                    shape        = RoundedCornerShape(15.dp),
                    gradientSeed = kf._id.ifBlank { kf.displayName },
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Text(
                            text     = kf.displayName,
                            style    = AuntieTheme.typography.titleMedium,
                            color    = c.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (isNew) {
                            AuntieStatusPill(
                                label   = "New",
                                tone    = AuntieStatusTone.Success,
                                showDot = false,
                            )
                        }
                    }
                    // Mockup subtitle reads "the Thornes · Riverside" (household + area).
                    // We have the household last name; neighborhood is not a Kinfolk
                    // field, so surface "the {lastName}s" rather than invent a locality.
                    // SUGGESTION: add a neighborhood/serviceArea field if the
                    // "household · area" subtitle is desired verbatim.
                    val subtitle = if (kf.lastName.isNotBlank()) householdLabel(kf.lastName)
                                   else kinSummaryOf(kin)
                    // #829: a household with no Emergency Contact shows the flag in
                    // the subtitle slot. The card is a fixed 196dp, so a new row
                    // would squeeze the kin chips, and at the 290dp minimum the
                    // footer cannot hold the flag beside the status pill (render
                    // test: KinfolkCardRenderTest). The subtitle only repeats the
                    // household name, so the flag takes its place.
                    if (emergencyContactsOf(kf).isEmpty()) {
                        // #829 review item 14: the compact pill, as on every client.
                        AuntieStatusPill(label = NO_EMERGENCY_CONTACT, tone = AuntieStatusTone.Orange, compact = true)
                    } else if (subtitle.isNotBlank()) {
                        Text(
                            text     = subtitle,
                            style    = AuntieTheme.typography.bodySmall,
                            color    = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            Spacer(Modifier.height(13.dp))

            // ── Kin chips (cap at 3 visible + overflow, keeps card height fixed) ─
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (kin.isNotEmpty()) {
                    val shown = kin.take(3)
                    val overflow = kin.size - shown.size
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        shown.forEach { k ->
                            AuntieChip(
                                label   = k.name,
                                tone    = AuntieChipTone.Teal,
                                leading = {
                                    AuntieAvatar(
                                        imageUrl     = null,
                                        glyph        = Lucide.PawPrint,
                                        size         = 28.dp,
                                        gradientSeed = k._id.ifBlank { k.name },
                                    )
                                },
                            )
                        }
                        if (overflow > 0) {
                            AuntieChip(label = "+$overflow more", tone = AuntieChipTone.Neutral, mono = true)
                        }
                    }
                } else {
                    Text(
                        text  = "No kin on file",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textFaint,
                    )
                }
            }

            // ── Footer: contact rail + status pill ────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(AuntieTheme.dims.borderHairline)
                    .background(c.borderSoft),
            )
            Spacer(Modifier.height(13.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                // #829 review: the left half yields width to the pills on the
                // right, so at the 290dp minimum "Last visit" ellipsizes instead of
                // squeezing the pills into wrapping.
                Row(
                    modifier = Modifier.weight(1f, fill = false),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    // Mockup phone/mail are per-contact actions. There is no
                    // platform tel:/mailto: launcher in the verified API, so these
                    // open the profile (where the operator can copy the number /
                    // email) rather than faking a dialer. Audit [low] item.
                    if (kf.phoneNumber.isNotBlank()) {
                        AuntieIconButton(
                            icon               = Lucide.Phone,
                            contentDescription = "Open profile to call",
                            onClick            = onClick,
                            size               = 30.dp,
                        )
                    }
                    if (kf.email.isNotBlank()) {
                        AuntieIconButton(
                            icon               = Lucide.Mail,
                            contentDescription = "Open profile to email",
                            onClick            = onClick,
                            size               = 30.dp,
                        )
                    }
                    // Last COMPLETED visit footer (directory.lastVisit). Omitted when
                    // there is no completed session on file (never fabricate a date).
                    lastVisit?.let { iso ->
                        Text(
                            text  = "Last visit ${humanizeDate(iso)}",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                StatusPill(status = kf.status)
            }
        }
    }
}

/**
 * Kin card. Mirrors the Kinfolk card's frame for the Kin tab: a paw-glyph
 * avatar, the pet name, a species · breed · age detail line, and the status
 * pill. Tapping opens the Kin editor (real wiring preserved).
 */
@Composable
private fun KinCard(
    kin: Kin,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(CARD_HEIGHT)
            .clip(RoundedCornerShape(20.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(18.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                AuntieAvatar(
                    imageUrl     = null,
                    glyph        = Lucide.PawPrint,
                    size         = 50.dp,
                    shape        = RoundedCornerShape(15.dp),
                    gradientSeed = kin._id.ifBlank { kin.name },
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    Text(
                        text     = kin.name,
                        style    = AuntieTheme.typography.titleMedium,
                        color    = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val detail = listOfNotNull(
                        kin.species.ifBlank { null },
                        kin.breed.ifBlank { null },
                        if (kin.age.isNotBlank()) "${kin.age} yrs" else null,
                    ).joinToString(" · ")
                    if (detail.isNotBlank()) {
                        Text(
                            text     = detail,
                            style    = AuntieTheme.typography.bodySmall,
                            color    = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            Spacer(Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(AuntieTheme.dims.borderHairline)
                    .background(c.borderSoft),
            )
            Spacer(Modifier.height(13.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = if (kin.sex.isNotBlank()) kin.sex else "",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                StatusPill(status = kin.status)
            }
        }
    }
}

/** Summarize the active kin into a compact "Biscuit, Gravy & 1 more" line. */
private fun kinSummaryOf(activeKin: List<Kin>): String = when {
    activeKin.isEmpty() -> ""
    activeKin.size == 1 -> activeKin[0].name
    else -> activeKin.take(2).joinToString(", ") { it.name } +
            if (activeKin.size > 2) " & ${activeKin.size - 2} more" else ""
}

@Composable
private fun StatusPill(status: String) {
    val tone = when (status.lowercase()) {
        "active"   -> AuntieStatusTone.Success
        "inactive" -> AuntieStatusTone.Muted
        "archived" -> AuntieStatusTone.Warning
        else       -> AuntieStatusTone.Neutral
    }
    AuntieStatusPill(
        label   = status.lowercase(),
        tone    = tone,
        showDot = true,
    )
}

private fun initials(name: String): String {
    val parts = name.split(" ").filter { it.isNotBlank() }
    return when (parts.size) {
        0    -> "?"
        1    -> parts[0].take(2).uppercase()
        else -> (parts.first().first().toString() + parts.last().first().toString()).uppercase()
    }
}
