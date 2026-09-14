package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Info
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.theme.KinfolkOrange
import java.time.LocalTime

/**
 * DenScreenKit: the shared Den-redesign vocabulary, ported from the web app so
 * Android and Web speak the same visual language: a mono kicker + serif page
 * heading, brand-toned stat cards, glass section panels with a serif title,
 * service pills, and a quiet empty hint. Screens compose these instead of
 * re-inventing layout, which keeps the whole app reading as one Den.
 */

// ── breadcrumbs ─────────────────────────────────────────────────────────────

/**
 * One step of a breadcrumb trail. [onClick] null means this is the page you are
 * ON: it renders as plain text and takes no tap, because a tappable crumb for
 * the current page promises a journey it cannot make.
 */
data class DenCrumb(val label: String, val onClick: (() -> Unit)? = null)

/** Separators sit BETWEEN steps, so a trail of n has n-1 of them (never -1). */
fun crumbSeparatorCount(crumbs: Int): Int = if (crumbs <= 1) 0 else crumbs - 1

/**
 * The mocks' `.crumbs`, the Android twin of `DenBreadcrumbs` in
 * `src/components/DenScreenKit.tsx`: mono, 12px, dim cream, a slash between
 * steps, the current page in full cream.
 *
 * The slash is `clearAndSetSemantics {}` rather than merely unlabelled: without
 * it TalkBack reads "Directory slash the Wrens slash Members and invites" and
 * three destinations arrive as one sentence.
 */
@Composable
fun DenBreadcrumbs(crumbs: List<DenCrumb>, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        crumbs.forEachIndexed { i, crumb ->
            val onClick = crumb.onClick
            Text(
                text = crumb.label,
                style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
                color = if (onClick == null) c.textPrimary else c.textDim,
                modifier = if (onClick == null) Modifier else Modifier.clickable(onClick = onClick),
            )
            if (i < crumbs.size - 1) {
                Text(
                    text = "/",
                    style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
                    color = c.textFaint,
                    modifier = Modifier
                        .padding(horizontal = 6.dp)
                        .clearAndSetSemantics {},
                )
            }
        }
    }
}

// ── the subtitle tooltip ────────────────────────────────────────────────────

/**
 * The info affordance that replaced the subtitle line (#752, web PR in the same
 * change).
 *
 * "why are there so many unneeded subheadings. at most they can be tool tips,
 * otherwise they are making the ui too busy with unneccessary text" (operator,
 * 2026-09-11). Every panel and every page heading in the admin carried a
 * sentence of explanation. The sentence is still worth having the first time
 * you meet a screen, so it moves behind a hairline "i": long-press or hover the
 * button on the way past, or tap it outright, and the tooltip appears.
 *
 * The icon's own content description is the EXPLANATION, not "About this
 * section" as on web. Compose has no `aria-describedby`, so a generic label
 * would make the sentence reachable by sighted touch only; putting it on the
 * icon keeps TalkBack hearing it the way a web screen reader hears the
 * description on the title.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DenInfoTip(text: String, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val state = rememberTooltipState()
    val scope = rememberCoroutineScope()
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(text, style = AuntieTheme.typography.bodySmall) } },
        state = state,
        modifier = modifier,
    ) {
        IconButton(
            // TooltipBox already answers long-press and hover. A tap has to be
            // wired by hand, and without it the tip is a gesture nobody finds.
            onClick = { scope.launch { state.show() } },
            modifier = Modifier.size(24.dp),
        ) {
            Icon(
                imageVector = Lucide.Info,
                contentDescription = text,
                tint = c.textDim,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

// ── page heading ────────────────────────────────────────────────────────────

/** The mocks' `.hero` corner: one radius step rounder than a panel (24 over 20). */
private val HeroBandShape = RoundedCornerShape(24.dp)

/**
 * The standard Den page heading, and since #780 the mocks' HERO BAND, which
 * is what every Android sweep of 2026-09-11 reported it could not draw: a
 * small uppercase mono [kicker] in brand orange (or the [crumbs] trail in its
 * place), then a large serif [title] with an optional italic [accentTail]
 * (the word painted in primary), an info button carrying the [subtitle]
 * explanation, and an optional [detail] value line, all on the band the mocks
 * draw and the web `.den-heading` has painted since #759.
 *
 * THE BAND. The panel gradient (the same surface-to-surface-2 fall
 * `GlassSurface` takes) lit from the top-left corner by a wide radial of
 * Kinfolk Orange at 26%, on a hairline, at 24dp, 22dp inside. The orange is
 * the `KinfolkOrange` constant rather than the role token: the mocks'
 * `rgba(223,132,49,.26)` is the brand orange itself, and the wash is the
 * band's continuation of the orange orb behind the same corner. Until #780
 * this was a bare Row, the one kit piece that drew no surface at all.
 *
 * THE SLOTS, the same three as web's `leading`, `badges` and `children`:
 *  - [leading] sits before the title block and never shrinks: the profile
 *    mocks' hero photo or avatar tile. The caller sizes it (84dp on the
 *    kinfolk profile, the kin detail mock draws 120).
 *  - [content] is a second line under the detail: the kin detail's "belongs
 *    to the Wrens". Prose, not pills.
 *  - [badges] is the mocks' `.hero .tags`, a wrapping row of
 *    `AuntieStatusPill` last in the title block. The band draws the gaps; the
 *    caller passes the pills (and at most a small control that edits them)
 *    with no row of its own.
 *
 * WHERE [trailing] GOES. Beside the title, as it always has, on a heading
 * with no [leading]: the list screens' one or two buttons fit there and
 * thirteen call sites lay out that way. On a heading WITH a [leading] it
 * goes under the title block, full width, wrapping: that is a profile band,
 * the mocks' own rule at phone width (`.hero{flex-wrap:wrap}` and `.actions`
 * at `width:100%` under 860px) and the web band's rule under 720px, and a
 * seven-button action row beside an 84dp avatar and a name does not fit a
 * phone any other way.
 *
 * [subtitle] is the EXPLANATION and never reaches the screen as copy; [detail]
 * is a VALUE that does (a count, a date, a range, a name). See DenInfoTip.
 *
 * Pass [crumbs] on a NESTED screen and the trail takes the kicker's place. Not
 * a style preference: the ten `.crumbs` mocks all put the trail exactly where a
 * list screen puts its kicker, and none shows both. "THE DEN · DIRECTORY" is
 * word for word what the Directory two levels up says, so on a nested screen it
 * is the line with nothing to say and the trail is the line that has something.
 *
 * Every new parameter defaults to null and every existing call site names its
 * arguments, so a heading that passes none of the slots compiles and lays out
 * as before, only now on the band.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DenScreenHeading(
    kicker: String,
    title: String,
    modifier: Modifier = Modifier,
    accentTail: String? = null,
    subtitle: String? = null,
    detail: String? = null,
    crumbs: List<DenCrumb>? = null,
    trailing: (@Composable () -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    badges: (@Composable () -> Unit)? = null,
    content: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val trailingUnder = trailing != null && leading != null
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(HeroBandShape)
            .background(
                Brush.linearGradient(
                    colors = listOf(c.surface, c.surface2),
                    start = Offset.Zero,
                    end = Offset.Infinite,
                ),
            )
            .drawBehind {
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(KinfolkOrange.copy(alpha = 0.26f), Color.Transparent),
                        center = Offset.Zero,
                        radius = size.width * 0.75f,
                    ),
                )
            }
            .border(dims.borderHairline, c.border, HeroBandShape)
            .padding(22.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(18.dp))
            }
            Column(Modifier.weight(1f)) {
                if (crumbs == null) {
                    Text(
                        text = kicker.uppercase(),
                        style = AuntieTheme.typography.mono.copy(letterSpacing = 1.6.sp, fontSize = 11.sp),
                        color = c.primary,
                    )
                } else {
                    DenBreadcrumbs(crumbs)
                }
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
                    if (subtitle != null) {
                        Spacer(Modifier.width(8.dp))
                        DenInfoTip(subtitle)
                    }
                }
                if (detail != null) {
                    Spacer(Modifier.height(6.dp))
                    Text(detail, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
                if (content != null) {
                    // The mock's `.owner` / `.where`: 9px under the line above.
                    Spacer(Modifier.height(9.dp))
                    content()
                }
                if (badges != null) {
                    // The mock's `.hero .tags`: 8px between capsules, 12px under
                    // the line above (the profile mocks say 11 and 13).
                    Spacer(Modifier.height(12.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        badges()
                    }
                }
            }
            if (trailing != null && !trailingUnder) {
                Spacer(Modifier.width(18.dp))
                trailing()
            }
        }
        if (trailing != null && trailingUnder) {
            Spacer(Modifier.height(16.dp))
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
 * A glass section panel with a serif [title], an info button carrying the
 * [subtitle] explanation, an optional [detail] value line, an optional [meta]
 * note and an optional [trailing] slot in the header, then arbitrary
 * [content]. The workhorse container for the redesign's two-column dashboards
 * and stacked detail pages.
 *
 * [subtitle] is the EXPLANATION and never reaches the screen as copy; [detail]
 * is a VALUE that does (a count, a date, a name, a status word). See DenInfoTip.
 *
 * [meta] is the mocks' `.ct`, and the web panel's `meta` prop (#780): a short
 * right-aligned mono note on the header rule, for a count or a window ("2
 * kin", "next 7 days", "admin only"). Distinct from [trailing], which holds
 * CONTROLS: this is a statement about the panel's contents, text and never
 * interactive. It exists as its own parameter because the alternative the
 * kinfolk profile reached for was a private `PanelMeta` passed through
 * [trailing], which put a caption where a button goes and outside TalkBack's
 * reading of the header. Blank renders nothing.
 *
 * #445: [title] carries `Modifier.semantics { heading() }`, so TalkBack can jump
 * panel to panel with its next-heading gesture instead of swiping through
 * everything in between. Mirrors `DenPanel` on web (#404 / PR #417), which
 * renders its title as a real `h2`/`h3` instead of a `<span>`. Compose has no DOM
 * and no heading LEVEL, only the boolean marker `heading()`: every panel title
 * is a heading, full stop, so there is no web-style "which level nests under
 * which" to get wrong here. What web's `headingLevel` prop had to answer, this
 * still had to check: no `DenPanel` mounts inside another `DenPanel`'s `content`
 * anywhere in this app (surveyed every call site), so no panel title heading
 * sits nested under a sibling panel's; and no screen composes its own
 * `heading()` elsewhere that a panel title would collide with or duplicate.
 * `DenScreenHeading` (the page-level title) was out of #445's scope on both
 * platforms and still carries no marker.
 */
@Composable
fun DenPanel(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    detail: String? = null,
    cornerRadius: Dp = 18.dp,
    contentPadding: Dp = 20.dp,
    // #12/#13 (2026-06-08): opt-in collapsible panel (parity with web). Default
    // false keeps every existing call site identical.
    collapsible: Boolean = false,
    initiallyExpanded: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    meta: String? = null,
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
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            title,
                            style = AuntieTheme.typography.headlineSmall,
                            color = c.textPrimary,
                            // #445: the accessible name is the title alone, same
                            // as web. Since #752 the explanation is not a Text
                            // beneath it at all but the info button's tooltip,
                            // which keeps it out of the heading either way.
                            modifier = Modifier.semantics { heading() },
                        )
                        if (subtitle != null) {
                            Spacer(Modifier.width(8.dp))
                            DenInfoTip(subtitle)
                        }
                    }
                    if (detail != null) {
                        Spacer(Modifier.height(4.dp))
                        Text(detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
                if (!meta.isNullOrBlank()) {
                    // The mocks' `.ct`: mono, small, dim, at the right of the
                    // rule, before any control. Web's `.den-panel-meta`.
                    Text(
                        text = meta,
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                        maxLines = 1,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
                if (trailing != null) {
                    if (!meta.isNullOrBlank()) Spacer(Modifier.width(8.dp))
                    trailing()
                }
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

/**
 * Same quiet line as [EmptyHint], but for a state that is genuinely in flight
 * rather than empty or failed: a small spinner beside the sentence, matching
 * the web admin's `LoadingRow` (issue #714). Settings sections cold-start their
 * callables at 8-10s, and a bare hint sentence with nothing moving read as
 * broken rather than slow, next to no motion cue at all.
 */
@Composable
fun LoadingHint(text: String) {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(vertical = 8.dp),
    ) {
        AuntieSpinner(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = c.textDim)
        Spacer(Modifier.width(8.dp))
        Text(text, style = AuntieTheme.typography.bodySmall, color = c.textDim)
    }
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
