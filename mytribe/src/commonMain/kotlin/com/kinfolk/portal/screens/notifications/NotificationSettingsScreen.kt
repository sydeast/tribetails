package com.kinfolk.portal.screens.notifications

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.notifications.ALL_MARKETING_CATEGORIES
import com.kinfolk.portal.notifications.CatalogState
import com.kinfolk.portal.notifications.CategoryDef
import com.kinfolk.portal.notifications.KINFOLK_CATEGORIES
import com.kinfolk.portal.notifications.NotificationCatalogRepository
import com.kinfolk.portal.notifications.NotificationChannel
import com.kinfolk.portal.notifications.NotificationKey
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch

/**
 * Hybrid notification settings.
 *
 * UI layout:
 *   1. Marketing opt-in card — per-marketingCategory toggle chip (off by
 *      default; CAN-SPAM/CASL unsubscribe-by-default).
 *   2. Per-category cards — header row with "select all by channel" chips;
 *      expand chevron reveals per-key channel chips that override the row
 *      default.
 *
 * Write semantics:
 *   - byCategory map mirrors the header chip state per category.
 *   - byKey map holds per-key overrides that diverge from the category default.
 *   - marketingOptIn carries the per-MarketingCategory boolean.
 *
 * Required channels render as locked chips (selected + disabled clickable).
 * Channels outside a key's `allowedChannels` are hidden.
 *
 * Notification revamp: admin-locked channels explain themselves with the
 * operator's lockReason when one exists (default "Required by Tribe Tails"
 * line otherwise). Fully locked keys read as always-on, and the category
 * "select all" row only offers channels some key can actually toggle (see
 * NotificationLockDisplay.kt for the pure rules).
 */
@Composable
fun NotificationSettingsScreen(
    familyName: String,
    portalApi: PortalApi,
    notificationCatalog: NotificationCatalogRepository? = null,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()

    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    val byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>> = remember { mutableStateMapOf() }
    val byKey: SnapshotStateMap<String, MutableMap<String, Boolean>> = remember { mutableStateMapOf() }
    val marketingOptIn: SnapshotStateMap<String, Boolean> = remember { mutableStateMapOf() }
    val expanded: SnapshotStateMap<String, Boolean> = remember { mutableStateMapOf() }

    // Dynamic catalog state. When notificationCatalog repo is provided, the
    // server is the source of truth (closes the static-mirror drift gap).
    // When repo is null OR fetch fails, fall back to the static
    // KINFOLK_CATEGORIES const with a visible banner per fail-loud policy.
    var dynamicCategories by remember { mutableStateOf<List<CategoryDef>?>(null) }
    var catalogWarning by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(notificationCatalog) {
        if (notificationCatalog == null) {
            // Transitional: caller didn't wire repo. Stay on static const.
            dynamicCategories = null
            catalogWarning = null
            return@LaunchedEffect
        }
        when (val s = notificationCatalog.load()) {
            is CatalogState.Success -> {
                dynamicCategories = s.categories
                catalogWarning = null
            }
            is CatalogState.Failure -> {
                dynamicCategories = null
                catalogWarning = "Showing cached preference menu. ${s.message}"
            }
            CatalogState.Loading -> { /* impossible: load() returns terminal state */ }
        }
    }

    val effectiveCategories: List<CategoryDef> = dynamicCategories ?: KINFOLK_CATEGORIES

    LaunchedEffect(Unit) {
        try {
            val server = portalApi.getMyNotificationPrefs()
            byCategory.clear()
            server.byCategory.forEach { (cat, channels) -> byCategory[cat] = channels.toMutableMap() }
            byKey.clear()
            server.byKey.forEach { (k, channels) -> byKey[k] = channels.toMutableMap() }
            marketingOptIn.clear()
            ALL_MARKETING_CATEGORIES.forEach { mc ->
                marketingOptIn[mc.id] = server.marketingOptIn[mc.id] == true
            }
            loaded = true
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load preferences"
            loaded = true
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "Notification Settings", kicker = "Account")

        if (!loaded) {
            Box(
                modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
                contentAlignment = Alignment.Center,
            ) {
                KinSpinner()
            }
            return@Column
        }
        if (error != null) {
            Text(
                error!!,
                style = type.sansBody,
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }

        if (catalogWarning != null) {
            Text(
                catalogWarning!!,
                style = type.sansLabel.copy(color = KinfolkBrand.PackPink),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }

        MarketingOptInBlock(marketingOptIn = marketingOptIn)

        effectiveCategories.forEach { cat ->
            // D12: present the "schedule" category with the Schedule Reminders
            // framing from the mockup when the flag is on. Relabel only; the
            // catalog id/key/keys are untouched, so prefs still write the same.
            val scheduleRelabel = cat.id == "schedule"
            CategoryCard(
                cat = cat,
                byCategory = byCategory,
                byKey = byKey,
                marketingOptIn = marketingOptIn,
                isExpanded = expanded[cat.id] == true,
                onToggleExpand = { expanded[cat.id] = !(expanded[cat.id] == true) },
                displayTitle = if (scheduleRelabel) "Schedule Reminders" else cat.title,
                displayDescription = if (scheduleRelabel) {
                    "Reminders before upcoming and pending visits on your calendar."
                } else {
                    cat.description
                },
            )
        }

        if (status != null) {
            Text(
                status!!,
                style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }
        KinButton(
            label = if (saving) "Saving…" else "Save Notification Preferences",
            onClick = {
                if (saving) return@KinButton
                saving = true
                status = null
                scope.launch {
                    try {
                        portalApi.saveMyNotificationPrefs(
                            byCategory = byCategory.mapValues { (_, v) -> v.toMap() },
                            byKey = byKey.mapValues { (_, v) -> v.toMap() },
                            marketingOptIn = marketingOptIn.toMap(),
                        )
                        status = "Preferences saved."
                    } catch (t: Throwable) {
                        status = "Save failed: ${t.message ?: t}"
                    } finally {
                        saving = false
                    }
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
        )
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

@Composable
private fun MarketingOptInBlock(marketingOptIn: SnapshotStateMap<String, Boolean>) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Marketing Opt-Ins", style = type.heritageTitle)
            Text(
                "These are off by default. Tap a category to receive related communications. " +
                    "Every marketing email includes an unsubscribe link.",
                style = type.sansBody,
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = KinfolkSpacing.xs),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                ALL_MARKETING_CATEGORIES.forEach { mc ->
                    val selected = marketingOptIn[mc.id] == true
                    KinChip(
                        label = mc.label,
                        selected = selected,
                        onClick = { marketingOptIn[mc.id] = !selected },
                    )
                }
            }
        }
    }
}

@Composable
private fun CategoryCard(
    cat: CategoryDef,
    byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    byKey: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    marketingOptIn: SnapshotStateMap<String, Boolean>,
    isExpanded: Boolean,
    onToggleExpand: () -> Unit,
    displayTitle: String = cat.title,
    displayDescription: String = cat.description,
) {
    val type = LocalKinfolkTypography.current
    val isMarketingCategory = cat.id == "marketing"

    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onToggleExpand() },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.padding(end = KinfolkSpacing.s)) {
                    Text(displayTitle, style = type.heritageTitle)
                    Text(displayDescription, style = type.sansBody)
                }
                Icon(
                    imageVector = if (isExpanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = if (isExpanded) "Collapse" else "Expand",
                    tint = KinfolkBrand.NavyMuted,
                )
            }

            // Legend for the chip markers, only when this category renders any.
            categoryMarkerLegend(cat)?.let { legend ->
                Text(legend, style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
            }

            if (!isMarketingCategory) {
                CategoryChannelRow(cat = cat, byCategory = byCategory, byKey = byKey)
            }

            if (isExpanded) {
                cat.keys.forEach { key ->
                    PerKeyRow(
                        key = key,
                        catId = cat.id,
                        byCategory = byCategory,
                        byKey = byKey,
                        marketingOptIn = marketingOptIn,
                    )
                }
            }
        }
    }
}

@Composable
private fun CategoryChannelRow(
    cat: CategoryDef,
    byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    byKey: SnapshotStateMap<String, MutableMap<String, Boolean>>,
) {
    val type = LocalKinfolkTypography.current
    // Notification revamp: only offer "select all" chips for channels at least
    // one key can actually toggle. A channel that is locked (or required) on
    // every key would be a dead chip: it writes byCategory, but the locked key
    // chips below stay on regardless, so the row would visually contradict
    // them. When NOTHING in the category is toggleable, say so instead of
    // rendering a dead row.
    val alwaysOnNote = categoryAlwaysOnNote(cat)
    if (alwaysOnNote != null) {
        Text(
            alwaysOnNote,
            style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
            modifier = Modifier.padding(top = KinfolkSpacing.s),
        )
        return
    }
    val channelsInCategory: Set<NotificationChannel> = cat.toggleableChannelsInCategory()

    Row(
        modifier = Modifier.fillMaxWidth().padding(top = KinfolkSpacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("All in category:", style = type.sansLabel)
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            NotificationChannel.entries.forEach { ch ->
                if (ch !in channelsInCategory) return@forEach
                val current = byCategory[cat.id]?.get(ch.id) == true
                KinChip(
                    label = ch.label,
                    selected = current,
                    onClick = {
                        val map = byCategory[cat.id]?.toMutableMap() ?: mutableMapOf()
                        map[ch.id] = !current
                        byCategory[cat.id] = map
                        cat.keys.forEach { k -> byKey.remove(k.key) }
                    },
                )
            }
        }
    }
}

@Composable
private fun PerKeyRow(
    key: NotificationKey,
    catId: String,
    byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    byKey: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    marketingOptIn: SnapshotStateMap<String, Boolean>,
) {
    val type = LocalKinfolkTypography.current
    val marketingGate = key.marketingCategory?.let { marketingOptIn[it.id] != true } == true

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = KinfolkSpacing.s),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
    ) {
        Text(key.title, style = type.sansLabel)
        Text(key.description, style = type.sansBody)
        if (marketingGate) {
            Text(
                "Enable the parent marketing opt-in above to receive this.",
                style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
            )
        }
        // Run-4 #13 + notification revamp: when the business operator LOCKS a
        // channel on, the kinfolk must read WHY the chip is required +
        // read-only, not just see an icon. The operator can author that reason
        // (lockReason); without one, a default line names the locked channels,
        // and a fully locked key reads as always-on. The dispatcher enforces
        // the same lock server-side, so this is purely an explanation.
        val lockLine = lockExplanation(key)
        if (lockLine != null) {
            Text(
                lockLine,
                style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            NotificationChannel.entries.forEach { ch ->
                if (ch !in key.allowedChannels) return@forEach
                // Run-4 #13: required/admin-locked channels are pinned ON. The
                // kinfolk sees them but can't change them (the server enforces
                // the same at dispatch), and byKey/byCategory writes never flip
                // them (see channelChipState). Only pinned-ON channels reach
                // here; a pinned-off channel is already hidden.
                val chip = channelChipState(
                    key = key,
                    ch = ch,
                    marketingGate = marketingGate,
                    perKey = byKey[key.key]?.get(ch.id),
                    perCat = byCategory[catId]?.get(ch.id),
                )
                KinChip(
                    label = chip.label,
                    selected = chip.checked,
                    onClick = {
                        if (chip.locked) return@KinChip
                        val map = byKey[key.key]?.toMutableMap() ?: mutableMapOf()
                        map[ch.id] = !chip.checked
                        byKey[key.key] = map
                    },
                    trailingIcon = when (chip.marker) {
                        ChipMarker.RequiredCheck -> Icons.Filled.Check
                        ChipMarker.AdminLock -> Icons.Filled.Lock
                        null -> null
                    },
                )
            }
        }
    }
}
