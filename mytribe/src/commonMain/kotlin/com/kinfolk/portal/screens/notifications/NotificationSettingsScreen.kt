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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
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
import com.kinfolk.portal.portal.NotificationPrefsPatch
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.applyNotificationPrefsPatch
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlin.coroutines.cancellation.CancellationException
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
 * Saving (#1292): every tap saves on its own, pessimistically. Nothing on
 * screen changes until the server confirms; while the write is out every chip
 * is disabled and a "Saving…" cue shows; a failure leaves the chip where it was
 * and says so. The write is a PATCH naming only what the tap changed (see
 * NotificationPrefsPatch), so it can never rewrite a choice made elsewhere.
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
 * operator's lockReason when one exists (else the stock "Set by Tribe Tails
 * Pet Care. Can't be changed here." line — #451: never "Always on", which this
 * screen has no standing to promise). A fully locked key gets that same
 * sentence, and the category "select all" row only offers channels some key can
 * actually toggle (see NotificationLockDisplay.kt for the pure rules).
 */
@Composable
fun NotificationSettingsScreen(
    familyName: String,
    portalApi: PortalApi,
    notificationCatalog: NotificationCatalogRepository? = null,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()

    // `loaded` means the request FINISHED; `prefsLoaded` means it succeeded and
    // the three maps below hold real server state. They are separate on
    // purpose. Task 27b/I3: the catch used to set `loaded = true` too, so a
    // failed load rendered the editor and a live Save button over three empty
    // maps — and an empty map is not "no change" on the wire, it goes into the
    // Firestore update mask like any other value, so one click wiped the whole
    // preference document. Nothing may reach saveMyNotificationPrefs until
    // prefsLoaded is true.
    var loaded by remember { mutableStateOf(false) }
    var prefsLoaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }

    val byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>> = remember { mutableStateMapOf() }
    // Task 27a model: byKey is an override, absence means inherit — a key
    // channel is on, off, or inheriting, and a kinfolk must be able to get
    // back to inheriting. PerKeyRow's chip toggle does double duty: setting a
    // channel to the value it would already inherit clears the entry instead
    // of pinning an explicit duplicate of it (see channelInheritedChecked in
    // NotificationLockDisplay.kt). CategoryChannelRow's "All in category"
    // chips never touch this map: byKey always wins over byCategory, both
    // server-side (prefs.ts explicitUserChoice) and in channelChipState, so a
    // category change only changes what UNoverridden keys inherit. Web's
    // NotificationSettings.tsx implements the identical model.
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
    // One tap, one write. The maps change only after the server says ok, so a
    // failed save leaves the screen showing what is really stored.
    val savePatch: (NotificationPrefsPatch) -> Unit = { patch ->
        if (!saving && prefsLoaded) {
            saving = true
            status = null
            saveError = null
            scope.launch {
                try {
                    portalApi.saveMyNotificationPrefs(patch)
                    applyNotificationPrefsPatch(patch, byCategory, byKey, marketingOptIn)
                    status = "Saved."
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    saveError = "Couldn't save that change: ${t.message ?: t}. It is back where it was."
                } finally {
                    saving = false
                }
            }
        }
    }

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
            prefsLoaded = true
            error = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            error = t.message ?: "Could not load preferences"
            loaded = true
            prefsLoaded = false
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
        if (!prefsLoaded) {
            // The load failed. Show why and stop: no editor, no Save. Rendering
            // the empty maps as if they were the kinfolk's choices, over a Save
            // button that would then persist them, is the one outcome worse
            // than an error message. Web does the same thing by short-circuiting
            // to <LaunchError> on prefs.isError.
            return@Column
        }

        if (catalogWarning != null) {
            Text(
                catalogWarning!!,
                style = type.sansLabel.copy(color = KinfolkBrand.PackPink),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }

        MarketingOptInBlock(marketingOptIn = marketingOptIn, saving = saving, onPatch = savePatch)

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
                saving = saving,
                onPatch = savePatch,
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

        if (saving) {
            Row(
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l).testTag("notif-saving"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                KinSpinner(size = 18.dp)
                Text("Saving your change…", style = type.sansLabel)
            }
        }
        if (status != null && !saving) {
            Text(
                status!!,
                style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
            )
        }
        if (saveError != null && !saving) {
            Text(
                saveError!!,
                style = type.sansLabel.copy(color = KinfolkBrand.PackPink),
                modifier = Modifier.padding(horizontal = KinfolkSpacing.l).testTag("notif-save-error"),
            )
        }
        Text(
            "Each change saves as soon as you make it.",
            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
            modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
        )
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

@Composable
private fun MarketingOptInBlock(
    marketingOptIn: SnapshotStateMap<String, Boolean>,
    saving: Boolean,
    onPatch: (NotificationPrefsPatch) -> Unit,
) {
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
                        onClick = { onPatch(NotificationPrefsPatch(marketingOptIn = mapOf(mc.id to !selected))) },
                        enabled = !saving,
                        modifier = Modifier.testTag("mkt-chip-${mc.id}"),
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
    saving: Boolean,
    onPatch: (NotificationPrefsPatch) -> Unit,
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
                CategoryChannelRow(cat = cat, byCategory = byCategory, saving = saving, onPatch = onPatch)
            }

            if (isExpanded) {
                cat.keys.forEach { key ->
                    PerKeyRow(
                        key = key,
                        catId = cat.id,
                        byCategory = byCategory,
                        byKey = byKey,
                        marketingOptIn = marketingOptIn,
                        saving = saving,
                        onPatch = onPatch,
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
    saving: Boolean,
    onPatch: (NotificationPrefsPatch) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    // Notification revamp: only offer "select all" chips for channels at least
    // one key can actually toggle. A channel that is locked (or required) on
    // every key would be a dead chip: it writes byCategory, but the locked key
    // chips below stay on regardless, so the row would visually contradict
    // them. When NOTHING in the category is toggleable, say so instead of
    // rendering a dead row.
    val setByBusinessNote = categorySetByBusinessNote(cat)
    if (setByBusinessNote != null) {
        Text(
            setByBusinessNote,
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
        CategoryRowLabel(cat.id)
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            NotificationChannel.entries.forEach { ch ->
                if (ch !in channelsInCategory) return@forEach
                // Same default as the web screen and the dispatcher: an unset
                // channel reads email-on, everything else off. This used to read
                // `== true`, so an untouched Email chip drew OFF here while the
                // household was in fact getting email.
                val current = byCategory[cat.id]?.get(ch.id) ?: (ch == NotificationChannel.EMAIL)
                KinChip(
                    label = ch.label,
                    selected = current,
                    onClick = {
                        onPatch(NotificationPrefsPatch(byCategory = mapOf(cat.id to mapOf(ch.id to !current))))
                    },
                    enabled = !saving,
                    modifier = Modifier.testTag("catchip-${cat.id}-${ch.id}"),
                )
            }
        }
    }
}

/**
 * "All in category:" with an info icon. The note that a key's own channel choice
 * survives this control used to sit under the chips as a line of text; the
 * operator ruled (2026-09-11) that panels carry no explanatory copy, so it lives
 * behind the icon and shows on tap (#1359). Task 27a defect #2 is why it exists:
 * byKey always wins over byCategory, so this row only moves keys with no choice
 * of their own.
 */
@Composable
private fun CategoryRowLabel(catId: String) {
    val type = LocalKinfolkTypography.current
    var showNote by remember { mutableStateOf(false) }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
            Text("All in category:", style = type.sansLabel)
            Icon(
                imageVector = Icons.Filled.Info,
                contentDescription = "About this switch: $CATEGORY_OVERRIDE_NOTE",
                tint = KinfolkBrand.NavyMuted,
                modifier = Modifier
                    .size(18.dp)
                    .testTag("catinfo-$catId")
                    .clickable { showNote = !showNote },
            )
        }
        if (showNote) {
            Text(
                CATEGORY_OVERRIDE_NOTE,
                style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                modifier = Modifier.testTag("catinfo-note-$catId"),
            )
        }
    }
}

internal const val CATEGORY_OVERRIDE_NOTE = "Keys below with their own channel choice won't change when you flip this."

@Composable
private fun PerKeyRow(
    key: NotificationKey,
    catId: String,
    byCategory: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    byKey: SnapshotStateMap<String, MutableMap<String, Boolean>>,
    marketingOptIn: SnapshotStateMap<String, Boolean>,
    saving: Boolean,
    onPatch: (NotificationPrefsPatch) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val marketingGate = key.marketingCategory?.let { marketingOptIn[it.id] != true } == true

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = KinfolkSpacing.s),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
    ) {
        Text(key.title, style = type.sansLabel)
        keyDescriptionLine(key)?.let { Text(it, style = type.sansBody) }
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
                        // Task 27a: if this click recreates the value the
                        // channel would inherit anyway, clear the override
                        // (see channelInheritedChecked) instead of pinning
                        // an explicit duplicate of it — otherwise the key
                        // would silently stop following future category
                        // changes with no way back.
                        val next = !chip.checked
                        val inherited = channelInheritedChecked(
                            key = key,
                            ch = ch,
                            perCat = byCategory[catId]?.get(ch.id),
                        )
                        // Clearing is sent as a null channel; the server drops the entry.
                        onPatch(
                            NotificationPrefsPatch(
                                byKey = mapOf<String, Map<String, Boolean?>?>(
                                    key.key to mapOf<String, Boolean?>(ch.id to if (next == inherited) null else next),
                                ),
                            ),
                        )
                    },
                    enabled = !saving,
                    trailingIcon = when (chip.marker) {
                        ChipMarker.RequiredCheck -> Icons.Filled.Check
                        ChipMarker.AdminLock -> Icons.Filled.Lock
                        null -> null
                    },
                    modifier = Modifier.testTag("perkey-chip-${key.key}-${ch.id}"),
                )
            }
        }
    }
}
