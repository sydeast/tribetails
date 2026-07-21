package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
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
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.LocalTime

/**
 * DenScreenKit: the shared Den-redesign vocabulary, ported from the web app so
 * Android and Web speak the same visual language: a mono kicker + serif page
 * heading, brand-toned stat cards, glass section panels with a serif title,
 * service pills, and a quiet empty hint. Screens compose these instead of
 * re-inventing layout, which keeps the whole app reading as one Den.
 */

// ── page heading ────────────────────────────────────────────────────────────

/**
 * The standard Den page heading: a small uppercase mono [kicker] in brand
 * orange, then a large serif [title] with an optional italic [accentTail]
 * (the word painted in primary), and an optional [subtitle] blurb.
 */
@Composable
fun DenScreenHeading(
    kicker: String,
    title: String,
    modifier: Modifier = Modifier,
    accentTail: String? = null,
    subtitle: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
        Column(Modifier.weight(1f)) {
            Text(
                text = kicker.uppercase(),
                style = AuntieTheme.typography.mono.copy(letterSpacing = 1.6.sp, fontSize = 11.sp),
                color = c.primary,
            )
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    text = if (accentTail != null) "$title " else title,
                    style = AuntieTheme.typography.displayMedium,
                    color = c.textPrimary,
                )
                if (accentTail != null) {
                    Text(
                        text = accentTail,
                        style = AuntieTheme.typography.displayMedium.copy(fontStyle = FontStyle.Italic),
                        color = c.primary,
                    )
                }
            }
            if (subtitle != null) {
                Spacer(Modifier.height(6.dp))
                Text(subtitle, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
            }
        }
        if (trailing != null) {
            Spacer(Modifier.height(0.dp))
            trailing()
        }
    }
}

// ── stat card ────────────────────────────────────────────────────────────────

/**
 * A Den stat card: small label, big value, trend subline, tone accent. The
 * [feature] variant fills with a faint tone wash and paints the value in the
 * tone color, mirroring the redesign hero stat. Lifts when [onClick] is set
 * and hovered (no-op on touch; kept for surface parity).
 */
@Composable
fun StatCard(
    label: String,
    value: String,
    trend: String,
    tone: AuntieStatusTone,
    modifier: Modifier = Modifier,
    feature: Boolean = false,
    onClick: (() -> Unit)? = null,
    // 17.3 alive-widgets: when set, the value rolls up from 0 with [formatValue]
    // instead of rendering [value] statically. Callers keep passing [value] for
    // loading/error placeholders; the roll only plays over real numbers.
    numericValue: Double? = null,
    formatValue: ((Double) -> String)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val shape = RoundedCornerShape(16.dp)
    val toneColor = tone.color(c)
    // Non-feature cards keep the flat glass fill. The feature card uses a base fill
    // plus a radial orange wash painted in drawBehind (item 2: the hero stat).
    val fill by animateColorAsState(
        if (feature) c.surfaceGlass else if (hovered) c.surface else c.surfaceGlass,
        label = "statFill",
    )
    val borderColor by animateColorAsState(
        if (hovered) toneColor.copy(alpha = 0.5f) else if (feature) toneColor.copy(alpha = 0.35f) else c.border,
        label = "statBorder",
    )
    val lift by animateDpAsState(if (hovered && onClick != null) (-3).dp else 0.dp, label = "statLift")

    Box(
        modifier = modifier
            .offset(y = lift)
            .clip(shape)
            .background(fill)
            .then(
                if (feature) Modifier.drawBehind {
                    drawRect(
                        brush = Brush.radialGradient(
                            colors = listOf(toneColor.copy(alpha = 0.30f), Color.Transparent),
                            center = Offset(size.width, 0f),
                            radius = size.width * 0.95f,
                        ),
                    )
                } else Modifier,
            )
            .border(dims.borderHairline, borderColor, shape)
            .then(if (onClick != null) Modifier.clickable(interaction, indication = null, onClick = onClick) else Modifier)
            .padding(16.dp),
    ) {
        if (feature) {
            Icon(
                imageVector = Lucide.PawPrint,
                contentDescription = null,
                tint = toneColor,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(78.dp)
                    .alpha(0.16f)
                    // 17.3 alive-widgets: the watermark breathes so the hero
                    // stat is never completely static.
                    .breathe(),
            )
        }
        Column {
            Text(label, style = AuntieTheme.typography.labelSmall, color = c.textDim)
            Spacer(Modifier.height(8.dp))
            val valueStyle = if (feature) {
                AuntieTheme.typography.displayLarge.copy(fontSize = 52.sp, fontWeight = FontWeight.SemiBold)
            } else {
                AuntieTheme.typography.headlineLarge.copy(fontWeight = FontWeight.SemiBold)
            }
            val valueColor = if (feature) toneColor else c.textPrimary
            if (numericValue != null && formatValue != null) {
                CountUpText(target = numericValue, format = formatValue, style = valueStyle, color = valueColor)
            } else {
                Text(value, style = valueStyle, color = valueColor)
            }
            Spacer(Modifier.height(6.dp))
            Text(trend, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

// ── section panel ──────────────────────────────────────────────────────────

/**
 * A glass section panel with a serif [title], optional [subtitle] and [trailing]
 * slot in the header, then arbitrary [content]. The workhorse container for the
 * redesign's two-column dashboards and stacked detail pages.
 */
@Composable
fun DenPanel(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    cornerRadius: Dp = 18.dp,
    contentPadding: Dp = 20.dp,
    // #12/#13 (2026-06-08): opt-in collapsible panel (parity with web). Default
    // false keeps every existing call site identical.
    collapsible: Boolean = false,
    initiallyExpanded: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    var expanded by remember { mutableStateOf(initiallyExpanded) }
    val showContent = !collapsible || expanded
    GlassSurface(cornerRadius = cornerRadius, modifier = modifier) {
        Column(Modifier.padding(contentPadding)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = if (collapsible) {
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { expanded = !expanded }
                } else {
                    Modifier.fillMaxWidth()
                },
            ) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = AuntieTheme.typography.headlineSmall, color = c.textPrimary)
                    if (subtitle != null) {
                        Spacer(Modifier.height(4.dp))
                        Text(subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
                if (trailing != null) trailing()
                if (collapsible) {
                    Icon(
                        imageVector = if (expanded) Lucide.ChevronDown else Lucide.ChevronRight,
                        contentDescription = if (expanded) "Collapse" else "Expand",
                        tint = c.textDim,
                        modifier = Modifier.padding(start = 8.dp).size(20.dp),
                    )
                }
            }
            if (showContent) {
                Spacer(Modifier.height(14.dp))
                content()
            }
        }
    }
}

// ── service pill ─────────────────────────────────────────────────────────────

/** A small lowercase mono pill tinted to a service [tone]. */
@Composable
fun ServicePill(serviceType: String, tone: AuntieStatusTone = serviceTone(serviceType)) {
    val c = AuntieTheme.colors
    val t = tone.color(c)
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(t.copy(alpha = 0.14f))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Text(
            serviceType.ifBlank { "visit" }.lowercase(),
            style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp), color = t,
        )
    }
}

// ── empty / hint line ──────────────────────────────────────────────────────

/** A quiet inline hint line for loading / empty / error states inside a panel. */
@Composable
fun EmptyHint(text: String, error: Boolean = false) {
    val c = AuntieTheme.colors
    Text(
        text,
        style = AuntieTheme.typography.bodySmall,
        color = if (error) c.error else c.textDim,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

// ── shared helpers ───────────────────────────────────────────────────────────

/** Hour-of-day [0..23] from the device clock, defaulting to 9 if unavailable. */
fun denCurrentHour(): Int = runCatching { LocalTime.now().hour }.getOrDefault(9)

/** "Good morning/afternoon/evening" for an hour-of-day. */
fun greetingForHour(hour: Int): String = when (hour) {
    in 0..11 -> "Good morning"
    in 12..16 -> "Good afternoon"
    else -> "Good evening"
}

/** Maps a free-text service type to a brand tone for pills / avatars. */
/**
 * Matches "sit" only at a word start, so it catches "House Sit" and "Pet
 * Sitting" but NOT the "sit" buried inside "vi-sit". Bare `"sit" in s` painted
 * every visit house-sitting purple (AO-19). Mirrors the web DenScreenKit.
 */
private val SIT_WORD = Regex("""\bsit""")

fun serviceTone(serviceType: String): AuntieStatusTone {
    val s = serviceType.lowercase()
    return when {
        "walk" in s -> AuntieStatusTone.Teal
        "drop" in s -> AuntieStatusTone.Orange
        SIT_WORD.containsMatchIn(s) || "house" in s || "overnight" in s -> AuntieStatusTone.Purple
        "meet" in s || "greet" in s -> AuntieStatusTone.Success
        else -> AuntieStatusTone.Orange
    }
}

/** Human label for a KinCare session status. */
fun statusLabel(status: String): String = when (status.uppercase()) {
    "COMPLETED" -> "done"
    "ON_MY_WAY" -> "on the way"
    "ARRIVED" -> "arrived"
    "DEPARTED" -> "departed"
    "CANCELLED" -> "cancelled"
    else -> "scheduled"
}

/** Formats an ISO timestamp to a compact "h:mma/p" local-ish time, or echoes input. */
fun formatTime(iso: String): String = runCatching {
    if (iso.length < 16) return iso
    val hour = iso.substring(11, 13).toInt()
    val minute = iso.substring(14, 16)
    val ampm = if (hour >= 12) "p" else "a"
    val hour12 = when (hour % 12) { 0 -> 12; else -> hour % 12 }
    "$hour12:$minute$ampm"
}.getOrDefault(iso)
