package com.tribetails.auntieos.web.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.shaders.meshGradientBackground
import com.tribetails.auntieos.web.ui.shaders.rememberMeshPointer

/**
 * Adaptive shell:
 *  - width >= 960dp: left side rail + content
 *  - else:           floating bottom dock + content
 *
 * Always paints the mesh-gradient background behind everything.
 */
@Composable
fun AppShell(
    current: Destination,
    onNavigate: (Destination) -> Unit,
    onSignOut: (() -> Unit)? = null,
    accountName: String? = null,
    accountRole: String? = null,
    onAccountClick: () -> Unit = {},
    unreadCount: Int = 0,
    testMode: com.tribetails.auntieos.web.data.TestMode = com.tribetails.auntieos.web.data.TestMode.OFF,
    // Global search (Stage 0C / Phase 2). The shell owns the input; the host
    // computes results off the live streams via the pure [globalSearch] matcher.
    searchQuery: String = "",
    onSearchQueryChange: (String) -> Unit = {},
    searchResults: List<SearchResult> = emptyList(),
    searchError: String? = null,
    onOpenSearchResult: (SearchResult) -> Unit = {},
    // 17.2 Branding: resolved brand identity (blanks already defaulted by the host).
    brandLogoUrl: String = "",
    brandWordmark: String = "AuntieOS",
    brandTagline: String = "Tribe Tails Care",
    // 17.4 Nav editor: per-operator nav tokens (empty -> shipped grouped default).
    navConfig: List<String> = emptyList(),
    // 17.4 fail-loud: non-null when the current hash named no screen (router fell to Home).
    routeError: String? = null,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    val pointer = rememberMeshPointer()
    // The notification bell always renders (wired + deployed). Global search is a
    // real client-side search over the live kinfolk / kin / KinTale streams.

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.background)
            .meshGradientBackground(c, pointer),
    ) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val wide = maxWidth >= 960.dp
            if (wide) {
                Row(modifier = Modifier.fillMaxSize()) {
                    SideRail(
                        current   = current,
                        onSelect  = onNavigate,
                        onHome    = { onNavigate(Destination.Home) },
                        onSignOut = onSignOut,
                        accountName = accountName,
                        accountRole = accountRole,
                        onAccountClick = onAccountClick,
                        brandLogoUrl = brandLogoUrl,
                        brandWordmark = brandWordmark,
                        brandTagline = brandTagline,
                        navConfig = navConfig,
                        modifier  = Modifier
                            .fillMaxHeight()
                            .width(AuntieTheme.dims.sideRailWidth)
                            .padding(12.dp),
                    )
                    Column(modifier = Modifier.fillMaxSize()) {
                        // Side rail already carries the brand → no logo needed in the bar here.
                        TopBar(
                            showLogo = false,
                            unreadCount = unreadCount,
                            onNavigate = onNavigate,
                            searchQuery = searchQuery,
                            onSearchQueryChange = onSearchQueryChange,
                            searchResults = searchResults,
                            searchError = searchError,
                            onOpenSearchResult = onOpenSearchResult,
                        )
                        TestModeBanner(testMode)
                        ContentArea(Modifier.weight(1f), routeError = routeError, content = content)
                    }
                }
            } else {
                Box(modifier = Modifier.fillMaxSize()) {
                    Column(modifier = Modifier.fillMaxSize()) {
                        // No side rail on narrow screens, so the bar carries the logo → home.
                        TopBar(
                            showLogo = true,
                            unreadCount = unreadCount,
                            onNavigate = onNavigate,
                            searchQuery = searchQuery,
                            onSearchQueryChange = onSearchQueryChange,
                            searchResults = searchResults,
                            searchError = searchError,
                            onOpenSearchResult = onOpenSearchResult,
                        )
                        TestModeBanner(testMode)
                        ContentArea(Modifier.weight(1f), routeError = routeError, content = content)
                    }
                    BottomDock(
                        current  = current,
                        onSelect = onNavigate,
                        onSignOut = onSignOut,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(horizontal = 12.dp, vertical = 16.dp),
                    )
                }
            }
        }
    }
}

/**
 * Stage 0I: persistent, NON-dismissible TEST MODE banner shown on every screen
 * when a test admin is signed in (testTribeId claim). It is the loud, always-on
 * signal that the data on screen is the sandbox tribe only, not live records.
 * Rendered nowhere when [TestMode.active] is false, so the normal-admin shell is
 * pixel-identical to before. Copy is functional (a state marker), not authored.
 */
@Composable
private fun TestModeBanner(testMode: com.tribetails.auntieos.web.data.TestMode) {
    if (!testMode.active) return
    val c = AuntieTheme.colors
    Box(modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 8.dp)) {
        com.tribetails.auntieos.web.ui.components.AuntieBanner(
            tone = com.tribetails.auntieos.web.ui.components.AuntieBannerTone.Warning,
            title = "TEST MODE",
            icon = Lucide.TriangleAlert,
            pillLabel = "SANDBOX",
            // No onDismiss: this banner is intentionally not dismissible.
        ) {
            Text(
                text = "Sandbox data only. Scoped to test tribe ${testMode.testTribeId.orEmpty()}.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/**
 * Shell-level top bar (Decision 10). Logo → Home (narrow only; the side rail owns the brand
 * when wide). Search is a real client-side global search over the live kinfolk / kin /
 * KinTale streams: typing filters via the pure [globalSearch] matcher and selecting a hit
 * navigates to that entity. Bell routes to Notifications with an unread ping driven by a
 * real count ([unreadNotificationCount]).
 */
@Composable
private fun TopBar(
    showLogo: Boolean,
    unreadCount: Int,
    onNavigate: (Destination) -> Unit,
    searchQuery: String,
    onSearchQueryChange: (String) -> Unit,
    searchResults: List<SearchResult>,
    searchError: String?,
    onOpenSearchResult: (SearchResult) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp)
            .padding(top = 16.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (showLogo) LogoMark(onClick = { onNavigate(Destination.Home) })
        GlobalSearchField(
            query = searchQuery,
            onQueryChange = onSearchQueryChange,
            results = searchResults,
            error = searchError,
            onOpenResult = onOpenSearchResult,
            modifier = Modifier.weight(1f),
        )
        NotificationBell(unreadCount = unreadCount, onClick = { onNavigate(Destination.Notifications) })
    }
}

/** Compact brand paw that returns to Home. */
@Composable
private fun LogoMark(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(c.primary.copy(alpha = 0.18f).compositeOver(c.surface))
            .border(AuntieTheme.dims.borderHairline, c.primary, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Lucide.PawPrint, contentDescription = "Home", tint = c.primary, modifier = Modifier.size(18.dp))
    }
}

/**
 * Real global search: an [AuntieSearchField] plus a results dropdown grouped by
 * type. The host computes [results] off the live streams (pure [globalSearch]).
 * An empty query shows nothing; a stream error surfaces a fail-loud row instead
 * of silently hiding results. Selecting a hit navigates via [onOpenResult].
 */
@Composable
private fun GlobalSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    results: List<SearchResult>,
    error: String?,
    onOpenResult: (SearchResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val trimmed = query.trim()
    // Dropdown is open whenever the user has a live query: it shows results, the
    // fail-loud error row, or a "no matches" line, never a dead silent input.
    val expanded = trimmed.isNotEmpty()

    Box(modifier = modifier.widthIn(max = 360.dp)) {
        com.tribetails.auntieos.web.ui.components.AuntieSearchField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = "Find a kinfolk, kin, or KinTale...",
            onClear = { onQueryChange("") },
            modifier = Modifier.fillMaxWidth(),
        )
        androidx.compose.material3.DropdownMenu(
            expanded = expanded,
            onDismissRequest = { /* keep open while typing; clearing the field closes it */ },
            properties = androidx.compose.ui.window.PopupProperties(focusable = false),
        ) {
            when {
                error != null -> SearchErrorRow(error)
                results.isEmpty() -> SearchEmptyRow()
                else -> {
                    // Render in fixed group order with a header before each group.
                    SearchResultType.entries.forEach { group ->
                        val groupHits = results.filter { it.type == group }
                        if (groupHits.isNotEmpty()) {
                            SearchGroupHeader(group.label, groupHits.size)
                            groupHits.forEach { hit ->
                                SearchResultRow(hit) { onOpenResult(hit) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchGroupHeader(label: String, count: Int) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        Text("$count", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
    }
}

@Composable
private fun SearchResultRow(result: SearchResult, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    androidx.compose.material3.DropdownMenuItem(
        text = {
            Column {
                Text(result.title, style = AuntieTheme.typography.labelLarge, color = c.textPrimary)
                if (result.subtitle.isNotBlank()) {
                    Text(result.subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        },
        onClick = onClick,
    )
}

@Composable
private fun SearchEmptyRow() {
    val c = AuntieTheme.colors
    Box(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text("No matches", style = AuntieTheme.typography.bodySmall, color = c.textDim)
    }
}

/** Fail-loud surface when a search stream errors: never silently empty. */
@Composable
private fun SearchErrorRow(message: String) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Lucide.TriangleAlert, contentDescription = null, tint = c.error, modifier = Modifier.size(14.dp))
        Text("Search unavailable: $message", style = AuntieTheme.typography.bodySmall, color = c.error)
    }
}

/** Bell entry-point to Notifications; shows an unread ping + compact count when nonzero. */
@Composable
private fun NotificationBell(unreadCount: Int, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val label = bellBadgeLabel(unreadCount)
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Lucide.Bell, contentDescription = "Notifications", tint = c.textDim, modifier = Modifier.size(18.dp))
        if (label != null) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(4.dp)
                    .size(14.dp)
                    .clip(CircleShape)
                    .background(c.primary),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = AuntieTheme.typography.labelSmall, color = c.background, fontSize = 8.sp)
            }
        }
    }
}

@Composable
private fun ContentArea(modifier: Modifier = Modifier, routeError: String? = null, content: @Composable () -> Unit) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 20.dp),
    ) {
        // 17.4 fail-loud: a hash that names no screen lands on Home; say so rather than
        // silently swapping the page out from under the operator.
        if (routeError != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Page not found") {
                Text(routeError, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
            Spacer(Modifier.height(12.dp))
        }
        content()
    }
}

@Composable
private fun SideRail(
    current: Destination,
    onSelect: (Destination) -> Unit,
    onHome: (() -> Unit)? = null,
    onSignOut: (() -> Unit)? = null,
    accountName: String? = null,
    accountRole: String? = null,
    onAccountClick: () -> Unit = {},
    brandLogoUrl: String = "",
    brandWordmark: String = "AuntieOS",
    brandTagline: String = "Tribe Tails Care",
    navConfig: List<String> = emptyList(),
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    GlassSurface(modifier = modifier.fillMaxHeight(), cornerRadius = 16.dp) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                BrandHeader(
                    onClick = onHome,
                    logoUrl = brandLogoUrl,
                    wordmark = brandWordmark,
                    tagline = brandTagline,
                )
                Spacer(Modifier.height(12.dp))

                if (navConfig.isEmpty()) {
                    // Default: the shipped grouped layout (enum order within each group).
                    val grouped = Destination.values().filter {
                        it != Destination.MediaGallery && it != Destination.AccountSettings && it != Destination.MyNotifications
                    }.groupBy { it.group }
                    grouped.forEach { (group, dests) ->
                        Text(
                            text  = group.label.uppercase(),
                            style = AuntieTheme.typography.labelSmall,
                            color = c.textFaint,
                            modifier = Modifier.padding(start = 10.dp, top = 14.dp, bottom = 6.dp),
                        )
                        dests.forEach { d ->
                            NavRow(
                                dest      = d,
                                selected  = d == current,
                                onClick   = { onSelect(d) },
                            )
                        }
                    }
                } else {
                    // 17.4 custom nav: flat, operator-ordered, renamed, with hidden links
                    // omitted. Unknown keys (a removed destination) are skipped silently;
                    // they cannot be navigated to anyway.
                    Spacer(Modifier.height(8.dp))
                    resolvedNav(navConfig, navEditableDestinations.map { it.name }).forEach { entry ->
                        destinationByName(entry.key)?.let { dest ->
                            NavRow(
                                dest     = dest,
                                selected = dest == current,
                                onClick  = { onSelect(dest) },
                                label    = entry.label(dest.title),
                            )
                        }
                    }
                }
            }
            if (accountName != null) {
                Spacer(Modifier.height(8.dp))
                AccountChip(name = accountName, role = accountRole ?: "Admin", onClick = onAccountClick)
            }
            if (onSignOut != null) {
                Spacer(Modifier.height(6.dp))
                SignOutRow(onClick = onSignOut)
            }
        }
    }
}

/** Bottom-of-rail operator identity chip (mirrors the redesign mockup's .me). */
@Composable
private fun AccountChip(name: String, role: String, onClick: () -> Unit = {}) {
    val c = AuntieTheme.colors
    val initial = name.trim().firstOrNull()?.uppercase() ?: "A"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(12.dp))
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(c.primary.copy(alpha = 0.20f).compositeOver(c.surface))
                .border(AuntieTheme.dims.borderHairline, c.primary.copy(alpha = 0.6f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(initial, style = AuntieTheme.typography.labelLarge, color = c.primary)
        }
        Column(Modifier.weight(1f)) {
            Text(name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            Text(role, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

@Composable
private fun SignOutRow(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.LogOut,
            contentDescription = "Sign out",
            tint = c.textDim,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text  = "Sign out",
            style = AuntieTheme.typography.labelLarge,
            color = c.textDim,
        )
    }
}

@Composable
private fun BrandHeader(
    onClick: (() -> Unit)? = null,
    logoUrl: String = "",
    wordmark: String = "AuntieOS",
    tagline: String = "Tribe Tails Care",
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .let { if (onClick != null) it.clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick) else it }
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (logoUrl.isNotBlank()) {
            // 17.2 operator logo. AuntieAvatar loads the image and, on a broken URL,
            // falls back to the PawPrint glyph (fail-visible, never an empty hole).
            AuntieAvatar(
                imageUrl = logoUrl,
                glyph = Lucide.PawPrint,
                size = 28.dp,
                shape = CircleShape,
                gradientSeed = wordmark,
            )
        } else {
            // Shipped default: faint-primary disc + primary PawPrint (unchanged look).
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(c.primary.copy(alpha = 0.18f).compositeOver(c.surface))
                    .border(AuntieTheme.dims.borderHairline, c.primary, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Lucide.PawPrint, contentDescription = null, tint = c.primary, modifier = Modifier.size(16.dp))
            }
        }
        Column {
            Text(wordmark, style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
            Text(tagline,  style = AuntieTheme.typography.bodySmall,  color = c.textDim)
        }
    }
}

@Composable
private fun NavRow(
    dest: Destination,
    selected: Boolean,
    onClick: () -> Unit,
    label: String = dest.title,
) {
    val c = AuntieTheme.colors
    val bg = if (selected) c.primary.copy(alpha = 0.12f).compositeOver(c.surface) else androidx.compose.ui.graphics.Color.Transparent
    val border = if (selected) c.primary.copy(alpha = 0.55f) else androidx.compose.ui.graphics.Color.Transparent
    val tint = if (selected) c.primary else c.textDim

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            .border(AuntieTheme.dims.borderHairline, border, RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(dest.icon, contentDescription = label, tint = tint, modifier = Modifier.size(16.dp))
        Text(
            text  = label,
            style = AuntieTheme.typography.labelLarge,
            color = if (selected) c.textPrimary else c.textDim,
        )
    }
}

@Composable
private fun BottomDock(
    current: Destination,
    onSelect: (Destination) -> Unit,
    onSignOut: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    // On narrow screens we show only a "pinned" subset to keep the dock readable.
    val pinned = listOf(
        Destination.Home,
        Destination.Communicate,
        Destination.Directory,
        Destination.Sessions,
        Destination.Schedule,
        Destination.Settings,
    )
    GlassSurface(modifier = modifier.height(AuntieTheme.dims.bottomDockHeight), cornerRadius = 999.dp) {
        Row(
            modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            pinned.forEach { d ->
                val on = d == current
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .clickable { onSelect(d) }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Icon(d.icon, contentDescription = d.title, tint = if (on) c.primary else c.textDim, modifier = Modifier.size(18.dp))
                    Text(d.title, style = AuntieTheme.typography.labelSmall, color = if (on) c.primary else c.textDim)
                }
            }
            if (onSignOut != null) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .clickable(onClick = onSignOut)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Icon(
                        imageVector = Lucide.LogOut,
                        contentDescription = "Sign out",
                        tint = c.textDim,
                        modifier = Modifier.size(18.dp),
                    )
                    Text("Sign out", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                }
            }
        }
    }
}
