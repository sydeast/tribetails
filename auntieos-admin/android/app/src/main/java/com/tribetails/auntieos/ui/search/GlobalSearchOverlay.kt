package com.tribetails.auntieos.ui.search

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

/** Trim + debounce window for the live query (ms). */
private const val SEARCH_DEBOUNCE_MS = 200L

/**
 * Full-screen global-search overlay (Stage 0C / Phase 2, Android parity with web).
 *
 * Loads the admin's kinfolk, kin, and KinTale reports once via [AuntieRepository],
 * then matches them client-side through the pure [globalSearch] helper. The query is
 * trimmed + debounced; a blank query renders nothing. Selecting a result routes to
 * that entity's screen via [onNavigate] (route from the pure [searchHitRoute] mapping).
 *
 * Fail-loud: a load failure surfaces a visible error banner; we never fabricate data.
 */
@Composable
fun GlobalSearchOverlay(
    onDismiss: () -> Unit,
    onNavigate: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }

    var kinfolk by remember { mutableStateOf<List<Kinfolk>>(emptyList()) }
    var kin by remember { mutableStateOf<List<Kin>>(emptyList()) }
    var tales by remember { mutableStateOf<List<KinCareReport>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true
        // Fail loud: any failed load shows a banner; nothing is faked.
        val kinfolkRes = repo.getKinfolk()
        val kinRes = repo.getAllKin()
        val taleRes = repo.getAllKinCareReports()
        val failure = kinfolkRes.exceptionOrNull()
            ?: kinRes.exceptionOrNull()
            ?: taleRes.exceptionOrNull()
        if (failure != null) {
            error = failure.message ?: "Search data failed to load"
        } else {
            kinfolk = kinfolkRes.getOrDefault(emptyList())
            kin = kinRes.getOrDefault(emptyList())
            tales = taleRes.getOrDefault(emptyList())
            error = null
        }
        loading = false
    }

    var rawQuery by remember { mutableStateOf("") }
    var debounced by remember { mutableStateOf("") }
    LaunchedEffect(rawQuery) {
        delay(SEARCH_DEBOUNCE_MS)
        debounced = rawQuery
    }

    val results = remember(debounced, kinfolk, kin, tales) {
        globalSearch(debounced, kinfolk, kin, tales)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.background)
            .statusBarsPadding(),
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AuntieSearchField(
                    value = rawQuery,
                    onValueChange = { rawQuery = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Find a kinfolk, kin, or KinTale",
                    onClear = { rawQuery = "" },
                )
                Text(
                    text = "Close",
                    style = AuntieTheme.typography.labelLarge,
                    color = c.textDim,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onDismiss)
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }

            Spacer(Modifier.height(12.dp))

            when {
                error != null -> {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Search unavailable",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(error!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
                loading -> {
                    Box(modifier = Modifier.fillMaxWidth().padding(top = 24.dp), contentAlignment = Alignment.Center) {
                        AuntieSpinner(modifier = Modifier.size(32.dp))
                    }
                }
                debounced.trim().isEmpty() -> {
                    // Empty query shows nothing (just the hint).
                    EmptyHint("Type to search kinfolk, kin, and KinTale reports.")
                }
                results.isEmpty -> {
                    EmptyHint("No matches for \"${debounced.trim()}\".")
                }
                else -> {
                    ResultsList(results = results) { hit ->
                        searchHitRoute(hit)?.let { route ->
                            onNavigate(route)
                            onDismiss()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultsList(
    results: GlobalSearchResults,
    onSelect: (SearchHit) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (results.kinfolk.isNotEmpty()) {
            item("h-kinfolk") { GroupHeader("Kinfolk") }
            items(results.kinfolk, key = { "kf-${it.id}" }) { hit ->
                ResultRow(hit = hit, onSelect = onSelect)
            }
        }
        if (results.kin.isNotEmpty()) {
            item("h-kin") { GroupHeader("Kin") }
            items(results.kin, key = { "kn-${it.id}" }) { hit ->
                ResultRow(hit = hit, onSelect = onSelect)
            }
        }
        if (results.tales.isNotEmpty()) {
            item("h-tale") { GroupHeader("KinTale") }
            items(results.tales, key = { "tl-${it.id}" }) { hit ->
                ResultRow(hit = hit, onSelect = onSelect)
            }
        }
    }
}

@Composable
private fun GroupHeader(label: String) {
    val c = AuntieTheme.colors
    Text(
        text = label.uppercase(),
        style = AuntieTheme.typography.labelSmall,
        color = c.textFaint,
        modifier = Modifier.padding(start = 4.dp, top = 14.dp, bottom = 4.dp),
    )
}

@Composable
private fun ResultRow(hit: SearchHit, onSelect: (SearchHit) -> Unit) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(c.surfaceGlass)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = { onSelect(hit) },
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = hit.primary.ifBlank { "Untitled" },
                style = AuntieTheme.typography.titleSmall,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (hit.secondary.isNotBlank()) {
                Text(
                    text = hit.secondary,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
