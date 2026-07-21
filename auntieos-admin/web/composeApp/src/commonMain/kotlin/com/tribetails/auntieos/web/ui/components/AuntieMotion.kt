package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.delay

// ─── CollapsingSection ────────────────────────────────────────────────────────
@Composable
fun CollapsingSection(
    header: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
    headerColor: Color = AuntieTheme.colors.surface,
    accentColor: Color = AuntieTheme.colors.primary,
    content: @Composable ColumnScope.() -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    val chevronRotation by animateFloatAsState(
        targetValue   = if (expanded) 180f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMedium),
        label         = "chevron",
    )
    val shape = if (expanded) RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp) else RoundedCornerShape(12.dp)

    Column(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(headerColor)
                .clickable { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Box(modifier = Modifier.weight(1f)) { header() }
            Icon(
                imageVector        = Lucide.ChevronDown,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint               = accentColor,
                modifier           = Modifier.size(20.dp).rotate(chevronRotation),
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter   = expandVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) + fadeIn(),
            exit    = shrinkVertically(tween(200)) + fadeOut(tween(200)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(bottomStart = 12.dp, bottomEnd = 12.dp))
                    .background(AuntieTheme.colors.surface2),
                content = content,
            )
        }
    }
}

// ─── PulsingBadge ─────────────────────────────────────────────────────────────
@Composable
fun PulsingBadge(
    modifier: Modifier = Modifier,
    color: Color = AuntieTheme.colors.primary,
    count: Int = 0,
    pulsing: Boolean = true,
    size: Dp = 10.dp,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val haloScale by if (pulsing) {
        infiniteTransition.animateFloat(
            initialValue  = 1f,
            targetValue   = 1.6f,
            animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label         = "haloScale",
        )
    } else remember { mutableStateOf(1f) }
    val haloAlpha by if (pulsing) {
        infiniteTransition.animateFloat(
            initialValue  = 0.4f,
            targetValue   = 0f,
            animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label         = "haloAlpha",
        )
    } else remember { mutableStateOf(0f) }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .size(size)
                .scale(haloScale)
                .clip(RoundedCornerShape(50))
                .background(color.copy(alpha = haloAlpha)),
        )
        Box(
            modifier = Modifier
                .size(size)
                .clip(RoundedCornerShape(50))
                .background(color),
            contentAlignment = Alignment.Center,
        ) {
            if (count > 0) {
                Text(
                    text  = if (count > 99) "99+" else count.toString(),
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.background,
                )
            }
        }
    }
}

// ─── StaggerRevealList ────────────────────────────────────────────────────────
@Composable
fun <T> StaggerRevealList(
    items: List<T>,
    modifier: Modifier = Modifier,
    staggerMs: Long = 60L,
    verticalArrangement: Arrangement.Vertical = Arrangement.spacedBy(0.dp),
    itemContent: @Composable ColumnScope.(item: T) -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = verticalArrangement) {
        items.forEachIndexed { index, item ->
            var visible by remember(item) { mutableStateOf(false) }
            LaunchedEffect(item) {
                delay(index * staggerMs)
                visible = true
            }
            AnimatedVisibility(
                visible = visible,
                enter   = slideInVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 2 } + fadeIn(),
            ) {
                itemContent(item)
            }
        }
    }
}

// ─── Dashboard motion (17.3 alive-widgets pass) ──────────────────────────────

/**
 * Pure display math for a count-up animation: the value shown at [progress]
 * (0..1) of the roll from 0 to [target]. Extracted so tests can pin the curve
 * endpoints without driving a Compose clock.
 */
fun countUpDisplay(target: Double, progress: Float): Double =
    target * progress.coerceIn(0f, 1f)

/**
 * Rolls a numeric stat up from 0 to [target] once per distinct target, then
 * sits still. [format] turns the in-flight value into the rendered string
 * (count, money, ...). Loading states should render their placeholder INSTEAD
 * of this composable so the roll only ever plays over real data.
 */
@Composable
fun CountUpText(
    target: Double,
    format: (Double) -> String,
    style: androidx.compose.ui.text.TextStyle,
    color: Color,
) {
    val progress = remember(target) { Animatable(0f) }
    LaunchedEffect(target) {
        progress.snapTo(0f)
        progress.animateTo(1f, animationSpec = tween(durationMillis = 700, easing = FastOutSlowInEasing))
    }
    Text(format(countUpDisplay(target, progress.value)), style = style, color = color)
}

/**
 * One dashboard widget's entrance: rise from below + fade, staggered by the
 * widget's [index] in the layout. Plays once per index (re-plays when the
 * operator reorders, which reads as the card taking its new seat).
 */
@Composable
fun DashRevealItem(
    index: Int,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    var visible by remember(index) { mutableStateOf(false) }
    LaunchedEffect(index) {
        delay(index * 70L)
        visible = true
    }
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = slideInVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 3 } + fadeIn(),
    ) {
        content()
    }
}

/**
 * A slow breathe (scale loop) for decorative accents, the watermark-level
 * "never completely static" touch. Gentle by design: 6 percent over 4s.
 */
@Composable
fun Modifier.breathe(enabled: Boolean = true): Modifier {
    if (!enabled) return this
    val transition = rememberInfiniteTransition(label = "breathe")
    val s by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1.06f,
        animationSpec = infiniteRepeatable(tween(4000, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "breatheScale",
    )
    return this.scale(s)
}

// ─── SlideInCard ──────────────────────────────────────────────────────────────
@Composable
fun SlideInCard(
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    content: @Composable () -> Unit,
) {
    AnimatedVisibility(
        visible  = visible,
        modifier = modifier,
        enter    = slideInHorizontally(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 2 } + fadeIn(),
        exit     = slideOutHorizontally(tween(200)) { it / 2 } + fadeOut(tween(200)),
    ) {
        content()
    }
}
