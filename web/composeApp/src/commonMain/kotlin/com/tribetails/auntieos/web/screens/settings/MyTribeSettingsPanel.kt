package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageCircle
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.HomeSectionCfg
import com.tribetails.auntieos.web.data.MyTribePortalConfig
import com.tribetails.auntieos.web.data.PortalBanner
import com.tribetails.auntieos.web.data.PortalChat
import com.tribetails.auntieos.web.data.PortalHome
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.theme.AuntieThemePreset
import com.tribetails.auntieos.web.theme.swatch
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.AuntieSettingRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.ThemeSwatchCard
import kotlinx.coroutines.launch
import com.composables.icons.lucide.Image
import com.composables.icons.lucide.PawPrint

/**
 * The "MyTribe" settings section: the single operator surface for customizing the
 * kinfolk portal (logo, color theme, top banner, Home layout, Message-Auntie chat).
 *
 * It edits one local copy of [BusinessSettings.mytribePortal], dirty-tracks against
 * the loaded doc, and persists with the SAME merge write the rest of Settings uses
 * (vm.saveSettings -> saveBusinessSettings, gitlive merge, isAuntie-gated). A doc
 * with no `mytribePortal` loads a default-constructed config, so a never-configured
 * install reads byte-identical to today and saving only adds the nested map.
 *
 * Themes here are the PORTAL's themeId (consumed by the MyTribe app's own catalog);
 * the swatch previews reuse the shared brand presets purely for the picker visuals.
 * This is distinct from AuntieOS's own Appearance staff-UI theme.
 */
@Composable
internal fun MyTribePanel(
    authUser: AuthUser,
    client: FirestoreClient,
    vm: SettingsViewModel,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    saveError: String?,
) {
    val c = AuntieTheme.colors

    // Edit state seeded from the loaded doc; re-seeds when the stream re-emits (after
    // a save the new doc flows back and clears the dirty pip).
    val loaded = settingsData?.mytribePortal ?: MyTribePortalConfig()
    var portal by remember(settingsData) { mutableStateOf(loaded) }

    var uploading by remember { mutableStateOf(false) }
    var uploadError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    val dirty = portal != loaded

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        // ── Portal logo ──
        PortalLogoCard(
            logoUrl = portal.logoUrl,
            uploading = uploading,
            uploadError = uploadError,
            onUpload = {
                uploading = true
                uploadError = null
                scope.launch {
                    // Reuse the existing Cloudinary image-upload path (same as the
                    // AuntieOS brand logo in BrandingPanel). The portal logo is just
                    // another business-scoped media asset.
                    when (val up = client.uploadMedia("business_settings", "BUSINESS", byteArrayOf(), "image/png")) {
                        is WriteResult.Err -> uploadError = "Logo upload failed: ${up.message}"
                        is WriteResult.Ok -> {
                            val media = up.value
                            if (media._id.isBlank() || media.storageUrl.isBlank()) {
                                uploadError = "No logo selected"
                            } else {
                                portal = portal.copy(logoUrl = media.storageUrl)
                            }
                        }
                    }
                    uploading = false
                }
            },
            onClear = { portal = portal.copy(logoUrl = "") },
        )

        // ── Theme ──
        PortalThemeCard(
            themeId = portal.themeId,
            isDark = c.isDark,
            onSelect = { portal = portal.copy(themeId = it) },
        )

        // ── Banner ──
        PortalBannerCard(
            banner = portal.banner,
            onChange = { portal = portal.copy(banner = it) },
        )

        // ── Home layout ──
        PortalHomeCard(
            home = portal.home,
            onChange = { portal = portal.copy(home = it) },
        )

        // ── Message Auntie chat ──
        PortalChatCard(
            chat = portal.chat,
            onChange = { portal = portal.copy(chat = it) },
        )

        // ── Single save bar for the whole section ──
        saveError?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        AuntieSaveBar(
            dirty = dirty,
            saveEnabled = dirty && !saving && settingsLoaded,
            onCancel = {
                portal = loaded
                uploadError = null
            },
            onSave = {
                saving = true
                scope.launch {
                    // Overlay onto the freshly-loaded doc so the merge write never
                    // clobbers a sibling field.
                    val toSave = (settingsData ?: BusinessSettings()).copy(mytribePortal = portal)
                    vm.saveSettings(toSave)
                    saving = false
                }
            },
            dirtyLabel = "Unsaved MyTribe settings",
            savedLabel = "MyTribe settings saved",
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Portal logo
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PortalLogoCard(
    logoUrl: String,
    uploading: Boolean,
    uploadError: String?,
    onUpload: () -> Unit,
    onClear: () -> Unit,
) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Portal logo",
        subtitle = "Shown beside the MyTribe wordmark in your kinfolk portal. Leave blank for the wordmark only.",
        trailing = { AuntieStatusPill(label = "MyTribe", tone = AuntieStatusTone.Purple, mono = true) },
    ) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                AuntieAvatar(
                    imageUrl = logoUrl.ifBlank { null },
                    glyph = Lucide.PawPrint,
                    size = 56.dp,
                    shape = RoundedCornerShape(16.dp),
                    gradientSeed = "MyTribe",
                )
                Column(modifier = Modifier.weight(1f)) {
                    GhostButton(
                        label = when {
                            uploading -> "Uploading logo"
                            logoUrl.isBlank() -> "Upload logo"
                            else -> "Replace logo"
                        },
                        enabled = !uploading,
                        onClick = onUpload,
                        leading = {
                            Icon(Lucide.Image, contentDescription = null, tint = c.textDim, modifier = Modifier.size(14.dp))
                        },
                    )
                    if (logoUrl.isNotBlank()) {
                        Spacer(Modifier.height(8.dp))
                        GhostButton(label = "Remove logo", enabled = !uploading, onClick = onClear)
                    }
                }
            }
            uploadError?.let { msg ->
                Spacer(Modifier.height(10.dp))
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Logo upload failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun PortalThemeCard(
    themeId: String,
    isDark: Boolean,
    onSelect: (String) -> Unit,
) {
    DenPanel(
        title = "Theme",
        subtitle = "The color set kinfolk see across the portal. Midnight is a dark theme.",
    ) {
        androidx.compose.foundation.layout.FlowRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            AuntieThemePreset.entries.forEach { preset ->
                val sw = preset.swatch(isDark)
                ThemeSwatchCard(
                    label = preset.label,
                    dominant = sw.dominant,
                    accent = sw.accent,
                    selected = preset.key == themeId,
                    blurb = preset.blurb,
                    onClick = { onSelect(preset.key) },
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Banner
// ─────────────────────────────────────────────────────────────────────────────

private val BANNER_TONES = listOf("info", "success", "warning", "alert")
private val DISMISS_MODES = listOf("none", "perDevice", "perUser")

private fun bannerPreviewTone(tone: String): AuntieBannerTone = when (tone) {
    "success" -> AuntieBannerTone.Success
    "warning" -> AuntieBannerTone.Warning
    "alert" -> AuntieBannerTone.Error
    else -> AuntieBannerTone.Info
}

private fun dismissModeLabel(mode: String): String = when (mode) {
    "perDevice" -> "Per device"
    "perUser" -> "Per kinfolk"
    else -> "Not dismissible"
}

@Composable
private fun PortalBannerCard(
    banner: PortalBanner,
    onChange: (PortalBanner) -> Unit,
) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Banner",
        subtitle = "A message bar at the top of the portal. Edit the message to re-show it to kinfolk who dismissed an earlier one.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieSettingRow(
                title = "Show banner",
                description = "Display the message bar to all kinfolk.",
                showDivider = false,
                trailing = {
                    AuntieToggle(
                        checked = banner.enabled,
                        onCheckedChange = { onChange(banner.copy(enabled = it)) },
                    )
                },
            )

            MultilineField(
                value = banner.message,
                onValueChange = { msg ->
                    // Bump the stable id whenever the message changes so an edited
                    // banner re-shows to kinfolk who dismissed the previous one.
                    val nextId = if (msg != banner.message) bumpBannerId(banner.id) else banner.id
                    onChange(banner.copy(message = msg, id = nextId))
                },
                label = "Message",
                placeholder = "We'll be closed for the holiday weekend.",
                modifier = Modifier.fillMaxWidth(),
            )

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Tone", style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                SegmentedPicker(
                    options = BANNER_TONES,
                    selected = banner.tone.ifBlank { "info" },
                    onSelect = { onChange(banner.copy(tone = it)) },
                    label = { it.replaceFirstChar { ch -> ch.uppercaseChar() } },
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Dismissible", style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                Text(
                    "Whether kinfolk can close the banner, and whether that sticks per device or per person.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                SegmentedPicker(
                    options = DISMISS_MODES,
                    selected = banner.dismissMode.ifBlank { "none" },
                    onSelect = { onChange(banner.copy(dismissMode = it)) },
                    label = { dismissModeLabel(it) },
                )
            }

            // Live preview of how kinfolk will see it.
            if (banner.enabled && banner.message.isNotBlank()) {
                Text("Preview", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                AuntieBanner(
                    tone = bannerPreviewTone(banner.tone),
                    onDismiss = if (banner.dismissMode != "none") ({}) else null,
                ) {
                    Text(banner.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
    }
}

/** Bump a banner id to a fresh stable value (b1 -> b2 ...). Blank -> "b1". */
private fun bumpBannerId(current: String): String {
    val n = current.removePrefix("b").toIntOrNull() ?: 0
    return "b${n + 1}"
}

// ─────────────────────────────────────────────────────────────────────────────
// Home layout
// ─────────────────────────────────────────────────────────────────────────────

// The canonical Home sections in their default order. A doc with no `home.sections`
// renders this default; the operator can reorder, disable, and limit them.
private val DEFAULT_HOME_SECTIONS = listOf("liveVisit", "upNext", "tales", "roster", "quickStart")

private fun homeSectionLabel(id: String): String = when (id) {
    "liveVisit" -> "Live visit"
    "upNext" -> "Up next"
    "tales" -> "Tales"
    "roster" -> "Roster"
    "quickStart" -> "Quick start"
    else -> id
}

/** Sections that support a per-section item limit (count). */
private val LIMITED_SECTIONS = setOf("upNext", "tales", "roster")

/** The effective ordered section list: the saved config, or the default order when
 *  empty (back-compat). Any missing canonical section is appended enabled. */
private fun effectiveSections(home: PortalHome): List<HomeSectionCfg> {
    if (home.sections.isEmpty()) {
        return DEFAULT_HOME_SECTIONS.map { HomeSectionCfg(id = it, enabled = true, limit = 0) }
    }
    val present = home.sections.map { it.id }.toSet()
    val missing = DEFAULT_HOME_SECTIONS.filter { it !in present }.map { HomeSectionCfg(id = it, enabled = true, limit = 0) }
    return home.sections + missing
}

@Composable
private fun PortalHomeCard(
    home: PortalHome,
    onChange: (PortalHome) -> Unit,
) {
    val c = AuntieTheme.colors
    val sections = effectiveSections(home)
    DenPanel(
        title = "Home layout",
        subtitle = "Reorder, show or hide, and limit the sections on the kinfolk Home screen.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            sections.forEachIndexed { index, cfg ->
                HomeSectionRow(
                    cfg = cfg,
                    isFirst = index == 0,
                    isLast = index == sections.lastIndex,
                    onMoveUp = {
                        val next = sections.toMutableList()
                        val tmp = next[index - 1]; next[index - 1] = next[index]; next[index] = tmp
                        onChange(home.copy(sections = next))
                    },
                    onMoveDown = {
                        val next = sections.toMutableList()
                        val tmp = next[index + 1]; next[index + 1] = next[index]; next[index] = tmp
                        onChange(home.copy(sections = next))
                    },
                    onToggle = { enabled ->
                        val next = sections.toMutableList()
                        next[index] = cfg.copy(enabled = enabled)
                        onChange(home.copy(sections = next))
                    },
                    onLimit = { limit ->
                        val next = sections.toMutableList()
                        next[index] = cfg.copy(limit = limit)
                        onChange(home.copy(sections = next))
                    },
                )
            }
        }
    }
}

@Composable
private fun HomeSectionRow(
    cfg: HomeSectionCfg,
    isFirst: Boolean,
    isLast: Boolean,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onLimit: (Int) -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Up/down reorder.
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            ReorderButton(icon = Lucide.ArrowUp, enabled = !isFirst, onClick = onMoveUp, contentDescription = "Move up")
            ReorderButton(icon = Lucide.ArrowDown, enabled = !isLast, onClick = onMoveDown, contentDescription = "Move down")
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(homeSectionLabel(cfg.id), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            if (cfg.id in LIMITED_SECTIONS) {
                Text(
                    if (cfg.limit > 0) "Showing up to ${cfg.limit}" else "Showing the default count",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                )
            }
        }
        if (cfg.id in LIMITED_SECTIONS) {
            BottomBorderField(
                value = if (cfg.limit > 0) cfg.limit.toString() else "",
                onValueChange = { onLimit(it.filter { ch -> ch.isDigit() }.toIntOrNull() ?: 0) },
                label = "",
                placeholder = "Limit",
                keyboardType = KeyboardType.Number,
                modifier = Modifier.size(width = 72.dp, height = 44.dp),
            )
        }
        AuntieToggle(checked = cfg.enabled, onCheckedChange = onToggle, compact = true)
    }
}

@Composable
private fun ReorderButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
    contentDescription: String,
) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(20.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (enabled) c.surface2 else c.surface2.copy(alpha = 0.4f))
            .then(
                if (enabled) Modifier.clickableNoRipple(onClick) else Modifier,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = if (enabled) c.textDim else c.textFaint,
            modifier = Modifier.size(13.dp),
        )
    }
}

/** No-ripple click, matching the SectionNav rows in SettingsScreen. */
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    this.clickable(
        interactionSource = MutableInteractionSource(),
        indication = null,
        onClick = onClick,
    )

// ─────────────────────────────────────────────────────────────────────────────
// Message Auntie chat
// ─────────────────────────────────────────────────────────────────────────────

private val CHAT_DAYS = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

@Composable
private fun PortalChatCard(
    chat: PortalChat,
    onChange: (PortalChat) -> Unit,
) {
    val c = AuntieTheme.colors
    DenPanel(
        title = "Message Auntie chat",
        subtitle = "Whether kinfolk can message you from the portal, plus availability and limits.",
        trailing = { Icon(Lucide.MessageCircle, contentDescription = null, tint = c.textDim, modifier = Modifier.size(18.dp)) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieSettingRow(
                title = "Allow messaging",
                description = "Kinfolk can start a chat with Auntie from the portal.",
                showDivider = false,
                trailing = {
                    AuntieToggle(checked = chat.enabled, onCheckedChange = { onChange(chat.copy(enabled = it)) })
                },
            )

            MultilineField(
                value = chat.awayMessage,
                onValueChange = { onChange(chat.copy(awayMessage = it)) },
                label = "Away message",
                placeholder = "I'll reply as soon as I'm back. Thanks for your patience!",
                modifier = Modifier.fillMaxWidth(),
            )

            AuntieSettingRow(
                title = "Set messaging hours",
                description = "Outside these hours, kinfolk see your away message.",
                showDivider = false,
                trailing = {
                    AuntieToggle(
                        checked = chat.hoursEnabled,
                        onCheckedChange = { onChange(chat.copy(hoursEnabled = it)) },
                    )
                },
            )

            if (chat.hoursEnabled) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    CHAT_DAYS.forEach { day ->
                        val current = chat.hours[day] ?: ""
                        val malformed = current.isNotBlank() && !CHAT_HOURS_REGEX.matches(current.trim())
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                day.take(3),
                                style = AuntieTheme.typography.labelSmall,
                                color = c.textDim,
                                modifier = Modifier.size(width = 36.dp, height = 20.dp),
                            )
                            BottomBorderField(
                                value = current,
                                onValueChange = { onChange(chat.copy(hours = chat.hours + (day to it))) },
                                label = "",
                                placeholder = "09:00-17:00 or blank if closed",
                                modifier = Modifier.weight(1f),
                            )
                            if (malformed) {
                                AuntieStatusPill(label = "Check format", tone = AuntieStatusTone.Warning, mono = true)
                            }
                        }
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                BottomBorderField(
                    value = if (chat.maxMessageLength > 0) chat.maxMessageLength.toString() else "",
                    onValueChange = { onChange(chat.copy(maxMessageLength = it.filter { ch -> ch.isDigit() }.toIntOrNull() ?: 0)) },
                    label = "Max message length",
                    placeholder = "2000",
                    keyboardType = KeyboardType.Number,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    value = if (chat.rateLimitPerHour > 0) chat.rateLimitPerHour.toString() else "",
                    onValueChange = { onChange(chat.copy(rateLimitPerHour = it.filter { ch -> ch.isDigit() }.toIntOrNull() ?: 0)) },
                    label = "Messages per hour (0 = unlimited)",
                    placeholder = "0",
                    keyboardType = KeyboardType.Number,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

private val CHAT_HOURS_REGEX = Regex("""^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$""")
