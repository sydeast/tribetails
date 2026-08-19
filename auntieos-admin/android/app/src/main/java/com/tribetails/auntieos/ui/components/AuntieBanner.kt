package com.tribetails.auntieos.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieBanner: persistent inline banner / callout for the Den kit.
 *
 * The fail-loud policy primitive: surfaces info, success, warning, error, and
 * suggestion states inline rather than swallowing them. Color-keyed by [tone]
 * (resolved via [AuntieBannerTone.color] in AuntieTones.kt), so the leading icon
 * tile, the left accent rail, the soft fill wash, the border, and the optional
 * pill all resolve to the SAME brand swatch.
 *
 * Anatomy (left to right, top to bottom):
 *  - A left accent rail in the tone color, signalling the state at a glance.
 *  - An optional leading [icon] rendered in a tinted glyph tile (caller supplies
 *    the [ImageVector]; none are hardcoded). Drawn with foundation Image +
 *    rememberVectorPainter + a tint ColorFilter, never the Material3 Icon.
 *  - An optional [title] in the Fraunces display face (headlineSmall) paired with
 *    an optional Spline-mono [pillLabel] chip.
 *  - A rich [body] slot the caller fills with any Composable content (text, links,
 *    inline fields). This keeps copy authoring with the caller.
 *  - An optional [trailing] action slot (for example a GhostButton) and an
 *    optional dismiss affordance wired to [onDismiss].
 *
 * Set [dashed] for a dashed border treatment, the Den convention for advisory or
 * placeholder callouts (for example a stubbed-feature warning) versus the solid
 * border used for live committed state.
 *
 * ## Dismissing (#444)
 *
 * [dismissible] opts a banner into a close affordance even when the caller has
 * nothing of its own to run on dismiss (a notice computed straight from a
 * record, like "Archived", rather than from local state). The banner then
 * hides itself; no caller-held `remember { mutableStateOf(...) }` required.
 * Passing [onDismiss] still works exactly as before and implies dismissible on
 * its own, so no existing call site's CLICK behavior changes.
 *
 * BACK PRESS IS NEW BEHAVIOR FOR EVERY EXISTING onDismiss CALL SITE, not just
 * the two newly-[dismissible] ones. Before this, none of them intercepted back
 * at all; now, for as long as one of these banners is visible, back dismisses
 * it instead of doing whatever it would otherwise do (typically leaving the
 * screen). That is the intended touch/hardware-key equivalent of web's Escape,
 * per #444, but unlike Escape it is not scoped to "focus is inside the
 * banner" — Compose has no keyboard-focus concept for a screen shown on a
 * phone, so while any dismissible banner is on screen, back dismisses it, full
 * stop. Worth knowing if a call site's designer wanted back to keep leaving
 * the screen even with the banner up; none of the current ones is that case.
 *
 * Every dismissible banner, new or existing, also gets an accessible label on
 * its close glyph ("Dismiss") via [Modifier.semantics], the same idiom
 * [AuntieIconButton] uses, mirroring `aria-label="Dismiss"` on the web
 * `<button>` (`Banner.tsx`'s `dismissible` prop, PR #419).
 *
 * [BackHandler] callbacks resolve most-recently-added-first, so a banner
 * nested inside a [Dialog] that also uses `BackHandler` for its own back
 * behavior (see `NewBookingWizard.kt`) intercepts back before that dialog
 * does — verified for `Dialog`, not exercised against a focusable `Popup`
 * (e.g. `AuntieDialog`'s base), whose own key handling may consume back before
 * the activity dispatcher runs. No dismissible banner is wired inside a
 * `Popup` today.
 */
@Composable
fun AuntieBanner(
    modifier: Modifier = Modifier,
    tone: AuntieBannerTone = AuntieBannerTone.Info,
    title: String? = null,
    icon: ImageVector? = null,
    dashed: Boolean = false,
    pillLabel: String? = null,
    dismissible: Boolean = false,
    onDismiss: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    body: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val toneColor = tone.color(c)

    // #444: dismissible opts in a close button with no onDismiss of its own;
    // onDismiss alone still implies it, unchanged from before this banner had
    // any internal state. Once hidden, this banner renders nothing further, so
    // a caller relying on onDismiss to clear its own state (the pre-existing
    // ~15 call sites) sees no CLICK behavior change: the banner disappears
    // either way. Back press is a new interception for those same sites — see
    // the class doc's "Dismissing" section.
    val canDismiss = dismissible || onDismiss != null
    var hidden by remember { mutableStateOf(false) }
    if (hidden) return

    val handleDismiss: () -> Unit = {
        hidden = true
        onDismiss?.invoke()
    }

    // The Escape-key equivalent: back press dismisses this banner while it is
    // showing, rather than whatever it would otherwise do (unscoped — Compose
    // has no keyboard-focus concept to gate this on, unlike web's Escape).
    BackHandler(enabled = canDismiss, onBack = handleDismiss)

    val corner = 14.dp
    val shape = RoundedCornerShape(corner)

    // Soft wash fill keyed to the tone, sitting on the glass surface so the banner
    // reads on any background. Slightly stronger in dark mode for legibility.
    val fillAlpha = if (c.isDark) 0.14f else 0.09f
    val fillBrush = Brush.linearGradient(
        listOf(
            toneColor.copy(alpha = fillAlpha),
            toneColor.copy(alpha = fillAlpha * 0.5f),
        ),
    )
    val borderColor = toneColor.copy(alpha = if (c.isDark) 0.48f else 0.40f)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(fillBrush)
            .drawBehind {
                val cr = CornerRadius(corner.toPx())
                val stroke = if (dashed) {
                    Stroke(
                        width = dims.borderHairline.toPx(),
                        pathEffect = PathEffect.dashPathEffect(
                            floatArrayOf(6.dp.toPx(), 4.dp.toPx()),
                            0f,
                        ),
                    )
                } else {
                    Stroke(width = dims.borderHairline.toPx())
                }
                // Left accent rail first: a tone-colored band hugging the rounded
                // left edge, then mask its inner side so only the thin band shows.
                val railWidth = 4.dp.toPx()
                drawRoundRect(
                    color = toneColor,
                    topLeft = Offset(0f, 0f),
                    size = Size(railWidth + cr.x, size.height),
                    cornerRadius = cr,
                )
                drawRect(
                    brush = fillBrush,
                    topLeft = Offset(railWidth, 0f),
                    size = Size(size.width - railWidth, size.height),
                )
                // Border outline drawn last so the dashed / solid edge stays crisp
                // over the rail and mask.
                drawRoundRect(
                    color = borderColor,
                    cornerRadius = cr,
                    style = stroke,
                )
            }
            .padding(start = dims.space4 + 4.dp, top = dims.space3, end = dims.space3, bottom = dims.space3),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
            verticalAlignment = Alignment.Top,
        ) {
            if (icon != null) {
                BannerGlyphTile(icon = icon, toneColor = toneColor)
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                if (title != null || pillLabel != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (title != null) {
                            Text(
                                text = title,
                                style = AuntieTheme.typography.headlineSmall,
                                color = c.textPrimary,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                        }
                        if (pillLabel != null) {
                            BannerPill(label = pillLabel, toneColor = toneColor)
                        }
                    }
                }

                // Rich body slot: caller-authored content. The caller fills this
                // with any Composable (text, links, inline fields) and owns the copy.
                Box {
                    body()
                }

                if (trailing != null) {
                    Box(modifier = Modifier.padding(top = dims.space1)) {
                        trailing()
                    }
                }
            }

            if (canDismiss) {
                BannerDismiss(toneColor = toneColor, onDismiss = handleDismiss)
            }
        }
    }
}

/**
 * The leading glyph tile: a soft tone wash square holding the caller's icon, drawn
 * with foundation Image + vector painter + tint (no Material3 Icon).
 */
@Composable
private fun BannerGlyphTile(
    icon: ImageVector,
    toneColor: Color,
) {
    val c = AuntieTheme.colors
    val tileSize = 32.dp
    val washAlpha = if (c.isDark) 0.22f else 0.16f
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier = Modifier
            .size(tileSize)
            .clip(shape)
            .background(toneColor.copy(alpha = washAlpha)),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = rememberVectorPainter(icon),
            contentDescription = null,
            colorFilter = ColorFilter.tint(toneColor),
            modifier = Modifier.size(tileSize * 0.55f),
        )
    }
}

/**
 * Optional Spline-mono pill beside the title, for short SCREAMING_SNAKE labels
 * (for example STUBBED, NEEDS_ATTENTION). Mirrors the AuntieStatusPill swatch.
 */
@Composable
private fun BannerPill(
    label: String,
    toneColor: Color,
) {
    val c = AuntieTheme.colors
    val hairline = AuntieTheme.dims.borderHairline
    val padH = AuntieTheme.dims.space2
    val fill = toneColor.copy(alpha = if (c.isDark) 0.20f else 0.14f)
    val border = toneColor.copy(alpha = 0.45f)
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(fill)
            .drawBehind {
                drawRoundRect(
                    color = border,
                    cornerRadius = CornerRadius(999.dp.toPx()),
                    style = Stroke(width = hairline.toPx()),
                )
            }
            .padding(horizontal = padH, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label.uppercase(),
            style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 0.6.sp),
            color = toneColor,
        )
    }
}

/**
 * The dismiss affordance: a borderless hover-reactive close glyph drawn with Canvas
 * (an X stroke), so no specific ImageVector is hardcoded and no Material3 Icon is used.
 *
 * #444: carries its own accessible label. Without it TalkBack has nothing to
 * announce beyond "button" for an icon drawn on a raw Canvas, the same gap
 * `aria-label="Dismiss"` closed on the web `<button>`. Same idiom as
 * [AuntieIconButton]'s `contentDescription` parameter.
 */
@Composable
private fun BannerDismiss(
    toneColor: Color,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    val strokeWidthDp = AuntieTheme.dims.borderEmphasis
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    val glyphColor = animateColorAsState(
        if (hovered) toneColor else c.textFaint,
        label = "bannerDismissGlyph",
    ).value
    val bgColor = animateColorAsState(
        if (hovered) toneColor.copy(alpha = if (c.isDark) 0.18f else 0.12f) else Color.Transparent,
        label = "bannerDismissBg",
    ).value

    Box(
        modifier = Modifier
            .size(24.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onDismiss,
            )
            .semantics { contentDescription = "Dismiss" }
            .drawBehind {
                val pad = 7.dp.toPx()
                val w = strokeWidthDp.toPx()
                drawLine(
                    color = glyphColor,
                    start = Offset(pad, pad),
                    end = Offset(size.width - pad, size.height - pad),
                    strokeWidth = w,
                )
                drawLine(
                    color = glyphColor,
                    start = Offset(size.width - pad, pad),
                    end = Offset(pad, size.height - pad),
                    strokeWidth = w,
                )
            },
    )
}
